import { err, ok, type Result } from "./result";

export type Currency = "USD" | "EUR" | "BRL";
export type Money = { readonly amountMinor: number; readonly currency: Currency };
export type MoneyError = {
  kind:
    | "invalid_amount"
    | "invalid_currency"
    | "currency_mismatch"
    | "invalid_decimal"
    | "overflow";
};
export function minorUnitScale(_currency: Currency): number {
  return 2;
}
export function money(amountMinor: number, currency: Currency): Result<Money, MoneyError> {
  if (!["USD", "EUR", "BRL"].includes(currency)) return err({ kind: "invalid_currency" });
  if (!Number.isSafeInteger(amountMinor)) return err({ kind: "invalid_amount" });
  return ok({ amountMinor: Object.is(amountMinor, -0) ? 0 : amountMinor, currency });
}
function arithmetic(a: Money, b: Money, subtract: boolean): Result<Money, MoneyError> {
  const left = money(a.amountMinor, a.currency);
  if (!left.ok) return left;
  const right = money(b.amountMinor, b.currency);
  if (!right.ok) return right;
  if (a.currency !== b.currency) return err({ kind: "currency_mismatch" });
  const amount =
    BigInt(a.amountMinor) + (subtract ? -BigInt(b.amountMinor) : BigInt(b.amountMinor));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER))
    return err({ kind: "overflow" });
  return money(Number(amount), a.currency);
}
export const add = (a: Money, b: Money) => arithmetic(a, b, false);
export const subtract = (a: Money, b: Money) => arithmetic(a, b, true);
export function toDecimalString(value: Money): string {
  if (!money(value.amountMinor, value.currency).ok) throw new Error("Invalid Money value");
  const amount = BigInt(value.amountMinor);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
export function fromDecimalString(value: string, currency: Currency): Result<Money, MoneyError> {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) return err({ kind: "invalid_decimal" });
  const [whole = "", fraction = ""] = value.replace(/^-/, "").split(".");
  const amount =
    (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))) * (value.startsWith("-") ? -1n : 1n);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER))
    return err({ kind: "overflow" });
  return money(Number(amount), currency);
}
