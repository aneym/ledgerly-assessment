import { feeSplit, formatMoney } from "@/lib/catalog/money";
import type { Product, Seller } from "@/lib/catalog/types";
import { Ledger, LedgerLine } from "./ledger-line";

type Props = {
  product: Pick<Product, "price">;
  seller: Pick<Seller, "shortName">;
  /** "keeps" on the product page, "receives" on the featured card. */
  verb?: "keeps" | "receives";
};

/** You pay / Ledgerly fee 8% / seller keeps. The split comes from computePlatformFee. */
export function FeeLedger({ product, seller, verb = "keeps" }: Props) {
  const split = feeSplit(product.price);
  return (
    <Ledger>
      <LedgerLine label="You pay" value={formatMoney(split.gross)} />
      <LedgerLine label="Ledgerly fee, 8%" value={formatMoney(split.fee)} quiet />
      <LedgerLine
        label={`${seller.shortName} ${verb}`}
        value={formatMoney(split.sellerShare)}
        total
      />
    </Ledger>
  );
}
