import { computePlatformFee } from "@ledgerly/core/fee";
import { Ledger, LedgerLine, ProvenanceBadge } from "@/components";
import type { Money, OrderView } from "@/lib/buyer/api";
import { formatMoney } from "@/lib/catalog";
import type { SellerDisplay } from "./resolve";

export const FEE_RATE_BPS = 800;

export type Split =
  | { ok: true; fee: Money; sellerShare: Money; source: "api" | "computed" }
  | { ok: false; reason: string };

/**
 * The fee and the seller share for an order. The API's own numbers win, since
 * the fee is computed server-side; when a payload leaves them out the split is
 * computed here with the same core function and marked as such.
 */
export function splitOf(order: OrderView): Split {
  if (order.fee && order.sellerShare) {
    return { ok: true, fee: order.fee, sellerShare: order.sellerShare, source: "api" };
  }
  const computed = computePlatformFee(order.price, FEE_RATE_BPS);
  if (!computed.ok) return { ok: false, reason: computed.error.kind.replace(/_/g, " ") };
  return { ok: true, ...computed.value, source: "computed" };
}

/** Who is paid by whom, in one sentence, for the line under the split. */
export function whoPays(seller: SellerDisplay): string {
  if (seller.salePolicy === "platform_charge_transfer") {
    return `Before processing fees. Ledgerly collects the payment, then transfers ${seller.shortName}'s share.`;
  }
  return `Before processing fees. ${seller.shortName} is paid by Whop at checkout.`;
}

/** The fee split on a plate: you pay, the 8% fee, what the seller keeps. */
export function FeeSplit({
  order,
  seller,
  ...rest
}: { order: OrderView; seller: SellerDisplay } & Record<`data-${string}`, string | undefined>) {
  const gross = order.price;
  const split = splitOf(order);

  return (
    <div className="split" data-split-source={split.ok ? split.source : "none"} {...rest}>
      <div className="h">
        <span>Where {formatMoney(gross)} goes</span>
        <ProvenanceBadge provenance={order.provenance} />
      </div>
      <Ledger>
        <LedgerLine label="You pay" value={formatMoney(gross)} />
        {split.ok ? (
          <>
            <LedgerLine label="Ledgerly fee, 8%" value={formatMoney(split.fee)} quiet />
            <LedgerLine
              label={`${seller.shortName} keeps`}
              value={formatMoney(split.sellerShare)}
              total
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
      <p className="who-pays">{whoPays(seller)}</p>
    </div>
  );
}
