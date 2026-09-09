import Link from "next/link";
import { ProductCard } from "@/components/product-card";
import { Shell } from "@/components/shell";
import { readPublicCatalog } from "@/lib/catalog/public";
import { catalogSeller } from "@/lib/catalog/published";
import type { Seller } from "@/lib/catalog/types";
import { CATEGORIES, type Product } from "@/lib/catalog/types";

const PRICE_BANDS = [
  { id: "under-30", label: "Under $30", min: 0, max: 2999 },
  { id: "30-to-80", label: "$30 to $80", min: 3000, max: 8000 },
  { id: "over-80", label: "Over $80", min: 8001, max: Number.MAX_SAFE_INTEGER },
] as const;

const SORTS = [
  { id: "newest", label: "Newest" },
  { id: "price-asc", label: "Price, low to high" },
  { id: "price-desc", label: "Price, high to low" },
] as const;

type SortId = (typeof SORTS)[number]["id"];

type Filters = { category: string | null; price: string | null; sort: SortId; q: string | null };

function first(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s ? s : null;
}

function href(f: Filters, patch: Partial<Filters>): string {
  const next = { ...f, ...patch };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.category) params.set("category", next.category);
  if (next.price) params.set("price", next.price);
  if (next.sort !== "newest") params.set("sort", next.sort);
  const s = params.toString();
  return s ? `/browse?${s}` : "/browse";
}

function apply(products: Product[], f: Filters, sellers: Seller[]): Product[] {
  let out = products;
  if (f.q) {
    const q = f.q.toLowerCase();
    out = out.filter((p) => {
      const seller = catalogSeller(sellers, p.sellerId);
      return (
        p.title.toLowerCase().includes(q) ||
        p.subtitle.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        seller.name.toLowerCase().includes(q)
      );
    });
  }
  if (f.category) out = out.filter((p) => p.category === f.category);
  const band = PRICE_BANDS.find((b) => b.id === f.price);
  if (band)
    out = out.filter((p) => p.price.amountMinor >= band.min && p.price.amountMinor <= band.max);
  const sorted = [...out];
  if (f.sort === "price-asc") sorted.sort((a, b) => a.price.amountMinor - b.price.amountMinor);
  else if (f.sort === "price-desc")
    sorted.sort((a, b) => b.price.amountMinor - a.price.amountMinor);
  else sorted.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
  return sorted;
}

export default async function BrowsePage({ searchParams }: PageProps<"/browse">) {
  const sp = await searchParams;
  const sortParam = first(sp.sort);
  const filters: Filters = {
    q: first(sp.q),
    category: first(sp.category),
    price: first(sp.price),
    sort: SORTS.some((s) => s.id === sortParam) ? (sortParam as SortId) : "newest",
  };
  const catalog = await readPublicCatalog();
  const all = catalog.products;
  const sellers = catalog.sellers;
  const categories = [...new Set([...CATEGORIES, ...all.map((p) => p.category)])];
  const shown = apply(all, filters, sellers);
  const active = Boolean(filters.q || filters.category || filters.price);

  // Each count previews that link's result, keeping the other filters active.
  const categoryChoices = apply(all, { ...filters, category: null }, sellers);
  const priceChoices = apply(all, { ...filters, price: null }, sellers);

  return (
    <Shell screen="browse" section="browse" searchQuery={filters.q ?? ""}>
      <div className="wrap browse-head">
        <h1>{filters.q ? `Results for “${filters.q}”` : "Browse"}</h1>
        <p>
          {all.length} products from {sellers.length} creators.{" "}
          {catalog.source === "fixture" ? "Fictional sample catalog. " : ""} Each price shows the 8%
          Ledgerly fee before checkout.
        </p>
      </div>
      <div className="wrap browse">
        <aside className="rail" data-tour="browse.filters" aria-label="Filters">
          <section>
            <h2>Category</h2>
            <ul>
              <li>
                <Link
                  href={href(filters, { category: null })}
                  aria-current={!filters.category ? "true" : undefined}
                >
                  All
                  <i className="lead" aria-hidden="true" />
                  <span className="n">{categoryChoices.length}</span>
                </Link>
              </li>
              {categories.map((c) => (
                <li key={c}>
                  <Link
                    href={href(filters, { category: c })}
                    aria-current={filters.category === c ? "true" : undefined}
                  >
                    {c}
                    <i className="lead" aria-hidden="true" />
                    <span className="n">
                      {categoryChoices.filter((p) => p.category === c).length}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>Price</h2>
            <ul>
              <li>
                <Link
                  href={href(filters, { price: null })}
                  aria-current={!filters.price ? "true" : undefined}
                >
                  Any price
                  <i className="lead" aria-hidden="true" />
                  <span className="n">{priceChoices.length}</span>
                </Link>
              </li>
              {PRICE_BANDS.map((b) => (
                <li key={b.id}>
                  <Link
                    href={href(filters, { price: b.id })}
                    aria-current={filters.price === b.id ? "true" : undefined}
                  >
                    {b.label}
                    <i className="lead" aria-hidden="true" />
                    <span className="n">
                      {
                        priceChoices.filter(
                          (p) => p.price.amountMinor >= b.min && p.price.amountMinor <= b.max,
                        ).length
                      }
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          {active ? (
            <Link className="clear" href="/browse">
              Clear filters
            </Link>
          ) : null}
        </aside>

        <div>
          <div className="sortbar">
            <span className="count">
              {shown.length === all.length
                ? `All ${all.length} products`
                : `${shown.length} of ${all.length} products`}
            </span>
            <nav className="sort" aria-label="Sort" data-tour="browse.sort">
              <span className="lbl">Sort</span>
              {SORTS.map((s) => (
                <Link
                  key={s.id}
                  className="cat"
                  href={href(filters, { sort: s.id })}
                  aria-current={filters.sort === s.id ? "true" : undefined}
                >
                  {s.label}
                </Link>
              ))}
            </nav>
          </div>
          {shown.length === 0 ? (
            <p className="empty-state" data-tour="browse.grid">
              Nothing matches. <Link href="/browse">Clear the filters</Link> to see all {all.length}{" "}
              products.
            </p>
          ) : (
            <div className="pgrid tight" data-tour="browse.grid">
              {shown.map((p) => (
                <ProductCard key={p.id} product={p} seller={catalogSeller(sellers, p.sellerId)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
