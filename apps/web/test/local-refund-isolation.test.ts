import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalRuntime } from "@ledgerly/db";
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
import { createLocalRefundIsolation } from "../src/lib/local-refund-isolation";

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
let isolation: ReturnType<typeof createLocalRefundIsolation>;

function dependencies() {
  return {
    config,
    refundSafety: isolation.refundSafety,
    authenticate: async () => principal,
    orders: createOrdersRepo(db),
    sellers: { get: (id: typeof sid) => uow.run((r) => r.sellers.get(id)) },
    uow,
    inbox: isolation.syntheticInbox,
    now: () => now,
    webhookSecret: () => secret,
    async readDelivery(id: string) {
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
  isolation = makeIsolation();
  await isolation.ready;
  uow = isolation.ordinaryUow;
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});
beforeEach(async () => {
  await db.$client.exec(
    "TRUNCATE local_refund_deliveries,local_refund_claims,ledger_entries,business_effects,webhook_inbox,operations,refund_requests,orders,sellers RESTART IDENTITY",
  );
  secret = randomBytes(32).toString("hex");
  principal = { userId: "buyer_owned", runId: "run_owned" };
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

const env: NodeJS.ProcessEnv = {
  LEDGERLY_LOCAL_RUNTIME: "1",
  LEDGERLY_TEST_MODE: "1",
  NODE_ENV: "test",
  WHOP_MODE: "mock",
  APP_BASE_URL: origin,
  LEDGERLY_LOCAL_DB_DIR: "/tmp/source-contract-only",
};
const scope = { runId: "run_owned", orderId: oid, paymentId: "pay_owned" };
function makeIsolation() {
  return createLocalRefundIsolation({
    client: db.$client,
    env,
    baseUow: createPgliteUnitOfWork(db.$client),
    platformAccountId: "biz_platform",
    now: () => now,
  });
}
function signedRefund(id: string, overrides: Record<string, unknown> = {}) {
  const rawBody = JSON.stringify({
    id,
    type: "refund.created",
    api_version: "v1",
    api_version_date: "2026-08-21",
    timestamp: now.toISOString(),
    account_id: "biz_platform",
    data: {
      id: `rf_${id}`,
      payment_id: "pay_owned",
      checkout_configuration_id: "ch_owned",
      amount_minor: "2500",
      currency: "usd",
      ...overrides,
    },
  });
  const timestamp = String(now.getTime() / 1000);
  return {
    rawBody,
    now,
    secret,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signStandardWebhook({ rawBody, id, timestamp, secret }),
    },
  };
}
async function claimCount() {
  return (await db.$client.query("SELECT * FROM local_refund_claims")).rows;
}

describe("durable local refund isolation", () => {
  it("persists ordinary and isolated claims after actual disk close and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ledgerly-isolation-test-"));
    const persistentEnv = { ...env, LEDGERLY_LOCAL_DB_DIR: directory };
    let runtime = getLocalRuntime(persistentEnv);
    let client = runtime.db.$client;
    try {
      await runtime.ready;
      // Reuse the paid source fixture produced by the real signed pipeline above.
      const sellerRows = await db.$client.query<Record<string, unknown>>(
        "SELECT * FROM sellers WHERE id=$1",
        [sid],
      );
      const orderRows = await db.$client.query<Record<string, unknown>>(
        "SELECT * FROM orders WHERE id=$1",
        [oid],
      );
      for (const [table, rows] of [
        ["sellers", sellerRows.rows],
        ["orders", orderRows.rows],
      ] as const) {
        for (const row of rows) {
          const columns = Object.keys(row);
          const values = Object.values(row);
          await client.query(
            `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`,
            values,
          );
        }
      }
      let persistent = createLocalRefundIsolation({
        client,
        env,
        baseUow: createPgliteUnitOfWork(client),
        platformAccountId: "biz_platform",
        now: () => now,
      });
      expect(await persistent.refundSafety.ensure(scope)).toMatchObject(scope);
      await persistent.guardRefund("pay_ordinary", async () => true);
      await runtime.close();
      runtime = getLocalRuntime(persistentEnv);
      await runtime.ready;
      client = runtime.db.$client;
      persistent = createLocalRefundIsolation({
        client,
        env,
        baseUow: createPgliteUnitOfWork(client),
        platformAccountId: "biz_platform",
        now: () => now,
      });
      expect(await persistent.refundSafety.ensure(scope)).toMatchObject(scope);
      await expect(persistent.guardRefund(scope.paymentId, async () => true)).rejects.toThrow(
        "local_refund_isolated",
      );
      expect(
        (await client.query("SELECT payment_id,mode FROM local_refund_claims ORDER BY payment_id"))
          .rows,
      ).toEqual([
        { payment_id: "pay_ordinary", mode: "ordinary" },
        { payment_id: "pay_owned", mode: "isolated" },
      ]);
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
  it("refuses direct orders whose settlement permits payment rebinding", async () => {
    await db.$client.query("UPDATE orders SET flow='direct' WHERE id=$1", [oid]);
    expect(await isolation.refundSafety.ensure(scope)).toBeNull();
    expect(await claimCount()).toEqual([]);
  });
  it("acquisition versus an already-started ordinary processor cannot interleave its effect transaction", async () => {
    const legacy = createInboxService({
      uow: createPgliteUnitOfWork(db.$client),
      clock: { now: () => now },
      decoder: { decodeEnvelope, verifyStandardWebhook },
      provenance: "mock",
      platformAccountId: "biz_platform",
    });
    await legacy.receiveWebhook(signedRefund("racing_pending"));
    const [processed, acquired] = await Promise.all([
      inbox.processInbox({ limit: 100 }),
      isolation.refundSafety.ensure(scope),
    ]);
    expect(acquired).toBeNull();
    expect(processed.effects).toBe(1);
    expect(await claimCount()).toMatchObject([{ mode: "ordinary" }]);
  });
  it("rolls back marker changes with a failed ordinary inbox transaction", async () => {
    const input = signedRefund("rollback");
    const decoded = value(decodeEnvelope(input.rawBody, input.headers["webhook-timestamp"]));
    await expect(
      uow.run(async (r) => {
        await r.inbox.insert(
          {
            deliveryId: value(deliveryId("rollback")),
            envelope: decoded,
            receivedAt: now,
            status: "received",
          },
          {},
        );
        throw new Error("fail transaction");
      }),
    ).rejects.toThrow("fail transaction");
    expect(await claimCount()).toEqual([]);
    expect(await dependencies().readDelivery("rollback")).toBeNull();
    expect(await isolation.refundSafety.ensure(scope)).toMatchObject(scope);
  });
  it("reports commit and rollback telemetry for guarded transactions", async () => {
    const events: unknown[] = [];
    const tracked = createLocalRefundIsolation({
      client: db.$client,
      env,
      baseUow: uow,
      platformAccountId: "biz_platform",
      now: () => now,
      emitter: { emit: (e) => events.push(e) },
    });
    await tracked.refundSafety.ensure(scope);
    await expect(tracked.guardRefund(scope.paymentId, async () => true)).rejects.toThrow(
      "local_refund_isolated",
    );
    expect(events).toMatchObject([
      { source: "db", phase: "end", path: "run", provenance: "pglite", status: "ok" },
      { source: "db", phase: "end", path: "run", provenance: "pglite", status: "error" },
    ]);
  });
  it("acquires once, survives adapter recreation and blocks later provider calls", async () => {
    expect(await isolation.refundSafety.ensure(scope)).toMatchObject({
      ...scope,
      guarantee: "lifecycle_isolated",
    });
    expect(await isolation.refundSafety.ensure(scope)).toMatchObject(scope);
    const reopened = makeIsolation();
    await reopened.ready;
    let called = false;
    await expect(
      reopened.guardRefund(scope.paymentId, async () => {
        called = true;
      }),
    ).rejects.toThrow("local_refund_isolated");
    expect(called).toBe(false);
    expect(await reopened.refundSafety.ensure(scope)).toMatchObject(scope);
    expect(await claimCount()).toHaveLength(1);
  });
  it("ordinary provider claims before callback and permanently refuses isolation on unknown outcome", async () => {
    let acquisition: unknown;
    await expect(
      isolation.guardRefund(scope.paymentId, async () => {
        acquisition = await isolation.refundSafety.ensure(scope);
        throw new Error("unknown provider result");
      }),
    ).rejects.toThrow("unknown provider result");
    expect(acquisition).toBeNull();
    expect(await makeIsolation().refundSafety.ensure(scope)).toBeNull();
    expect(await claimCount()).toMatchObject([{ mode: "ordinary" }]);
  });
  it("ordinary signed receipt before acquisition prevents isolation", async () => {
    expect((await inbox.receiveWebhook(signedRefund("queued"))).ok).toBe(true);
    expect(await isolation.refundSafety.ensure(scope)).toBeNull();
    expect((await inbox.processInbox({ limit: 100 })).effects).toBe(1);
    expect(await savedOrder()).toMatchObject({ status: "refunded" });
  });
  it("refuses legacy prequeued refund before guards were mounted", async () => {
    const legacy = createInboxService({
      uow: createPgliteUnitOfWork(db.$client),
      clock: { now: () => now },
      decoder: { decodeEnvelope, verifyStandardWebhook },
      provenance: "mock",
      platformAccountId: "biz_platform",
    });
    expect((await legacy.receiveWebhook(signedRefund("legacy"))).ok).toBe(true);
    expect(await isolation.refundSafety.ensure(scope)).toBeNull();
    expect(await claimCount()).toEqual([]);
    expect((await inbox.processInbox({ limit: 100 })).effects).toBe(1);
  });
  it("quarantines ordinary signed refunds after isolation including forged local metadata", async () => {
    await isolation.refundSafety.ensure(scope);
    const before = await balance();
    const forged = signedRefund("forged");
    const raw = JSON.parse(forged.rawBody);
    raw.local_test = { ...scope, userId: "buyer_owned", guarantee: "lifecycle_isolated" };
    forged.rawBody = JSON.stringify(raw);
    forged.headers["webhook-signature"] = signStandardWebhook({
      rawBody: forged.rawBody,
      id: "forged",
      timestamp: forged.headers["webhook-timestamp"],
      secret,
    });
    expect((await inbox.receiveWebhook(forged)).ok).toBe(true);
    expect((await inbox.processInbox({ limit: 100 })).effects).toBe(0);
    expect((await dependencies().readDelivery("forged"))?.row.status).toBe("quarantined");
    expect(await balance()).toEqual(before);
  });
  it("process-time transaction also blocks an ordinary row inserted through an old receiver", async () => {
    await isolation.refundSafety.ensure(scope);
    const legacy = createInboxService({
      uow: createPgliteUnitOfWork(db.$client),
      clock: { now: () => now },
      decoder: { decodeEnvelope, verifyStandardWebhook },
      provenance: "mock",
      platformAccountId: "biz_platform",
    });
    await legacy.receiveWebhook(signedRefund("legacy_after"));
    expect((await inbox.processInbox({ limit: 100 })).effects).toBe(0);
    expect((await dependencies().readDelivery("legacy_after"))?.row.status).toBe("quarantined");
    expect(await savedOrder()).toMatchObject({ status: "paid" });
  });
  it("real helper signs, authorizes, quarantines invalid refunds and posts exactly one full reversal", async () => {
    const before = await balance();
    expect(
      await post({ type: "refund.created", resourceId: "partial", amountMinor: 2499 }),
    ).toMatchObject({
      status: 200,
      body: { status: "quarantined", error: "partial_refund_unsupported" },
    });
    expect(await balance()).toEqual(before);
    const full = { type: "refund.created" as const, resourceId: "full", deliveryId: "full" };
    expect((await post(full)).body.status).toBe("processed");
    expect((await post(full)).body.duplicate).toBe(true);
    expect(
      (await post({ ...full, resourceId: "second_label", deliveryId: "second" })).body.status,
    ).toBe("processed");
    expect(await savedOrder()).toMatchObject({ status: "refunded" });
    expect((await balance()).map((e) => e.amount.amountMinor).sort((a, b) => a - b)).toEqual([
      -2300, -200, 200, 2300,
    ]);
    await expect(isolation.guardRefund("pay_owned", async () => true)).rejects.toThrow(
      "local_refund_isolated",
    );
  });
  it.each(["tampered", "stale"] as const)(
    "rejects %s synthetic signature without authorizing a delivery",
    async (signatureCase) => {
      expect((await post()).body.status).toBe("processed");
      const bad = await post({
        type: "refund.created",
        resourceId: "bad",
        deliveryId: "negative",
        signatureCase,
      });
      expect(bad.status).toBe(422);
      expect((await db.$client.query("SELECT * FROM local_refund_deliveries")).rows).toEqual([]);
      expect(await savedOrder()).toMatchObject({ status: "paid" });
    },
  );
  it("rejects a raw synthetic call without a durable claim", async () => {
    expect((await isolation.syntheticInbox.receiveWebhook(signedRefund("unclaimed"))).ok).toBe(
      false,
    );
    expect((await db.$client.query("SELECT * FROM local_refund_deliveries")).rows).toEqual([]);
  });
  it("provider-versus-acquisition race elects only one mode", async () => {
    let called = 0;
    const [a, b] = await Promise.allSettled([
      isolation.refundSafety.ensure(scope),
      isolation.guardRefund("pay_owned", async () => {
        called++;
      }),
    ]);
    const mode = (await claimCount())[0] as { mode: string };
    if (mode.mode === "isolated") {
      expect(a).toMatchObject({ status: "fulfilled", value: scope });
      expect(b.status).toBe("rejected");
      expect(called).toBe(0);
    } else {
      expect(a).toMatchObject({ status: "fulfilled", value: null });
      expect(b.status).toBe("fulfilled");
      expect(called).toBe(1);
    }
  });
  it.each([{ runId: "foreign" }, { orderId: "foreign" }, { paymentId: "pay_foreign" }])(
    "failed scope acquisition %j leaves no marker",
    async (patch) => {
      expect(await isolation.refundSafety.ensure({ ...scope, ...patch })).toBeNull();
      expect(await claimCount()).toEqual([]);
    },
  );
  it("rejects production before touching the database", () => {
    expect(() =>
      createLocalRefundIsolation({
        client: db.$client,
        env: { ...env, NODE_ENV: "production" },
        baseUow: uow,
        platformAccountId: "biz_platform",
        now: () => now,
      }),
    ).toThrow();
  });
});
