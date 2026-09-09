import type { SVGProps } from "react";

/**
 * The Ledgerly mark as inline SVG. Same geometry as public/brand/ledgerly-mark.svg
 * (tight box 329 x 512, mark space). Inline so it takes `currentColor`, needs no
 * request and stays crisp at any device pixel ratio.
 *
 * Decorative by default: the wordmark text beside it carries the name.
 */

/** Outer silhouette: the L with the nib at top left and the folded corner at bottom right. */
const OUTER =
  "M0 0 L36 0 C112 0 152 32 152 82 L152 352 L304 352 A25 25 0 0 1 329 377 L329 388 L205 512 L82 512 A60 60 0 0 1 22 452 L22 44 C22 20 8 10 0 0 Z";

/** Reversed-out page: three rules joined by a right edge, both ends curling. */
const PAGE =
  "M52 380 L192 380 L192 497 A17 17 0 0 1 175 480 L175 476 L66 476 L58 468 C55 465 54 463 54 460 L175 460 L175 436 L52 436 L52 420 L175 420 L175 396 L52 396 Z";

/** Small-size page: two slabs, so the counter still reads under 40 px. */
const PAGE_SMALL =
  "M52 372 L196 372 L196 498 A18 18 0 0 1 178 480 L178 468 L52 468 L52 440 L178 440 L178 400 L52 400 Z";

export const MARK_ASPECT = 329 / 512;

type Props = {
  /** Rendered height in px. Width follows the mark's aspect. */
  height: number;
  /** "auto" picks the two-slab page under 40 px. */
  variant?: "auto" | "full" | "small";
} & Omit<SVGProps<SVGSVGElement>, "height" | "width" | "viewBox" | "children">;

export function Mark({ height, variant = "auto", ...rest }: Props) {
  const width = Math.round(height * MARK_ASPECT * 100) / 100;
  const page = variant === "full" || (variant === "auto" && height >= 40) ? PAGE : PAGE_SMALL;
  return (
    <svg
      viewBox="0 0 329 512"
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path fill="currentColor" fillRule="evenodd" d={`${OUTER} ${page}`} />
    </svg>
  );
}
