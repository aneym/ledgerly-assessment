import type { ReactNode } from "react";

type Props = {
  label: ReactNode;
  value: ReactNode;
  /** Total rows get ink rules above and below. */
  total?: boolean;
  /** Quiet values are regular weight in ink-2 (the fee line). */
  quiet?: boolean;
  /** Let a long value wrap onto a second line, right aligned. */
  wrap?: boolean;
  /** Small note between the leader and the value. */
  fine?: ReactNode;
  /** Replace the dotted leader with something else, for example a status chip. */
  leader?: ReactNode;
  className?: string;
};

/** The ledger line: label left, dotted leader, tabular value right. One device for every amount. */
export function LedgerLine({ label, value, total, quiet, wrap, fine, leader, className }: Props) {
  return (
    <div className={["ll", total ? "total" : "", className ?? ""].filter(Boolean).join(" ")}>
      <span className="k">{label}</span>
      {leader ?? <i className="lead" aria-hidden="true" />}
      {fine ? <span className="fine">{fine}</span> : null}
      <span className={["v", quiet ? "q" : "", wrap ? "wrap-ok" : ""].filter(Boolean).join(" ")}>
        {value}
      </span>
    </div>
  );
}

export function Ledger({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={["ledger", className].filter(Boolean).join(" ")}>{children}</div>;
}
