/** Plain, serializable slide data. The server page builds it; the client carousel renders it. */
export type FeaturedSlide = {
  slug: string;
  href?: string;
  artworkKey?: string;
  title: string;
  category: string;
  cover: { motif: string; tone: "light" | "dark" };
  /** "$25.00" */
  price: string;
  /** What the seller receives after the 8% fee, formatted. */
  sellerShare: string;
  sellerName: string;
  sellerShort: string;
  city: string;
  /** Public path under apps/web/public. */
  avatar: string;
  /** One sentence on what the creator built. */
  blurb: string;
};
