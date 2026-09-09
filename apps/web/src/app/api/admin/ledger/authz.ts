import { type OperatorAuthzDeps, requireOperator as requireScopedOperator } from "../issues/authz";

export type { OperatorAuthzDeps };

// Preserve the ledger routes' historical 401 for ordinary non-operator sessions.
export async function requireOperator(deps: OperatorAuthzDeps, request?: Request) {
  const result = await requireScopedOperator(deps, request);
  return !result.ok && result.error !== "demo_scope" ? { ...result, status: 401 as const } : result;
}
