import { sellerInScope } from "@/lib/demo-scope";
// POST /api/admin/issues/{id}/actions/{refetch|import_confirmed|recheck|escalate}: the one
// place an operator changes an issue's state, matching the marketplace issues contract
// exactly (see docs/lanes/architecture/admin-resolution-contract.md). The action name is a
// URL path segment, not a body field. Idempotency is read from the Idempotency-Key header,
// falling back to a body `idempotency_key` field when the header is absent — every request
// must carry one either way (packages/core/src/services/resolution.ts's runAction claims it
// via resolution_actions' unique constraint before doing anything else), so a retried or
// double-submitted request returns the same action row instead of re-applying its effect.
// "recheck" never resolves an issue on the click alone: runAction re-runs reconcileSeller
// and only relabels the stored action "resolve" when the fresh report confirms the
// discrepancy is gone (see the contract doc). Returns the updated Issue JSON — the same
// shape the list and detail routes return (see ../../../serialize.ts) — not a
// {action, case} wrapper.
//
// "note" is accepted here too even though the contract's addendum lists only four action
// ids (refetch/import_confirmed/recheck/escalate): packages/core's own ALLOWED_ACTIONS
// permits "note" for every case kind as a free-text audit entry with no state transition,
// and the old actions route already exposed it. Kept rather than dropped silently —
// surfaced as a judgment call in the final report, not hidden.
import type { SellerId } from "../../../../../../../../../../packages/core/src/ids";
import type { Seller } from "../../../../../../../../../../packages/core/src/services/ports";
import type {
  ResolutionAction,
  ResolutionActionRequest,
  ResolutionCase,
  ResolutionCaseKind,
} from "../../../../../../../../../../packages/core/src/services/resolution";
import { getAdminResolution } from "../../../../../../../lib/admin-resolution";
import { instrumented } from "../../../../../../../lib/instrument";
import { getSession } from "../../../../../../../lib/session";
import { type OperatorAuthzDeps, requireOperator } from "../../../authz";
import { serializeIssue } from "../../../serialize";

export const runtime = "nodejs";

const ACTIONS = new Set<ResolutionActionRequest>([
  "refetch",
  "import_confirmed",
  "recheck",
  "escalate",
  "note",
]);

function isActionRequest(value: string): value is ResolutionActionRequest {
  return ACTIONS.has(value as ResolutionActionRequest);
}

type RunActionBody = { idempotencyKey?: string; note?: string };

function parseBody(value: unknown): RunActionBody | null {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.idempotency_key !== undefined && typeof body.idempotency_key !== "string") return null;
  if (body.note !== undefined && typeof body.note !== "string") return null;
  return {
    ...(typeof body.idempotency_key === "string" ? { idempotencyKey: body.idempotency_key } : {}),
    ...(typeof body.note === "string" ? { note: body.note } : {}),
  };
}

type RunActionResult = { action: ResolutionAction; case: ResolutionCase };
type RunActionError =
  | { kind: "case_not_found" }
  | { kind: "action_not_allowed"; action: ResolutionActionRequest; caseKind: ResolutionCaseKind }
  | { kind: "seller_not_connected" };

export type RunIssueActionDeps = OperatorAuthzDeps & {
  getCase?: (id: string) => Promise<ResolutionCase | null>;
  runAction: (
    input: {
      caseId: string;
      action: ResolutionActionRequest;
      idempotencyKey: string;
      actorUserId: string;
      note?: string;
    },
    operator?: boolean,
  ) => Promise<{ ok: true; value: RunActionResult } | { ok: false; error: RunActionError }>;
  listActionsForCase: (caseId: string) => Promise<ResolutionAction[]>;
  getSeller: (id: SellerId) => Promise<Seller | null>;
  now: () => Date;
};

export function createRunIssueActionHandler(
  deps: RunIssueActionDeps,
): (request: Request, id: string, action: string) => Promise<Response> {
  return async function handleRunIssueAction(request: Request, id: string, action: string) {
    const authz = await requireOperator(deps, request);
    if (!authz.ok) return Response.json({ error: authz.error }, { status: authz.status });

    if (!isActionRequest(action))
      return Response.json({ error: "unknown_action" }, { status: 404 });

    let json: unknown;
    try {
      json = request.headers.get("content-length") === "0" ? null : await request.json();
    } catch {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const body = parseBody(json);
    if (!body) return Response.json({ error: "invalid_body" }, { status: 400 });

    const idempotencyKey = request.headers.get("Idempotency-Key") ?? body.idempotencyKey;
    if (!idempotencyKey?.trim())
      return Response.json({ error: "missing_idempotency_key" }, { status: 400 });

    if (authz.scope.kind === "demo") {
      const kase = await deps.getCase?.(id);
      const seller = kase?.sellerId ? await deps.getSeller(kase.sellerId) : null;
      if (!sellerInScope(authz.scope, seller))
        return Response.json({ error: "demo_scope" }, { status: 403 });
    }
    const result = await deps.runAction(
      {
        caseId: id,
        action,
        idempotencyKey,
        actorUserId: authz.userId,
        ...(body.note !== undefined ? { note: body.note } : {}),
      },
      authz.scope.kind === "operator",
    );
    if (!result.ok) {
      const kind = result.error.kind;
      const status = kind === "case_not_found" ? 404 : kind === "action_not_allowed" ? 409 : 422;
      return Response.json({ error: kind }, { status });
    }

    const kase = result.value.case;
    const [actions, seller] = await Promise.all([
      deps.listActionsForCase(kase.id),
      kase.sellerId ? deps.getSeller(kase.sellerId) : Promise.resolve(null),
    ]);
    return Response.json(serializeIssue(kase, seller, actions, deps.now()));
  };
}

const handleRunIssueAction = createRunIssueActionHandler({
  getSession,
  getCase: (id) => getAdminResolution().getCase(id),
  runAction: async (input, operator) => {
    const admin = getAdminResolution();
    return admin.resolution.runAction(
      await admin.providerForCase(input.caseId, operator === true),
      input,
    );
  },
  listActionsForCase: (caseId) => getAdminResolution().listActionsForCase(caseId),
  getSeller: (id) => getAdminResolution().getSeller(id),
  now: () => getAdminResolution().clock.now(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await context.params;
  return instrumented((req) => handleRunIssueAction(req, id, action))(request);
}
