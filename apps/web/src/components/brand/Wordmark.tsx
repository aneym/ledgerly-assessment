import Link from "next/link";
import { Mark } from "./Mark";
import "./brand.css";

/**
 * Mark plus "Ledgerly" in Fraunces, one lockup for every surface.
 *
 * - nav: storefront header, mark 22 px beside 24 px text.
 * - seller: the creator rail, adds a "Creator" tag.
 * - operator: the operator app bar, adds an "Operator" tag (hidden under 720 px).
 * - footer: the storefront footer, muted until hover.
 *
 * The link's accessible name is its text ("Ledgerly", or "Ledgerly Creator" /
 * "Ledgerly Operator" on the app surfaces). The mark is aria-hidden.
 */
export type WordmarkVariant = "nav" | "seller" | "operator" | "footer";

const MARK_HEIGHT: Record<WordmarkVariant, number> = {
  nav: 22,
  seller: 20,
  operator: 18,
  footer: 16,
};

const TAG: Partial<Record<WordmarkVariant, string>> = {
  seller: "Creator",
  operator: "Operator",
};

export function Wordmark({
  variant,
  href = "/",
  className,
}: {
  variant: WordmarkVariant;
  href?: string;
  className?: string;
}) {
  const tag = TAG[variant];
  const classes = ["brand-wm", `brand-wm-${variant}`, className].filter(Boolean).join(" ");
  return (
    <Link className={classes} href={href}>
      <Mark height={MARK_HEIGHT[variant]} />
      <span>
        Ledger<em>ly</em>
      </span>
      {tag ? <span className="brand-wm-tag">{tag}</span> : null}
    </Link>
  );
}
