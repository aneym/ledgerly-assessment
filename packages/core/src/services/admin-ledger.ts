// Cross-business admin ledger, per docs/lanes/architecture/decision.md and the owner's
// requirement for a platform-wide view of every payment, fee, transfer, refund and payout -
// authoritative from stored records, never inferred cosmetically. This module holds the
// business identity, type mapping and status derivation rules; packages/db/src/repos/
// admin-ledger.ts does the SQL (filters, keyset pagination, the order-resolution join) and
// calls buildAdminLedgerRow to turn each raw row into the shape this module defines.
import type { OrderId, SellerId, WhopAccountId } from "../ids";
import type { InstrumentationEvent } from "../instrumentation/types";
import { type Currency, type Money, money } from "../money";
import type { SalePolicy } from "../seller";

export type AdminLedgerEntryType = "payment" | "fee" | "transfer" | "refund" | "payout";

export type AdminLedgerEntryStatus =
  | "settling"
  | "settled"
  | "pending"
  | "held"
  | "refunded"
  | "paid_out"
  | "failed";

const ADMIN_LEDGER_STATUSES: ReadonlySet<string> = new Set([
  "settling",
  "settled",
  "pending",
  "held",
  "refunded",
  "paid_out",
  "failed",
]);

function isAdminLedgerStatus(value: string): value is AdminLedgerEntryStatus {
  return ADMIN_LEDGER_STATUSES.has(value);
}

// The documented kind -> type table. This is the single source of truth for how a
// ledger_entries.kind (written by packages/core/src/services/inbox.ts) maps onto the admin
// ledger's coarser `type` filter: payment/fee/refund keep their own row's economics distinct
// (a payment and its matching fee are two separate ledger_entries rows sharing an effect_key,
// per inbox.ts's `post` calls), refund_fee collapses into "fee" since it is the platform's cut
// of a refund the same way "fee" is the platform's cut of a payment, and every payout
// transition collapses into "payout" since the admin ledger's `type` filter does not need to
// distinguish a pending payout from a completed one - that distinction lives entirely in
// `status`.
const KIND_TO_TYPE: Readonly<Record<string, AdminLedgerEntryType>> = {
  payment: "payment",
  fee: "fee",
  refund: "refund",
  refund_fee: "fee",
  transfer: "transfer",
  payout_pending: "payout",
  payout_in_transit: "payout",
  payout_completed: "payout",
  payout_failed: "payout",
  payout_canceled: "payout",
};

// The reverse of KIND_TO_TYPE, built from it rather than hand-duplicated, so a `type` query
// filter can be turned into the list of ledger_entries.kind values the repo's SQL should
// match against - the two tables can never drift apart because there is only one of them.
export const TYPE_TO_KINDS: Readonly<Record<AdminLedgerEntryType, readonly string[]>> = (() => {
  const table: Record<AdminLedgerEntryType, string[]> = {
    payment: [],
    fee: [],
    transfer: [],
    refund: [],
    payout: [],
  };
  for (const [kind, type] of Object.entries(KIND_TO_TYPE)) table[type].push(kind);
  return table;
})();

export function mapLedgerKindToType(kind: string): AdminLedgerEntryType {
  const type = KIND_TO_TYPE[kind];
  if (!type) throw new Error(`Unrecognized ledger_entries.kind for the admin ledger: ${kind}`);
  return type;
}

// Payout entries are posted single-sided, one row per transition (see inbox.ts's payout
// branch), so the kind alone names the status - there is no sibling row to reconcile against
// the way payment/refund rows have one.
const PAYOUT_KIND_TO_STATUS: Readonly<Record<string, AdminLedgerEntryStatus>> = {
  payout_pending: "pending",
  payout_in_transit: "settling",
  payout_completed: "paid_out",
  payout_failed: "failed",
  payout_canceled: "failed",
};

export type DeriveAdminLedgerStatusInput = {
  kind: string;
  // ledger_entries.status: an explicit operator/compliance override (e.g. a manual hold).
  storedStatus: string | null;
  // True when a refund or refund_fee ledger entry resolves, via the order-resolution join in
  // packages/db/src/repos/admin-ledger.ts, to the same order as this payment/fee entry.
  // Ignored for every kind other than payment/fee.
  hasResolvedRefund: boolean;
};

// Status derivation rule for the admin ledger, in priority order. This is the documented rule
// the build brief asks for; packages/db/test/admin-ledger.test.ts exercises it end to end
// through seeded webhook fixtures, and packages/core/test/services/admin-ledger.test.ts
// exercises it directly, case by case.
//
// 1. A stored `ledger_entries.status` always wins, whatever the kind. This is the only path
//    that can ever produce "held": nothing below derives it, so a row only ever shows "held"
//    when something (a future compliance/hold feature, not built by this round) explicitly
//    wrote it there.
// 2. transfer -> "settled". inbox.ts's `supported` event list only ever processes
//    transfer.completed, never a pending or reversed transfer, so a transfer row existing at
//    all means it already settled.
// 3. payout_pending/in_transit/completed/failed/canceled map straight to
//    pending/settling/paid_out/failed/failed.
// 4. refund/refund_fee -> "refunded" unconditionally: the row's own existence is the refund.
// 5. payment/fee -> "refunded" when a refund/refund_fee entry has resolved to the same order
//    (hasResolvedRefund), else "settled". orders.status deliberately plays no part in this:
//    OrderStatus only ever reaches "pending" (on insert) or "checkout_created" (once a
//    checkout configuration exists) anywhere in this codebase - "failed" is declared in the
//    union but no code path in packages/core or packages/db ever assigns it - so it carries no
//    signal a webhook-posted ledger row doesn't already carry more directly. A payment or fee
//    ledger row existing at all means the webhook that created it fully posted through
//    inbox.ts, which is a stronger settlement signal than an order's largely-unused status.
// 6. Anything else -> "pending", a conservative fallback that should be unreachable given the
//    fully-enumerated kinds inbox.ts ever writes.
export function deriveAdminLedgerStatus(
  input: DeriveAdminLedgerStatusInput,
): AdminLedgerEntryStatus {
  if (input.storedStatus !== null) {
    if (!isAdminLedgerStatus(input.storedStatus))
      throw new Error(`ledger_entries.status holds an unrecognized value: ${input.storedStatus}`);
    return input.storedStatus;
  }
  if (input.kind === "transfer") return "settled";
  const payoutStatus = PAYOUT_KIND_TO_STATUS[input.kind];
  if (payoutStatus) return payoutStatus;
  if (input.kind === "refund" || input.kind === "refund_fee") return "refunded";
  if (input.kind === "payment" || input.kind === "fee")
    return input.hasResolvedRefund ? "refunded" : "settled";
  return "pending";
}

// A row is "settled" for the purpose of settled_at once it reaches one of these terminal
// states. "pending"/"settling"/"held" are all still in flight, so settled_at stays null.
const SETTLED_ADMIN_LEDGER_STATUSES: ReadonlySet<AdminLedgerEntryStatus> = new Set([
  "settled",
  "refunded",
  "paid_out",
  "failed",
]);

export type AdminLedgerSeller = {
  id: SellerId;
  // display_name, falling back to the seller title from the Whop readback if the repo has one
  // stored, else externalId. Resolved once by the repo (see resolveSellerName there); this
  // module just carries the already-resolved string.
  name: string;
  whopAccountId: WhopAccountId | null;
  salePolicy: SalePolicy;
};

export type AdminLedgerRow = {
  id: string;
  seller: AdminLedgerSeller;
  type: AdminLedgerEntryType;
  orderId: OrderId | null;
  providerResourceId: string;
  status: AdminLedgerEntryStatus;
  gross: Money | null;
  fee: Money | null;
  net: Money | null;
  currency: Currency;
  createdAt: Date;
  updatedAt: Date;
  settledAt: Date | null;
  correlationId: string | null;
  provenance: string;
};

// What the repo's SQL hands back per row, before the business rules above turn it into an
// AdminLedgerRow. Kept separate from AdminLedgerRow itself so the kind/status-derivation
// inputs (kind, storedStatus, hasResolvedRefund) don't leak into the public row shape.
export type RawAdminLedgerEntry = {
  id: string;
  seller: AdminLedgerSeller;
  kind: string;
  // Resolved via the business_effects/webhook_inbox replay described in
  // packages/db/src/repos/admin-ledger.ts, for payment/fee/refund/refund_fee kinds only; null
  // for transfer/payout kinds (structurally unresolvable - see that file's module comment) and
  // for a payment/refund whose resolution genuinely finds no matching order.
  orderId: OrderId | null;
  providerResourceId: string;
  storedStatus: string | null;
  hasResolvedRefund: boolean;
  amountMinor: number;
  currency: Currency;
  // The resolved order's own gross_minor/fee_minor, unsigned, exactly as stored - present only
  // when orderId is non-null. Not applicable (null) otherwise: a transfer or payout row has no
  // order to quote a gross/fee from, and this module will not fabricate one.
  orderGrossMinor: number | null;
  orderFeeMinor: number | null;
  createdAt: Date;
  occurredAt: Date;
  correlationId: string | null;
  provenance: string;
};

function moneyOrThrow(amountMinor: number, currency: Currency): Money {
  const result = money(amountMinor, currency);
  if (!result.ok) throw new Error("Invalid money on a persisted admin ledger row");
  return result.value;
}

// Turns one raw repo row into the row this service publishes. `net` is always the row's own
// posted amount (ledger_entries.amount_minor), signed exactly as inbox.ts wrote it - that is
// the row's real economic effect and needs no reinterpretation. `gross`/`fee` are quoted
// straight off the resolved order's own columns, unsigned, exactly as stored: a refund row's
// gross/fee describe the order being refunded, not a synthesized negative counterpart, since
// inventing a sign convention for them would be exactly the "cosmetic inference" the brief
// rules out. They are null whenever no order resolved (transfer/payout rows, or a
// payment/refund whose resolution comes up empty).
export function buildAdminLedgerRow(raw: RawAdminLedgerEntry): AdminLedgerRow {
  const type = mapLedgerKindToType(raw.kind);
  const status = deriveAdminLedgerStatus({
    kind: raw.kind,
    storedStatus: raw.storedStatus,
    hasResolvedRefund: raw.hasResolvedRefund,
  });
  const gross =
    raw.orderGrossMinor === null ? null : moneyOrThrow(raw.orderGrossMinor, raw.currency);
  const fee = raw.orderFeeMinor === null ? null : moneyOrThrow(raw.orderFeeMinor, raw.currency);
  const net = moneyOrThrow(raw.amountMinor, raw.currency);
  return {
    id: raw.id,
    seller: raw.seller,
    type,
    orderId: raw.orderId,
    providerResourceId: raw.providerResourceId,
    status,
    gross,
    fee,
    net,
    currency: raw.currency,
    createdAt: raw.createdAt,
    // ledger_entries has no updated_at column and rows are append-only (inbox.ts only ever
    // inserts, never updates one), so createdAt doubles as updatedAt: there is truthfully
    // nothing else that could have "updated" the row since it was written.
    updatedAt: raw.createdAt,
    settledAt: SETTLED_ADMIN_LEDGER_STATUSES.has(status) ? raw.occurredAt : null,
    correlationId: raw.correlationId,
    provenance: raw.provenance,
  };
}

export type AdminLedgerQuery = {
  q?: string;
  type?: AdminLedgerEntryType;
  status?: AdminLedgerEntryStatus;
  sellerId?: SellerId;
  provenance?: string;
  from?: Date;
  to?: Date;
  currency?: Currency;
  cursor?: string;
  limit?: number;
};

export type AdminLedgerCurrencyTotals = { gross: number; fee: number; net: number };

// Per-currency, never summed across currencies - each key is independent, matching
// packages/core/src/services/earnings.ts's per-currency Map pattern.
export type AdminLedgerSummary = Partial<Record<Currency, AdminLedgerCurrencyTotals>>;

export type AdminLedgerQueryResult = { rows: AdminLedgerRow[]; nextCursor: string | null };

export interface AdminLedgerRepo {
  query(query: AdminLedgerQuery): Promise<AdminLedgerQueryResult>;
  // Same filters as query() minus cursor/limit: the summary always covers the whole filtered
  // result set, not just the current page, so an admin dashboard's totals don't shift as it
  // paginates.
  summarize(query: Omit<AdminLedgerQuery, "cursor" | "limit">): Promise<AdminLedgerSummary>;
}

export type AdminLedgerPage = {
  rows: AdminLedgerRow[];
  nextCursor: string | null;
  summary: AdminLedgerSummary;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(limit), MAX_LIMIT);
}

// Normalizes the query (limit default/clamp, trimmed free-text search), fans out to the repo
// for the page of rows and the whole-result-set summary in parallel, and defensively checks
// the summary never reports a currency Money itself would reject - cheap insurance against a
// future repo change that accidentally coalesces currencies. There is no failure mode here
// worth a Result: an out-of-range or missing filter just narrows to fewer/no rows.
export async function listAdminLedger(
  repo: AdminLedgerRepo,
  query: AdminLedgerQuery,
): Promise<AdminLedgerPage> {
  const normalized: AdminLedgerQuery = {
    ...query,
    ...(query.q !== undefined ? { q: query.q.trim() } : {}),
    limit: clampLimit(query.limit),
  };
  const { cursor: _cursor, limit: _limit, ...summaryQuery } = normalized;
  const [{ rows, nextCursor }, summary] = await Promise.all([
    repo.query(normalized),
    repo.summarize(summaryQuery),
  ]);
  for (const currencyKey of Object.keys(summary)) {
    if (!money(0, currencyKey as Currency).ok)
      throw new Error(`Admin ledger summary reported an invalid currency: ${currencyKey}`);
  }
  return { rows, nextCursor, summary };
}

// getAdminLedgerEntry's result: the row itself, its linked order (when one resolved),
// every other ledger row that resolves to that same order (payment/fee/refund/transfer -
// "siblings" of the same economic event), and the instrumentation events recorded under the
// row's correlation id, when it has one.
export type AdminLedgerEntryDetail = {
  row: AdminLedgerRow;
  order: {
    id: OrderId;
    productTitle: string;
    gross: Money;
    fee: Money;
    status: string;
  } | null;
  siblings: AdminLedgerRow[];
  instrumentationEvents: InstrumentationEvent[];
};
