import { type Money, type MoneyError, money } from "./money";
import { err, ok, type Result } from "./result";
export type FeeError =
  | MoneyError
  | { kind: "invalid_rate" | "invalid_gross" | "fee_not_positive" | "fee_not_less_than_gross" };
// Round half up using integer minor units.
export function computePlatformFee(
  gross: Money,
  rateBps = 800,
): Result<{ fee: Money; sellerShare: Money }, FeeError> {
  const valid = money(gross.amountMinor, gross.currency);
  if (!valid.ok) return valid;
  if (gross.amountMinor <= 0) return err({ kind: "invalid_gross" });
  if (!Number.isSafeInteger(rateBps) || rateBps < 0) return err({ kind: "invalid_rate" });
  const amount = BigInt(gross.amountMinor);
  const fee = (amount * BigInt(rateBps) + 5000n) / 10000n;
  if (fee <= 0n) return err({ kind: "fee_not_positive" });
  if (fee >= amount) return err({ kind: "fee_not_less_than_gross" });
  return ok({
    fee: { amountMinor: Number(fee), currency: gross.currency },
    sellerShare: { amountMinor: Number(amount - fee), currency: gross.currency },
  });
}
