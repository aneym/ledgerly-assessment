import type { OrderView, SalePolicy } from "@/lib/buyer/api";
import { allProducts, allSellers, type Product, type Seller } from "@/lib/catalog";

/**
 * Joins an order payload to the fixture catalog so the screens can draw the
 * real cover and avatar. Anything the API sends wins over the fixture; the
 * fixture only fills what the payload leaves out after identity is confirmed.
 */

export type SellerDisplay = {
  /** The catalog seller when the order names one; null for an unknown seller. */
  fixture: Seller | null;
  name: string;
  shortName: string;
  city: string | null;
  handle: string | null;
  salePolicy: SalePolicy | null;
  shopHref: string | null;
};

function shortNameOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 && !/\b(studio|sounds|type|foundry|labs?)\b/i.test(name)
    ? (parts[0] ?? name)
    : name;
}

export function resolveSeller(seller: OrderView["seller"]): SellerDisplay {
  const fixture =
    allSellers().find((candidate) =>
      seller.id !== null
        ? candidate.id === seller.id
        : seller.handle !== null && candidate.handle === seller.handle,
    ) ?? null;
  const name = seller.name !== "Seller" ? seller.name : (fixture?.name ?? "Seller");
  const handle = seller.handle ?? fixture?.handle ?? null;
  const fixturePolicy: SalePolicy | null =
    fixture?.salePolicy === "direct_charge" || fixture?.salePolicy === "platform_charge_transfer"
      ? fixture.salePolicy
      : null;
  return {
    fixture,
    name,
    shortName: fixture && fixture.name === name ? fixture.shortName : shortNameOf(name),
    city: seller.city ?? fixture?.city ?? null,
    handle,
    salePolicy: seller.salePolicy ?? fixturePolicy,
    shopHref: handle ? `/c/${handle}` : null,
  };
}

export type CoverProduct = Pick<Product, "slug" | "title" | "cover" | "artworkKey">;

/**
 * Fixture art requires matching immutable product and seller ids.
 * A shared title or slug cannot establish ownership of another product's artwork.
 */
export function resolveCover(product: OrderView["product"]): CoverProduct {
  const fixture = allProducts().find(
    (candidate) => candidate.id === product.id && candidate.sellerId === product.sellerId,
  );
  return {
    slug: product.slug ?? product.id ?? "unknown",
    title: product.title,
    // An explicit empty key prevents ProductCover's legacy slug fallback.
    artworkKey: fixture?.slug ?? "",
    cover: fixture?.cover ?? { motif: "no cover on file", tone: "dark" },
  };
}
