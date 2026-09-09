import type { ReactNode } from "react";
import type { Tone } from "./types";

/**
 * The filled .chip from globals.css with its leading dot. In a table it is 20px
 * and the word folds to the dot under a 420px card; the inner span keeps the
 * word for screen readers and `title` keeps it for the pointer.
 */
export function StatusChip({
  tone = "plain",
  size = "card",
  title,
  children,
  className,
}: {
  tone?: Tone;
  size?: "table" | "card";
  /** Pointer title under the 420px fold. Defaults to the text when children is a string. */
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  const cls = ["chip", tone === "plain" ? "" : tone, className].filter(Boolean).join(" ");
  const hover = title ?? (typeof children === "string" ? children : undefined);
  if (size === "table") {
    return (
      <span className={cls} title={hover}>
        <span>{children}</span>
      </span>
    );
  }
  return <span className={cls}>{children}</span>;
}
