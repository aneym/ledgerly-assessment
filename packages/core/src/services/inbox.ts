import { canonicalEventType, effectKey } from "../effects";
import { computePlatformFee } from "../fee";
import { deliveryId } from "../ids";
import { add, fromDecimalString, type Money, money, subtract } from "../money";
import { err, ok, type Result } from "../result";
import type {
  Clock,
  Envelope,
  InboxRow,
  LedgerEntry,
  LedgerRepo,
  Repositories,
  Seller,
  UnitOfWork,
} from "./ports";

export type ReceiveInput = {
  rawBody: string;
  headers: { "webhook-id": string; "webhook-timestamp": string; "webhook-signature": string };
  secret: string;
  now: Date;
};
export type DecodeIssue = { path: string; message: string };
export type DecodeError = { kind: string; issues?: DecodeIssue[]; eventType?: string | null };
export type WebhookDecoder = {
  verifyStandardWebhook(input: ReceiveInput): Result<true, { kind: string }>;
  decodeEnvelope(raw: string, fallbackTimestampSeconds?: string): Result<Envelope, DecodeError>;
};
// A compact, value-free description of why the envelope failed to decode: paths and messages
// only, so the stored error never leaks payload data. Used for the webhook_inbox `error` column.
function describeDecodeError(error: DecodeError): string {
  if (!error.issues || error.issues.length === 0) return error.kind;
  return error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}
// A placeholder envelope for a delivery whose body could not be decoded. It carries just enough
// to satisfy the not-null inbox columns; the row is stored as "failed" and processInbox never
// looks at it again, so these values are never read as real seller/money data.
function undecodableEnvelope(rawBody: string, error: DecodeError): Envelope {
  const eventType = error.eventType ?? "undecodable";
  return {
    accountId: "",
    originalAccountField: "account_id",
    eventType,
    apiVersionDate: "",
    rawBody,
    raw: { type: eventType, timestamp: 0 },
  };
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function amount(data: Record<string, unknown>, version: string): Money | null {
  const currency = typeof data.currency === "string" ? data.currency.toUpperCase() : "";
  if (currency !== "USD" && currency !== "EUR" && currency !== "BRL") return null;
  let parsed: ReturnType<typeof money>;
  if (version >= "2026-08-21") {
    if (typeof data.amount_minor !== "string" || !/^\d+$/.test(data.amount_minor)) return null;
    parsed = money(Number(data.amount_minor), currency);
  } else {
    if (typeof data.amount !== "string" && typeof data.amount !== "number") return null;
    parsed = fromDecimalString(String(data.amount), currency);
  }
  return parsed.ok && parsed.value.amountMinor > 0 ? parsed.value : null;
}
function negative(value: Money): Money {
  const result = subtract({ amountMinor: 0, currency: value.currency }, value);
  if (!result.ok) throw new Error("Invalid ledger debit");
  return result.value;
}
async function entriesFor(
  r: Repositories,
  row: InboxRow,
  seller: Seller,
  provenance: "sandbox" | "mock",
  platformAccountId: string | undefined,
) {
  const type = canonicalEventType(row.envelope.eventType);
  const supported = [
    "payment.succeeded",
    "refund.created",
    "transfer.completed",
    "payout.created",
    "payout.updated",
  ];
  if (!supported.includes(type)) return ok(null);
  const data = object(row.envelope.raw.data);
  if (!data || typeof data.id !== "string" || !data.id || data.id.includes(":"))
    return err({ kind: "invalid_resource" as const });
  const resourceType = type.split(".")[0];
  if (!resourceType) throw new Error("Event has no resource type");
  let transition = type.split(".")[1] ?? "";
  if (resourceType === "payout") {
    // Current Whop vocabulary (requested/in_review/processing/completed/reversed/
    // canceled/failed/denied) plus the original five (pending/in_transit/completed/
    // failed/canceled) this inbox shipped with, so a payload recorded against the old
    // vocabulary still replays. Only "completed" ever debits the balance, below.
    const PAYOUT_STATUSES = [
      "requested",
      "in_review",
      "processing",
      "completed",
      "reversed",
      "canceled",
      "failed",
      "denied",
      "pending",
      "in_transit",
    ];
    if (typeof data.status !== "string" || !PAYOUT_STATUSES.includes(data.status))
      return err({ kind: "invalid_status" as const });
    transition = data.status;
  }
  const key = effectKey(resourceType, data.id, transition);
  const occurredAt = new Date(
    typeof row.envelope.raw.timestamp === "number"
      ? row.envelope.raw.timestamp * 1000
      : row.envelope.raw.timestamp,
  );
  if (!Number.isFinite(occurredAt.getTime())) return err({ kind: "invalid_timestamp" as const });
  const base = {
    runId: seller.runId,
    sellerId: seller.id,
    resourceType,
    resourceId: data.id,
    effectKey: key,
    occurredAt,
    provenance,
  };
  const entries: LedgerEntry[] = [];
  let detail: Record<string, unknown> | undefined;
  let orderTransition: Parameters<LedgerRepo["settleOrder"]> | undefined;
  const post = (side: "seller" | "platform", value: Money, kind: string) =>
    entries.push({ ...base, accountSide: side, amount: value, kind });
  if (resourceType === "payment" || resourceType === "refund") {
    const metadata = object(data.metadata);
    const paymentId =
      resourceType === "payment"
        ? data.id
        : typeof data.payment_id === "string"
          ? data.payment_id
          : undefined;
    orderTransition = [
      seller,
      {
        ...(paymentId ? { paymentId } : {}),
        ...(typeof data.checkout_configuration_id === "string"
          ? { checkoutId: data.checkout_configuration_id }
          : {}),
        ...(typeof metadata?.order_id === "string" ? { orderId: metadata.order_id } : {}),
      },
      {
        ...(paymentId ? { paymentId } : {}),
        status: resourceType === "payment" ? "paid" : "refunded",
        provenance,
      },
    ];
    const settlement = await r.ledger.resolveOrder(orderTransition[0], orderTransition[1], {
      requirePostedPayment:
        resourceType === "refund" && row.envelope.accountId === platformAccountId,
    });
    if (!settlement.matched) {
      detail = { unmatched_order: true };
      orderTransition = undefined;
    }
    const order = settlement.allocation;
    if (resourceType === "refund" && !order) return err({ kind: "payment_not_posted" as const });
    const gross = order?.gross ?? amount(data, row.envelope.apiVersionDate);
    if (!gross) return err({ kind: "invalid_amount" as const });
    let allocation: { fee: Money; sellerShare: Money };
    if (order) {
      const share = subtract(order.gross, order.fee);
      if (!share.ok || order.fee.amountMinor <= 0 || share.value.amountMinor <= 0)
        return err({ kind: "invalid_order_allocation" as const });
      allocation = { fee: order.fee, sellerShare: share.value };
    } else {
      const calculated = computePlatformFee(gross);
      if (!calculated.ok) return calculated;
      allocation = calculated.value;
    }
    if (resourceType === "refund") {
      const refund = amount(data, row.envelope.apiVersionDate);
      if (!refund || refund.currency !== gross.currency || refund.amountMinor !== gross.amountMinor)
        return err({ kind: "partial_refund_unsupported" as const });
    }
    post(
      "seller",
      resourceType === "refund" ? negative(allocation.sellerShare) : allocation.sellerShare,
      resourceType === "refund" ? "refund" : "payment",
    );
    post(
      "platform",
      resourceType === "refund" ? negative(allocation.fee) : allocation.fee,
      resourceType === "refund" ? "refund_fee" : "fee",
    );
  } else {
    const value = amount(data, row.envelope.apiVersionDate);
    if (!value) return err({ kind: "invalid_amount" as const });
    if (resourceType === "transfer") {
      if (data.destination_id !== undefined && data.destination_id !== seller.whopAccountId)
        return err({ kind: "seller_mismatch" as const });
      post("platform", negative(value), "transfer");
      post("seller", value, "transfer");
    } else {
      // Status observations never replace older rows. Only completed debits the balance.
      post(
        "seller",
        transition === "completed" ? negative(value) : { ...value, amountMinor: 0 },
        `payout_${transition}`,
      );
    }
  }
  // Check the allocation sum through the money functions, not floating point arithmetic.
  if (entries.length === 2) {
    const [first, second] = entries;
    if (!first || !second || !add(first.amount, second.amount).ok)
      throw new Error("Invalid ledger allocation");
  }
  return ok({
    effect: {
      key,
      deliveryId: row.deliveryId,
      resourceType,
      resourceId: data.id,
      transition,
      ...(detail ? { detail } : {}),
    },
    entries,
    orderTransition,
  });
}
async function resolveSeller(
  r: Repositories,
  envelope: Envelope,
  platformAccountId: string | undefined,
): Promise<Seller | null> {
  const type = canonicalEventType(envelope.eventType);
  if (type !== "payment.succeeded" && type !== "refund.created")
    return r.sellers.byAccount(envelope.accountId);
  const data = object(envelope.raw.data);
  const metadata = object(data?.metadata);
  if (!data) return null;
  const paymentId = type === "refund.created" ? data.payment_id : data.id;
  const checkoutId = data.checkout_configuration_id;
  const orderId = metadata?.order_id;
  const sellerId = metadata?.seller_id;
  const paymentOrder = typeof paymentId === "string" ? await r.orders.byPaymentId(paymentId) : null;
  if (paymentOrder && "kind" in paymentOrder) return null;
  if (!platformAccountId || envelope.accountId !== platformAccountId) {
    // A seller-account signature cannot authorize a platform order, even when its
    // payment or checkout reference belongs to that seller.
    const referenced = [
      paymentOrder,
      typeof checkoutId === "string" ? await r.orders.byCheckoutConfigurationId(checkoutId) : null,
      typeof orderId === "string" ? await r.orders.byId(orderId) : null,
    ];
    if (referenced.some((order) => order?.flow === "platform_transfer")) return null;
    return r.sellers.byAccount(envelope.accountId);
  }
  if (
    typeof paymentId !== "string" ||
    !paymentId ||
    [checkoutId, orderId, sellerId].some(
      (id) => id !== undefined && (typeof id !== "string" || !id),
    )
  )
    return null;
  const checkoutOrder =
    typeof checkoutId === "string" ? await r.orders.byCheckoutConfigurationId(checkoutId) : null;
  const hintedOrder = typeof orderId === "string" ? await r.orders.byId(orderId) : null;
  // Every supplied hint must resolve to the same persisted order. A new payment can bind
  // an unbound checkout. A refund for an unbound checkout stays pending until its payment
  // credit exists; processing revalidates any payment identity bound in the meantime.
  const order = paymentOrder ?? checkoutOrder ?? hintedOrder;
  if (
    order?.flow !== "platform_transfer" ||
    (checkoutId !== undefined && checkoutOrder?.id !== order.id) ||
    (orderId !== undefined && hintedOrder?.id !== order.id) ||
    (sellerId !== undefined && sellerId !== order.sellerId) ||
    (order.paymentId !== null && (order.paymentId !== paymentId || paymentOrder?.id !== order.id))
  )
    return null;
  const seller = await r.sellers.get(order.sellerId);
  return seller?.runId === order.runId ? seller : null;
}
export function createInboxService(deps: {
  uow: UnitOfWork;
  clock: Clock;
  decoder: WebhookDecoder;
  // Omitted by legacy callers that only handle seller-account deliveries.
  platformAccountId?: string;
  // Static per-service-instance: "sandbox" for a real (signed) Whop delivery pipeline, "mock"
  // for one wired to the mock adapter. Stamped onto any order a payment/refund effect settles;
  // there is no per-delivery signal to derive this from (the mock adapter's emitWebhook signs
  // envelopes identically to a real delivery).
  provenance: "sandbox" | "mock";
}) {
  return {
    async receiveWebhook(input: ReceiveInput) {
      const verified = deps.decoder.verifyStandardWebhook(input);
      if (!verified.ok) return err({ kind: "signature" as const, reason: verified.error.kind });
      const id = deliveryId(input.headers["webhook-id"]);
      if (!id.ok) return err({ kind: "decode" as const, reason: "invalid_delivery_id" });
      const headers = {
        "webhook-id": input.headers["webhook-id"],
        "webhook-timestamp": input.headers["webhook-timestamp"],
      };
      const decodeResult = deps.decoder.decodeEnvelope(
        input.rawBody,
        input.headers["webhook-timestamp"],
      );
      if (!decodeResult.ok) {
        // The signature already verified, so this is a genuine delivery we cannot decode (e.g.
        // Whop's dashboard "send test event"). Store it so the shape can be diagnosed, and tell
        // Whop we received it so it does not retry forever.
        return deps.uow.run(async (r) => {
          const row: InboxRow = {
            deliveryId: id.value,
            envelope: undecodableEnvelope(input.rawBody, decodeResult.error),
            receivedAt: input.now,
            status: "failed",
          };
          const recorded = await r.inbox.insert(row, headers);
          if (!recorded.duplicate)
            await r.inbox.mark(
              id.value,
              "failed",
              input.now,
              describeDecodeError(decodeResult.error),
            );
          const decoded: boolean = false;
          return ok({ ...recorded, decoded });
        });
      }
      return deps.uow.run(async (r) => {
        const seller = await resolveSeller(r, decodeResult.value, deps.platformAccountId);
        const row: InboxRow = {
          deliveryId: id.value,
          envelope: decodeResult.value,
          receivedAt: input.now,
          status: seller ? "received" : "quarantined",
        };
        const recorded = await r.inbox.insert(row, headers);
        const decoded: boolean = true;
        return ok({ ...recorded, decoded });
      });
    },
    async processInbox({ limit }: { limit: number }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("Inbox limit must be 1 to 1000");
      const rows = await deps.uow.run((r) => r.inbox.pending(limit));
      const counts = { processed: 0, effects: 0, quarantined: 0, skipped: 0, deferred: 0 };
      for (const candidate of rows) {
        const result = await deps.uow.run(async (r) => {
          await r.lock(`inbox:${candidate.deliveryId}`);
          const row = await r.inbox.get(candidate.deliveryId);
          // "failed" is a terminal, undecodable delivery here (see receiveWebhook); it is never
          // retried, so its stored error is not overwritten by a later sweep.
          if (row.status !== "received")
            return { skipped: 1, processed: 0, effects: 0, quarantined: 0, deferred: 0 };
          const seller = await resolveSeller(r, row.envelope, deps.platformAccountId);
          const planned = seller
            ? await entriesFor(r, row, seller, deps.provenance, deps.platformAccountId)
            : err({ kind: "unknown_seller" });
          if (!planned.ok) {
            if (planned.error.kind === "payment_not_posted")
              return { skipped: 0, processed: 0, effects: 0, quarantined: 0, deferred: 1 };
            await r.inbox.mark(row.deliveryId, "quarantined", deps.clock.now(), planned.error.kind);
            return { quarantined: 1, processed: 0, effects: 0, skipped: 0, deferred: 0 };
          }
          let applied = false;
          if (planned.value) {
            applied = await r.effects.insert(planned.value.effect, deps.clock.now());
            if (applied) {
              await r.ledger.append(planned.value.entries);
              if (planned.value.orderTransition)
                await r.ledger.settleOrder(...planned.value.orderTransition);
            }
          }
          await r.inbox.mark(row.deliveryId, "processed", deps.clock.now());
          return {
            processed: 1,
            effects: Number(applied),
            quarantined: 0,
            skipped: 0,
            deferred: 0,
          };
        });
        counts.processed += result.processed;
        counts.effects += result.effects;
        counts.quarantined += result.quarantined;
        counts.skipped += result.skipped;
        counts.deferred += result.deferred;
      }
      return counts;
    },
  };
}
