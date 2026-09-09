import { feeSplit, formatMoney } from "@/lib/catalog/money";
import { productHref } from "@/lib/catalog/published";
import type { Product, Seller } from "@/lib/catalog/types";
import { BLURBS } from "./blurbs";
import type { FeaturedSlide } from "./types";

/** Server-side: flatten products and sellers into the plain slide shape the carousel takes. */
export function toFeaturedSlides(
  products: Product[],
  sellerOf: (sellerId: string) => Seller,
): FeaturedSlide[] {
  return products.map((p) => {
    const seller = sellerOf(p.sellerId);
    const split = feeSplit(p.price);
    return {
      slug: p.slug,
      href: productHref(p),
      artworkKey: p.artworkKey,
      title: p.title,
      category: p.category,
      cover: p.cover,
      price: formatMoney(split.gross),
      sellerShare: formatMoney(split.sellerShare),
      sellerName: seller.name,
      sellerShort: seller.shortName,
      city: seller.city,
      avatar: seller.avatar,
      blurb: BLURBS[p.artworkKey ?? p.slug] ?? p.subtitle,
    };
  });
}
