import Link from "next/link";
import { canBuy } from "@/lib/catalog/load";
import { formatMoney } from "@/lib/catalog/money";
import { productHref } from "@/lib/catalog/published";
import type { Product, Seller } from "@/lib/catalog/types";
import { LedgerLine } from "./ledger-line";
import { ProductCover } from "./product-cover";
import { SellerByline } from "./seller-byline";

type Props = { product: Product; seller: Seller };

/** Bezel card: white mat, matte plate, drawn cover, title in Fraunces, byline, ledger line price. */
export function ProductCard({ product, seller }: Props) {
  const forSale = canBuy(seller);
  return (
    <article
      className={["card", "lift", forSale ? "" : "unavail"].filter(Boolean).join(" ")}
      data-tour-item={product.id}
    >
      <div className="plate">
        <ProductCover product={product} />
      </div>
      <div className="card-body">
        <h3 className="card-title">
          <Link href={productHref(product)} className="card-link">
            {product.title}
          </Link>
        </h3>
        <p className="card-sub">{product.subtitle}</p>
        <SellerByline
          seller={seller}
          city={false}
          rating={product.rating.count > 0 ? product.rating : undefined}
        />
        <div className="card-foot">
          {forSale ? null : <span className="chip warn status">Not for sale yet</span>}
          <LedgerLine label={product.category} value={formatMoney(product.price)} />
        </div>
      </div>
    </article>
  );
}
