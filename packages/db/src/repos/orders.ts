import {
  type Emitter,
  type LedgerEntry,
  type LedgerRepo,
  money,
  type NewOrder,
  type Order,
  type OrderStatus,
  type OrdersRepo,
  orderId,
  type ProviderSource,
  parseEffectKey,
  runId,
  type Seller,
  type SellerLookup,
  sellerId,
  type TransferCandidate,
  type TransferOrdersRepo,
  uncorrelated,
  whopAccountId,
} from "@ledgerly/core";
import { and, asc, desc, eq, isNull, lt, lte, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { InboxOrdersRepo } from "../../../core/src/services/ports";
import { ledgerEntries, orders, sellers } from "../schema";

const PROVIDER_SOURCES = new Set<ProviderSource>(["sandbox", "mock"]);
function asProviderSource(value: string): ProviderSource {
  return PROVIDER_SOURCES.has(value as ProviderSource) ? (value as ProviderSource) : "mock";
}

// Generic over the query-result HKT so the same repo works against both the
// Neon HTTP driver (production) and PGlite (tests) — the two drizzle
// instances built by createDb()/createTestDb() in ../client.ts. Shared with
// users.ts so both repo modules accept either driver's db instance.
export type Database<TQueryResult extends PgQueryResultHKT> = PgDatabase<
  TQueryResult,
  Record<string, unknown>
>;

function toOrder(row: typeof orders.$inferSelect): Order {
  const id = orderId(row.id);
  const run = runId(row.runId);
  const seller = sellerId(row.sellerId);
  const gross = money(row.grossMinor, row.currency);
  const fee = money(row.feeMinor, row.currency);
  if (!id.ok || !run.ok || !seller.ok || !gross.ok || !fee.ok)
    throw new Error("Invalid persisted order row");
  if (
    row.status !== "pending" &&
    row.status !== "checkout_created" &&
    row.status !== "failed" &&
    row.status !== "paid" &&
    row.status !== "refunded"
  )
    throw new Error("Invalid persisted order status");
  return {
    id: id.value,
    runId: run.value,
    sellerId: seller.value,
    productTitle: row.productTitle,
    productExternalId: row.productExternalId,
    gross: gross.value,
    fee: fee.value,
    flow: row.flow,
    checkoutConfigurationId: row.checkoutConfigurationId,
    purchaseUrl: row.purchaseUrl,
    status: row.status,
    createdAt: row.createdAt,
    provenance: asProviderSource(row.provenance),
    buyerUserId: row.buyerUserId,
    paymentId: row.paymentId,
  };
}

// Opaque cursor for listForBuyer: base64 of "<createdAt ISO>|<id>", the same (createdAt,
// id) pair the query orders and filters by. Order ids are random UUIDs (see
// apps/web/src/lib/commerce.ts's ids.order()), not time-sortable, so createdAt alone can't
// be the sole cursor key - two orders can share a millisecond. id breaks the tie in the same
// descending direction as the page order, so paging never repeats or skips a row.
function encodeOrderCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

function decodeOrderCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const separatorIndex = raw.indexOf("|");
    if (separatorIndex < 0) return null;
    const createdAt = new Date(raw.slice(0, separatorIndex));
    const id = raw.slice(separatorIndex + 1);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function createOrdersRepo<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
  // Opt in only on the root autocommit database. A transaction's RETURNING does not
  // prove commit; transaction callers must keep this omitted and emit after commit.
  committedWrites?: {
    emitter: Emitter;
    provenance: "neon" | "pglite";
  },
): OrdersRepo & InboxOrdersRepo {
  function committed(order: Order): void {
    committedWrites?.emitter.emit({
      correlationId: uncorrelated,
      runId: order.runId,
      source: "db",
      phase: "end",
      path: "orders",
      status: "ok",
      provenance: committedWrites.provenance,
      safeIds: { order_id: order.id },
      summary: "orders row committed",
      at: new Date(),
    });
  }
  return {
    async byCheckoutConfigurationId(id) {
      const rows = await db.select().from(orders).where(eq(orders.checkoutConfigurationId, id));
      return rows.length === 1 && rows[0] ? toOrder(rows[0]) : null;
    },
    async byPaymentId(id) {
      const rows = await db.select().from(orders).where(eq(orders.paymentId, id)).limit(2);
      return rows.length > 1 ? { kind: "ambiguous" } : rows[0] ? toOrder(rows[0]) : null;
    },
    async byId(id) {
      const rows = await db.select().from(orders).where(eq(orders.id, id));
      return rows.length === 1 && rows[0] ? toOrder(rows[0]) : null;
    },
    async createOrFetch(input: NewOrder, id) {
      const inserted = await db
        .insert(orders)
        .values({
          id,
          runId: input.runId,
          sellerId: input.sellerId,
          productTitle: input.productTitle,
          productExternalId: input.productExternalId ?? null,
          buyerUserId: input.buyerUserId ?? null,
          grossMinor: input.gross.amountMinor,
          currency: input.gross.currency,
          feeMinor: input.fee.amountMinor,
          flow: input.flow,
          status: "pending" satisfies OrderStatus,
        })
        .onConflictDoNothing({ target: orders.id })
        .returning();
      const row = inserted[0] ?? (await db.select().from(orders).where(eq(orders.id, id)))[0];
      if (!row) throw new Error("Order disappeared after insert-or-fetch");
      const order = toOrder(row);
      if (inserted[0]) committed(order);
      return order;
    },
    async get(id) {
      const rows = await db.select().from(orders).where(eq(orders.id, id));
      return rows[0] ? toOrder(rows[0]) : null;
    },
    async setCheckout(id, update) {
      const rows = await db
        .update(orders)
        .set({
          checkoutConfigurationId: update.checkoutConfigurationId,
          purchaseUrl: update.purchaseUrl,
          status: update.status,
          provenance: update.provenance,
        })
        .where(eq(orders.id, id))
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Order disappeared during checkout update");
      const order = toOrder(row);
      committed(order);
      return order;
    },
    async listForBuyer(buyerUserId, opts) {
      // Clamp defensively: an unbounded or absurd limit from a caller-controlled query
      // param would otherwise reach the database as-is.
      const limit = Math.max(1, Math.min(opts.limit, 100));
      const cursor = opts.cursor ? decodeOrderCursor(opts.cursor) : null;
      // Same (createdAt, id) ordering as the ORDER BY below: strictly older, or
      // same-instant with a strictly smaller id.
      const olderThanCursor = cursor
        ? or(
            lt(orders.createdAt, cursor.createdAt),
            and(eq(orders.createdAt, cursor.createdAt), lt(orders.id, cursor.id)),
          )
        : undefined;
      const whereClauses = [eq(orders.buyerUserId, buyerUserId)];
      if (olderThanCursor) whereClauses.push(olderThanCursor);
      // Fetch one extra row to learn whether a next page exists without a second query.
      const rows = await db
        .select()
        .from(orders)
        .where(and(...whereClauses))
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor = rows.length > limit && last ? encodeOrderCursor(last) : null;
      return { orders: page.map(toOrder), nextCursor };
    },
  };
}

function toSeller(row: typeof sellers.$inferSelect): Seller {
  const id = sellerId(row.id);
  const run = runId(row.runId);
  if (!id.ok || !run.ok) throw new Error("Invalid persisted seller row");
  const account = row.whopAccountId ? whopAccountId(row.whopAccountId) : null;
  if (account && !account.ok) throw new Error("Invalid persisted seller row");
  return {
    id: id.value,
    runId: run.value,
    externalId: row.externalId,
    email: row.email,
    country: row.country,
    whopAccountId: account ? account.value : null,
    salePolicy: row.salePolicy,
    status: row.status,
  };
}

// The full domain Seller (with salePolicy/status), read straight off the
// sellers table. ports.ts's SellerRepo selects fewer columns because
// onboarding/inbox/reconciliation never need sale policy or suspension.
export function createSellerLookup<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
): SellerLookup {
  return {
    async get(id) {
      const rows = await db.select().from(sellers).where(eq(sellers.id, id));
      return rows[0] ? toSeller(rows[0]) : null;
    },
  };
}

// Not part of the SellerLookup port (ports.ts is forbidden and its interface has no room
// for this without touching onboarding.ts's own callers), so this is its own small repo.
// Used by POST /api/sellers to detect the "account created, onboarding link failed" partial
// state: the seller row is looked up again by the identity the request carries (runId +
// externalId, the same pair the `sellers_run_external_unique` constraint enforces), since a
// failed onboardSeller() call returns the raw provider error with no seller attached to it.
export function createSellerIdentityLookup<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
) {
  return {
    async getByIdentity(runId: string, externalId: string): Promise<Seller | null> {
      const rows = await db
        .select()
        .from(sellers)
        .where(and(eq(sellers.runId, runId), eq(sellers.externalId, externalId)));
      return rows[0] ? toSeller(rows[0]) : null;
    },
  };
}

// sellers.displayName (admin-ledger's additive column) has no place in ports.ts's narrower
// Seller type, so reading and writing it lives here instead of going through onboarding.ts
// or its SellerRepo. POST /api/sellers writes it once, right after onboarding succeeds, when
// the request carried a name/title; every seller-serializing GET route reads it back to
// prefer over externalId, per the JSON-shapes addendum.
export function createSellerDisplayNameRepo<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
) {
  return {
    async get(id: string): Promise<string | null> {
      const rows = await db
        .select({ displayName: sellers.displayName })
        .from(sellers)
        .where(eq(sellers.id, id));
      return rows[0]?.displayName ?? null;
    },
    async set(id: string, displayName: string): Promise<void> {
      await db.update(sellers).set({ displayName }).where(eq(sellers.id, id));
    },
  };
}

// Operator seller list for GET /api/sellers: newest first, keyset-paged on (createdAt, id)
// with the same opaque cursor shape listForBuyer uses. Carries the display name so the
// route can serialize without a second query per row.
export type SellerListItem = { seller: Seller; displayName: string | null };
export function createSellerListRepo<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
) {
  return {
    async list(opts: {
      limit: number;
      cursor?: string | null;
    }): Promise<{ sellers: SellerListItem[]; nextCursor: string | null }> {
      const limit = Math.min(Math.max(opts.limit, 1), 100);
      const cursor = opts.cursor ? decodeOrderCursor(opts.cursor) : null;
      const olderThanCursor = cursor
        ? or(
            lt(sellers.createdAt, cursor.createdAt),
            and(eq(sellers.createdAt, cursor.createdAt), lt(sellers.id, cursor.id)),
          )
        : undefined;
      const query = db.select().from(sellers);
      const rows = await (olderThanCursor ? query.where(olderThanCursor) : query)
        .orderBy(desc(sellers.createdAt), desc(sellers.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor = rows.length > limit && last ? encodeOrderCursor(last) : null;
      return {
        sellers: page.map((row) => ({ seller: toSeller(row), displayName: row.displayName })),
        nextCursor,
      };
    },
  };
}

// The two operator-only writes on a seller row (sellers.sale_policy, sellers.status), for
// POST /api/sellers/{id}/policy and POST /api/sellers/{id}/suspend. Neither belongs on
// SellerLookup (a read-only port shared with the order service) or on onboarding.ts's own
// SellerRepo, so - same precedent as createSellerDisplayNameRepo just above - this is its
// own small repo rather than an addition to a forbidden core file.
export function createSellerAdminWritesRepo<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
) {
  return {
    async setSalePolicy(id: string, salePolicyValue: "direct" | "platform_only"): Promise<void> {
      await db.update(sellers).set({ salePolicy: salePolicyValue }).where(eq(sellers.id, id));
    },
    async suspend(id: string): Promise<void> {
      await db.update(sellers).set({ status: "suspended" }).where(eq(sellers.id, id));
    },
  };
}

function toLedgerEntry(row: typeof ledgerEntries.$inferSelect): LedgerEntry {
  const run = runId(row.runId);
  const seller = sellerId(row.sellerId ?? "");
  const amount = money(row.amountMinor, row.currency);
  const effectKey = parseEffectKey(row.effectKey);
  if (!run.ok || !seller.ok || !amount.ok || !effectKey.ok)
    throw new Error("Invalid persisted ledger entry row");
  return {
    runId: run.value,
    sellerId: seller.value,
    accountSide: row.accountSide,
    amount: amount.value,
    kind: row.kind,
    resourceType: row.providerResourceType,
    resourceId: row.providerResourceId,
    effectKey: effectKey.value,
    occurredAt: row.occurredAt,
  };
}

function toTransferCandidate(row: typeof orders.$inferSelect): TransferCandidate {
  const id = orderId(row.id);
  const run = runId(row.runId);
  const seller = sellerId(row.sellerId);
  const gross = money(row.grossMinor, row.currency);
  const fee = money(row.feeMinor, row.currency);
  if (!id.ok || !run.ok || !seller.ok || !gross.ok || !fee.ok)
    throw new Error("Invalid persisted order row");
  return {
    id: id.value,
    runId: run.value,
    sellerId: seller.value,
    gross: gross.value,
    fee: fee.value,
    createdAt: row.createdAt,
  };
}

// Reads and writes orders.transfer_id, the pre-existing column no other write path used
// until packages/core/src/services/transfers.ts's releaseTransfers. findEligible's
// `isNull(transferId)` filter is the actual double-send guard: once recordTransfer writes
// a row, that order can never be selected again, even across a process restart.
export function createTransferOrdersRepo<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
): TransferOrdersRepo {
  return {
    async findEligible({ olderThan, limit }) {
      const rows = await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.flow, "platform_transfer"),
            eq(orders.status, "paid"),
            isNull(orders.transferId),
            lte(orders.createdAt, olderThan),
          ),
        )
        .orderBy(asc(orders.createdAt))
        .limit(limit);
      return rows.map(toTransferCandidate);
    },
    async recordTransfer(id, transferId) {
      await db.update(orders).set({ transferId }).where(eq(orders.id, id));
    },
  };
}

// Earnings only ever reads the ledger, so this stops at `forSeller` instead of pulling
// in the full LedgerRepo (append/allocation are write paths that belong to the
// onboarding/reconciliation flows, not the earnings route). Mirrors the SQL in
// packages/db/src/repos/repositories.ts's ledger.forSeller exactly, just through the
// Drizzle query builder so it works against both Neon and PGlite.
export function createLedgerReader<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
): Pick<LedgerRepo, "forSeller"> {
  return {
    async forSeller(id) {
      const rows = await db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.sellerId, id))
        .orderBy(asc(ledgerEntries.id));
      return rows.map(toLedgerEntry);
    },
  };
}
