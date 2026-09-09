import { allSellers } from "@/lib/catalog";
import { getSession } from "@/lib/session";
import { type FixtureSellerLike, resolveSellerIdentity, type SellerIdentity } from "./identity";
import { ownedSeller } from "./owned";

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Fixture sellers in the shape the rail and identity resolver need. */
export function fixtureSellers(): FixtureSellerLike[] {
  return allSellers().map((s) => ({
    id: s.id,
    name: s.name,
    handle: s.handle,
    avatar: s.avatar,
    city: s.city,
    salePolicy: s.salePolicy,
  }));
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Server-side identity for a seller page: the session's own seller, then `?seller=`, then the demo seller. */
export async function currentSeller(searchParams: SearchParams): Promise<SellerIdentity> {
  const [session, params] = await Promise.all([getSession(), searchParams]);
  const owned = await ownedSeller(session?.userId);
  return resolveSellerIdentity({
    session,
    ownedSeller: owned,
    sellerParam: first(params.seller),
    fixtures: fixtureSellers(),
  });
}

export async function correlationParam(searchParams: SearchParams): Promise<string | null> {
  const params = await searchParams;
  return first(params.correlationId);
}
