import Link from "next/link";
import { CreatorCard } from "@/components/creator-card";
import { FeaturedCarousel, toFeaturedSlides } from "@/components/featured";
import { ProductCard } from "@/components/product-card";
import { Shell } from "@/components/shell";
import { readPublicCatalog } from "@/lib/catalog/public";
import { catalogSeller } from "@/lib/catalog/published";
import { CATEGORIES } from "@/lib/catalog/types";

export default async function HomePage() {
  const { products, sellers, source } = await readPublicCatalog();
  const sellerById = (id: string) => catalogSeller(sellers, id);
  const slides = toFeaturedSlides(products, sellerById);

  return (
    <Shell screen="home" section="browse">
      <section className="featured">
        <div className="wrap">
          <div className="head">
            <div>
              <h1>
                Explore <em>{products.length} releases.</em>
              </h1>
              <p className="lede">
                {source === "fixture" ? "Fictional sample catalog. " : ""}Products from{" "}
                {sellers.length} independent creators. Each seller sets the price. Ledgerly keeps
                8%, and the split is printed on every product.
              </p>
            </div>
          </div>
          {slides.length > 0 ? (
            <FeaturedCarousel slides={slides} />
          ) : (
            <p>No published products yet.</p>
          )}
        </div>
      </section>

      <div className="wrap toolbar">
        <nav className="cats" aria-label="Category">
          <Link className="cat" href="/browse" aria-current="true">
            All
          </Link>
          {CATEGORIES.map((c) => (
            <Link key={c} className="cat" href={`/browse?category=${encodeURIComponent(c)}`}>
              {c}
            </Link>
          ))}
        </nav>
        <div className="tool-r">
          <span>{products.length} products</span>
        </div>
      </div>

      <div className="wrap pgrid" data-tour="home.grid">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} seller={sellerById(p.sellerId)} />
        ))}
      </div>

      <section className="creators-band" id="creators">
        <div className="wrap">
          <div className="row-head">
            <h2>Creators</h2>
          </div>
          <div className="creators" data-tour="home.creators">
            {sellers.map((s) => (
              <CreatorCard
                key={s.id}
                seller={s}
                products={products.filter((p) => p.sellerId === s.id)}
              />
            ))}
          </div>
        </div>
      </section>
    </Shell>
  );
}
