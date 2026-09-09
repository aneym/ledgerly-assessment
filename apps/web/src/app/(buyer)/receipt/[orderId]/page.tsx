import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PillLink, Shell } from "@/components";
import { NotLive } from "@/components/buyer/NotLive";
import { ReceiptSlip } from "@/components/buyer/ReceiptSlip";
import { resolveCover, resolveSeller } from "@/components/buyer/resolve";
import { toOrderView } from "@/lib/buyer/api";
import { orderFailureTitle } from "@/lib/buyer/format";
import { getOrder, serverCorrelationId } from "@/lib/buyer/server";

export const metadata: Metadata = { title: "Receipt · Ledgerly" };

const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const first = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

export default async function ReceiptPage(props: PageProps<"/receipt/[orderId]">) {
  const [{ orderId }, search] = await Promise.all([props.params, props.searchParams]);
  if (!ORDER_ID.test(orderId)) notFound();

  const correlationId = await serverCorrelationId(first(search.correlationId));
  const result = await getOrder(orderId, correlationId);

  if (!result.ok) {
    return (
      <Shell screen="receipt">
        <div className="wrap by-page" data-correlation-id={correlationId}>
          <div className="by-head">
            <div>
              <h1 className="by-h1">Receipt</h1>
              <p className="by-lede">
                Order <span className="by-mono">{orderId}</span>
              </p>
            </div>
          </div>
          <NotLive
            failure={result}
            title={orderFailureTitle(result)}
            actions={
              <>
                <PillLink href="/library" tone="ink">
                  Go to library
                </PillLink>
                <PillLink href="/browse" tone="ghost">
                  Browse
                </PillLink>
              </>
            }
          >
            <p>
              A receipt is a record of a real charge. This page prints what the order API returns
              and nothing else.
            </p>
          </NotLive>
        </div>
      </Shell>
    );
  }

  const order = toOrderView(result.data);
  if (!order) {
    return (
      <Shell screen="receipt">
        <div className="wrap by-page" data-correlation-id={correlationId}>
          <div className="by-head">
            <h1 className="by-h1">Receipt</h1>
          </div>
          <div className="by-notlive">
            <h2 className="by-h3">The order payload is missing fields</h2>
            <p>
              <span className="by-mono">
                {result.method} {result.path}
              </span>{" "}
              answered {result.status} but without an id, a product title and an integer price, so
              no receipt can be printed from it.
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  const seller = resolveSeller(order.seller);
  const cover = resolveCover(order.product);

  return (
    <Shell screen="receipt">
      <div className="by-wash">
        <div
          className="wrap by-page by-rc"
          data-correlation-id={correlationId}
          data-provenance-assumed={order.provenanceAssumed || undefined}
        >
          <ReceiptSlip order={order} cover={cover} seller={seller} correlationId={correlationId} />
          <aside className="by-rc-notes">
            <section>
              <h2 className="by-h2">Your files</h2>
              <p>
                Everything you buy stays in your library with the receipt beside it. Download again
                at any time from any signed-in device.
              </p>
              <PillLink href="/library" tone="ghost">
                Open library
              </PillLink>
            </section>
          </aside>
        </div>
      </div>
    </Shell>
  );
}
