// GET /api/admin/ledger/[id]: one ledger row's full detail - the row itself, its linked
// order (when one resolved), every sibling ledger row that resolves to the same order, and
// the instrumentation events recorded under its correlation id. Operator-only (see
// ../authz.ts). packages/db/src/repos/admin-ledger.ts's getAdminLedgerEntry does the query;
// this route only wraps it and maps the result to the route's snake_case wire shape.
import type { AdminLedgerEntryDetail, AdminLedgerRow, InstrumentationEvent } from "@ledgerly/core";
import { getAdminLedgerEntry } from "@ledgerly/db";
import { instrumented } from "@/lib/instrument";
import { getServer } from "@/lib/server";
import { getSession } from "@/lib/session";
import { type OperatorAuthzDeps, requireOperator } from "../authz";
import { getRowScope, type LedgerScopeDeps, ledgerRowInScope } from "../scope";

export const runtime = "nodejs";

// Duplicated from ../route.ts rather than shared, the same way
// apps/web/src/app/api/admin/resolution/[id]/route.ts's serializeCase duplicates fields
// its list route also serializes: the two routes' wire shapes are allowed to drift (this one
// nests the row inside a detail envelope with order/siblings/instrumentation_events), so a
// shared helper would need to be generic over a difference that doesn't otherwise exist.
function serializeSeller(seller: AdminLedgerRow["seller"]) {
  return {
    id: seller.id,
    name: seller.name,
    whop_account_id: seller.whopAccountId,
    sale_policy: seller.salePolicy,
  };
}

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

function serializeOrder(order: AdminLedgerEntryDetail["order"]) {
  if (!order) return null;
  return {
    id: order.id,
    product_title: order.productTitle,
    gross: order.gross,
    fee: order.fee,
    status: order.status,
  };
}

function serializeInstrumentationEvent(event: InstrumentationEvent) {
  return {
    correlation_id: event.correlationId,
    ...(event.runId !== undefined ? { run_id: event.runId } : {}),
    source: event.source,
    phase: event.phase,
    ...(event.method !== undefined ? { method: event.method } : {}),
    path: event.path,
    status: event.status,
    ...(event.durationMs !== undefined ? { duration_ms: event.durationMs } : {}),
    provenance: event.provenance,
    safe_ids: event.safeIds,
    ...(event.gate ? { gate: event.gate } : {}),
    summary: event.summary,
    at: event.at.toISOString(),
  };
}

export type GetAdminLedgerEntryDeps = OperatorAuthzDeps &
  LedgerScopeDeps & {
    getEntry: (id: string) => Promise<AdminLedgerEntryDetail | null>;
  };

// Factored out from the exported GET so a test can supply a stubbed session and a
// PGlite-backed getEntry, mirroring
// apps/web/src/app/api/admin/resolution/[id]/route.ts's createGetResolutionCaseHandler.
export function createGetAdminLedgerEntryHandler(
  deps: GetAdminLedgerEntryDeps,
): (request: Request, id: string) => Promise<Response> {
  return async function handleGetAdminLedgerEntry(request: Request, id: string) {
    const authz = await requireOperator(deps, request);
    if (!authz.ok) return Response.json({ error: authz.error }, { status: authz.status });

    const detail = await deps.getEntry(id);
    if (!detail) return Response.json({ error: "not_found" }, { status: 404 });

    let siblings = detail.siblings;
    let instrumentationEvents = detail.instrumentationEvents;
    if (authz.scope.kind === "demo") {
      const { runId } = authz.scope;
      if (!(await ledgerRowInScope(deps, runId, detail.row)))
        return Response.json({ error: "demo_scope" }, { status: 403 });
      const allowed = await Promise.all(
        detail.siblings.map((row) => ledgerRowInScope(deps, runId, row)),
      );
      siblings = detail.siblings.filter((_, index) => allowed[index]);
      instrumentationEvents = detail.instrumentationEvents.filter((event) => event.runId === runId);
    }
    return Response.json({
      row: serializeRow(detail.row),
      order: serializeOrder(detail.order),
      siblings: siblings.map(serializeRow),
      instrumentation_events: instrumentationEvents.map(serializeInstrumentationEvent),
    });
  };
}

const handleGetAdminLedgerEntry = createGetAdminLedgerEntryHandler({
  getSession,
  getRowScope,
  getEntry: (id) => getAdminLedgerEntry(getServer().db, id),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return instrumented((req) => handleGetAdminLedgerEntry(req, id))(request);
}
