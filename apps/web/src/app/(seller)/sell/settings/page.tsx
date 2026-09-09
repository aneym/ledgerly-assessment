import type { Metadata } from "next";
import { PageHead } from "@/components/seller/PageHead";
import { currentSeller, type SearchParams } from "@/lib/seller/current";
import { chargeModelSentence } from "@/lib/seller/identity";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const seller = await currentSeller(searchParams);
  const rows: Array<[string, string]> = [
    ["Display name", seller.name],
    ["Seller id", seller.id],
    ["Handle", seller.handle ? `@${seller.handle}` : "Set after onboarding"],
    ["City", seller.city ?? "From Whop onboarding"],
    ["Charge model", chargeModelSentence(seller.salePolicy)],
  ];

  return (
    <div data-screen="sell.settings" className="mx-auto max-w-[720px]">
      <PageHead
        title="Settings"
        sub="What Ledgerly stores about you. Identity and bank details live on Whop and are edited there."
      />
      <dl className="sl-paper divide-y divide-line px-6 md:px-8">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="sl-grid grid-cols-1 gap-1 py-4 sm:grid-cols-[160px_1fr] sm:gap-6"
          >
            <dt className="text-[13px] text-muted">{label}</dt>
            <dd
              className={`text-[14px] text-ink ${label === "Seller id" ? "font-mono text-[13px]" : ""}`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-[12.5px] leading-relaxed text-muted">
        Editing lands with the sellers API. Until then these values come from the session, the
        seller parameter or the demo fixture.
      </p>
    </div>
  );
}
