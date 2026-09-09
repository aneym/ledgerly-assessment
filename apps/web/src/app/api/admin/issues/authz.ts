import { type DemoScope, demoScopeFor } from "@/lib/demo-scope";

export type OperatorAuthzDeps = {
  getSession: () => Promise<{ userId: string; role: string } | null>;
};

// Callers accepting demo sessions must pass the request and enforce the returned scope.
// Callers that have not adopted scoped access remain operator-only.
export async function requireOperator(
  deps: OperatorAuthzDeps,
  request?: Request,
): Promise<
  | { ok: true; userId: string; scope: DemoScope }
  | { ok: false; status: 401 | 403; error: "unauthorized" | "demo_scope" }
> {
  const session = await deps.getSession();
  if (!session) return { ok: false, status: 401, error: "unauthorized" };
  const scope = request
    ? demoScopeFor(session, request)
    : session.role === "operator"
      ? { kind: "operator" as const }
      : null;
  if (!scope)
    return {
      ok: false,
      status: 403,
      error: session.role === "demo" ? "demo_scope" : "unauthorized",
    };
  return { ok: true, userId: session.userId, scope };
}
