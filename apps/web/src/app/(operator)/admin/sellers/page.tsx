import type { Metadata } from "next";
import { RouteState } from "@/components/operator/route-state";
import { SellersTable } from "@/components/operator/sellers-table";
import { ProvenanceBadge } from "@/components/provenance-badge";
import { PageHeader } from "@/components/table";
import { MOCK_SELLERS } from "@/lib/operator/fixtures";
import { readSellers } from "@/lib/operator/sellers-server";

export const metadata: Metadata = { title: "Sellers, Ledgerly operator" };

/** Real sellers from GET /api/sellers, read with the operator session; the fixture list while that route is not live. */
export default async function SellersPage() {
  const read = await readSellers();
  const live = read.kind === "live";
  const sellers = live ? read.sellers : MOCK_SELLERS;
  const direct = sellers.filter((seller) => seller.sale_policy === "direct").length;
  const provenance = live ? read.provenance : "mock";
  return (
    <div data-screen="admin.sellers" className="tbl-shell">
      <PageHeader
        title="Sellers"
        lede={
          <>
            <b>{sellers.length} sellers.</b> {direct} sell direct, {sellers.length - direct} sell
            through Ledgerly. Policy, capability, transfer and withdrawal eligibility are separate
            gates and stay separate here.
          </>
        }
        aside={<ProvenanceBadge provenance={provenance} />}
      />
      {read.kind === "miss" && (
        <div className="op-source">
          <RouteState kind="miss" miss={read.miss} />
          <span>Showing the fixture list in its place.</span>
        </div>
      )}
      <SellersTable
        initial={sellers}
        foot={{
          left: `${sellers.length} ${sellers.length === 1 ? "seller" : "sellers"}`,
          right: provenance === "mock" ? "" : provenance.toUpperCase(),
        }}
      />
    </div>
  );
}
