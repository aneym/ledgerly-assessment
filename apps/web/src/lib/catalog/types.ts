import type { Currency, Money } from "../../../../../packages/core/src/money";

export type Provenance = "mock" | "sandbox" | "live" | "catalog";

export type FixtureSalePolicy =
  | "direct_charge"
  | "platform_charge_transfer"
  | "blocked_onboarding_incomplete";

export type Category =
  | "Photography"
  | "Typography"
  | "Audio"
  | "Templates"
  | "Writing"
  | "3D"
  | "Productivity"
  | "Music";

export const CATEGORIES: readonly Category[] = [
  "Photography",
  "Typography",
  "Audio",
  "Templates",
  "Writing",
  "3D",
  "Productivity",
  "Music",
];

export type Seller = {
  id: string;
  name: string;
  /** First name for a person, studio name without the word "Studio" for a studio. */
  shortName: string;
  handle: string;
  kind: "person" | "studio";
  city: string;
  country: string;
  countryName: string;
  bio: string;
  /** Public path under apps/web/public. */
  avatar: string;
  salePolicy: FixtureSalePolicy;
};

export type IncludedItem = { label: string; value: string };

export type Product = {
  id: string;
  slug: string;
  /** Collision-safe public URL token; slug remains the seller-scoped checkout key. */
  publicKey?: string;
  artworkKey?: string;
  title: string;
  subtitle: string;
  category: string;
  sellerId: string;
  price: Money;
  description: string[];
  includes: IncludedItem[];
  rating: { avg: number; count: number };
  cover: { motif: string; tone: "light" | "dark" };
  releasedAt: string;
  provenance: Provenance;
};

/** Raw shapes as written in fixtures/demo. */
export type SellersFile = {
  sellers: Array<{
    id: string;
    name: string;
    handle: string;
    kind: "person" | "studio";
    city: string;
    country: string;
    bio: string;
    avatar: string;
    sale_policy: FixtureSalePolicy;
  }>;
};

export type CatalogFile = {
  products: Array<{
    id: string;
    slug: string;
    title: string;
    subtitle: string;
    category: Category;
    seller_id: string;
    price: { amount_minor: number; currency: Currency };
    description: string[];
    includes: IncludedItem[];
    rating: { avg: number; count: number };
    cover: { motif: string; tone: "light" | "dark" };
    released_at: string;
    provenance: Provenance;
  }>;
};
