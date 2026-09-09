export type DemoScope = { kind: "operator" } | { kind: "demo"; runId: string };

export type DemoScopedSession = { role: string; demoRunId?: string };

/** All caller selectors must agree; a header never overrides a conflicting cookie. */
export function requestedDemoRuns(request: Request): string[] | null {
  const runs: string[] = [];
  const header = request.headers.get("x-demo-run");
  if (header !== null) runs.push(header);
  try {
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
      const [name, ...value] = part.trim().split("=");
      if (name === "ledgerly_demo_run") runs.push(decodeURIComponent(value.join("=")));
    }
  } catch {
    return null;
  }
  return runs.every((run) => /^run_[A-Za-z0-9]{1,32}$/.test(run)) ? runs : null;
}

/** A run is an authenticated session attribute, never a caller-selected authorization. */
export function ownDemoRun(session: DemoScopedSession | null, request: Request): string | null {
  const run = session?.demoRunId;
  if (!run || !/^run_[A-Za-z0-9]{1,32}$/.test(run)) return null;
  const requested = requestedDemoRuns(request);
  return requested && requested.length > 0 && requested.every((value) => value === run)
    ? run
    : null;
}

/** Runtime authorization only. Never promotes the stored account role. */
export function demoScopeFor(
  session: DemoScopedSession | null,
  request: Request,
): DemoScope | null {
  if (session?.role === "operator") return { kind: "operator" };
  if (session?.role !== "demo") return null;
  const runId = ownDemoRun(session, request);
  return runId ? { kind: "demo", runId } : null;
}

export function sellerInScope(
  scope: DemoScope,
  seller: { runId: string } | null | undefined,
): boolean {
  return scope.kind === "operator" || seller?.runId === scope.runId;
}

export function filterSellers<T extends { runId: string }>(scope: DemoScope, sellers: T[]): T[] {
  return sellers.filter((seller) => sellerInScope(scope, seller));
}
