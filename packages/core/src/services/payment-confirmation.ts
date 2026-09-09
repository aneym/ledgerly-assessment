import { effectKey } from "../effects";
import { deliveryId, type OrderId, type WhopAccountId, type WhopPaymentId } from "../ids";
import { type Money, subtract } from "../money";
import { err, ok, type Result } from "../result";
import type { Order } from "./orders";
import type { Clock, LedgerEntry, Repositories, Seller, UnitOfWork } from "./ports";

export type PaymentObservation = {
  paymentId: WhopPaymentId;
  accountId: WhopAccountId;
  checkoutId: string;
  gross: Money;
  refunded: Money;
  status: string;
  substatus: string;
  paidAt: Date;
  refundedAt: Date | null;
  autoRefunded: boolean;
  metadata: { order_id?: string; seller_id?: string; run_id?: string };
};
export type ConfirmedPaymentRead = PaymentObservation & {
  source: "sandbox";
  sellerAccountId: WhopAccountId;
  parentAccountId: WhopAccountId;
  observedAt: Date;
};
export type PaymentConfirmationError = {
  kind:
    | "not_found"
    | "forbidden"
    | "not_available"
    | "binding_mismatch"
    | "payment_not_paid"
    | "payment_refunded"
    | "amount_mismatch"
    | "source_unverified"
    | "provider_read_failed"
    | "invalid_observation"
    | "invariant_conflict";
};
export type PaymentConfirmationInput = {
  orderId: OrderId;
  paymentId: WhopPaymentId;
  buyerUserId: string;
};
export type PaymentConfirmationResult = Result<
  {
    orderId: OrderId;
    paymentId: WhopPaymentId;
    status: "paid";
    provenance: "sandbox";
    duplicate: boolean;
  },
  PaymentConfirmationError
>;
type Snapshot = { order: Order; seller: Seller };
class ConfirmationConflict extends Error {}

function sameMoney(a: Money, b: Money): boolean {
  return a.amountMinor === b.amountMinor && a.currency === b.currency;
}
async function snapshot(
  r: Repositories,
  input: PaymentConfirmationInput,
): Promise<Result<Snapshot, PaymentConfirmationError>> {
  if (!r.orders.forPaymentConfirmation || !r.ledger.forPaymentConfirmation)
    return err({ kind: "not_available" });
  const order = await r.orders.forPaymentConfirmation(input.orderId);
  if (!order) return err({ kind: "not_found" });
  if (!input.buyerUserId || order.buyerUserId !== input.buyerUserId)
    return err({ kind: "forbidden" });
  if (
    order.provenance !== "sandbox" ||
    !order.checkoutConfigurationId ||
    !["checkout_created", "paid"].includes(order.status)
  )
    return err({ kind: "not_available" });
  if (order.paymentId !== null && order.paymentId !== input.paymentId)
    return err({ kind: "binding_mismatch" });
  const seller = await r.sellers.get(order.sellerId);
  if (!seller?.whopAccountId || seller.runId !== order.runId)
    return err({ kind: "binding_mismatch" });
  return ok({ order, seller });
}
function validate(
  read: ConfirmedPaymentRead,
  state: Snapshot,
  input: PaymentConfirmationInput,
  platform: WhopAccountId,
): Result<true, PaymentConfirmationError> {
  const { order, seller } = state;
  if (read.source !== "sandbox") return err({ kind: "source_unverified" });
  if (
    read.paymentId !== input.paymentId ||
    read.checkoutId !== order.checkoutConfigurationId ||
    read.accountId !== (order.flow === "platform_transfer" ? platform : seller.whopAccountId) ||
    read.sellerAccountId !== seller.whopAccountId ||
    read.parentAccountId !== platform ||
    (read.metadata.order_id !== undefined && read.metadata.order_id !== order.id) ||
    (read.metadata.seller_id !== undefined && read.metadata.seller_id !== order.sellerId) ||
    (read.metadata.run_id !== undefined && read.metadata.run_id !== order.runId)
  )
    return err({ kind: "binding_mismatch" });
  if (read.status !== "paid" || read.substatus !== "succeeded")
    return err({ kind: "payment_not_paid" });
  if (read.autoRefunded || read.refundedAt !== null || read.refunded.amountMinor !== 0)
    return err({ kind: "payment_refunded" });
  if (!sameMoney(read.gross, order.gross) || read.refunded.currency !== order.gross.currency)
    return err({ kind: "amount_mismatch" });
  if (!Number.isFinite(read.paidAt.getTime()) || !Number.isFinite(read.observedAt.getTime()))
    return err({ kind: "invalid_observation" });
  return ok(true);
}
function exactPostedPair(entries: LedgerEntry[], order: Order, paymentId: string): boolean {
  const key = effectKey("payment", paymentId, "succeeded");
  const share = subtract(order.gross, order.fee);
  if (!share.ok || entries.length !== 2) return false;
  if (
    entries.some(
      (e) =>
        e.runId !== order.runId ||
        e.sellerId !== order.sellerId ||
        e.resourceId !== paymentId ||
        e.resourceType !== "payment" ||
        e.effectKey !== key ||
        e.provenance !== "sandbox",
    )
  )
    return false;
  const seller = entries.find((e) => e.accountSide === "seller" && e.kind === "payment");
  const platform = entries.find((e) => e.accountSide === "platform" && e.kind === "fee");
  return (
    !!seller &&
    !!platform &&
    sameMoney(seller.amount, share.value) &&
    sameMoney(platform.amount, order.fee)
  );
}

// A provider read authorizes only this stored checkout's canonical payment effect.
// Network reads happen outside the transaction; every local binding is checked again under lock.
export function createPaymentConfirmationService(deps: {
  uow: UnitOfWork;
  platformAccountId: WhopAccountId;
  clock: Clock;
  readPayment: (input: {
    paymentId: WhopPaymentId;
    sellerAccountId: WhopAccountId;
  }) => Promise<Result<ConfirmedPaymentRead, PaymentConfirmationError>>;
}) {
  return async (input: PaymentConfirmationInput): Promise<PaymentConfirmationResult> => {
    const initial = await deps.uow.run((r) => snapshot(r, input));
    if (!initial.ok) return initial;
    const sellerAccountId = initial.value.seller.whopAccountId;
    if (!sellerAccountId) return err({ kind: "binding_mismatch" });
    const read = await deps.readPayment({ paymentId: input.paymentId, sellerAccountId });
    if (!read.ok) return read;
    const checked = validate(read.value, initial.value, input, deps.platformAccountId);
    if (!checked.ok) return checked;
    try {
      return await deps.uow.run(async (r): Promise<PaymentConfirmationResult> => {
        const current = await snapshot(r, input);
        if (!current.ok) return current;
        const { order, seller } = current.value;
        if (
          order.sellerId !== initial.value.order.sellerId ||
          order.runId !== initial.value.order.runId ||
          order.flow !== initial.value.order.flow ||
          !sameMoney(order.fee, initial.value.order.fee)
        )
          return err({ kind: "binding_mismatch" });
        const rechecked = validate(read.value, current.value, input, deps.platformAccountId);
        if (!rechecked.ok) return rechecked;
        const byPayment = await r.orders.byPaymentId(input.paymentId);
        const byCheckout = await r.orders.byCheckoutConfigurationId(read.value.checkoutId);
        if (
          (byPayment && ("kind" in byPayment || byPayment.id !== order.id)) ||
          byCheckout?.id !== order.id ||
          (order.paymentId !== null && byPayment?.id !== order.id)
        )
          return err({ kind: "binding_mismatch" });
        const posted = await r.ledger.forPaymentConfirmation?.(input.paymentId);
        if (!posted) return err({ kind: "not_available" });
        const duplicate = order.status === "paid";
        if (
          duplicate
            ? order.paymentId !== input.paymentId ||
              !exactPostedPair(posted, order, input.paymentId)
            : posted.length !== 0
        )
          return err({ kind: "invariant_conflict" });
        const share = subtract(order.gross, order.fee);
        if (!share.ok || order.fee.amountMinor <= 0 || share.value.amountMinor <= 0)
          return err({ kind: "invariant_conflict" });
        const key = effectKey("payment", input.paymentId, "succeeded");
        const auditId = deliveryId(`provider_read:${input.paymentId}:${order.id}`);
        if (!auditId.ok) throw new Error("Invalid payment observation audit ID");
        const inserted = await r.effects.insert(
          {
            key,
            deliveryId: auditId.value,
            resourceType: "payment",
            resourceId: input.paymentId,
            transition: "succeeded",
            detail: {
              source: "provider_read",
              order_id: order.id,
              checkout_configuration_id: read.value.checkoutId,
              actor_user_id: input.buyerUserId,
              observed_at: read.value.observedAt.toISOString(),
            },
          },
          deps.clock.now(),
        );
        if (inserted === duplicate) {
          // Inserting an effect for an already-paid order is inconsistent. Throw to roll it back.
          if (inserted) throw new ConfirmationConflict();
          return err({ kind: "invariant_conflict" });
        }
        if (inserted) {
          const base = {
            runId: order.runId,
            sellerId: order.sellerId,
            resourceType: "payment",
            resourceId: input.paymentId,
            effectKey: key,
            occurredAt: read.value.paidAt,
            provenance: "sandbox" as const,
          };
          await r.ledger.append([
            { ...base, accountSide: "seller", amount: share.value, kind: "payment" },
            { ...base, accountSide: "platform", amount: order.fee, kind: "fee" },
          ]);
          await r.ledger.settleOrder(
            seller,
            { orderId: order.id, checkoutId: read.value.checkoutId, paymentId: input.paymentId },
            { paymentId: input.paymentId, status: "paid", provenance: "sandbox" },
          );
          const settled = await r.orders.forPaymentConfirmation?.(order.id);
          const entries = await r.ledger.forPaymentConfirmation?.(input.paymentId);
          if (
            settled?.status !== "paid" ||
            settled.paymentId !== input.paymentId ||
            settled.provenance !== "sandbox" ||
            !entries ||
            !exactPostedPair(entries, settled, input.paymentId)
          )
            throw new ConfirmationConflict();
        }
        return ok({
          orderId: order.id,
          paymentId: input.paymentId,
          status: "paid",
          provenance: "sandbox",
          duplicate,
        });
      });
    } catch (error) {
      if (error instanceof ConfirmationConflict) return err({ kind: "invariant_conflict" });
      throw error;
    }
  };
}
