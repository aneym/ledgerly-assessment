import { getCommerce } from "@/lib/commerce";

/**
 * The seller a signed-in user owns, from the seller_owners mapping the seller create
 * route writes. No app API route answers "which seller is mine" yet, so this reads the
 * mapping directly; the display name is the seller row's external id. Server only.
 */
export type OwnedSeller = { id: string; name: string };

export async function ownedSeller(userId: string | null | undefined): Promise<OwnedSeller | null> {
  if (!userId) return null;
  try {
    const db = getCommerce().db;
    const owner = await db.query.sellerOwners.findFirst({
      columns: { sellerId: true },
      where: (t, { eq }) => eq(t.userId, userId),
    });
    if (!owner) return null;
    const seller = await db.query.sellers.findFirst({
      columns: { externalId: true },
      where: (t, { eq }) => eq(t.id, owner.sellerId),
    });
    return { id: owner.sellerId, name: seller?.externalId ?? "Your seller" };
  } catch (cause) {
    // A page never fails because the ownership lookup did; it falls back to the
    // `?seller=` param or the demo seller and the API readback says the rest.
    console.error("ownedSeller lookup failed", cause instanceof Error ? cause.message : cause);
    return null;
  }
}
