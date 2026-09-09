import { computePlatformFee } from "../../../../../packages/core/src/fee";
import { type Money, toDecimalString } from "../../../../../packages/core/src/money";

const PREFIX: Record<Money["currency"], string> = { USD: "$", EUR: "€", BRL: "R$" };

/** "$25.00". Always two decimals, via core's toDecimalString. */
export function formatMoney(value: Money): string {
  return `${PREFIX[value.currency]}${toDecimalString(value)}`;
}

export type FeeSplit = { gross: Money; fee: Money; sellerShare: Money };

/** The 8% split for a listed price. Fixture prices are valid by construction, so a failure is a bug. */
export function feeSplit(gross: Money): FeeSplit {
  const result = computePlatformFee(gross);
  if (!result.ok) throw new Error(`computePlatformFee failed: ${result.error.kind}`);
  return { gross, fee: result.value.fee, sellerShare: result.value.sellerShare };
}
