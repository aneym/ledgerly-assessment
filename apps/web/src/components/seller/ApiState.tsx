import type { ReactNode } from "react";
import { type ApiFail, describeFailure, isNotLive } from "@/lib/seller/api";

/**
 * Calm inline state for a route that is not live yet. Names method, path and status.
 * Never dressed up as success. The correlation id sits in the title attribute; the dev
 * panel prints it in full.
 */
export function NotLive({ fail, children }: { fail: ApiFail; children?: ReactNode }) {
  const text =
    fail.kind === "network"
      ? "Could not reach the app API. The screen shows what it has; nothing was sent or confirmed."
      : fail.kind === "unexpected"
        ? "The route answered, but not with the JSON shape this screen expects. Nothing here is a result."
        : isNotLive(fail)
          ? "This route is not live yet. The screen shows what it has; nothing here is a result."
          : (fail.reason ?? "The request did not succeed.");
  return (
    <div
      role="status"
      className="flex flex-col gap-1.5 rounded-in bg-plate/70 px-4 py-3 text-[13px] leading-relaxed text-ink-2 shadow-[inset_0_0_0_1px_rgba(38,37,31,0.06)]"
      data-fail-kind={fail.kind}
      data-correlation={fail.correlationId}
      title={`correlation ${fail.correlationId}`}
    >
      <div className="font-mono text-[12px] text-ink">{describeFailure(fail)}</div>
      <div>
        {text}
        {children ? <> {children}</> : null}
      </div>
    </div>
  );
}

/** Loading line. The visible text is plain; method and path stay in the title attribute. */
export function Reading({
  method,
  path,
  label = "Reading your account",
}: {
  method: string;
  path: string;
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-in bg-plate/50 px-4 py-3 text-[13px] text-muted"
      title={`${method} ${path}`}
    >
      <span className="size-2 flex-none animate-pulse rounded-full bg-line-strong motion-reduce:animate-none" />
      {label}
    </div>
  );
}
