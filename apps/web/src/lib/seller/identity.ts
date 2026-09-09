import { displaySeller } from "@/lib/catalog/display-name";
import type { Session } from "@/lib/session";

export const DEMO_SELLER_ID = "sel_onda";

/**
 * Fixture seller ids (`sel_*`) name catalog sellers for display only; no sellers row carries
 * one, so the app API is never called with one. Pages check this before any read.
 */
export function isFixtureSellerId(id: string): boolean {
  return /^sel_/.test(id);
}

/** True when a seller page may read the API for this identity. */
export function canReadSeller(identity: Pick<SellerIdentity, "id" | "source">): boolean {
  return identity.source !== "demo" && !isFixtureSellerId(identity.id);
}

/** A seller as the rail and pages need it; fixture sellers carry avatar and policy. */
export type SellerIdentity = {
  id: string;
  name: string;
  handle: string | null;
  avatar: string | null;
  city: string | null;
  salePolicy: "direct_charge" | "platform_charge_transfer" | "blocked_onboarding_incomplete" | null;
  /** How the id was chosen. "demo" shows the demo seller chip. */
  source: "session" | "param" | "demo";
};

export type FixtureSellerLike = {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  city: string;
  salePolicy: SellerIdentity["salePolicy"];
};

/** The seller the signed-in user owns, looked up server-side (lib/seller/owned.ts). */
export type OwnedSellerLike = { id: string; name: string };

/**
 * The session's own seller first, then the `seller` search param, then the demo seller.
 * A session alone does not name a seller: the user id is not the seller id, the
 * seller_owners mapping is, so the caller passes the owned seller it looked up.
 * Pure so the server layout, the client rail and the pages agree.
 */
export function resolveSellerIdentity(input: {
  session: Session | null;
  ownedSeller?: OwnedSellerLike | null;
  sellerParam: string | null | undefined;
  fixtures: FixtureSellerLike[];
}): SellerIdentity {
  const owned = input.session ? (input.ownedSeller ?? null) : null;
  const id = owned?.id ?? input.sellerParam?.trim() ?? "";
  const source: SellerIdentity["source"] = owned ? "session" : id ? "param" : "demo";
  const resolvedId = id || DEMO_SELLER_ID;
  const fixture = input.fixtures.find((s) => s.id === resolvedId);
  if (fixture) {
    return {
      id: fixture.id,
      name: fixture.name,
      handle: fixture.handle,
      avatar: fixture.avatar,
      city: fixture.city,
      salePolicy: fixture.salePolicy,
      source,
    };
  }
  // owned.name is the seller row's external id; a person sees the display identity for it
  // (fixtures/demo/display-names.json), never the external id.
  const shown = owned ? displaySeller({ id: resolvedId, external_id: owned.name }) : null;
  return {
    id: resolvedId,
    name: shown?.name ?? "New seller",
    handle: null,
    avatar: shown?.avatar ?? null,
    city: null,
    salePolicy: null,
    source,
  };
}

/** Keeps `?seller=` on rail links so a freshly created seller stays selected. */
export function sellerHref(path: string, identity: SellerIdentity): string {
  if (identity.source !== "param") return path;
  const url = new URL(path, "http://ledgerly.local");
  url.searchParams.set("seller", identity.id);
  return `${url.pathname}${url.search}`;
}

/** One initials rule for the whole app (lib/identity/mark). */
export { initialsOf as initials } from "@/lib/identity/mark";

/** One line for the earnings head. */
export function chargeModelSentence(policy: SellerIdentity["salePolicy"]): string {
  switch (policy) {
    case "direct_charge":
      return "Direct charge: refunds are handled by you.";
    case "platform_charge_transfer":
      return "Platform charge: Ledgerly collects, then transfers your share.";
    case "blocked_onboarding_incomplete":
      return "Not selling yet: finish Whop onboarding to receive sales.";
    default:
      return "Charge model is set once Whop onboarding completes.";
  }
}
