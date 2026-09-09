import type { Metadata } from "next";
import { EarningsView } from "@/components/seller/EarningsView";
import { correlationParam, currentSeller, type SearchParams } from "@/lib/seller/current";
import { canReadSeller, chargeModelSentence, sellerHref } from "@/lib/seller/identity";
import { ondaFixtureLedger } from "@/lib/seller/ledger";

export const metadata: Metadata = { title: "Earnings" };

export default async function EarningsPage({ searchParams }: { searchParams: SearchParams }) {
  const [seller, correlationId] = await Promise.all([
    currentSeller(searchParams),
    correlationParam(searchParams),
  ]);
  const readable = canReadSeller(seller);
  return (
    <div data-screen="sell.earnings">
      <EarningsView
        sellerId={seller.id}
        sellerName={seller.name}
        readable={readable}
        correlationId={correlationId}
        initial={readable ? null : ondaFixtureLedger()}
        chargeModel={chargeModelSentence(seller.salePolicy)}
        withdrawHref={sellerHref("/sell/payouts", seller)}
      />
    </div>
  );
}
