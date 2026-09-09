import Link from "next/link";
import { formatMoney } from "@/lib/catalog/money";
import type { Product, Seller } from "@/lib/catalog/types";
import { Avatar } from "./avatar";
import { LedgerLine } from "./ledger-line";

type Props = { seller: Seller; products: Product[] };

function policyHint(seller: Seller): string {
  switch (seller.salePolicy) {
    case "direct_charge":
      return "Sells direct";
    case "platform_charge_transfer":
      return "Via Ledgerly";
    case "blocked_onboarding_incomplete":
      return "Onboarding not done";
  }
}

function priceLine(
  seller: Seller,
  products: Product[],
): { label: string; value: string; quiet: boolean } {
  if (seller.salePolicy === "blocked_onboarding_incomplete")
    return { label: "Buying", value: "closed", quiet: true };
  if (products.length === 0) return { label: "Products", value: "none yet", quiet: true };
  const low = products.reduce((a, b) => (a.price.amountMinor <= b.price.amountMinor ? a : b));
  return {
    label: products.length > 1 ? "From" : "Price",
    value: formatMoney(low.price),
    quiet: false,
  };
}

/** Portrait card for the creators row. */
export function CreatorCard({ seller, products }: Props) {
  const count =
    products.length === 0
      ? "Opening soon"
      : `${products.length} ${products.length === 1 ? "product" : "products"}`;
  const line = priceLine(seller, products);
  return (
    <Link className="cc" href={`/c/${seller.handle}`} data-tour-item={seller.id}>
      <Avatar src={seller.avatar} alt="" size="lg" />
      <div className="name">{seller.name}</div>
      <div className="loc">{seller.city}</div>
      <div className="cnt">{count}</div>
      <div className="pol">{policyHint(seller)}</div>
      <LedgerLine label={line.label} value={line.value} quiet={line.quiet} />
    </Link>
  );
}
