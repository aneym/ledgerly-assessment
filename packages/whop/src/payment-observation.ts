import {
  type ConfirmedPaymentRead,
  err,
  fromDecimalString,
  ok,
  type PaymentConfirmationError,
  type PaymentObservation,
  type Result,
  type WhopPort,
  whopAccountId,
  whopPaymentId,
} from "@ledgerly/core";
import { z } from "zod";

const currency = z.enum(["usd", "eur", "brl", "USD", "EUR", "BRL"]);
const amount = z.object({ amount: z.string(), currency });
// Captured GET /payments response, run-2026-09-08d; nullable bindings fail closed.
const schema = z.object({
  id: z.string().regex(/^pay_[A-Za-z0-9]+$/),
  account_id: z.string().regex(/^biz_[A-Za-z0-9]+$/),
  checkout_configuration_id: z.string().regex(/^ch_[A-Za-z0-9]+$/),
  total: amount,
  currency,
  refunded_amount: amount,
  tax_refunded_amount: amount,
  status: z.string().min(1),
  substatus: z.string().min(1),
  paid_at: z.iso.datetime({ offset: true }),
  refunded_at: z.iso.datetime({ offset: true }).nullable(),
  auto_refunded: z.boolean(),
  metadata: z.object({
    order_id: z.string().min(1).optional(),
    seller_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
  }),
});
export function decodePaymentObservation(
  raw: unknown,
): Result<PaymentObservation, PaymentConfirmationError> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return err({ kind: "invalid_observation" });
  const p = parsed.data;
  const code = p.currency.toUpperCase() as "USD" | "EUR" | "BRL";
  const gross = fromDecimalString(p.total.amount, code);
  const refunded = fromDecimalString(p.refunded_amount.amount, code);
  const taxRefunded = fromDecimalString(p.tax_refunded_amount.amount, code);
  const paymentId = whopPaymentId(p.id);
  const accountId = whopAccountId(p.account_id);
  if (
    !gross.ok ||
    !refunded.ok ||
    !taxRefunded.ok ||
    !paymentId.ok ||
    !accountId.ok ||
    gross.value.amountMinor <= 0 ||
    refunded.value.amountMinor < 0 ||
    taxRefunded.value.amountMinor !== 0 ||
    p.tax_refunded_amount.currency.toUpperCase() !== code ||
    p.total.currency.toUpperCase() !== code ||
    p.refunded_amount.currency.toUpperCase() !== code
  )
    return err({ kind: "invalid_observation" });
  return ok({
    paymentId: paymentId.value,
    accountId: accountId.value,
    checkoutId: p.checkout_configuration_id,
    gross: gross.value,
    refunded: refunded.value,
    status: p.status,
    substatus: p.substatus,
    paidAt: new Date(p.paid_at),
    refundedAt: p.refunded_at === null ? null : new Date(p.refunded_at),
    autoRefunded: p.auto_refunded,
    metadata: {
      ...(p.metadata.order_id === undefined ? {} : { order_id: p.metadata.order_id }),
      ...(p.metadata.seller_id === undefined ? {} : { seller_id: p.metadata.seller_id }),
      ...(p.metadata.run_id === undefined ? {} : { run_id: p.metadata.run_id }),
    },
  });
}
const sourceSchema = z.object({ meta: z.object({ source: z.literal("sandbox") }) });
const accountSchema = z.object({
  id: z.string(),
  raw: z.object({ id: z.string(), parent_account: z.object({ id: z.string() }) }),
});

// The hybrid adapter attaches routing metadata. Missing metadata is
// not evidence of sandbox I/O; direct fixtures and mock fallback results are rejected here.
export function createPaymentObservationReader(
  provider: Pick<WhopPort, "getPayment" | "getAccount">,
  now: () => Date,
) {
  return async (input: {
    paymentId: PaymentObservation["paymentId"];
    sellerAccountId: ConfirmedPaymentRead["sellerAccountId"];
  }): Promise<Result<ConfirmedPaymentRead, PaymentConfirmationError>> => {
    const payment = await provider.getPayment(
      input.paymentId,
      `confirm-payment:${input.paymentId}`,
    );
    if (!payment.ok) return err({ kind: "provider_read_failed" });
    if (!sourceSchema.safeParse(payment.value).success) return err({ kind: "source_unverified" });
    const observation = decodePaymentObservation(payment.value.raw);
    if (!observation.ok) return observation;
    if (payment.value.id !== input.paymentId || observation.value.paymentId !== input.paymentId)
      return err({ kind: "binding_mismatch" });
    const account = await provider.getAccount(
      input.sellerAccountId,
      `confirm-account:${input.paymentId}`,
    );
    if (!account.ok) return err({ kind: "provider_read_failed" });
    if (!sourceSchema.safeParse(account.value).success) return err({ kind: "source_unverified" });
    const decoded = accountSchema.safeParse(account.value);
    if (!decoded.success) return err({ kind: "invalid_observation" });
    const parent = whopAccountId(decoded.data.raw.parent_account.id);
    if (
      !parent.ok ||
      decoded.data.id !== input.sellerAccountId ||
      decoded.data.raw.id !== input.sellerAccountId
    )
      return err({ kind: "binding_mismatch" });
    return ok({
      ...observation.value,
      sellerAccountId: input.sellerAccountId,
      parentAccountId: parent.value,
      source: "sandbox",
      observedAt: now(),
    });
  };
}
