import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PillLink, Shell } from "@/components";
import { type CheckoutRequest, StartCheckout } from "@/components/buyer/StartCheckout";
import { serverCorrelationId } from "@/lib/buyer/server";
import { checkoutHref } from "@/lib/catalog/checkout-link";
import { formatMoney } from "@/lib/catalog/money";
import { readPublicCatalog } from "@/lib/catalog/public";
import {
  checkoutProduct,
  productKey,
  productHref as publicProductHref,
} from "@/lib/catalog/published";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Checkout · Ledgerly" };

const first = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

/**
 * The buy button lands here with `?product=<slug>`. This page turns the catalog product
 * into a slug-based POST /api/checkouts request. The API resolves pricing; StartCheckout
 * opens the hosted checkout URL or falls back to /checkout/[orderId].
 *
 * The product fixes the seller. A conflicting seller query is rejected. Anonymous visitors are sent to sign in first: an order needs a buyer.
 */
export default async function NewCheckoutPage(props: PageProps<"/checkout/new">) {
  const search = await props.searchParams;
  const slug = first(search.product);
  const catalog = await readPublicCatalog();
  const paramSeller = first(search.seller)?.trim() || null;
  const product = checkoutProduct(catalog, slug, paramSeller);
  if (!product) notFound();

  const [correlationId, session] = await Promise.all([
    serverCorrelationId(first(search.correlationId)),
    getSession(),
  ]);
  // An order needs a buyer: send anonymous visitors to sign in and bring them back here.
  if (!session) {
    const next = checkoutHref(productKey(product), search.correlationId);
    redirect(`/signin?next=${encodeURIComponent(next)}`);
  }
  // The selected public product fixes both the seller and the seller-scoped slug.
  const sellerId = product.sellerId;
  const sellerSource: "param" | "catalog" = paramSeller ? "param" : "catalog";

  const request: CheckoutRequest = {
    seller_id: sellerId,
    product_slug: product.slug,
  };
  const productHref = publicProductHref(product);

  return (
    <Shell screen="checkout">
      <div
        className="wrap by-page"
        data-correlation-id={correlationId}
        data-seller-source={sellerSource}
      >
        <div className="by-head">
          <div>
            <h1 className="by-h1">Checkout</h1>
            <p className="by-lede">
              {product.title}, {formatMoney(product.price)}.
            </p>
          </div>
        </div>
        <div className="by-co">
          <div className="by-co-main">
            <StartCheckout
              request={request}
              correlationId={correlationId}
              productHref={productHref}
            />
          </div>
          {sellerSource === "param" ? (
            <aside className="by-co-side">
              <section className="card by-status" aria-label="Order seller">
                <div className="row">
                  <span>Seller for this order</span>
                  <span className="by-mono">{sellerId}</span>
                </div>
                <div className="next">
                  <span>Seller id from the address bar.</span>
                </div>
                <div className="act">
                  <PillLink href={productHref} tone="ghost" size="sm">
                    Back to the product
                  </PillLink>
                </div>
              </section>
            </aside>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}
