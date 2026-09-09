import type { Metadata } from "next";
import { Suspense } from "react";
import { DevPanelMount } from "@/components/dev/dev-panel-mount";
import { SellerRail } from "@/components/seller/SellerRail";
import { DashboardShell } from "@/components/table";
import { fixtureSellers } from "@/lib/seller/current";
import { ownedSeller } from "@/lib/seller/owned";
import { getSession } from "@/lib/session";
import "@/components/table/table.css";
import "@/components/seller/seller.css";

export const metadata: Metadata = {
  title: { default: "Ledgerly Creator", template: "%s, Ledgerly Creator" },
};

export default async function SellerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const owned = await ownedSeller(session?.userId);
  const fixtures = fixtureSellers();
  return (
    <div className="sl-shell bg-canvas text-ink">
      <Suspense fallback={<aside className="sl-rail" aria-hidden="true" />}>
        <SellerRail session={session} owned={owned} fixtures={fixtures} />
      </Suspense>
      {/* The document is the one vertical scroller: the rail is sticky, main scrolls with the page,
          and every table head and totals row sticks to the viewport at --shell-top (0 here). */}
      <main className="sl-main">
        <div className="mx-auto w-full max-w-[1040px]">
          <DashboardShell shellTop={0}>{children}</DashboardShell>
        </div>
      </main>
      <DevPanelMount />
    </div>
  );
}
