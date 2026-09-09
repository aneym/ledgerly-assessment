import { createHash } from "node:crypto";
import type { OrdersRepo } from "@ledgerly/core";
import { deliveryId, orderId } from "@ledgerly/core";
import type {
  InboxRow,
  SellerRepo,
  UnitOfWork,
} from "../../../../../packages/core/src/services/ports";
import { signStandardWebhook } from "../../../../../packages/whop/src/webhooks";
import type { createDeliveryInbox } from "./delivery-inbox";
import { actualNodeEnvironment } from "./runtime-environment.server";

export type TestEvent = {
  orderId: string;
  deliveryId: string;
  type: "payment.succeeded" | "refund.created";
  resourceId: string;
  amountMinor: number;
  currency: "USD" | "EUR" | "BRL";
  signatureCase?: "valid" | "tampered" | "stale";
};
export type TestRuntimeConfig = {
  enabled: boolean;
  nodeEnv: string;
  provider: string;
  database: string;
  origin: string;
  runId: string;
  platformAccountId: string;
};
export type RefundScope = Readonly<{ runId: string; orderId: string; paymentId: string }>;
export type RefundSafety = {
  /** Establish or verify an enforced guarantee for the entire order lifecycle, including
   * future ordinary refunds. A request-local mutex or caller assertion is insufficient.
   * Return null when the runtime cannot enforce that guarantee. Never release it after POST. */
  ensure(scope: RefundScope): Promise<
    | (RefundScope & {
        guarantee: "lifecycle_isolated" | "durable_refund_invariant";
      })
    | null
  >;
};
type Dependencies = {
  config: TestRuntimeConfig;
  authenticate(request: Request): Promise<{ userId: string; runId: string } | null>;
  orders: Pick<OrdersRepo, "get">;
  sellers: Pick<SellerRepo, "get">;
  uow: Pick<UnitOfWork, "exclusive" | "run">;
  inbox: ReturnType<typeof createDeliveryInbox>;
  // Explicit null keeps refund injection disabled. No adapter is implemented by this lane.
  refundSafety: RefundSafety | null;
  // Adapter reads the persisted inbox row; core's InboxRepo omits error and throws on absence.
  readDelivery(id: string): Promise<{ row: InboxRow; error: string | null } | null>;
  webhookSecret(): string;
  now(): Date;
};
const label = /^[A-Za-z0-9_-]{1,100}$/;
const allowed = new Set([
  "orderId",
  "deliveryId",
  "type",
  "resourceId",
  "amountMinor",
  "currency",
  "signatureCase",
]);
function parse(value: unknown): TestEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (
    Object.keys(o).some((key) => !allowed.has(key)) ||
    ![o.orderId, o.deliveryId, o.resourceId].every((s) => typeof s === "string" && label.test(s)) ||
    typeof o.type !== "string" ||
    !["payment.succeeded", "refund.created"].includes(o.type) ||
    !Number.isSafeInteger(o.amountMinor) ||
    Number(o.amountMinor) < 1 ||
    typeof o.currency !== "string" ||
    !["USD", "EUR", "BRL"].includes(o.currency) ||
    (o.signatureCase !== undefined &&
      (typeof o.signatureCase !== "string" ||
        !["valid", "tampered", "stale"].includes(o.signatureCase)))
  )
    return null;
  return o as TestEvent;
}
function digest(parts: string[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
function failure(error: string, status: number) {
  return reply({ error }, status);
}
const safeErrors = new Set([
  "partial_refund_unsupported",
  "invalid_amount",
  "payment_not_posted",
  "invalid_resource",
  "invalid_status",
  "seller_mismatch",
  "unknown_seller",
]);

/** Source-only handlers. The runtime owner must inject only its local mock pipeline.
 * Checkout/payment creation belongs to the existing checkout control. */
export function createTestEventHandlers(deps: Dependencies) {
  const config = Object.freeze({ ...deps.config });
  let origin: URL;
  try {
    origin = new URL(config.origin);
  } catch {
    throw new Error("invalid_local_origin");
  }
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    !origin.port ||
    origin.origin !== config.origin ||
    !label.test(config.runId)
  ) {
    throw new Error("invalid_local_origin");
  }
  const guard = async (request: Request) => {
    if (
      !config.enabled ||
      !["development", "test"].includes(config.nodeEnv) ||
      actualNodeEnvironment() === "production" ||
      config.provider !== "mock" ||
      config.database !== "pglite"
    ) {
      return failure("not_found", 404);
    }
    if (
      new URL(request.url).origin !== config.origin ||
      request.headers.get("host") !== origin.host ||
      request.headers.get("origin") !== config.origin
    )
      return failure("forbidden_origin", 403);
    const principal = await deps.authenticate(request);
    if (!principal) return failure("unauthenticated", 401);
    if (principal.runId !== config.runId) return failure("not_found", 404);
    return principal;
  };
  async function ownedOrder(id: string, userId: string) {
    const parsed = orderId(id);
    if (!parsed.ok) return null;
    const order = await deps.orders.get(parsed.value);
    if (
      !order ||
      order.runId !== config.runId ||
      order.buyerUserId !== userId ||
      order.provenance !== "mock" ||
      !order.paymentId ||
      !order.checkoutConfigurationId
    )
      return null;
    const seller = await deps.sellers.get(order.sellerId);
    if (!seller?.whopAccountId || seller.runId !== config.runId) return null;
    return { order, seller };
  }
  function idFor(order: string, delivery: string) {
    return `local_test_${digest([config.runId, order, delivery])}`;
  }
  async function result(id: string, order: string, user: string, duplicate?: boolean) {
    const stored = await deps.readDelivery(id);
    if (!stored) return failure("not_found", 404);
    const raw = JSON.parse(stored.row.envelope.rawBody) as Record<string, unknown>;
    const correlation = raw.local_test as Record<string, unknown> | undefined;
    if (
      stored.row.deliveryId !== id ||
      !correlation ||
      correlation.runId !== config.runId ||
      correlation.orderId !== order ||
      correlation.userId !== user
    )
      return failure("not_found", 404);
    return reply({
      delivery_id: id,
      order_id: order,
      run_id: config.runId,
      provenance: "mock",
      status: stored.row.status,
      terminal: stored.row.status !== "received",
      ...(duplicate === undefined ? {} : { duplicate }),
      ...(stored.error
        ? { error: safeErrors.has(stored.error) ? stored.error : "processing_failed" }
        : {}),
    });
  }
  return {
    async post(request: Request) {
      const principal = await guard(request);
      if (principal instanceof Response) return principal;
      if (request.method !== "POST") return failure("method_not_allowed", 405);
      // Bound the stream before parsing, including requests without Content-Length.
      const reader = request.body?.getReader();
      if (!reader) return failure("invalid_event", 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return failure("event_too_large", 413);
        }
        chunks.push(next.value);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return failure("invalid_event", 400);
      }
      const event = parse(body);
      if (!event) return failure("invalid_event", 400);
      return deps.uow.exclusive(`local-test:${config.runId}:${event.orderId}`, async () => {
        const owned = await ownedOrder(event.orderId, principal.userId);
        if (!owned) return failure("not_found", 404);
        const { order, seller } = owned;
        if (event.type === "refund.created") {
          const scope = Object.freeze({
            runId: config.runId,
            orderId: order.id,
            paymentId: order.paymentId ?? "",
          });
          // Missing, throwing or incorrectly scoped adapters fail before any signing or inbox work.
          let safety: Awaited<ReturnType<RefundSafety["ensure"]>> = null;
          try {
            safety = (await deps.refundSafety?.ensure(scope)) ?? null;
          } catch {
            /* Fail closed. */
          }
          if (
            !safety ||
            !["lifecycle_isolated", "durable_refund_invariant"].includes(safety.guarantee) ||
            safety.runId !== scope.runId ||
            safety.orderId !== scope.orderId ||
            safety.paymentId !== scope.paymentId
          ) {
            return failure("refund_safety_required", 409);
          }
        }
        if (
          event.type === "payment.succeeded" &&
          (event.resourceId !== order.paymentId ||
            event.amountMinor !== order.gross.amountMinor ||
            event.currency !== order.gross.currency)
        ) {
          return failure("payment_replay_required", 409);
        }
        const id = idFor(order.id, event.deliveryId);
        const resource =
          event.type === "payment.succeeded"
            ? order.paymentId
            : `rf_local_${digest([config.runId, order.id, order.paymentId ?? ""])}`;
        if (event.type === "refund.created" && String(order.status) === "refunded") {
          const entries = await deps.uow.run((r) => r.ledger.forSeller(order.sellerId));
          if (
            !entries.some(
              (entry) => entry.resourceType === "refund" && entry.resourceId === resource,
            )
          ) {
            return failure("already_refunded", 409);
          }
        }
        // One full refund per durable payment, regardless of caller labels.
        const fingerprint = digest([
          event.orderId,
          event.deliveryId,
          event.type,
          event.resourceId,
          String(event.amountMinor),
          event.currency,
          event.signatureCase ?? "valid",
        ]);
        const previous = await deps.readDelivery(id);
        if (previous) {
          const raw = JSON.parse(previous.row.envelope.rawBody) as {
            local_test?: { fingerprint?: string };
          };
          if (raw.local_test?.fingerprint !== fingerprint) return failure("delivery_conflict", 409);
        }
        const now = deps.now();
        const timestamp = String(
          Math.floor(now.getTime() / 1000) - (event.signatureCase === "stale" ? 600 : 0),
        );
        const rawBody = JSON.stringify({
          id,
          type: event.type,
          api_version: "v1",
          api_version_date: "2026-08-21",
          timestamp: now.toISOString(),
          account_id: order.flow === "direct" ? seller.whopAccountId : config.platformAccountId,
          local_test: {
            runId: config.runId,
            orderId: order.id,
            userId: principal.userId,
            fingerprint,
          },
          data: {
            id: resource,
            payment_id: order.paymentId,
            checkout_configuration_id: order.checkoutConfigurationId,
            amount_minor: String(event.amountMinor),
            currency: event.currency.toLowerCase(),
          },
        });
        const secret = deps.webhookSecret();
        const signature = signStandardWebhook({ rawBody, id, timestamp, secret });
        const received = await deps.inbox.receiveWebhook({
          rawBody: event.signatureCase === "tampered" ? `${rawBody} ` : rawBody,
          secret,
          now,
          headers: {
            "webhook-id": id,
            "webhook-timestamp": timestamp,
            "webhook-signature": signature,
          },
        });
        if (!received.ok)
          return reply(
            { delivery_id: id, provenance: "mock", status: "rejected", error: received.error.kind },
            422,
          );
        const parsedDelivery = deliveryId(id);
        if (!parsedDelivery.ok) throw new Error("invalid_generated_delivery");
        await deps.inbox.processDelivery(parsedDelivery.value);
        return result(id, order.id, principal.userId, received.value.duplicate);
      });
    },
    async get(request: Request) {
      const principal = await guard(request);
      if (principal instanceof Response) return principal;
      if (request.method !== "GET") return failure("method_not_allowed", 405);
      const params = new URL(request.url).searchParams;
      const order = params.get("orderId") ?? "";
      const id = params.get("deliveryId") ?? "";
      if (!label.test(order) || !/^local_test_[a-f0-9]{64}$/.test(id))
        return failure("invalid_delivery", 400);
      if (!(await ownedOrder(order, principal.userId))) return failure("not_found", 404);
      return result(id, order, principal.userId);
    },
  };
}
