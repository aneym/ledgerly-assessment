import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { WhopMark } from "@/components/brand/WhopMark";
import { FeeLedger } from "@/components/fee-ledger";
import { StarIcon } from "@/components/icons";
import { Ledger, LedgerLine } from "@/components/ledger-line";
import { PillButton, PillLink } from "@/components/pill";
import { ProductCover } from "@/components/product-cover";
import { ProvenanceBadge } from "@/components/provenance-badge";
import { Shell } from "@/components/shell";
import { checkoutHref } from "@/lib/catalog/checkout-link";
import { canBuy } from "@/lib/catalog/load";
import { feeSplit, formatMoney } from "@/lib/catalog/money";
import { readPublicCatalog } from "@/lib/catalog/public";
import { catalogSeller, findPublicProduct, productKey } from "@/lib/catalog/published";
import type { Seller } from "@/lib/catalog/types";

export async function generateMetadata({ params }: PageProps<"/p/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const catalog = await readPublicCatalog();
  const product = findPublicProduct(catalog, slug);
  return { title: product ? `${product.title} on Ledgerly` : "Ledgerly" };
}

function sellerLine(seller: Seller): string {
  switch (seller.salePolicy) {
    case "direct_charge":
      return `${seller.city}. Sells directly, handles refunds.`;
    case "platform_charge_transfer":
      return `${seller.city}. Paid through Ledgerly after each sale.`;
    case "blocked_onboarding_incomplete":
      return `${seller.city}. Whop onboarding not finished.`;
  }
}

export default async function ProductPage({ params, searchParams }: PageProps<"/p/[slug]">) {
  const { slug } = await params;
  const catalog = await readPublicCatalog();
  const product = findPublicProduct(catalog, slug);
  if (!product) notFound();
  const seller = catalogSeller(catalog.sellers, product.sellerId);
  const search = await searchParams;
  const buyHref = checkoutHref(productKey(product), search.correlationId);
  const forSale = canBuy(seller);
  const price = formatMoney(product.price);
  const split = feeSplit(product.price);

  return (
    <Shell screen="product" section="browse">
      <nav className="wrap crumbs" aria-label="Breadcrumb">
        <Link href="/browse">Browse</Link>
        <span>
          <Link href={`/browse?category=${encodeURIComponent(product.category)}`}>
            {product.category}
          </Link>
        </span>
        <span>{product.title}</span>
      </nav>

      <div className="wrap pd">
        <div className="card raised preview" data-tour="product.cover">
          <div className="plate">
            <ProductCover product={product} wide detail />
          </div>
        </div>
        <div className="pd-media">
          <h2>About</h2>
          {product.description.map((para) => (
            <p key={para} className="prose">
              {para}
            </p>
          ))}
        </div>

        <aside className="pd-side">
          <p className="pd-cat">{product.category}</p>
          <h1 data-tour="product.title">{product.title}</h1>
          {catalog.source === "fixture" ? <p>Fictional sample listing.</p> : null}
          <p className="lede">{product.subtitle}</p>
          {product.rating.count > 0 ? (
            <p className="rate">
              <StarIcon />
              <b>{product.rating.avg.toFixed(1)}</b>
              <span>from {product.rating.count} buyers</span>
            </p>
          ) : (
            <p>No reviews yet.</p>
          )}

          <Link className="seller" href={`/c/${seller.handle}`} data-tour="product.seller">
            <Avatar src={seller.avatar} alt="" size="md" />
            <span className="who">
              <b>{seller.name}</b>
              <span>{sellerLine(seller)}</span>
            </span>
            <span className="shop">View shop</span>
          </Link>

          <div className="buycard">
            <div className="pricebox">
              <span className="price" data-tour="product.price">
                {price}
              </span>
              <span className="fine">
                One-time purchase.{" "}
                {catalog.source === "database"
                  ? "File delivery is not available yet."
                  : "Sample listing."}
              </span>
            </div>
            {forSale ? (
              <PillLink tone="buy" size="lg" wide href={buyHref} data-tour="product.buy">
                Buy for {price}
              </PillLink>
            ) : (
              <PillButton tone="buy" size="lg" wide disabled data-tour="product.buy">
                Not for sale yet
              </PillButton>
            )}
            {forSale ? (
              <p className="proof">
                Secure checkout by <WhopMark />.{" "}
                {seller.salePolicy === "direct_charge"
                  ? `Refunds within 14 days, handled by ${seller.shortName}.`
                  : `Refunds within 14 days, handled by Ledgerly.`}
              </p>
            ) : (
              <p className="proof blocked">
                {seller.name} has not finished Whop onboarding. The buy button opens when it is
                done.
              </p>
            )}
            <div className="split" data-tour="product.fee-split">
              <div className="h">
                <span>Where {price} goes</span>
                <ProvenanceBadge provenance={product.provenance} />
              </div>
              <FeeLedger product={product} seller={seller} />
              <p className="who-pays">
                Before processing fees.{" "}
                {seller.salePolicy === "direct_charge"
                  ? `${seller.shortName} is paid by Whop at checkout.`
                  : `Ledgerly transfers ${formatMoney(split.sellerShare)} to ${seller.shortName} after settlement.`}
              </p>
            </div>
          </div>

          <div className="gets" data-tour="product.includes">
            <h3>What you get</h3>
            <Ledger>
              {product.includes.map((item) => (
                <LedgerLine key={item.label} label={item.label} value={item.value} wrap />
              ))}
            </Ledger>
          </div>
        </aside>
      </div>
    </Shell>
  );
}
