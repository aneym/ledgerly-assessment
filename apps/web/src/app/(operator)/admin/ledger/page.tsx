import type { Metadata } from "next";
import { Suspense } from "react";
import { LedgerView } from "@/components/operator/ledger-view";
import { MOCK_ISSUES, MOCK_LEDGER, MOCK_SELLERS } from "@/lib/operator/fixtures";
import { readSellers } from "@/lib/operator/sellers-server";

export const metadata: Metadata = { title: "Ledger, Ledgerly operator" };

/**
 * The platform ledger. The page reads GET /api/sellers with the operator session so the
 * business picker and the Reconcile control work on real seller ids; the fixture list
 * stands in only while that route is not live, and says so. Filters live in the URL
 * query and the client reads GET /api/admin/ledger with them.
 */
export default async function LedgerPage() {
  const read = await readSellers();
  const sellers = read.kind === "live" ? read.sellers : MOCK_SELLERS;
  return (
    <div data-screen="admin.ledger" className="tbl-shell">
      <Suspense fallback={null}>
        <LedgerView
          sellers={sellers}
          sellersRead={read.kind === "live" ? { live: true } : { live: false, miss: read.miss }}
          fixture={MOCK_LEDGER}
          issues={MOCK_ISSUES}
        />
      </Suspense>
    </div>
  );
}
