import { getSession } from "@/lib/session";
// GET /api/admin/assistant/health: lets the sidebar (and anyone debugging it) check
// whether the assistant is wired up without spending a model call. Reports which model id
// is configured and whether the gateway has credentials, never a credential value itself.
import { getAssistantModelId, isGatewayConfigured } from "../../../../../lib/assistant/model";
import { instrumented } from "../../../../../lib/instrument";
import { type OperatorAuthzDeps, requireOperator } from "../../issues/authz";

export const runtime = "nodejs";

export type AssistantHealthDeps = OperatorAuthzDeps & {
  getModel: () => string;
  isGatewayConfigured: () => boolean;
};

export function createAssistantHealthHandler(
  deps: AssistantHealthDeps,
): (request: Request) => Promise<Response> {
  return async function handleGet(request: Request): Promise<Response> {
    const authz = await requireOperator(deps, request);
    if (!authz.ok) return Response.json({ error: authz.error }, { status: authz.status });
    const configured = deps.isGatewayConfigured();
    return Response.json({
      ok: configured,
      model: deps.getModel(),
      gateway: "vercel-ai-gateway",
      configured,
    });
  };
}

const handleGet = createAssistantHealthHandler({
  getSession,
  getModel: getAssistantModelId,
  isGatewayConfigured,
});

export async function GET(request: Request) {
  return instrumented((req) => handleGet(req))(request);
}
