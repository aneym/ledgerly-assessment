import type { Metadata } from "next";
import { Suspense } from "react";
import { IssuesView } from "@/components/operator/issues-view";
import { MOCK_ISSUES_PAGE, MOCK_SELLERS } from "@/lib/operator/fixtures";

export const metadata: Metadata = { title: "Issues, Ledgerly operator" };

/**
 * The issue resolution center. Filters and the selected issue live in the URL query.
 * The client reads GET /api/admin/issues; while it is not live the page says so and
 * shows the MOCK fixture. The demo fault control renders only under DEMO_MODE.
 */
export default function IssuesPage() {
  const demoMode = process.env.DEMO_MODE === "1";
  return (
    <div data-screen="admin.issues" className="tbl-shell">
      <Suspense fallback={null}>
        <IssuesView sellers={MOCK_SELLERS} fixture={MOCK_ISSUES_PAGE} demoMode={demoMode} />
      </Suspense>
    </div>
  );
}
