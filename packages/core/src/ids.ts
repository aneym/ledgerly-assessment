import { err, ok, type Result } from "./result";

declare const brand: unique symbol;
type Id<Name extends string> = string & { readonly [brand]: Name };
export type SellerId = Id<"SellerId">;
export type RunId = Id<"RunId">;
export type OrderId = Id<"OrderId">;
export type WhopAccountId = Id<"WhopAccountId">;
export type WhopPaymentId = Id<"WhopPaymentId">;
export type WhopTransferId = Id<"WhopTransferId">;
export type DeliveryId = Id<"DeliveryId">;
export type EffectKey = Id<"EffectKey">;
export type IdError = { kind: "invalid_id"; prefix: string };

function idConstructor<T extends string>(prefix = "") {
  return (value: string): Result<T, IdError> =>
    value.trim() === value && value.length > prefix.length && value.startsWith(prefix)
      ? ok(value as T)
      : err({ kind: "invalid_id", prefix });
}
export const sellerId = idConstructor<SellerId>();
export const runId = idConstructor<RunId>();
export const orderId = idConstructor<OrderId>();
export const whopAccountId = idConstructor<WhopAccountId>("biz_");
export const whopPaymentId = idConstructor<WhopPaymentId>("pay_");
export const whopTransferId = idConstructor<WhopTransferId>();
export const deliveryId = idConstructor<DeliveryId>();
export const parseEffectKey = idConstructor<EffectKey>();
