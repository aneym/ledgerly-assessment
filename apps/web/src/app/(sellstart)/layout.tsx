import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import "@/components/seller/seller.css";

export const metadata: Metadata = { title: "Sell on Ledgerly" };

/** /sell is the public pre-seller landing: storefront chrome, no seller rail. */
export default function SellStartLayout({ children }: { children: React.ReactNode }) {
  return (
    <Shell screen="sell.start" section="sell">
      {children}
    </Shell>
  );
}
