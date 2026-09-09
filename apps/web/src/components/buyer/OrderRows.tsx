import Link from "next/link";
import { DownloadIcon, PillLink, ProductCover, SellerByline } from "@/components";
import type { OrderView } from "@/lib/buyer/api";
import { describeStatus, formatDate } from "@/lib/buyer/format";
import { formatMoney } from "@/lib/catalog";
import { BylineFallback, Chip } from "./primitives";
import { resolveCover, resolveSeller } from "./resolve";

type Variant = "library" | "account";

const TOUR: Record<Variant, { list: string; item: string | undefined }> = {
  library: { list: "library.list", item: "library.item" },
  account: { list: "account.orders", item: undefined },
};

/**
 * One ruled row per order. The library variant leads with the download; the
 * account variant leads with the status and links to the receipt.
 */
export function OrderRows({ orders, variant }: { orders: OrderView[]; variant: Variant }) {
  const tour = TOUR[variant];

  if (orders.length === 0) {
    return (
      <section className="card by-lib" data-tour={tour.list}>
        <div className="by-lib-empty">
          <h2 className="by-h2">Nothing here yet</h2>
          <p>Purchases land here the moment an order is paid.</p>
          <PillLink href="/browse" tone="ink">
            Browse the catalog
          </PillLink>
        </div>
      </section>
    );
  }

  return (
    <section className="card by-lib" aria-label="Orders">
      <ul className="by-lib-list" data-tour={tour.list}>
        {orders.map((order) => {
          const seller = resolveSeller(order.seller);
          const cover = resolveCover(order.product);
          const when = formatDate(order.createdAt);
          const status = describeStatus(order.status);
          const productHref = order.product.id
            ? `/p/${encodeURIComponent(order.product.id)}`
            : null;
          const receiptHref = `/receipt/${encodeURIComponent(order.id)}`;
          return (
            <li key={order.id} data-tour-item={order.id}>
              <div className={`by-lib-row ${variant}`} data-tour={tour.item}>
                <div className="plate">
                  <ProductCover product={cover} />
                </div>
                <div>
                  <span className="name">
                    {productHref ? (
                      <Link href={productHref}>{order.product.title}</Link>
                    ) : (
                      order.product.title
                    )}
                  </span>
                  {seller.fixture ? (
                    <SellerByline seller={seller.fixture} city={false} />
                  ) : (
                    <BylineFallback
                      name={seller.name}
                      id={order.seller.id}
                      handle={seller.handle}
                    />
                  )}
                </div>
                {variant === "account" ? <Chip tone={status.tone}>{status.label}</Chip> : null}
                <div className="when">
                  <b>{formatMoney(order.price)}</b>
                  {when ? (
                    <time dateTime={order.createdAt ?? undefined}>
                      {variant === "library" ? `Purchased ${when}` : when}
                    </time>
                  ) : (
                    <span>Date unknown</span>
                  )}
                </div>
                {variant === "library" ? (
                  <PillLink href={order.downloadUrl ?? receiptHref} tone="ink" size="sm">
                    <DownloadIcon />
                    {order.downloadUrl ? "Download" : "Receipt"}
                  </PillLink>
                ) : (
                  <PillLink href={receiptHref} tone="ghost" size="sm">
                    Receipt
                  </PillLink>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
