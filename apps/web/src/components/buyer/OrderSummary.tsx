import type { ReactNode } from "react";
import { Ledger, LedgerLine, ProductCover, SellerByline } from "@/components";
import type { OrderView } from "@/lib/buyer/api";
import { formatMoney } from "@/lib/catalog";
import { BylineFallback } from "./primitives";
import type { CoverProduct, SellerDisplay } from "./resolve";

/** Cover on a plate, title, subtitle and the seller byline. Shared by checkout and the receipt. */
export function OrderItem({
  order,
  cover,
  seller,
}: {
  order: OrderView;
  cover: CoverProduct;
  seller: SellerDisplay;
}) {
  return (
    <div className="by-item">
      <div className="plate">
        <ProductCover product={cover} />
      </div>
      <div>
        <span className="name">{order.product.title}</span>
        {order.product.subtitle ? <span className="sub">{order.product.subtitle}</span> : null}
        {seller.fixture ? (
          <SellerByline seller={seller.fixture} />
        ) : (
          <BylineFallback
            name={seller.name}
            id={order.seller.id}
            handle={seller.handle}
            city={seller.city}
          />
        )}
      </div>
    </div>
  );
}

export function OrderSummary({
  order,
  cover,
  seller,
  children,
  ...rest
}: { order: OrderView; cover: CoverProduct; seller: SellerDisplay; children?: ReactNode } & Record<
  `data-${string}`,
  string | undefined
>) {
  return (
    <section className="card raised by-summary" aria-label="Order summary" {...rest}>
      <OrderItem order={order} cover={cover} seller={seller} />
      <Ledger>
        <LedgerLine label="Price" value={formatMoney(order.price)} />
      </Ledger>
      {children}
    </section>
  );
}
