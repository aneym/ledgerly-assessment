import { money, type WhopPort } from "@ledgerly/core";
export function validCheckout(
  input: Parameters<WhopPort["createCheckoutConfiguration"]>[0],
): boolean {
  if (!money(input.price.amountMinor, input.price.currency).ok || input.price.amountMinor <= 0)
    return false;
  const fee = input.applicationFee;
  return (
    fee === null ||
    (input.accountId !== null &&
      money(fee.amountMinor, fee.currency).ok &&
      fee.currency === input.price.currency &&
      fee.amountMinor > 0 &&
      fee.amountMinor < input.price.amountMinor)
  );
}
export function validToken(
  input: Parameters<WhopPort["createAccessToken"]>[0],
  now: Date,
): boolean {
  return (
    input.scopedActions.length > 0 &&
    input.scopedActions.every((action) => action.trim().length > 0) &&
    Number.isFinite(input.expiresAt.getTime()) &&
    input.expiresAt.getTime() > now.getTime()
  );
}
