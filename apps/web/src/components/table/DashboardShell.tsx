import type { CSSProperties, ReactNode } from "react";
import { Announcer } from "./Announcer";
import "./table.css";

/**
 * A dashboard page's content: one announcer before the content, the --shell-top
 * every sticky element reads, and a vertical stack. The seller rail and the
 * operator bar stay as they are; this sits inside them.
 */
export function DashboardShell({
  shellTop,
  children,
  className,
}: {
  /** Height of the shell's sticky chrome in px. Omit to inherit (.op-root sets 56, the seller shell 0). */
  shellTop?: number;
  children: ReactNode;
  className?: string;
}) {
  const style =
    shellTop === undefined ? undefined : ({ "--shell-top": `${shellTop}px` } as CSSProperties);
  return (
    <Announcer>
      <div className={["tbl-shell", className].filter(Boolean).join(" ")} style={style}>
        {children}
      </div>
    </Announcer>
  );
}

/**
 * A table card beside its inspector. The 320px column exists only while the
 * inspector is passed and the viewport is 1024 or wider; below that the inspector
 * is a dialog and the card takes the full width.
 */
export function InspectorLayout({
  inspector,
  children,
}: {
  inspector?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={inspector ? "tbl-layout has-inspector" : "tbl-layout"}>
      {children}
      {inspector}
    </div>
  );
}
