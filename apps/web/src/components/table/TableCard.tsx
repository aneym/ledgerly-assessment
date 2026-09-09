import type { CSSProperties, ReactNode } from "react";
import type { Density } from "./types";
import "./table.css";

/**
 * The sheet: white card, 1px line ring, zero padding, corners clipped. Owns the
 * toolbar (title, count, period, at most one tool), the foot bar (a ledger line)
 * and the note under the card. Children are <TableScroll><DataTable/></TableScroll>.
 */
export function TableCard({
  id,
  title,
  count,
  period,
  tools,
  density = "ledger",
  chrome,
  foot,
  note,
  children,
  className,
}: {
  /** The h2 id; the section's aria-labelledby target. */
  id: string;
  title: string;
  /** "24 rows match" */
  count?: ReactNode;
  /** "Aug 31 to Sep 08 · USD" */
  period?: ReactNode;
  /** At most one pill. */
  tools?: ReactNode;
  density?: Density;
  /** --tbl-chrome override in px: what the page keeps around a bounded region. */
  chrome?: number;
  foot?: { left: ReactNode; right?: ReactNode };
  /** One or two sentences under the card. The arithmetic sentence goes here. */
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const style =
    chrome === undefined ? undefined : ({ "--tbl-chrome": `${chrome}px` } as CSSProperties);
  const cls = ["tbl", density === "compact" ? "compact" : "", className].filter(Boolean).join(" ");
  return (
    <div className="tbl-wrap">
      <section className={cls} aria-labelledby={id} data-density={density} style={style}>
        <header className="tbl-bar">
          <h2 id={id}>{title}</h2>
          {count !== undefined && <span className="tbl-count">{count}</span>}
          {period !== undefined && <span className="tbl-period">{period}</span>}
          {tools !== undefined && <span className="tbl-bar-tools">{tools}</span>}
        </header>
        {children}
        {foot && (
          <footer className="tbl-foot">
            <span className="k">{foot.left}</span>
            <i className="lead" aria-hidden="true" />
            {foot.right !== undefined && <span className="v">{foot.right}</span>}
          </footer>
        )}
      </section>
      {note !== undefined && <p className="tbl-note">{note}</p>}
    </div>
  );
}
