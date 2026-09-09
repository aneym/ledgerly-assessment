import { requestedDemoRuns, sellerInScope } from "@/lib/demo-scope";
// POST /api/admin/issues/demo-fault?kind=...: the demo fault injector
// (packages/core/src/services/resolution.ts's injectSimulatedFault), matching the
// marketplace issues contract exactly (see docs/lanes/architecture/admin-resolution-contract.md).
// Gated on DEMO_MODE, checked BEFORE the session — same order as
// apps/web/src/app/api/demo/events/route.ts, so a non-demo deployment returns 404
// (indistinguishable from a route that does not exist) rather than leaking a 401 that would
// confirm the endpoint exists. Only ever opens an issue labeled simulated: true and
// provenance "mock" (forced, not read from WHOP_MODE), and never posts a ledger effect — see
// injectSimulatedFault's own module comment. Returns the created issue's Issue JSON (same
// shape as the list/detail/action routes; see ../serialize.ts), whose history carries the
// "demo fault injected" entry injectSimulatedFault writes.
//
// `kind` is a query param per the contract, but only one fault kind exists today
// (injectSimulatedFault only knows how to withhold a confirmed payment's ledger effect —
// see its own module comment on why the ledger can't simulate the other two case kinds), so
// this route accepts `kind=missing_local_payment` or an omitted kind and rejects anything
// else. `seller_id`/`payment_id` still come from the body: `kind` alone can't say which
// seller or payment to fault. Surfaced as a judgment call, not silent — see the final report.
import {
  sellerId as parseSellerId,
  type SellerId,
} from "../../../../../../../../packages/core/src/ids";
import type { Seller } from "../../../../../../../../packages/core/src/services/ports";
import type {
  InjectFaultError,
  ResolutionAction,
  ResolutionCase,
} from "../../../../../../../../packages/core/src/services/resolution";
import { getAdminResolution } from "../../../../../lib/admin-resolution";
import type { DemoReadFaultInput } from "../../../../../lib/demo-resolution-provider";
import { instrumented, runIdFromRequest } from "../../../../../lib/instrument";
import { getSession } from "../../../../../lib/session";
import { type OperatorAuthzDeps, requireOperator } from "../authz";
import { serializeIssue } from "../serialize";

export const runtime = "nodejs";

type DemoFaultBody = Pick<
  DemoReadFaultInput,
  "sellerId" | "paymentId" | "fresh" | "providerOutcome"
>;

function parseBody(value: unknown): DemoFaultBody | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.seller_id !== "string" || !body.seller_id.trim()) return null;
  const paymentId = body.paymentId ?? body.payment_id;
  if (paymentId !== undefined && (typeof paymentId !== "string" || !paymentId.trim())) return null;
  if (body.fresh !== undefined && typeof body.fresh !== "boolean") return null;
  if (body.provider_outcome !== undefined && body.provider_outcome !== "uncertain") return null;
  const sellerId = parseSellerId(body.seller_id);
  if (!sellerId.ok) return null;
  return {
    sellerId: sellerId.value,
    paymentId: paymentId as string | undefined,
    fresh: body.fresh as boolean | undefined,
    ...(body.provider_outcome === "uncertain" ? { providerOutcome: "uncertain" as const } : {}),
  };
}

type InjectFaultResult =
  | { ok: true; value: ResolutionCase }
  | {
      ok: false;
      error: InjectFaultError;
    };

export type DemoFaultDeps = OperatorAuthzDeps & {
  isDemoMode: () => boolean;
  isDemoReadFaultEnabled?: () => boolean;
  injectFault: (input: DemoReadFaultInput & { paymentId: string }) => Promise<InjectFaultResult>;
  listActionsForCase: (caseId: string) => Promise<ResolutionAction[]>;
  getSeller: (id: SellerId) => Promise<Seller | null>;
  now: () => Date;
};

export function createDemoFaultHandler(
  deps: DemoFaultDeps,
): (request: Request) => Promise<Response> {
  return async function handleDemoFault(request: Request): Promise<Response> {
    if (!deps.isDemoMode()) return Response.json({ error: "not_found" }, { status: 404 });

    const authz = await requireOperator(deps, request);
    if (!authz.ok) return Response.json({ error: authz.error }, { status: authz.status });

    const kind = new URL(request.url).searchParams.get("kind");
    if (kind !== null && kind !== "missing_local_payment")
      return Response.json({ error: "unsupported_kind" }, { status: 400 });

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const body = parseBody(json);
    if (!body) return Response.json({ error: "invalid_body" }, { status: 400 });

    if (
      authz.scope.kind === "demo" &&
      !sellerInScope(authz.scope, await deps.getSeller(body.sellerId))
    )
      return Response.json({ error: "demo_scope" }, { status: 403 });

    const readFaultRuns = body.providerOutcome ? requestedDemoRuns(request) : null;
    const demoRunId = body.providerOutcome ? readFaultRuns?.[0] : runIdFromRequest(request);
    if (body.providerOutcome) {
      if (authz.scope.kind !== "operator")
        return Response.json({ error: "unauthorized" }, { status: 403 });
      if (!deps.isDemoReadFaultEnabled?.())
        return Response.json({ error: "read_fault_unavailable" }, { status: 400 });
      if (
        body.fresh !== true ||
        body.paymentId ||
        !demoRunId ||
        !readFaultRuns?.every((run) => run === demoRunId)
      )
        return Response.json({ error: "fresh_read_fault_required" }, { status: 400 });
    }
    if ((!body.paymentId || body.fresh) && !demoRunId)
      return Response.json(
        {
          error: "payment_required",
          message: "Provide a payment ID or a demo run ID for a fresh payment.",
        },
        { status: 400 },
      );
    const result = await deps.injectFault({
      sellerId: body.sellerId,
      // Keep the existing injected-dependency string contract. An empty ID
      // requests seeding, just like an omitted ID in the core service.
      paymentId: body.paymentId ?? "",
      ...(body.fresh === undefined ? {} : { fresh: body.fresh }),
      ...(demoRunId ? { runId: demoRunId } : {}),
      ...(body.providerOutcome ? { providerOutcome: body.providerOutcome } : {}),
      provenance: "mock",
    });
    if (!result.ok) {
      if (result.error.kind === "case_resolved")
        return Response.json(
          { error: "case_resolved", case_id: result.error.caseId },
          { status: 409 },
        );
      if (result.error.kind === "payment_required" || result.error.kind === "run_required")
        return Response.json(
          { error: result.error.kind, message: result.error.message },
          { status: 400 },
        );
      const errKind = result.error.kind;
      const status = errKind === "demo_mode_required" ? 404 : 422;
      return Response.json({ error: errKind }, { status });
    }

    const kase = result.value;
    const [actions, seller] = await Promise.all([
      deps.listActionsForCase(kase.id),
      kase.sellerId ? deps.getSeller(kase.sellerId) : Promise.resolve(null),
    ]);
    return Response.json(serializeIssue(kase, seller, actions, deps.now()), { status: 201 });
  };
}

const handleDemoFault = createDemoFaultHandler({
  getSession,
  isDemoMode: () => getAdminResolution().isDemoMode(),
  isDemoReadFaultEnabled: () => getAdminResolution().isDemoReadFaultEnabled(),
  injectFault: (input) => getAdminResolution().injectFault(input),
  listActionsForCase: (caseId) => getAdminResolution().listActionsForCase(caseId),
  getSeller: (id) => getAdminResolution().getSeller(id),
  now: () => getAdminResolution().clock.now(),
});

export const POST = instrumented(handleDemoFault);
