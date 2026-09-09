import Link from "next/link";
import { DownloadIcon, Ledger, LedgerLine, PillLink, ProvenanceBadge } from "@/components";
import type { OrderView } from "@/lib/buyer/api";
import { formatDateTime } from "@/lib/buyer/format";
import { formatMoney } from "@/lib/catalog";
import { splitOf } from "./FeeSplit";
import { OrderItem } from "./OrderSummary";
import { RefundRequest } from "./RefundRequest";
import type { CoverProduct, SellerDisplay } from "./resolve";

function paidBy(order: OrderView, seller: SellerDisplay): string {
  const card = order.cardLast4 ? `, ending ${order.cardLast4}` : "";
  const policy =
    order.flow === "platform_transfer"
      ? "Ledgerly took this payment; refunds go to Ledgerly."
      : order.flow === "direct"
        ? `${seller.shortName} took this payment; refunds go to ${seller.shortName}.`
        : "";
  return [`Paid by card through Whop${card}.`, policy].filter(Boolean).join(" ");
}

/** The receipt as a paper slip: the one raised surface on its page. */
export function ReceiptSlip({
  order,
  cover,
  seller,
  correlationId,
}: {
  order: OrderView;
  cover: CoverProduct;
  seller: SellerDisplay;
  correlationId: string;
}) {
  const split = splitOf(order);
  const when = formatDateTime(order.createdAt);
  const direct = order.flow === "direct";
  const paid = order.status === "paid";
  const refundable = paid && Boolean(order.paymentId) && order.flow === "platform_transfer";

  return (
    <article className="by-rcpt" aria-labelledby="receipt-title">
      <div className="top">
        <h1 id="receipt-title">Receipt</h1>
        <div className="meta">
          <span className="id">
            <span data-tour="receipt.order-id">{order.id}</span>
            <span
              data-tour="receipt.provenance"
              data-provenance-assumed={order.provenanceAssumed || undefined}
            >
              <ProvenanceBadge provenance={order.provenance} />
            </span>
          </span>
          {when ? (
            <>
              <br />
              <time dateTime={order.createdAt ?? undefined}>{when}</time>
            </>
          ) : null}
        </div>
      </div>

      <OrderItem order={order} cover={cover} seller={seller} />

      <Ledger>
        <LedgerLine label="Item" value={formatMoney(order.price)} />
        <LedgerLine
          label={paid ? "You paid" : "Order total"}
          value={formatMoney(order.price)}
          total
        />
      </Ledger>

      <span className="section-label">HOW IT IS SHARED</span>
      <div data-tour="receipt.split" data-split-source={split.ok ? split.source : "none"}>
        <Ledger>
          {split.ok ? (
            <>
              <LedgerLine label="Ledgerly fee, 8%" value={formatMoney(split.fee)} quiet />
              <LedgerLine
                label={seller.name}
                fine="before processing fees"
                value={formatMoney(split.sellerShare)}
              />
            </>
          ) : (
            <LedgerLine
              label="Ledgerly fee, 8%"
              value={`not computable: ${split.reason}`}
              quiet
              wrap
            />
          )}
        </Ledger>
      </div>

      <p className="foot">
        {paid
          ? paidBy(order, seller)
          : order.status === "refunded"
            ? "This payment was refunded."
            : "Payment has not completed."}
      </p>

      <div className="btnrow">
        <PillLink href={order.downloadUrl ?? "/library"} tone="ink" data-tour="receipt.download">
          <DownloadIcon />
          {order.downloadUrl ? "Download files" : "Files in your library"}
        </PillLink>
        {refundable ? <RefundRequest orderId={order.id} correlationId={correlationId} /> : null}
      </div>
      <p className="policy">
        {direct ? (
          <>
            Refunds go to {seller.name}.
            {seller.shopHref ? (
              <>
                {" "}
                <Link className="by-link" href={seller.shopHref}>
                  Contact {seller.shortName} from the shop page.
                </Link>
              </>
            ) : null}
          </>
        ) : order.flow === "platform_transfer" ? (
          "Refund requests go to Ledgerly after payment completes."
        ) : (
          "Refund information is unavailable for this order."
        )}
      </p>
    </article>
  );
}
