import { getRowScope, type LedgerScopeDeps, scopedLedgerPage } from "./scope";
// GET /api/admin/ledger: the marketplace admin's cross-business ledger, per the owner's
// requirement for a real, platform-wide ledger authoritative from stored records - never
// inferred cosmetically. Operator-only (401 otherwise, including a seller session; see
// ./authz.ts). The business rules (kind -> type mapping, status derivation, per-currency
// summary) live in packages/core/src/services/admin-ledger.ts; the SQL (filters, keyset
// pagination, the order-resolution join) lives in packages/db/src/repos/admin-ledger.ts.
// This route only parses the query string, wires the two together through listAdminLedger,
// and maps the result to the route's snake_case wire shape.

import type {
  AdminLedgerCurrencyTotals,
  AdminLedgerEntryStatus,
  AdminLedgerEntryType,
  AdminLedgerPage,
  AdminLedgerQuery,
  AdminLedgerRow,
  Currency,
} from "@ledgerly/core";
import { listAdminLedger, sellerId as parseSellerId } from "@ledgerly/core";
import { createAdminLedgerRepo } from "@ledgerly/db";
import { instrumented } from "@/lib/instrument";
import { getServer } from "@/lib/server";
import { getSession } from "@/lib/session";
import { type OperatorAuthzDeps, requireOperator } from "./authz";

export const runtime = "nodejs";

const TYPES = new Set<AdminLedgerEntryType>(["payment", "fee", "transfer", "refund", "payout"]);
const STATUSES = new Set<AdminLedgerEntryStatus>([
  "settling",
  "settled",
  "pending",
  "held",
  "refunded",
  "paid_out",
  "failed",
]);
const CURRENCIES = new Set<Currency>(["USD", "EUR", "BRL"]);

function parseDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Every enum-shaped filter (type, status, currency, seller_id, from/to) is validated and
// rejected with a 400 on a bad value, matching apps/web/src/app/api/admin/resolution/
// route.ts's own parseFilter. q, provenance, cursor and limit are passed through untouched:
// q/provenance/cursor just narrow the SQL to fewer or no rows on a typo, and limit already
// has a graceful default/clamp built into listAdminLedger, so there is no failure mode here
// worth a 400.
function parseQuery(url: URL): AdminLedgerQuery | null {
  const params = url.searchParams;

  const type = params.get("type");
  if (type !== null && !TYPES.has(type as AdminLedgerEntryType)) return null;
  const status = params.get("status");
  if (status !== null && !STATUSES.has(status as AdminLedgerEntryStatus)) return null;
  const currency = params.get("currency");
  if (currency !== null && !CURRENCIES.has(currency as Currency)) return null;

  const sellerIdParam = params.get("seller_id");
  let sellerId: AdminLedgerQuery["sellerId"];
  if (sellerIdParam !== null) {
    const parsed = parseSellerId(sellerIdParam);
    if (!parsed.ok) return null;
    sellerId = parsed.value;
  }

  const fromParam = params.get("from");
  let from: Date | undefined;
  if (fromParam !== null) {
    const parsed = parseDate(fromParam);
    if (!parsed) return null;
    from = parsed;
  }
  const toParam = params.get("to");
  let to: Date | undefined;
  if (toParam !== null) {
    const parsed = parseDate(toParam);
    if (!parsed) return null;
    to = parsed;
  }

  const limitParam = params.get("limit");
  const limit = limitParam !== null ? Number(limitParam) : undefined;
  const q = params.get("q");
  const provenance = params.get("provenance");
  const cursor = params.get("cursor");

  return {
    ...(q ? { q } : {}),
    ...(type ? { type: type as AdminLedgerEntryType } : {}),
    ...(status ? { status: status as AdminLedgerEntryStatus } : {}),
    ...(sellerId ? { sellerId } : {}),
    ...(provenance ? { provenance } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(currency ? { currency: currency as Currency } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function serializeSeller(seller: AdminLedgerRow["seller"]) {
  return {
    id: seller.id,
    name: seller.name,
    whop_account_id: seller.whopAccountId,
    sale_policy: seller.salePolicy,
  };
}

// gross/fee/net are quoted through unchanged as Money objects ({ amountMinor, currency }) or
// null - the same convention apps/web/src/app/api/admin/resolution/[id]/route.ts already uses
// for its own Money-shaped fields (expected/observed/diff). Only the row's own top-level keys
// are snake_cased, per the build brief's wire shape.
function serializeRow(row: AdminLedgerRow) {
  return {
    id: row.id,
    seller: serializeSeller(row.seller),
    type: row.type,
    order_id: row.orderId,
    provider_resource_id: row.providerResourceId,
    status: row.status,
    gross: row.gross,
    fee: row.fee,
    net: row.net,
    currency: row.currency,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    settled_at: row.settledAt ? row.settledAt.toISOString() : null,
    correlation_id: row.correlationId,
    provenance: row.provenance,
  };
}

export type ListAdminLedgerDeps = OperatorAuthzDeps &
  LedgerScopeDeps & {
    listLedger: (query: AdminLedgerQuery) => Promise<AdminLedgerPage>;
  };

// Factored out from the exported GET so a test can supply a stubbed session and a
// PGlite-backed listLedger, mirroring apps/web/src/app/api/demo/events/route.ts's
// createEventsHandler and apps/web/src/app/api/admin/resolution/route.ts's
// createListResolutionCasesHandler.
export function createListAdminLedgerHandler(
  deps: ListAdminLedgerDeps,
): (request: Request) => Promise<Response> {
  return async function handleListAdminLedger(request: Request): Promise<Response> {
    const authz = await requireOperator(deps, request);
    if (!authz.ok) return Response.json({ error: authz.error }, { status: authz.status });

    const query = parseQuery(new URL(request.url));
    if (!query) return Response.json({ error: "invalid_query" }, { status: 400 });

    const page =
      authz.scope.kind === "demo"
        ? await scopedLedgerPage(deps, authz.scope.runId, query)
        : await deps.listLedger(query);
    if (!page) return Response.json({ error: "invalid_query" }, { status: 400 });
    const summary: Record<string, AdminLedgerCurrencyTotals> = page.summary;
    return Response.json({
      rows: page.rows.map(serializeRow),
      next_cursor: page.nextCursor,
      summary,
    });
  };
}

export const GET = instrumented(
  createListAdminLedgerHandler({
    getSession,
    getRowScope,
    // Built lazily, at request time - not at module load, when env vars getServer() needs
    // may not be set yet (a build, or a test that only imports this module for its exported
    // handler factory). createAdminLedgerRepo itself does no I/O; it just closes over the db
    // handle, so building it fresh per request costs nothing extra.
    listLedger: (query) => listAdminLedger(createAdminLedgerRepo(getServer().db), query),
  }),
);
