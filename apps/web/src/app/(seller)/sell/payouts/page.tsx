import type { Metadata } from "next";
import { WhopMark } from "@/components/brand/WhopMark";
import { NoSellerYet } from "@/components/seller/NoSellerYet";
import { PageHead } from "@/components/seller/PageHead";
import { PayoutsPanel } from "@/components/seller/PayoutsPanel";
import { correlationParam, currentSeller, type SearchParams } from "@/lib/seller/current";
import { canReadSeller } from "@/lib/seller/identity";

export const metadata: Metadata = { title: "Payouts" };

export default async function PayoutsPage({ searchParams }: { searchParams: SearchParams }) {
  const [seller, correlationId] = await Promise.all([
    currentSeller(searchParams),
    correlationParam(searchParams),
  ]);

  return (
    <div data-screen="sell.payouts" className="mx-auto max-w-[840px]">
      <PageHead
        title="Payouts"
        sub="Transfers fund your Whop balance. Payouts move it to your bank."
        aside={
          <span className="text-[12.5px] text-muted">
            Payouts by <WhopMark />
          </span>
        }
      />
      {canReadSeller(seller) ? (
        <PayoutsPanel
          sellerId={seller.id}
          correlationId={correlationId}
          simulationEnabled={process.env.DEMO_MODE === "1"}
        />
      ) : (
        <NoSellerYet screen="sell.payouts" />
      )}
    </div>
  );
}
