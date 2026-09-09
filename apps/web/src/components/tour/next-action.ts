import type {
  NextActionContext,
  NextActionKind,
} from "../../../../../packages/demo-runtime/src/react/tour-overlay";

/** No effects: previous visits never execute operations, and missing health never grants a session. */
export function nextAction(
  input: NextActionContext & {
    health: {
      operator_session: boolean;
      persona: boolean;
      profiles?: boolean;
      profile?: string | null;
    } | null;
    signingIn?: boolean;
    historyReady: boolean;
    awaitingProof?: boolean;
  },
): NextActionKind {
  if (!input.historyReady || input.awaitingProof) return "wait";
  if (input.viewing) return "navigate";
  if (input.done) return "finish";
  const step = input.step;
  if (!step || input.busy || input.signingIn || !input.health) return "wait";
  // Per-run sample profiles: every chapter runs as the profile its role names.
  if (input.health?.profiles) {
    const needed = profileForRole(step.step.role);
    if (needed && input.health.profile !== needed) return "re-session";
  } else if (["admin", "operator", "platform"].includes(step.step.role)) {
    if (!input.health) return "wait";
    if (!input.health.operator_session && input.health.persona) return "re-session";
  }
  if (step.status === "failed") return "retry";
  if (step.status === "blocked") return "wait";
  // Multi-action chapters remain observing between requests. Their next control is
  // derived from server proof, and busy/disabled controls prevent repeated writes.
  const continuation =
    step.step.expects.terminal &&
    ["C02", "C03", "C05", "C07"].includes(step.step.id) &&
    step.proof.request?.http_status !== null &&
    (step.proof.request?.http_status ?? 0) >= 200 &&
    (step.proof.request?.http_status ?? 0) < 300;
  if (step.status === "observing" && !continuation) return "wait";
  if (!input.anchorFound) return input.onThisScreen ? "wait" : "navigate";
  if (step.step.action.kind === "observe") return "wait";
  return step.step.action.kind === "type" ? "fill" : "act";
}

/** Which sample profile a chapter role runs as (dev-profiles lane). */
export function profileForRole(role: string): "buyer" | "seller" | "operator" | null {
  if (role === "buyer") return "buyer";
  if (role === "creator") return "seller";
  if (role === "admin" || role === "operator" || role === "platform") return "operator";
  return null;
}
