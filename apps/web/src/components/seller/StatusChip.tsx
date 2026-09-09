import type { ReactNode } from "react";

export type ChipTone = "ok" | "warn" | "bad" | "plain" | "line";

/** The shared .chip from globals.css with its leading dot. */
export function StatusChip({
  tone = "plain",
  children,
  className,
}: {
  tone?: ChipTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={["chip", tone === "plain" ? "" : tone, className].filter(Boolean).join(" ")}>
      {children}
    </span>
  );
}

/** Capability dot: ok, warn or bad, with a soft halo in the same hue. */
export function Dot({ tone }: { tone: "ok" | "warn" | "bad" }) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-bad";
  return <span aria-hidden="true" className={`sl-dot ${color}`} />;
}
