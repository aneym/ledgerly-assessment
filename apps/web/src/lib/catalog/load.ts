// Static JSON imports: the fixtures travel inside the bundle, so no disk read at request time
// and nothing for Vercel's function tracing to miss. Editing the JSON still hot-reloads in dev.
import catalogJson from "../../../../../fixtures/demo/catalog.json";
import sellersJson from "../../../../../fixtures/demo/sellers.json";
import type { CatalogFile, Product, Seller, SellersFile } from "./types";

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  DE: "Germany",
  BR: "Brazil",
  CA: "Canada",
  KR: "South Korea",
  PT: "Portugal",
};

/** Kept for callers that only need the repo-relative location of the fixtures. */
export function findFixturesDir(): string {
  return "fixtures/demo";
}

function readJson<T>(name: "catalog.json" | "sellers.json"): T {
  return (name === "catalog.json" ? catalogJson : sellersJson) as unknown as T;
}

function shortName(name: string, kind: "person" | "studio"): string {
  const words = name.split(" ");
  if (kind === "person") return words[0] ?? name;
  const rest = words.filter((w) => w !== "Studio");
  return rest[0] ?? name;
}

function toSeller(raw: SellersFile["sellers"][number]): Seller {
  const file = raw.avatar.split("/").at(-1) ?? "";
  return {
    id: raw.id,
    name: raw.name,
    shortName: shortName(raw.name, raw.kind),
    handle: raw.handle,
    kind: raw.kind,
    city: raw.city,
    country: raw.country,
    countryName: COUNTRY_NAMES[raw.country] ?? raw.country,
    bio: raw.bio,
    avatar: `/demo/${file}`,
    salePolicy: raw.sale_policy,
  };
}

function toProduct(raw: CatalogFile["products"][number]): Product {
  return {
    id: raw.id,
    slug: raw.slug,
    title: raw.title,
    subtitle: raw.subtitle,
    category: raw.category,
    sellerId: raw.seller_id,
    price: { amountMinor: raw.price.amount_minor, currency: raw.price.currency },
    description: raw.description,
    includes: raw.includes,
    rating: raw.rating,
    cover: raw.cover,
    releasedAt: raw.released_at,
    provenance: raw.provenance,
  };
}

type Catalog = {
  products: Product[];
  sellers: Seller[];
};

let cache: Catalog | null = null;

export function loadCatalog(): Catalog {
  if (cache) return cache;
  const sellers = readJson<SellersFile>("sellers.json").sellers.map(toSeller);
  const products = readJson<CatalogFile>("catalog.json").products.map(toProduct);
  cache = { products, sellers };
  return cache;
}

export function allProducts(): Product[] {
  return loadCatalog().products;
}

export function allSellers(): Seller[] {
  return loadCatalog().sellers;
}

export function productBySlug(slug: string): Product | null {
  return loadCatalog().products.find((p) => p.slug === slug) ?? null;
}

export function sellerById(id: string): Seller {
  const seller = loadCatalog().sellers.find((s) => s.id === id);
  if (!seller) throw new Error(`Unknown seller ${id}`);
  return seller;
}

export function sellerByHandle(handle: string): Seller | null {
  return loadCatalog().sellers.find((s) => s.handle === handle) ?? null;
}

export function productsBySeller(sellerId: string): Product[] {
  return loadCatalog().products.filter((p) => p.sellerId === sellerId);
}

export function canBuy(seller: Seller): boolean {
  return seller.salePolicy !== "blocked_onboarding_incomplete";
}

/** Plain-words policy for a creator page or a card hint. */
export function policySentence(seller: Seller): string {
  switch (seller.salePolicy) {
    case "direct_charge":
      return `Sells by direct charge. Refunds are handled by ${seller.shortName}.`;
    case "platform_charge_transfer":
      return `Ledgerly collects payment, then transfers ${seller.shortName}'s share.`;
    case "blocked_onboarding_incomplete":
      return "Not selling yet. Whop onboarding is incomplete.";
  }
}

export function policyLabel(seller: Seller): string {
  switch (seller.salePolicy) {
    case "direct_charge":
      return "Direct charge";
    case "platform_charge_transfer":
      return "Via Ledgerly";
    case "blocked_onboarding_incomplete":
      return "Onboarding";
  }
}
