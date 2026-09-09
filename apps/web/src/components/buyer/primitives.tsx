/**
 * Small pieces the buyer screens need on top of the shared primitives in
 * src/components: a status chip, an external-link pill, an arrow icon and an
 * avatar fallback for sellers the catalog does not know. All use the shared
 * class vocabulary from globals.css.
 */

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { IdentityMark } from "@/components/identity-mark";
import type { ChipTone } from "@/lib/buyer/format";
import { resolveMark } from "@/lib/identity/mark";

export function Chip({
  tone = "plain",
  code,
  children,
  className,
  ...rest
}: { tone?: ChipTone; code?: boolean } & ComponentPropsWithoutRef<"span">) {
  const classes = ["chip", tone === "plain" ? "" : tone, code ? "by-code" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  );
}

/** A pill that opens a provider-hosted page in a new tab. */
export function ExternalPill({
  href,
  tone = "buy",
  size = "md",
  children,
  ...rest
}: {
  href: string;
  tone?: "buy" | "ink" | "ghost";
  size?: "sm" | "md" | "lg";
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"a">, "href" | "children" | "className">) {
  const classes = ["pill", tone, size === "md" ? "" : size].filter(Boolean).join(" ");
  return (
    <a href={href} className={classes} target="_blank" rel="noreferrer noopener" {...rest}>
      {children}
    </a>
  );
}

export function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 8h10M9 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Byline for a seller the order names but the catalog join did not find: the canonical
 * mark for that identity (a portrait when the name or handle is known, initials otherwise).
 */
export function BylineFallback({
  name,
  id,
  handle,
  city,
  size = "xs",
}: {
  name: string;
  id?: string | null;
  handle?: string | null;
  city?: string | null;
  size?: "xs" | "sm";
}) {
  const mark = resolveMark({ id, handle, name });
  return (
    <div className="byline">
      <IdentityMark mark={mark} size={size} />
      <span className="who">{name}</span>
      {city ? <span className="loc">{city}</span> : null}
    </div>
  );
}
