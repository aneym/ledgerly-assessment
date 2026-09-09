import type { PublicCatalogRow } from "../../../../../packages/db/src/repos/public-catalog";
import { loadCatalog } from "./load";
import type { Product, Seller } from "./types";

export type PublicCatalog = {
  products: Product[];
  sellers: Seller[];
  source: "fixture" | "database";
};
export function fixtureCatalog(): PublicCatalog {
  return { ...loadCatalog(), source: "fixture" };
}

/** Fixture artwork stays available only for the same persisted seller and slug. */
export function projectCatalog(rows: PublicCatalogRow[]): PublicCatalog {
  const fixtures = loadCatalog();
  const sellers = new Map<string, Seller>();
  const products = rows.map((row): Product => {
    const exampleSeller = fixtures.sellers.find((s) => s.id === row.sellerId);
    const example = fixtures.products.find(
      (p) => p.sellerId === row.sellerId && p.slug === row.slug,
    );
    const name = row.sellerName?.trim() || exampleSeller?.name || "Independent seller";
    sellers.set(row.sellerId, {
      id: row.sellerId,
      name,
      shortName: name,
      handle: exampleSeller?.handle ?? row.sellerId,
      kind: exampleSeller?.kind ?? "person",
      city: exampleSeller?.city ?? "",
      country: row.country,
      countryName: exampleSeller?.countryName ?? row.country,
      bio: exampleSeller?.bio ?? "",
      avatar: exampleSeller?.avatar ?? "",
      salePolicy:
        row.sellerStatus !== "active" || (row.salePolicy === "direct" && !row.accountReady)
          ? "blocked_onboarding_incomplete"
          : row.salePolicy === "direct"
            ? "direct_charge"
            : "platform_charge_transfer",
    });
    return {
      id: row.id,
      sellerId: row.sellerId,
      slug: row.slug,
      publicKey: example?.slug ?? row.id,
      artworkKey: example?.slug ?? "",
      title: row.title,
      subtitle: row.subtitle ?? "",
      category: row.category,
      price: { amountMinor: row.priceMinor, currency: row.currency },
      description: row.description ? [row.description] : [],
      includes: [],
      rating: { avg: 0, count: 0 },
      cover: example?.cover ?? { motif: "No cover uploaded", tone: "light" },
      releasedAt: row.createdAt.toISOString(),
      provenance: "catalog",
    };
  });
  return { products, sellers: [...sellers.values()], source: "database" };
}

export function findPublicProduct(catalog: PublicCatalog, key: string): Product | null {
  // Immutable IDs cannot be confused by seller-scoped title collisions.
  const byId = catalog.products.find((p) => p.id === key);
  if (byId) return byId;
  const fixture = loadCatalog().products.find((p) => p.slug === key);
  if (fixture)
    return catalog.products.find((p) => p.sellerId === fixture.sellerId && p.slug === key) ?? null;
  const matches = catalog.products.filter((p) => p.slug === key);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
export function findPublicSeller(catalog: PublicCatalog, key: string): Seller | null {
  return catalog.sellers.find((s) => s.id === key || s.handle === key) ?? null;
}
export function productKey(product: Product): string {
  return product.publicKey ?? product.slug;
}
export function productHref(product: Product): string {
  return `/p/${encodeURIComponent(productKey(product))}`;
}
export function hasPersistentCatalog(env: Record<string, string | undefined>): boolean {
  return (
    env.LEDGERLY_LOCAL_RUNTIME !== undefined ||
    Boolean(env.DATABASE_URL) ||
    env.WHOP_MODE === "sandbox" ||
    env.WHOP_MODE === "hybrid"
  );
}

/** Resolve the purchase before authentication so a foreign seller query cannot alter it. */
export function checkoutProduct(
  catalog: PublicCatalog,
  key: string | null,
  sellerId: string | null,
): Product | null {
  const product = key ? findPublicProduct(catalog, key) : null;
  return product && (!sellerId || sellerId === product.sellerId) ? product : null;
}

export function catalogSeller(sellers: Seller[], id: string): Seller {
  const seller = sellers.find((s) => s.id === id);
  if (!seller) throw new Error("Catalog product has no public seller");
  return seller;
}
