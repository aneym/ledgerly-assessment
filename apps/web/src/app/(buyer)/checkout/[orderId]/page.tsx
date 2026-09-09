import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PillLink, Shell } from "@/components";
import { FeeSplit } from "@/components/buyer/FeeSplit";
import { NotLive } from "@/components/buyer/NotLive";
import { OrderSummary } from "@/components/buyer/OrderSummary";
import { ProviderMount } from "@/components/buyer/ProviderMount";
import { Chip } from "@/components/buyer/primitives";
import { resolveCover, resolveSeller } from "@/components/buyer/resolve";
import { toOrderView } from "@/lib/buyer/api";
import { describeStatus, orderFailureTitle } from "@/lib/buyer/format";
import { checkoutEmbedEnvironment, getOrder, serverCorrelationId } from "@/lib/buyer/server";

export const metadata: Metadata = { title: "Checkout · Ledgerly" };

const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const first = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

export default async function CheckoutPage(props: PageProps<"/checkout/[orderId]">) {
  const [{ orderId }, search] = await Promise.all([props.params, props.searchParams]);
  if (!ORDER_ID.test(orderId)) notFound();

  const correlationId = await serverCorrelationId(first(search.correlationId));
  const result = await getOrder(orderId, correlationId);

  if (!result.ok) {
    return (
      <Shell screen="checkout">
        <div className="wrap by-page" data-correlation-id={correlationId}>
          <div className="by-head">
            <div>
              <h1 className="by-h1">Checkout</h1>
              <p className="by-lede">
                Order <span className="by-mono">{orderId}</span>
              </p>
            </div>
          </div>
          <NotLive
            failure={result}
            title={orderFailureTitle(result)}
            actions={
              <PillLink href="/browse" tone="ink">
                Back to browse
              </PillLink>
            }
          >
            <p>
              This screen reads the order from the app API and shows what it returns, with its
              provenance. Until that route answers there is nothing to charge and nothing to show.
            </p>
          </NotLive>
        </div>
      </Shell>
    );
  }

  const order = toOrderView(result.data);
  if (!order) {
    return (
      <Shell screen="checkout">
        <div className="wrap by-page" data-correlation-id={correlationId}>
          <div className="by-head">
            <h1 className="by-h1">Checkout</h1>
          </div>
          <div className="by-notlive">
            <h2 className="by-h3">The order payload is missing fields</h2>
            <p>
              <span className="by-mono">
                {result.method} {result.path}
              </span>{" "}
              answered {result.status} but without an id, a product title and an integer price, so
              this page will not guess at a total.
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  const seller = resolveSeller(order.seller);
  const cover = resolveCover(order.product);
  const status = describeStatus(order.status);
  // The embed's environment follows the server's Whop API base; the return URL is this
  // order's receipt on the app's own origin (external payment steps land back here).
  const environment = checkoutEmbedEnvironment();
  const returnUrl = `${(process.env.APP_BASE_URL ?? "").replace(/\/+$/, "")}/receipt/${encodeURIComponent(order.id)}`;

  return (
    <Shell screen="checkout">
      <div
        className="wrap by-page"
        data-correlation-id={correlationId}
        data-provenance-assumed={order.provenanceAssumed || undefined}
      >
        <div className="by-head">
          <div>
            <h1 className="by-h1">Checkout</h1>
            <p className="by-lede">One payment, one fee, both on the receipt.</p>
          </div>
        </div>

        <div className="by-co">
          <div className="by-co-main">
            <ProviderMount
              order={order}
              environment={environment}
              returnUrl={returnUrl}
              correlationId={correlationId}
            />
          </div>
          <aside className="by-co-side">
            <OrderSummary order={order} cover={cover} seller={seller} data-tour="checkout.summary">
              <FeeSplit order={order} seller={seller} data-tour="checkout.fee-split" />
            </OrderSummary>
            <div className="card by-status" data-tour="checkout.status" data-status={order.status}>
              <div className="row">
                <span>Order status</span>
                <Chip tone={status.tone}>{status.label}</Chip>
              </div>
              <div className="next">
                {status.tone === "ok" ? (
                  <>
                    <span>The charge went through. Your receipt is ready.</span>
                    <PillLink
                      href={`/receipt/${encodeURIComponent(order.id)}`}
                      tone="ink"
                      size="sm"
                    >
                      View receipt
                    </PillLink>
                  </>
                ) : status.tone === "warn" ? (
                  <span>This page updates once Whop confirms the payment.</span>
                ) : (
                  <span>Nothing was charged for this order.</span>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </Shell>
  );
}
