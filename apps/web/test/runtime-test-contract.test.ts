import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliveryId, orderId, sellerId } from "../../../packages/core/src/ids";
import { createInboxService } from "../../../packages/core/src/services/inbox";
import type { UnitOfWork } from "../../../packages/core/src/services/ports";
import { createTestDb } from "../../../packages/db/src/client";
import { createOrdersRepo } from "../../../packages/db/src/repos/orders";
import { createPgliteUnitOfWork } from "../../../packages/db/src/repos/unit-of-work";
import { orders, sellers } from "../../../packages/db/src/schema";
import { decodeEnvelope } from "../../../packages/whop/src/envelope";
import { signStandardWebhook, verifyStandardWebhook } from "../../../packages/whop/src/webhooks";
import { createDeliveryInbox } from "../src/lib/runtime-test-contract/delivery-inbox";
import { createSourceAttestation } from "../src/lib/runtime-test-contract/source-attestation";
import {
  createTestEventHandlers,
  type TestEvent,
  type TestRuntimeConfig,
} from "../src/lib/runtime-test-contract/test-events";

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error("Expected success");
  return r.value;
}
const origin = "http://127.0.0.1:4474";
const now = new Date("2026-09-09T04:00:00Z");
const oid = value(orderId("order_owned"));
const sid = value(sellerId("seller_owned"));
const config: TestRuntimeConfig = {
  enabled: true,
  nodeEnv: "test",
  provider: "mock",
  database: "pglite",
  origin,
  runId: "run_owned",
  platformAccountId: "biz_platform",
};
let db: Awaited<ReturnType<typeof createTestDb>>;
let uow: UnitOfWork;
let inbox: ReturnType<typeof createInboxService>;
// New random secret on every fixture. Negative cases cannot pass because a fixed key is wrong.
let secret: string;
let principal: { userId: string; runId: string } | null;
let handlers: ReturnType<typeof createTestEventHandlers>;
let diagnosticsRead = 0;

function dependencies() {
  return {
    config,
    // This private in-memory fixture has no ordinary provider refund writer or background processor.
    refundSafety: {
      ensure: async (scope: { runId: string; orderId: string; paymentId: string }) => ({
        ...scope,
        guarantee: "lifecycle_isolated" as const,
      }),
    },
    authenticate: async () => principal,
    orders: createOrdersRepo(db),
    sellers: { get: (id: typeof sid) => uow.run((r) => r.sellers.get(id)) },
    uow,
    inbox: createDeliveryInbox({
      uow,
      clock: { now: () => now },
      decoder: { decodeEnvelope, verifyStandardWebhook },
      platformAccountId: "biz_platform",
    }),
    now: () => now,
    webhookSecret: () => secret,
    async readDelivery(id: string) {
      diagnosticsRead++;
      const found = await db.$client.query<{ error: string | null }>(
        "SELECT error FROM webhook_inbox WHERE delivery_id=$1",
        [id],
      );
      if (!found.rows[0]) return null;
      return {
        row: await uow.run((r) => r.inbox.get(value(deliveryId(id)))),
        error: found.rows[0].error,
      };
    },
  };
}
function event(patch: Partial<TestEvent> = {}): TestEvent {
  return {
    orderId: oid,
    deliveryId: "delivery_1",
    type: "payment.succeeded",
    resourceId: "pay_owned",
    amountMinor: 2500,
    currency: "USD",
    ...patch,
  };
}
function request(body: unknown, headers: Partial<Record<"host" | "origin", string>> = {}) {
  return new Request(`${origin}/test-events`, {
    method: "POST",
    headers: { origin, host: "127.0.0.1:4474", ...headers },
    body: JSON.stringify(body),
  });
}
async function post(patch: Partial<TestEvent> = {}) {
  const response = await handlers.post(request(event(patch)));
  return { status: response.status, body: await response.json() };
}
async function balance() {
  return uow.run((r) => r.ledger.forSeller(sid));
}
async function savedOrder() {
  return createOrdersRepo(db).get(oid);
}
beforeAll(async () => {
  db = await createTestDb();
  uow = createPgliteUnitOfWork(db.$client);
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});
beforeEach(async () => {
  await db.$client.exec(
    "TRUNCATE ledger_entries,business_effects,webhook_inbox,operations,refund_requests,orders,sellers RESTART IDENTITY",
  );
  secret = randomBytes(32).toString("hex");
  principal = { userId: "buyer_owned", runId: "run_owned" };
  diagnosticsRead = 0;
  inbox = createInboxService({
    uow,
    clock: { now: () => now },
    decoder: { decodeEnvelope, verifyStandardWebhook },
    provenance: "mock",
    platformAccountId: "biz_platform",
  });
  await db.insert(sellers).values({
    id: sid,
    runId: "run_owned",
    externalId: "owned",
    email: "owned@example.invalid",
    country: "DE",
    whopAccountId: "biz_owned",
    salePolicy: "platform_only",
  });
  await db.insert(orders).values({
    id: oid,
    sellerId: sid,
    runId: "run_owned",
    productTitle: "Course",
    grossMinor: 2500,
    feeMinor: 200,
    currency: "USD",
    status: "checkout_created",
    flow: "platform_transfer",
    provenance: "mock",
    buyerUserId: "buyer_owned",
    checkoutConfigurationId: "ch_owned",
  });
  // Establish paid state through the real signed decoder, inbox and transactional effect path.
  const rawBody = JSON.stringify({
    id: "initial",
    type: "payment.succeeded",
    api_version: "v1",
    api_version_date: "2026-08-21",
    timestamp: now.toISOString(),
    account_id: "biz_platform",
    data: {
      id: "pay_owned",
      amount_minor: "2500",
      currency: "usd",
      checkout_configuration_id: "ch_owned",
    },
  });
  const timestamp = String(now.getTime() / 1000);
  expect(
    (
      await inbox.receiveWebhook({
        rawBody,
        now,
        secret,
        headers: {
          "webhook-id": "initial",
          "webhook-timestamp": timestamp,
          "webhook-signature": signStandardWebhook({ rawBody, secret, timestamp, id: "initial" }),
        },
      })
    ).ok,
  ).toBe(true);
  expect((await inbox.processInbox({ limit: 100 })).effects).toBe(1);
  expect(await savedOrder()).toMatchObject({ status: "paid", paymentId: "pay_owned" });
  handlers = createTestEventHandlers(dependencies());
});

describe("signed local test events through migrated PGlite and real core inbox", () => {
  it.each([
    "absent",
    "null",
    "throws",
    "foreign_run",
    "foreign_order",
    "foreign_payment",
    "temporary",
  ])("fails closed for invalid refund safety evidence: %s", async (kind) => {
    const deps = dependencies();
    const refundSafety =
      kind === "absent"
        ? undefined
        : {
            ensure: async (scope: { runId: string; orderId: string; paymentId: string }) => {
              if (kind === "throws") throw new Error("private adapter failure");
              if (kind === "null") return null;
              return {
                ...scope,
                runId: kind === "foreign_run" ? "other" : scope.runId,
                orderId: kind === "foreign_order" ? "other" : scope.orderId,
                paymentId: kind === "foreign_payment" ? "other" : scope.paymentId,
                guarantee: kind === "temporary" ? "request_mutex" : "lifecycle_isolated",
              };
            },
          };
    // Exercise runtime-invalid JS bindings, which the required TypeScript interface rejects.
    handlers = createTestEventHandlers({ ...deps, refundSafety } as unknown as Parameters<
      typeof createTestEventHandlers
    >[0]);
    const before = await balance();
    expect(await post({ type: "refund.created", resourceId: "unsafe" })).toMatchObject({
      status: 409,
      body: { error: "refund_safety_required" },
    });
    expect(diagnosticsRead).toBe(0);
    expect(await balance()).toEqual(before);
  });
  it("checks exact durable scope again for every refund replay", async () => {
    const scopes: unknown[] = [];
    let enabled = true;
    handlers = createTestEventHandlers({
      ...dependencies(),
      refundSafety: {
        ensure: async (scope) => {
          scopes.push(scope);
          return enabled ? { ...scope, guarantee: "durable_refund_invariant" as const } : null;
        },
      },
    });
    expect((await post({ type: "refund.created", resourceId: "safe" })).body.status).toBe(
      "processed",
    );
    enabled = false;
    expect((await post({ type: "refund.created", resourceId: "safe" })).status).toBe(409);
    expect(scopes).toEqual([
      { runId: "run_owned", orderId: oid, paymentId: "pay_owned" },
      { runId: "run_owned", orderId: oid, paymentId: "pay_owned" },
    ]);
  });
  it("rejects synthetic refund without the isolation adapter before signing or inbox access", async () => {
    let signed = false;
    handlers = createTestEventHandlers({
      ...dependencies(),
      refundSafety: null,
      webhookSecret: () => {
        signed = true;
        return secret;
      },
    });
    const before = await balance();
    expect(await post({ type: "refund.created", resourceId: "refund_unbound" })).toMatchObject({
      status: 409,
      body: { error: "refund_safety_required" },
    });
    expect(signed).toBe(false);
    expect(diagnosticsRead).toBe(0);
    expect(await balance()).toEqual(before);
    expect(await savedOrder()).toMatchObject({ status: "paid" });
    expect((await post()).body.status).toBe("processed");
  });
  it("refuses another refund after the normal mock pipeline already refunded the order", async () => {
    const rawBody = JSON.stringify({
      id: "normal_refund",
      type: "refund.created",
      api_version: "v1",
      api_version_date: "2026-08-21",
      timestamp: now.toISOString(),
      account_id: "biz_platform",
      data: {
        id: "rf_mock_prior",
        payment_id: "pay_owned",
        amount_minor: "2500",
        currency: "usd",
        checkout_configuration_id: "ch_owned",
      },
    });
    const timestamp = String(now.getTime() / 1000);
    expect(
      (
        await inbox.receiveWebhook({
          rawBody,
          now,
          secret,
          headers: {
            "webhook-id": "normal_refund",
            "webhook-timestamp": timestamp,
            "webhook-signature": signStandardWebhook({
              rawBody,
              secret,
              timestamp,
              id: "normal_refund",
            }),
          },
        })
      ).ok,
    ).toBe(true);
    await inbox.processInbox({ limit: 100 });
    const before = await balance();
    expect(await savedOrder()).toMatchObject({ status: "refunded" });
    expect(await post({ type: "refund.created", resourceId: "refund_again" })).toMatchObject({
      status: 409,
      body: { error: "already_refunded" },
    });
    expect(await balance()).toEqual(before);
  });
  it("leaves a foreign run's pending delivery untouched", async () => {
    const foreign = value(sellerId("seller_foreign"));
    await db.insert(sellers).values({
      id: foreign,
      runId: "run_foreign",
      externalId: "foreign",
      email: "foreign@example.invalid",
      country: "US",
      whopAccountId: "biz_foreign",
      salePolicy: "direct",
    });
    const rawBody = JSON.stringify({
      id: "foreign_pending",
      type: "payment.succeeded",
      api_version: "v1",
      api_version_date: "2026-08-21",
      timestamp: now.toISOString(),
      account_id: "biz_foreign",
      data: { id: "pay_foreign", amount_minor: "8000", currency: "usd" },
    });
    const timestamp = String(now.getTime() / 1000);
    expect(
      (
        await inbox.receiveWebhook({
          rawBody,
          now,
          secret,
          headers: {
            "webhook-id": "foreign_pending",
            "webhook-timestamp": timestamp,
            "webhook-signature": signStandardWebhook({
              rawBody,
              secret,
              timestamp,
              id: "foreign_pending",
            }),
          },
        })
      ).ok,
    ).toBe(true);
    expect((await post()).body.status).toBe("processed");
    expect((await uow.run((r) => r.inbox.get(value(deliveryId("foreign_pending"))))).status).toBe(
      "received",
    );
    expect(await uow.run((r) => r.ledger.forSeller(foreign))).toEqual([]);
  });
  it("prevents a second full refund even with a different resource label", async () => {
    expect((await post({ type: "refund.created", resourceId: "refund_one" })).body.status).toBe(
      "processed",
    );
    const before = await balance();
    expect(
      (await post({ type: "refund.created", resourceId: "refund_two", deliveryId: "new_refund" }))
        .body.status,
    ).toBe("processed");
    expect(await balance()).toEqual(before);
  });
  it("serializes concurrent replays and accepts reordered JSON keys", async () => {
    const results = await Promise.all([post(), post()]);
    expect(results.map((r) => r.body.duplicate).sort()).toEqual([false, true]);
    const reordered = Object.fromEntries(Object.entries(event()).reverse());
    expect(await (await handlers.post(request(reordered))).json()).toMatchObject({
      duplicate: true,
    });
    expect(await balance()).toHaveLength(2);
  });
  it.each(["type", "currency", "signatureCase"])("rejects array-coerced enum %s", async (field) => {
    expect(
      (
        await handlers.post(
          request({
            ...event(),
            [field]: [
              field === "type" ? "payment.succeeded" : field === "currency" ? "USD" : "valid",
            ],
          }),
        )
      ).status,
    ).toBe(400);
  });
  it("deduplicates same delivery and a new delivery of the same payment, and reads exact persisted result", async () => {
    const before = await balance();
    const first = await post();
    expect(first).toMatchObject({
      status: 200,
      body: { status: "processed", terminal: true, duplicate: false, provenance: "mock" },
    });
    expect((await post()).body).toMatchObject({
      delivery_id: first.body.delivery_id,
      duplicate: true,
    });
    const another = await post({ deliveryId: "delivery_2" });
    expect(another.body).toMatchObject({ status: "processed", duplicate: false });
    expect(another.body.delivery_id).not.toBe(first.body.delivery_id);
    expect(await balance()).toEqual(before);
    const get = await handlers.get(
      new Request(`${origin}/test-events?orderId=${oid}&deliveryId=${first.body.delivery_id}`, {
        headers: { origin, host: "127.0.0.1:4474" },
      }),
    );
    expect(await get.json()).toMatchObject({
      status: "processed",
      delivery_id: first.body.delivery_id,
    });
    expect(JSON.stringify(first.body)).not.toContain(secret);
  });

  it.each([{ amountMinor: 2499 }, { currency: "EUR" as const }])(
    "quarantines invalid refund %j without order or allocation mutation",
    async (patch) => {
      const before = await balance();
      const order = await savedOrder();
      const got = await post({ type: "refund.created", resourceId: "refund_partial", ...patch });
      expect(got).toMatchObject({
        status: 200,
        body: { status: "quarantined", terminal: true, error: "partial_refund_unsupported" },
      });
      expect(await balance()).toEqual(before);
      expect(await savedOrder()).toEqual(order);
    },
  );

  it("applies full refund once; a late payment cannot restore refunded state or add an effect", async () => {
    expect((await post({ type: "refund.created", resourceId: "refund_full" })).body.status).toBe(
      "processed",
    );
    const entries = await balance();
    expect(entries.map((e) => e.amount.amountMinor).sort((a, b) => a - b)).toEqual([
      -2300, -200, 200, 2300,
    ]);
    expect(await savedOrder()).toMatchObject({ status: "refunded" });
    expect((await post({ deliveryId: "late_payment" })).body.status).toBe("processed");
    expect(
      (
        await post({
          type: "refund.created",
          resourceId: "refund_full",
          deliveryId: "refund_alias",
        })
      ).body.status,
    ).toBe("processed");
    expect(await balance()).toEqual(entries);
    expect(await savedOrder()).toMatchObject({ status: "refunded" });
  });

  it.each(["tampered", "stale"] as const)(
    "rejects %s signature after a valid same-key control; no inbox persistence",
    async (signatureCase) => {
      expect((await post({ deliveryId: "positive_control" })).body.status).toBe("processed");
      const before = await balance();
      const bad = await post({ deliveryId: "negative_control", signatureCase });
      expect(bad).toMatchObject({ status: 422, body: { status: "rejected", error: "signature" } });
      expect(await dependencies().readDelivery(bad.body.delivery_id)).toBeNull();
      expect(await balance()).toEqual(before);
    },
  );

  it("rejects reuse of delivery ID with changed semantics", async () => {
    await post();
    expect((await post({ type: "refund.created", resourceId: "refund_conflict" })).status).toBe(
      409,
    );
    expect(await savedOrder()).toMatchObject({ status: "paid" });
  });
  it("rejects arbitrary payment resources and unknown payload keys", async () => {
    expect((await post({ resourceId: "pay_foreign" })).status).toBe(409);
    expect((await handlers.post(request({ ...event(), account_id: "biz_foreign" }))).status).toBe(
      400,
    );
    expect((await handlers.post(request({ ...event(), extra: "x".repeat(5000) }))).status).toBe(
      413,
    );
  });
  it.each([
    { host: "localhost:4474" },
    { host: "evil.test" },
    { origin: "http://localhost:4474" },
    { origin: "null" },
    { origin: "" },
    { host: "" },
  ])("rejects nonexact Host or Origin %j before inbox access", async (headers) => {
    expect((await handlers.post(request(event(), headers))).status).toBe(403);
    expect(diagnosticsRead).toBe(0);
  });
  it.each([
    { enabled: false },
    { nodeEnv: "production" },
    { provider: "sandbox" },
    { database: "neon" },
  ])("hides control outside explicit local test mode %j", async (patch) => {
    handlers = createTestEventHandlers({ ...dependencies(), config: { ...config, ...patch } });
    expect((await post()).status).toBe(404);
    expect(diagnosticsRead).toBe(0);
  });
  it.each([
    null,
    { userId: "foreign", runId: "run_owned" },
    { userId: "buyer_owned", runId: "run_foreign" },
  ])("rejects unauthenticated or foreign principal %j including result reads", async (other) => {
    const accepted = await post();
    principal = other;
    expect((await post({ deliveryId: "attempt" })).status).toBe(other ? 404 : 401);
    const get = await handlers.get(
      new Request(`${origin}/test-events?orderId=${oid}&deliveryId=${accepted.body.delivery_id}`, {
        headers: { origin, host: "127.0.0.1:4474" },
      }),
    );
    expect(get.status).toBe(other ? 404 : 401);
  });
  it("keeps result correlation after factory recreation and handles an absent delivery", async () => {
    const first = await post();
    handlers = createTestEventHandlers(dependencies());
    const url = `${origin}/test-events?orderId=${oid}&deliveryId=`;
    const headers = { origin, host: "127.0.0.1:4474" };
    expect(
      (await handlers.get(new Request(url + first.body.delivery_id, { headers }))).status,
    ).toBe(200);
    expect(
      (await handlers.get(new Request(`${url}local_test_${"0".repeat(64)}`, { headers }))).status,
    ).toBe(404);
  });
});

it("rejects a requested revision that differs from the loaded and observed source", async () => {
  await expect(
    createSourceAttestation({
      loadedRevision: "a".repeat(40),
      targetRevision: "b".repeat(40),
      readSource: async () => ({ revision: "a".repeat(40), dirty: false }),
    }),
  ).rejects.toThrow("source_revision_mismatch");
});

it("attests only clean loaded source and fails if the checkout subsequently changes", async () => {
  let actual = { revision: "a".repeat(40), dirty: false };
  const attestation = await createSourceAttestation({
    loadedRevision: actual.revision,
    targetRevision: actual.revision,
    readSource: async () => actual,
  });
  expect(await attestation.read()).toEqual({ source_revision: "a".repeat(40) });
  actual = { ...actual, dirty: true };
  await expect(attestation.read()).rejects.toThrow("source_revision_mismatch");
  actual = { revision: "b".repeat(40), dirty: false };
  await expect(attestation.read()).rejects.toThrow("source_revision_mismatch");
});
