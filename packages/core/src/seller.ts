import type { RunId, SellerId, WhopAccountId } from "./ids";
import { err, ok, type Result } from "./result";
export type SalePolicy = "direct" | "platform_only";
export type Country = "US" | "DE" | "BR" | "CA" | "KR" | "PT";
export type Seller = {
  id: SellerId;
  runId: RunId;
  externalId: string;
  email: string;
  country: Country;
  whopAccountId: WhopAccountId | null;
  salePolicy: SalePolicy;
  status: "active" | "suspended";
};
export type PolicyError = { kind: "seller_suspended" | "platform_only" };
export function canSellDirect(seller: Seller): Result<true, PolicyError> {
  if (seller.status === "suspended") return err({ kind: "seller_suspended" });
  if (seller.salePolicy === "platform_only") return err({ kind: "platform_only" });
  return ok(true);
}
