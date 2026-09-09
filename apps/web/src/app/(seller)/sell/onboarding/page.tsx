import type { Metadata } from "next";
import { WhopMark } from "@/components/brand/WhopMark";
import { NoSellerYet } from "@/components/seller/NoSellerYet";
import { OnboardingStatus } from "@/components/seller/OnboardingStatus";
import { PageHead } from "@/components/seller/PageHead";
import { correlationParam, currentSeller, type SearchParams } from "@/lib/seller/current";
import { canReadSeller } from "@/lib/seller/identity";

export const metadata: Metadata = { title: "Onboarding" };

function flag(value: string | string[] | undefined): boolean {
  const first = Array.isArray(value) ? value[0] : value;
  return first === "1" || first === "true";
}

export default async function OnboardingPage({ searchParams }: { searchParams: SearchParams }) {
  const [seller, correlationId, params] = await Promise.all([
    currentSeller(searchParams),
    correlationParam(searchParams),
    searchParams,
  ]);
  // Whop sends the seller back here with ?returned=1 (done or left) or ?refresh=1 (link
  // expired), per ONBOARDING_RETURN_URL and ONBOARDING_REFRESH_URL. Either way the status
  // component reads the account back on mount; the flag only names why the page loaded.
  const arrival = flag(params.returned) ? "returned" : flag(params.refresh) ? "refresh" : null;

  return (
    <div data-screen="sell.onboarding" className="mx-auto max-w-[720px]">
      <PageHead
        title="Finish setting up on Whop"
        sub={
          <>
            {canReadSeller(seller) ? seller.name : "A seller"} needs a verified Whop account before
            the first sale. Whop runs the identity check; this page reads the result back.
          </>
        }
        aside={
          <span className="text-[12.5px] text-muted">
            Onboarding on <WhopMark />
          </span>
        }
      />
      {canReadSeller(seller) ? (
        <OnboardingStatus
          sellerId={seller.id}
          correlationId={correlationId}
          arrival={arrival}
          guided={process.env.DEMO_MODE === "1" && params.tour === "C02"}
        />
      ) : (
        <NoSellerYet screen="sell.onboarding" />
      )}
    </div>
  );
}
