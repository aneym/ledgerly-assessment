/**
 * State machine for the embedded checkout mount, kept pure so the rules can be tested
 * without a browser: which surface to show (the real Whop embed, the explicit hosted
 * fallback, or the labelled simulation), when the fallback may appear, and how the
 * completion callback stays idempotent while the order's paid status comes only from the
 * server (the webhook path writes it; this file never marks anything paid).
 */

export type EmbedSurface = "embed" | "simulation" | "unavailable";

export type EmbedPhase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "payment_error"; message: string; code: string | null }
  | { kind: "mount_failed"; reason: string }
  | { kind: "completed"; receiptId: string | null; completions: number }
  | { kind: "confirmed"; receiptId: string | null };

export type EmbedEvent =
  | { type: "state"; state: "loading" | "ready" | "disabled" }
  | { type: "complete"; receiptId: string | null }
  | { type: "payment_error"; message: string; code: string | null }
  | { type: "load_error"; reason: string }
  | { type: "timeout" }
  | { type: "order_read"; status: string };

/** How long the embed may stay in `loading` before the hosted fallback is offered. */
export const MOUNT_TIMEOUT_MS = 20_000;
/** Poll cadence and ceiling for the post-completion order read. */
export const CONFIRM_POLL_MS = 2_000;
export const CONFIRM_POLL_LIMIT = 45;

const PAID = new Set(["paid", "succeeded", "completed", "complete", "settled"]);
export const isPaidStatus = (status: string): boolean => PAID.has(status.toLowerCase());

/**
 * Which surface the checkout page mounts. Only a provider-issued checkout configuration can
 * back the real embed; a mock-provenance order (fixture mode, or the hybrid adapter's mock
 * route) gets the labelled simulation instead, never a pretend iframe.
 */
export function chooseSurface(order: {
  provenance: string;
  checkoutConfigurationId: string | null;
  purchaseUrl: string | null;
}): EmbedSurface {
  const mockUrl = !!order.purchaseUrl && /^https?:\/\/mock\.invalid\//i.test(order.purchaseUrl);
  if (order.provenance === "mock" || mockUrl) return "simulation";
  if (order.checkoutConfigurationId) return "embed";
  return "unavailable";
}

export function reduce(phase: EmbedPhase, event: EmbedEvent): EmbedPhase {
  switch (event.type) {
    case "state":
      // Once the embed reported ready, later loading/disabled flickers (submit in flight)
      // are not mount failures; and nothing moves a completed checkout backwards.
      if (phase.kind === "completed" || phase.kind === "confirmed") return phase;
      if (event.state === "ready") return { kind: "ready" };
      if (phase.kind === "loading" && event.state === "loading") return phase;
      return phase;
    case "complete": {
      // Idempotent: a second completion callback for the same mount is counted, not acted on.
      if (phase.kind === "confirmed") return phase;
      if (phase.kind === "completed")
        return {
          ...phase,
          completions: phase.completions + 1,
          receiptId: phase.receiptId ?? event.receiptId,
        };
      return { kind: "completed", receiptId: event.receiptId, completions: 1 };
    }
    case "payment_error":
      if (phase.kind === "completed" || phase.kind === "confirmed") return phase;
      return { kind: "payment_error", message: event.message, code: event.code };
    case "load_error":
      if (phase.kind === "completed" || phase.kind === "confirmed") return phase;
      return { kind: "mount_failed", reason: event.reason };
    case "timeout":
      // The fallback is offered only when the embed never became ready.
      return phase.kind === "loading" ? { kind: "mount_failed", reason: "timeout" } : phase;
    case "order_read":
      // The server's word is the only thing that confirms payment.
      if (phase.kind === "completed" && isPaidStatus(event.status))
        return { kind: "confirmed", receiptId: phase.receiptId };
      return phase;
  }
}

/** The explicit hosted fallback is offered only after the embed failed to mount. */
export const offersHostedFallback = (phase: EmbedPhase): boolean => phase.kind === "mount_failed";
