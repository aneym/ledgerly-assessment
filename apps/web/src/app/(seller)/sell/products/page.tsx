import type { Metadata } from "next";
import Link from "next/link";
import { PlusIcon } from "@/components/icons";
import { LedgerLine } from "@/components/ledger-line";
import { PillLink } from "@/components/pill";
import { ProductCover } from "@/components/product-cover";
import { ProvenanceBadge } from "@/components/provenance-badge";
import { PageHead } from "@/components/seller/PageHead";
import { StatusChip } from "@/components/seller/StatusChip";
import { formatMoney } from "@/lib/catalog/money";
import { readSellerCatalog } from "@/lib/catalog/public";
import { productHref } from "@/lib/catalog/published";
import { currentSeller, type SearchParams } from "@/lib/seller/current";
import { sellerHref } from "@/lib/seller/identity";

export const metadata: Metadata = { title: "Products" };

export default async function ProductsPage({ searchParams }: { searchParams: SearchParams }) {
  const seller = await currentSeller(searchParams);
  const catalog = await readSellerCatalog(seller);
  if ("forbidden" in catalog) return <p role="alert">Sign in as this seller to view products.</p>;
  const products = catalog.products;
  const shownSeller = catalog.sellers.find((s) => s.id === seller.id) ?? seller;
  const listed = shownSeller.salePolicy !== "blocked_onboarding_incomplete";

  return (
    <div data-screen="sell.products">
      <PageHead
        title="Products"
        sub={
          products.length === 0
            ? "Nothing listed yet. A product needs a title, a price and at least one file."
            : `${products.length} ${products.length === 1 ? "product" : "products"} listed under ${shownSeller.name}.`
        }
        aside={
          <PillLink
            href={sellerHref("/sell/products/new", seller)}
            tone="buy"
            data-tour="sell.products.new"
          >
            <PlusIcon />
            New product
          </PillLink>
        }
      />

      {products.length === 0 ? (
        <div
          className="rounded-card border border-dashed border-line-strong px-6 py-16 text-center"
          data-tour="sell.products.list"
        >
          <p
            className="font-serif text-[22px] text-ink"
            style={{ fontVariationSettings: "'opsz' 24" }}
          >
            No products yet
          </p>
          <p className="mx-auto mt-2 max-w-[44ch] text-[13.5px] leading-relaxed text-muted">
            Your first listing takes one form: title, price, cover, files and a description.
          </p>
        </div>
      ) : (
        <ul
          className="sl-paper divide-y divide-line overflow-hidden"
          data-tour="sell.products.list"
        >
          {products.map((product) => (
            <li
              key={product.id}
              className="sl-grid grid-cols-[64px_1fr] items-center gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-[64px_1fr_180px_auto] sm:gap-x-6 sm:px-6"
              data-tour="sell.products.item"
              data-tour-item={product.id}
            >
              <div className="plate p-1.5">
                <ProductCover product={product} />
              </div>
              <div className="min-w-0">
                <h2
                  className="truncate font-serif text-[18px] leading-[1.25] font-medium text-ink"
                  style={{ fontVariationSettings: "'opsz' 20" }}
                >
                  <Link href={productHref(product)} className="no-underline hover:underline">
                    {product.title}
                  </Link>
                </h2>
                <p className="mt-0.5 truncate text-[13px] text-ink-2">{product.subtitle}</p>
                <p className="mt-1 flex items-center gap-2 text-[12.5px] text-muted">
                  <span>{product.category}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-[11px]">{product.id}</span>
                  <ProvenanceBadge provenance={product.provenance} />
                </p>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <LedgerLine
                  label="Price"
                  value={formatMoney(product.price)}
                  className="border-b-0! py-0!"
                />
              </div>
              <div className="col-start-2 sm:col-start-auto">
                {listed ? (
                  <StatusChip tone="ok">Listed</StatusChip>
                ) : (
                  <StatusChip tone="warn">Not for sale yet</StatusChip>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
