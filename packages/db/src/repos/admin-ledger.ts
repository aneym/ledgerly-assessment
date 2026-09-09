// Cross-business admin ledger: the SQL side of packages/core/src/services/admin-ledger.ts.
// That module owns the business rules (kind -> type mapping, status derivation, row
// shaping); this file owns the query - filters, keyset pagination, and the order-resolution
// join described below - and hands each raw row to buildAdminLedgerRow.
//
// Signed deliveries resolve orders from their original checkout/order references.
// Provider-read payment effects have no inbox row. Resolve those only through the
// canonical payment effect, its audit binding, and the exact persisted payment/checkout.
// Payment-ID-only refunds can follow that same provider-read binding without inventing
// webhook data. Transfer and payout rows remain outside this order-resolution query.
//
// Status filtering. AdminLedgerEntryStatus is derived in TypeScript by
// deriveAdminLedgerStatus, not stored, so filtering on `status` needs the same rule expressed
// as SQL (STATUS_EXPR below) to run inside the database rather than after paging. The two
// must stay in sync by hand: STATUS_EXPR is a literal transcription of
// deriveAdminLedgerStatus's priority list in packages/core/src/services/admin-ledger.ts. This
// does not risk displaying a status inconsistent with the filter, though: the row a caller
// sees is still built by buildAdminLedgerRow from the same storedStatus/kind/hasResolvedRefund
// fields STATUS_EXPR reads, so the filter and the display always agree even if someone edits
// one and forgets the other (they'd just filter wrong, not display wrong).
import { eq, type SQL, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  type OrderId,
  orderId,
  sellerId,
  type WhopAccountId,
  whopAccountId,
} from "../../../core/src/ids";
import { type Currency, money } from "../../../core/src/money";
import type { SalePolicy } from "../../../core/src/seller";
import {
  type AdminLedgerEntryDetail,
  type AdminLedgerQuery,
  type AdminLedgerQueryResult,
  type AdminLedgerRepo,
  type AdminLedgerRow,
  type AdminLedgerSeller,
  type AdminLedgerSummary,
  buildAdminLedgerRow,
  type RawAdminLedgerEntry,
  TYPE_TO_KINDS,
} from "../../../core/src/services/admin-ledger";
import type * as schema from "../schema";
import { orders } from "../schema";
import { listInstrumentationEvents } from "./instrumentation";

// Typed over `typeof schema` (not `Record<string, unknown>`, unlike orders.ts) so a
// Database<TQueryResult> value here type-checks as the same parameter listInstrumentationEvents
// expects - this repo calls it directly for getAdminLedgerEntry's instrumentation-events field
// rather than re-implementing that query.
export type Database<TQueryResult extends PgQueryResultHKT> = PgDatabase<
  TQueryResult,
  typeof schema
>;

const DEFAULT_LIMIT = 50;

// What a raw row out of the `entries` CTE below looks like, before mapRow() turns it into a
// RawAdminLedgerEntry for buildAdminLedgerRow. bigint/bigserial columns come back from a raw
// db.execute() as strings on both the Neon and PGlite drivers (neither applies Drizzle's
// column-mode decoding outside the query builder), so the numeric fields are typed loosely
// here and converted with Number() in mapRow - safe for minor-unit amounts and row ids, which
// never approach Number.MAX_SAFE_INTEGER in this app.
type AdminLedgerSqlRow = {
  id: number | string;
  kind: string;
  provider_resource_id: string;
  stored_status: string | null;
  amount_minor: number | string;
  currency: Currency;
  created_at: Date | string;
  occurred_at: Date | string;
  correlation_id: string | null;
  provenance: string;
  seller_id: string;
  display_name: string | null;
  external_id: string;
  whop_account_id: string | null;
  sale_policy: SalePolicy;
  order_id: string | null;
  order_gross_minor: number | string | null;
  order_fee_minor: number | string | null;
  has_resolved_refund: boolean;
};

// The order-resolution CTEs, shared verbatim by query(), summarize() and
// getAdminLedgerEntry() so the matching logic exists in exactly one place.
function resolvedOrdersCte(): SQL {
  return sql`
    resolved_orders AS (
      SELECT
        le.id AS ledger_entry_id,
        ord.id AS order_id,
        ord.gross_minor AS order_gross_minor,
        ord.fee_minor AS order_fee_minor
      FROM ledger_entries le
      JOIN business_effects be ON be.effect_key = le.effect_key
      LEFT JOIN webhook_inbox wi ON wi.delivery_id = be.delivery_id
      LEFT JOIN LATERAL (
        SELECT o.id, o.gross_minor, o.fee_minor
        FROM orders o
        WHERE o.run_id = le.run_id
          AND o.seller_id = le.seller_id
          AND (
            (wi.delivery_id IS NOT NULL AND (
              o.checkout_configuration_id = (wi.raw_body::jsonb -> 'data' ->> 'checkout_configuration_id')
              OR o.id = (wi.raw_body::jsonb -> 'data' -> 'metadata' ->> 'order_id')
            ))
            OR (
              wi.delivery_id IS NULL AND be.detail ->> 'source' = 'provider_read'
              AND be.resource_type = 'payment' AND be.transition = 'succeeded'
              AND be.resource_id = le.provider_resource_id AND le.provider_resource_type = 'payment'
              AND be.effect_key = 'payment:' || be.resource_id || ':succeeded'
              AND le.kind IN ('payment','fee') AND le.provenance = 'sandbox' AND o.provenance = 'sandbox'
              AND o.id = be.detail ->> 'order_id'
              AND o.payment_id = be.resource_id
              AND o.checkout_configuration_id = be.detail ->> 'checkout_configuration_id'
              AND NOT EXISTS (SELECT 1 FROM orders other WHERE other.id <> o.id AND
                (other.payment_id = o.payment_id OR other.checkout_configuration_id = o.checkout_configuration_id))
            )
            OR (
              wi.delivery_id IS NOT NULL AND le.kind IN ('refund','refund_fee')
              AND o.payment_id = wi.raw_body::jsonb -> 'data' ->> 'payment_id'
              AND EXISTS (
                SELECT 1 FROM business_effects paid
                WHERE paid.effect_key = 'payment:' || o.payment_id || ':succeeded'
                  AND paid.resource_type = 'payment' AND paid.resource_id = o.payment_id AND paid.transition = 'succeeded'
                  AND paid.detail ->> 'source' = 'provider_read'
                  AND paid.detail ->> 'order_id' = o.id
                  AND paid.detail ->> 'checkout_configuration_id' = o.checkout_configuration_id
              )
              AND NOT EXISTS (SELECT 1 FROM orders other WHERE other.id <> o.id AND
                (other.payment_id = o.payment_id OR other.checkout_configuration_id = o.checkout_configuration_id))
            )
          )
        LIMIT 1
      ) ord ON true
      WHERE le.kind IN ('payment', 'fee', 'refund', 'refund_fee')
    ),
    refunded_orders AS (
      SELECT DISTINCT ro.order_id
      FROM resolved_orders ro
      JOIN ledger_entries le ON le.id = ro.ledger_entry_id
      WHERE le.kind IN ('refund', 'refund_fee') AND ro.order_id IS NOT NULL
    )
  `;
}

// entries: every ledger row joined to its seller and (when resolvable) its order, filtered by
// every criterion that doesn't depend on the derived status or the pagination cursor - those
// two are applied by the caller against this CTE's own output, since they need
// has_resolved_refund/kind (status) or occurred_at/id (cursor) already computed.
function entriesCte(baseFilter: SQL): SQL {
  return sql`
    entries AS (
      SELECT
        le.id,
        le.kind,
        le.provider_resource_id,
        le.status AS stored_status,
        le.amount_minor,
        le.currency,
        le.created_at,
        le.occurred_at,
        le.correlation_id,
        le.provenance,
        s.id AS seller_id,
        s.display_name,
        s.external_id,
        s.whop_account_id,
        s.sale_policy,
        ro.order_id,
        ro.order_gross_minor,
        ro.order_fee_minor,
        (ro.order_id IS NOT NULL AND ro.order_id IN (SELECT order_id FROM refunded_orders))
          AS has_resolved_refund
      FROM ledger_entries le
      JOIN sellers s ON s.id = le.seller_id
      LEFT JOIN resolved_orders ro ON ro.ledger_entry_id = le.id
      WHERE ${baseFilter}
    )
  `;
}

// A literal transcription of deriveAdminLedgerStatus's priority list - see the module
// comment above for why this duplication is safe.
const STATUS_EXPR = sql`(
  CASE
    WHEN entries.stored_status IS NOT NULL THEN entries.stored_status
    WHEN entries.kind = 'transfer' THEN 'settled'
    WHEN entries.kind = 'payout_pending' THEN 'pending'
    WHEN entries.kind = 'payout_in_transit' THEN 'settling'
    WHEN entries.kind = 'payout_completed' THEN 'paid_out'
    WHEN entries.kind = 'payout_failed' THEN 'failed'
    WHEN entries.kind = 'payout_canceled' THEN 'failed'
    WHEN entries.kind IN ('refund', 'refund_fee') THEN 'refunded'
    WHEN entries.kind IN ('payment', 'fee') THEN
      CASE WHEN entries.has_resolved_refund THEN 'refunded' ELSE 'settled' END
    ELSE 'pending'
  END
)`;

type BaseFilterQuery = Pick<
  AdminLedgerQuery,
  "q" | "type" | "sellerId" | "provenance" | "from" | "to" | "currency"
>;

function buildBaseFilter(query: BaseFilterQuery): SQL {
  const conditions: SQL[] = [sql`true`];
  if (query.q) {
    const pattern = `%${query.q}%`;
    conditions.push(sql`(
      le.provider_resource_id ILIKE ${pattern}
      OR COALESCE(s.display_name, s.external_id) ILIKE ${pattern}
      OR ro.order_id ILIKE ${pattern}
    )`);
  }
  if (query.type) {
    const kinds = TYPE_TO_KINDS[query.type];
    conditions.push(
      sql`le.kind IN (${sql.join(
        kinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})`,
    );
  }
  if (query.sellerId) conditions.push(sql`le.seller_id = ${query.sellerId}`);
  if (query.provenance) conditions.push(sql`le.provenance = ${query.provenance}`);
  if (query.from) conditions.push(sql`le.occurred_at >= ${query.from}`);
  if (query.to) conditions.push(sql`le.occurred_at <= ${query.to}`);
  if (query.currency) conditions.push(sql`le.currency = ${query.currency}`);
  return sql.join(conditions, sql` AND `);
}

type Cursor = { occurredAt: Date; id: number };

function encodeCursor(occurredAt: Date, id: number): string {
  return Buffer.from(JSON.stringify({ occurredAt: occurredAt.toISOString(), id })).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid admin ledger cursor");
  }
  const candidate = parsed as { occurredAt?: unknown; id?: unknown } | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.occurredAt !== "string" ||
    typeof candidate.id !== "number"
  )
    throw new Error("Invalid admin ledger cursor");
  const occurredAt = new Date(candidate.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) throw new Error("Invalid admin ledger cursor");
  return { occurredAt, id: candidate.id };
}

// db.execute()'s return type is generic over TQueryResult (an unresolved PgQueryResultHKT), so
// TypeScript cannot statically prove it carries `.rows` the way a concrete driver result does -
// only a specific driver's HKT (NeonHttpQueryResult, PgliteQueryResultHKT) resolves that. Both
// drivers this repo actually runs against (createDb()/createTestDb() in ../client.ts) do carry
// it, so this narrows the otherwise-opaque awaited result down to that shape with a runtime
// check, rather than asserting it away blind.
function extractRows<TRow>(result: unknown): TRow[] {
  if (
    typeof result !== "object" ||
    result === null ||
    !("rows" in result) ||
    !Array.isArray((result as { rows: unknown }).rows)
  )
    throw new Error("Expected the raw SQL result to expose a rows array");
  return (result as { rows: TRow[] }).rows;
}

function mapRow(row: AdminLedgerSqlRow): RawAdminLedgerEntry {
  const sellerIdResult = sellerId(row.seller_id);
  if (!sellerIdResult.ok) throw new Error("Invalid persisted seller id on an admin ledger row");
  let sellerAccount: WhopAccountId | null = null;
  if (row.whop_account_id !== null) {
    const accountResult = whopAccountId(row.whop_account_id);
    if (!accountResult.ok)
      throw new Error("Invalid persisted whop_account_id on an admin ledger row");
    sellerAccount = accountResult.value;
  }
  const seller: AdminLedgerSeller = {
    id: sellerIdResult.value,
    // display_name falls back to external_id; there is no persisted Whop-title-readback
    // column anywhere in schema.ts for a seller record, so that second fallback the build
    // brief mentions has nothing to read from yet - a gap flagged in the build report, not
    // fabricated here.
    name: row.display_name ?? row.external_id,
    whopAccountId: sellerAccount,
    salePolicy: row.sale_policy,
  };
  let resolvedOrderId: OrderId | null = null;
  if (row.order_id !== null) {
    const orderIdResult = orderId(row.order_id);
    if (!orderIdResult.ok) throw new Error("Invalid persisted order id on an admin ledger row");
    resolvedOrderId = orderIdResult.value;
  }
  return {
    id: String(row.id),
    seller,
    kind: row.kind,
    orderId: resolvedOrderId,
    providerResourceId: row.provider_resource_id,
    storedStatus: row.stored_status,
    hasResolvedRefund: row.has_resolved_refund,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    orderGrossMinor: row.order_gross_minor === null ? null : Number(row.order_gross_minor),
    orderFeeMinor: row.order_fee_minor === null ? null : Number(row.order_fee_minor),
    createdAt: new Date(row.created_at),
    occurredAt: new Date(row.occurred_at),
    correlationId: row.correlation_id,
    provenance: row.provenance,
  };
}

export function createAdminLedgerRepo<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
): AdminLedgerRepo {
  return {
    async query(query: AdminLedgerQuery): Promise<AdminLedgerQueryResult> {
      const limit = query.limit ?? DEFAULT_LIMIT;
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const baseFilter = buildBaseFilter(query);
      const outerConditions: SQL[] = [sql`true`];
      if (query.status) outerConditions.push(sql`${STATUS_EXPR} = ${query.status}`);
      if (cursor)
        outerConditions.push(
          sql`(entries.occurred_at, entries.id) < (${cursor.occurredAt}, ${cursor.id})`,
        );
      const outerFilter = sql.join(outerConditions, sql` AND `);
      const result = await db.execute<AdminLedgerSqlRow>(sql`
        WITH ${resolvedOrdersCte()}, ${entriesCte(baseFilter)}
        SELECT * FROM entries
        WHERE ${outerFilter}
        ORDER BY entries.occurred_at DESC, entries.id DESC
        LIMIT ${limit + 1}
      `);
      const allRows = extractRows<AdminLedgerSqlRow>(result);
      const hasMore = allRows.length > limit;
      const page = hasMore ? allRows.slice(0, limit) : allRows;
      const rows = page.map((row) => buildAdminLedgerRow(mapRow(row)));
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? encodeCursor(new Date(last.occurred_at), Number(last.id)) : null;
      return { rows, nextCursor };
    },
    async summarize(query): Promise<AdminLedgerSummary> {
      const baseFilter = buildBaseFilter(query);
      const outerConditions: SQL[] = [sql`true`];
      if (query.status) outerConditions.push(sql`${STATUS_EXPR} = ${query.status}`);
      const outerFilter = sql.join(outerConditions, sql` AND `);
      // Sums each matching row's own displayed gross/fee/net exactly as the list below it
      // would show them - not deduplicated across sibling rows sharing an order (a payment
      // and its fee both quote the same order's gross, and are both counted), since the
      // summary card totals the same rows the list renders, per currency, never combined
      // across currencies.
      type SummaryRow = {
        currency: Currency;
        gross: number | string;
        fee: number | string;
        net: number | string;
      };
      const result = await db.execute<SummaryRow>(sql`
        WITH ${resolvedOrdersCte()}, ${entriesCte(baseFilter)}
        SELECT
          entries.currency AS currency,
          SUM(COALESCE(entries.order_gross_minor, 0)) AS gross,
          SUM(COALESCE(entries.order_fee_minor, 0)) AS fee,
          SUM(entries.amount_minor) AS net
        FROM entries
        WHERE ${outerFilter}
        GROUP BY entries.currency
      `);
      const summary: AdminLedgerSummary = {};
      for (const row of extractRows<SummaryRow>(result)) {
        summary[row.currency] = {
          gross: Number(row.gross),
          fee: Number(row.fee),
          net: Number(row.net),
        };
      }
      return summary;
    },
  };
}

export async function getAdminLedgerEntry<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
  id: string,
): Promise<AdminLedgerEntryDetail | null> {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return null;

  const mainResult = await db.execute<AdminLedgerSqlRow>(sql`
    WITH ${resolvedOrdersCte()}, ${entriesCte(sql`true`)}
    SELECT * FROM entries WHERE entries.id = ${numericId} LIMIT 1
  `);
  const mainRow = extractRows<AdminLedgerSqlRow>(mainResult)[0];
  if (!mainRow) return null;
  const row = buildAdminLedgerRow(mapRow(mainRow));

  let order: AdminLedgerEntryDetail["order"] = null;
  let siblings: AdminLedgerRow[] = [];
  if (row.orderId) {
    const orderRows = await db.select().from(orders).where(eq(orders.id, row.orderId));
    const orderRow = orderRows[0];
    if (orderRow) {
      const gross = money(orderRow.grossMinor, orderRow.currency);
      const fee = money(orderRow.feeMinor, orderRow.currency);
      if (!gross.ok || !fee.ok)
        throw new Error("Invalid persisted order money on an admin ledger detail");
      order = {
        id: row.orderId,
        productTitle: orderRow.productTitle,
        gross: gross.value,
        fee: fee.value,
        status: orderRow.status,
      };
    }
    const siblingsResult = await db.execute<AdminLedgerSqlRow>(sql`
      WITH ${resolvedOrdersCte()}, ${entriesCte(sql`true`)}
      SELECT * FROM entries
      WHERE entries.order_id = ${row.orderId} AND entries.id != ${numericId}
      ORDER BY entries.occurred_at ASC, entries.id ASC
    `);
    siblings = extractRows<AdminLedgerSqlRow>(siblingsResult).map((sibling) =>
      buildAdminLedgerRow(mapRow(sibling)),
    );
  }

  const instrumentationEvents = row.correlationId
    ? await listInstrumentationEvents(db, { correlationId: row.correlationId })
    : [];

  return { row, order, siblings, instrumentationEvents };
}
