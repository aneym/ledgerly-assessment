import { sellerInScope } from "@/lib/demo-scope";
// GET /api/admin/issues/{id}: the issue detail view, matching the marketplace issues
// contract exactly (see docs/lanes/architecture/admin-resolution-contract.md). Returns the
// same nested Issue JSON shape ./route.ts's list view and the action route return (see
// ../serialize.ts). Operator-only (see ../authz.ts).
import type { SellerId } from "../../../../../../../../packages/core/src/ids";
import type { Seller } from "../../../../../../../../packages/core/src/services/ports";
import type {
  ResolutionAction,
  ResolutionCase,
} from "../../../../../../../../packages/core/src/services/resolution";
import { getAdminResolution } from "../../../../../lib/admin-resolution";
import { instrumented } from "../../../../../lib/instrument";
import { getSession } from "../../../../../lib/session";
import { type OperatorAuthzDeps, requireOperator } from "../authz";
import { serializeIssue } from "../serialize";

export const runtime = "nodejs";

export type GetIssueDeps = OperatorAuthzDeps & {
  getCase: (id: string) => Promise<ResolutionCase | null>;
  listActionsForCase: (caseId: string) => Promise<ResolutionAction[]>;
  getSeller: (id: SellerId) => Promise<Seller | null>;
  now: () => Date;
};

export function createGetIssueHandler(
  deps: GetIssueDeps,
): (request: Request, id: string) => Promise<Response> {
  return async function handleGetIssue(request: Request, id: string) {
    const authz = await requireOperator(deps, request);
    if (!authz.ok) return Response.json({ error: authz.error }, { status: authz.status });

    const kase = await deps.getCase(id);
    if (!kase) return Response.json({ error: "not_found" }, { status: 404 });

    const seller = kase.sellerId ? await deps.getSeller(kase.sellerId) : null;
    if (!sellerInScope(authz.scope, seller))
      return Response.json({ error: "demo_scope" }, { status: 403 });
    const actions = await deps.listActionsForCase(kase.id);

    return Response.json(serializeIssue(kase, seller, actions, deps.now()));
  };
}

const handleGetIssue = createGetIssueHandler({
  getSession,
  getCase: (id) => getAdminResolution().getCase(id),
  listActionsForCase: (caseId) => getAdminResolution().listActionsForCase(caseId),
  getSeller: (id) => getAdminResolution().getSeller(id),
  now: () => getAdminResolution().clock.now(),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return instrumented((req) => handleGetIssue(req, id))(request);
}
