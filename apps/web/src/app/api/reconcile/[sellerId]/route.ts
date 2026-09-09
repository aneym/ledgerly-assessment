// POST /api/reconcile/{sellerId}: an operator runs detection for one seller
// (apps/web/src/components/operator/ledger-view.tsx's reconcile control), via the same
// detectResolutionCases code path POST /api/admin/issues/detect already uses for its
// single-seller mode - this route only fixes the seller to the path param and shapes the
// response as a ReconciliationRun (apps/web/src/lib/operator/types.ts) instead of that
// route's `{mode, cases}` body. `id` and `recorded_at` are synthesized here: detectResolution
// Cases returns the resolution cases it touched, not a "run" record of its own: no run
// concept is persisted anywhere yet, so this stands one up per call rather than leaving the
// contract's `id`/`recorded_at` fields unfillable. Flagged as a judgment call.
import {
  sellerId as parseSellerId,
  type SellerId,
} from "../../../../../../../packages/core/src/ids";
import type { ResolutionCase } from "../../../../../../../packages/core/src/services/resolution";
import { getAdminResolution } from "../../../../lib/admin-resolution";
import { instrumented } from "../../../../lib/instrument";
import { getSession } from "../../../../lib/session";
import { type OperatorAuthzDeps, requireOperator } from "../../admin/issues/authz";

export const runtime = "nodejs";

type DetectResult = { ok: true; value: ResolutionCase[] } | { ok: false; error: { kind: string } };

export type ReconcileSellerDeps = OperatorAuthzDeps & {
  detectForSeller: (sellerId: SellerId, provenance: string) => Promise<DetectResult>;
  provenance: () => string;
  newRunId: () => string;
  now: () => Date;
};

export function createReconcileSellerHandler(
  deps: ReconcileSellerDeps,
): (request: Request, sellerId: string) => Promise<Response> {
  return async function handleReconcileSeller(_request: Request, sellerIdParam: string) {
    const authz = await requireOperator(deps);
    if (!authz.ok) return Response.json({ error: "unauthorized" }, { status: authz.status });

    const parsed = parseSellerId(sellerIdParam);
    if (!parsed.ok) return Response.json({ error: "invalid_seller_id" }, { status: 400 });

    const provenance = deps.provenance();
    const result = await deps.detectForSeller(parsed.value, provenance);
    if (!result.ok) {
      const status = result.error.kind === "seller_not_connected" ? 422 : 502;
      return Response.json({ error: result.error.kind }, { status });
    }

    return Response.json({
      id: deps.newRunId(),
      seller_id: sellerIdParam,
      recorded_at: deps.now().toISOString(),
      provenance,
      issue_ids: result.value.map((kase) => kase.id),
    });
  };
}

const handleReconcileSeller = createReconcileSellerHandler({
  getSession,
  detectForSeller: (sellerIdValue, provenance) =>
    getAdminResolution().resolution.detectResolutionCases({
      sellerId: sellerIdValue,
      provider: getAdminResolution().provider,
      provenance,
    }),
  provenance: () => process.env.WHOP_MODE ?? "mock",
  newRunId: () => `run_${crypto.randomUUID()}`,
  now: () => new Date(),
});

export async function POST(request: Request, context: { params: Promise<{ sellerId: string }> }) {
  const { sellerId } = await context.params;
  return instrumented((req) => handleReconcileSeller(req, sellerId))(request);
}
