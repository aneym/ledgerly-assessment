import type { ReactNode } from "react";
import "./table.css";

/**
 * The page head. Title in Fraunces, one sentence, provenance on the right.
 * Never sticky; the rail or the bar carries location.
 */
export function PageHeader({
  title,
  lede,
  aside,
  size = "operator",
}: {
  title: ReactNode;
  lede?: ReactNode;
  aside?: ReactNode;
  /** Seller pages set the 40px title; operator pages keep 30px. */
  size?: "operator" | "seller";
}) {
  return (
    <div className={size === "seller" ? "tbl-pghead lg" : "tbl-pghead"}>
      <div>
        <h1>{title}</h1>
        {lede !== undefined && <p className="tbl-lede">{lede}</p>}
      </div>
      {aside !== undefined && <div className="tbl-aside">{aside}</div>}
    </div>
  );
}
