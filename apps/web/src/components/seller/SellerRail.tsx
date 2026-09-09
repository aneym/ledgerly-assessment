"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Wordmark } from "@/components/brand/Wordmark";
import { IdentityMark } from "@/components/identity-mark";
import { resolveMark } from "@/lib/identity/mark";
import {
  type FixtureSellerLike,
  type OwnedSellerLike,
  resolveSellerIdentity,
  sellerHref,
} from "@/lib/seller/identity";
import type { Session } from "@/lib/session";

const LINKS = [
  { label: "Overview", href: "/sell" },
  { label: "Products", href: "/sell/products" },
  { label: "Earnings", href: "/sell/earnings" },
  { label: "Payouts", href: "/sell/payouts" },
  { label: "Settings", href: "/sell/settings" },
] as const;

function isCurrent(pathname: string, href: string): boolean {
  if (href === "/sell") return pathname === "/sell" || pathname === "/sell/onboarding";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SellerRail({
  session,
  owned,
  fixtures,
}: {
  session: Session | null;
  /** The seller the session owns, from the server layout. */
  owned: OwnedSellerLike | null;
  fixtures: FixtureSellerLike[];
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const identity = resolveSellerIdentity({
    session,
    ownedSeller: owned,
    sellerParam: params.get("seller"),
    fixtures,
  });

  return (
    <aside className="sl-rail" aria-label="Seller">
      <div className="sl-rail-head">
        <Wordmark variant="seller" />

        <div className="flex min-w-0 items-center gap-3">
          <IdentityMark
            mark={resolveMark({
              id: identity.id,
              externalId: owned?.name,
              handle: identity.handle,
              name: identity.name,
              avatar: identity.avatar,
            })}
            size="md"
          />
          <div className="min-w-0">
            <div className="truncate text-[14px] leading-tight font-medium text-ink">
              {identity.name}
            </div>
            {identity.city || identity.handle ? (
              <div className="mt-0.5 truncate text-[12px] leading-tight text-muted">
                {identity.city ?? `@${identity.handle}`}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <nav className="sl-rail-nav" aria-label="Seller sections">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={sellerHref(link.href, identity)}
            className="sl-rail-link"
            aria-current={isCurrent(pathname, link.href) ? "page" : undefined}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <div className="sl-rail-foot">
        <Link
          href="/"
          className="text-muted underline decoration-line-strong underline-offset-[3px] hover:text-ink hover:decoration-ink"
        >
          Back to the store
        </Link>
      </div>
    </aside>
  );
}
