import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { runId, sellerId, whopAccountId } from "../../../core/src/ids";
import type { Result } from "../../../core/src/result";
import { createInboxService, type ReceiveInput } from "../../../core/src/services/inbox";
import type { UnitOfWork } from "../../../core/src/services/ports";
import { decodeEnvelope } from "../../../whop/src/envelope";
import { createSimulatorAdapter } from "../../../whop/src/simulator/adapter";
import { signStandardWebhook, verifyStandardWebhook } from "../../../whop/src/webhooks";
import { createOrdersRepo } from "../../src/repos/orders";
import { createPgliteUnitOfWork } from "../../src/repos/unit-of-work";

// Reproduces ICR-2 with the actual simulator refund, without adding producer metadata.
const now = new Date("2026-09-09T12:00:00Z");
const secret = "review-fixture-only";
let db: PGlite;
let uow: UnitOfWork;
function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}
function service() {
  return createInboxService({
    uow,
    clock: { now: () => now },
    decoder: { decodeEnvelope, verifyStandardWebhook },
    platformAccountId: "biz_platform",
    provenance: "mock",
  });
}
beforeAll(async () => {
  db = new PGlite();
  await migrate(drizzle(db), {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
  uow = createPgliteUnitOfWork(db);
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(
    "TRUNCATE ledger_entries,business_effects,webhook_inbox,operations,orders,sellers RESTART IDENTITY",
  );
});
function signed(envelope: Record<string, unknown>, id: string): ReceiveInput {
  const rawBody = JSON.stringify({ ...envelope, id });
  const timestamp = String(now.getTime() / 1000);
  return {
    rawBody,
    secret,
    now,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signStandardWebhook({ rawBody, id, timestamp, secret }),
    },
  };
}
async function snapshot() {
  return {
    orders: (await db.query("SELECT * FROM orders ORDER BY id")).rows,
    effects: (await db.query("SELECT * FROM business_effects ORDER BY effect_key")).rows,
    ledger: (await db.query("SELECT * FROM ledger_entries ORDER BY id")).rows,
  };
}
async function paid(postPayment = true) {
  const inbox = service();
  await uow.run(async (r) => {
    for (const name of ["review", "foreign"]) {
      const seller = await r.sellers.createOrFetch(
        {
          runId: value(runId(`run_${name}`)),
          externalId: name,
          email: `${name}@example.invalid`,
          country: "BR",
        },
        value(sellerId(`seller_${name}`)),
      );
      await r.sellers.attach(seller.id, value(whopAccountId(`biz_${name}`)));
    }
  });
  let delivery: ReceiveInput | undefined;
  const simulator = createSimulatorAdapter({
    webhookSecret: secret,
    now: () => now,
    parentAccountId: value(whopAccountId("biz_platform")),
    accounts: [{ id: value(whopAccountId("biz_platform")), raw: {} }],
    deliver: async (event) => {
      delivery = { ...event, secret, now };
    },
  });
  const payment = value(
    simulator.seedPayment(
      { amountMinor: 2500, currency: "USD" },
      value(whopAccountId("biz_platform")),
    ),
  );
  await db.exec(
    "INSERT INTO orders (id,run_id,seller_id,product_title,gross_minor,currency,fee_minor,flow,checkout_configuration_id,status) VALUES ('order_review','run_review','seller_review','Review',2500,'USD',200,'platform_transfer','checkout_review','checkout_created'),('order_foreign','run_foreign','seller_foreign','Foreign',2500,'USD',200,'platform_transfer','checkout_foreign','checkout_created')",
  );
  await db.exec(
    "UPDATE orders SET payment_id='pay_foreign',status='paid' WHERE id='order_foreign'",
  );
  const paymentEnvelope = {
    type: "payment.succeeded",
    account_id: "biz_platform",
    api_version_date: "2026-08-21",
    timestamp: now.toISOString(),
    data: {
      id: payment.id,
      amount_minor: "2500",
      currency: "USD",
      checkout_configuration_id: "checkout_review",
    },
  };
  if (postPayment) {
    value(await inbox.receiveWebhook(signed(paymentEnvelope, "review_payment")));
    expect(await inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 1 });
  }
  value(await simulator.refundPayment(payment.id, "review_refund"));
  if (!delivery) throw new Error("Simulator did not emit a refund");
  return { inbox, payment, paymentEnvelope, delivery, envelope: JSON.parse(delivery.rawBody) };
}

it("applies the signed simulator refund, dedupes delivery and effect replays, and preserves refunded state", async () => {
  const s = await paid();
  expect(s.envelope.data).toEqual({
    id: "sim_ref_2",
    payment_id: s.payment.id,
    amount_minor: "2500",
    currency: "USD",
  });
  const beforeLookup = await snapshot();
  expect(await createOrdersRepo(drizzle(db)).byPaymentId(s.payment.id)).toMatchObject({
    id: "order_review",
    paymentId: s.payment.id,
  });
  expect(await uow.run((r) => r.orders.byPaymentId(s.payment.id))).toMatchObject({
    id: "order_review",
    paymentId: s.payment.id,
  });
  expect(await snapshot()).toEqual(beforeLookup);
  expect(value(await s.inbox.receiveWebhook(s.delivery)).row.status).toBe("received");
  expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 1 });
  const after = await snapshot();
  expect(after.orders).toMatchObject([
    { id: "order_foreign", status: "paid" },
    { id: "order_review", status: "refunded", payment_id: s.payment.id, provenance: "mock" },
  ]);
  expect(after.ledger).toMatchObject([
    { kind: "payment", amount_minor: 2300 },
    { kind: "fee", amount_minor: 200 },
    { kind: "refund", amount_minor: -2300 },
    { kind: "refund_fee", amount_minor: -200 },
  ]);
  expect(value(await s.inbox.receiveWebhook(s.delivery)).duplicate).toBe(true);
  value(await s.inbox.receiveWebhook(signed(s.envelope, "refund_other_delivery")));
  value(await s.inbox.receiveWebhook(signed(s.paymentEnvelope, "payment_other_delivery")));
  const sweeps = await Promise.all([
    s.inbox.processInbox({ limit: 10 }),
    s.inbox.processInbox({ limit: 10 }),
  ]);
  expect(sweeps.reduce((sum, sweep) => sum + sweep.effects, 0)).toBe(0);
  expect(await snapshot()).toEqual(after);
});

it.each([
  ["unknown payment", { payment_id: "pay_absent" }],
  ["missing payment", { payment_id: undefined }],
  ["empty payment", { payment_id: "" }],
  ["unknown checkout", { checkout_configuration_id: "checkout_absent" }],
  ["foreign checkout", { checkout_configuration_id: "checkout_foreign" }],
  ["unknown order", { metadata: { order_id: "order_absent" } }],
  ["foreign order", { metadata: { order_id: "order_foreign" } }],
  [
    "foreign payment with own order",
    { payment_id: "pay_foreign", metadata: { order_id: "order_review" } },
  ],
  [
    "unknown payment with own order",
    { payment_id: "pay_absent", metadata: { order_id: "order_review" } },
  ],
  ["foreign seller hint", { metadata: { seller_id: "seller_foreign" } }],
  ["unknown seller hint", { metadata: { seller_id: "seller_absent" } }],
  ["malformed order", { metadata: { order_id: 12 } }],
  ["malformed checkout", { checkout_configuration_id: null }],
  ["partial amount", { amount_minor: "1000" }],
  ["excess amount", { amount_minor: "2501" }],
  ["zero amount", { amount_minor: "0" }],
  ["negative amount", { amount_minor: "-2500" }],
  ["unsafe amount", { amount_minor: "9007199254740992" }],
  ["wrong currency", { currency: "EUR" }],
] as const)("rejects %s without changing orders, effects, or ledger", async (_name, patch) => {
  const s = await paid();
  const before = await snapshot();
  const received = value(
    await s.inbox.receiveWebhook(
      signed({ ...s.envelope, data: { ...s.envelope.data, ...patch } }, "invalid_refund"),
    ),
  );
  expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 0 });
  expect(["quarantined", "failed"]).toContain(
    (await uow.run((r) => r.inbox.get(received.row.deliveryId))).status,
  );
  expect(await snapshot()).toEqual(before);
});

it.each(["biz_absent", "biz_foreign", "biz_review"])(
  "rejects platform refund references signed for %s",
  async (accountId) => {
    const s = await paid();
    const before = await snapshot();
    expect(
      value(
        await s.inbox.receiveWebhook(
          signed({ ...s.envelope, account_id: accountId }, "foreign_account"),
        ),
      ).row.status,
    ).toBe("quarantined");
    expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 0 });
    expect(await snapshot()).toEqual(before);
  },
);

it.each(["direct order", "ambiguous payment", "seller run mismatch"])(
  "rejects a %s without financial writes",
  async (problem) => {
    const s = await paid();
    if (problem === "direct order")
      await db.exec("UPDATE orders SET flow='direct' WHERE id='order_review'");
    if (problem === "ambiguous payment")
      await db.query("UPDATE orders SET payment_id=$1 WHERE id='order_foreign'", [s.payment.id]);
    if (problem === "seller run mismatch")
      await db.exec("UPDATE orders SET run_id='run_foreign' WHERE id='order_review'");
    const before = await snapshot();
    expect(
      value(
        await s.inbox.receiveWebhook(
          signed(
            {
              ...s.envelope,
              data: { ...s.envelope.data, checkout_configuration_id: "checkout_review" },
            },
            "invalid_mapping",
          ),
        ),
      ).row.status,
    ).toBe("quarantined");
    expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 0 });
    expect(await snapshot()).toEqual(before);
  },
);

it.each(["orders", "webhook_inbox"])(
  "rolls back the complete accepted refund when writing %s fails",
  async (table) => {
    const s = await paid();
    const before = await snapshot();
    const received = value(await s.inbox.receiveWebhook(s.delivery));
    await db.exec(
      `CREATE FUNCTION reject_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected refund failure'; END $$; CREATE TRIGGER reject_refund BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_refund()`,
    );
    try {
      await expect(s.inbox.processInbox({ limit: 10 })).rejects.toThrow("injected refund failure");
      expect(await snapshot()).toEqual(before);
      expect(await uow.run((r) => r.inbox.get(received.row.deliveryId))).toMatchObject({
        status: "received",
      });
    } finally {
      await db.exec(`DROP TRIGGER reject_refund ON ${table}; DROP FUNCTION reject_refund()`);
    }
    expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 1 });
  },
);

it("accepts agreeing persisted payment, checkout, order, and seller hints", async () => {
  const s = await paid();
  const delivery = signed(
    {
      ...s.envelope,
      data: {
        ...s.envelope.data,
        checkout_configuration_id: "checkout_review",
        metadata: { order_id: "order_review", seller_id: "seller_review" },
      },
    },
    "agreeing_hints",
  );
  expect(value(await s.inbox.receiveWebhook(delivery)).row.status).toBe("received");
  expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 1 });
  expect((await snapshot()).orders).toMatchObject([
    { id: "order_foreign", status: "paid" },
    { id: "order_review", status: "refunded" },
  ]);
});

it("rechecks persisted payment mapping at processing and rejects a mapping changed after receipt", async () => {
  const s = await paid();
  const received = value(await s.inbox.receiveWebhook(s.delivery));
  await db.exec("UPDATE orders SET payment_id='pay_replaced' WHERE id='order_review'");
  const before = await snapshot();
  expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 0, quarantined: 1 });
  expect(await uow.run((r) => r.inbox.get(received.row.deliveryId))).toMatchObject({
    status: "quarantined",
  });
  expect(await snapshot()).toEqual(before);
});

it("rejects a tampered simulator signature before persisting the delivery", async () => {
  const s = await paid();
  const before = await snapshot();
  const inboxBefore = (await db.query("SELECT * FROM webhook_inbox ORDER BY delivery_id")).rows;
  expect(
    await s.inbox.receiveWebhook({ ...s.delivery, rawBody: `${s.delivery.rawBody} ` }),
  ).toMatchObject({ ok: false, error: { kind: "signature" } });
  expect((await db.query("SELECT * FROM webhook_inbox ORDER BY delivery_id")).rows).toEqual(
    inboxBefore,
  );
  expect(await snapshot()).toEqual(before);
});

it.each(["biz_review", "biz_foreign"])(
  "rejects an ambiguous platform payment refunded under seller account %s",
  async (accountId) => {
    const s = await paid();
    expect(await createOrdersRepo(drizzle(db)).byPaymentId("pay_absent")).toBeNull();
    expect(await uow.run((r) => r.orders.byPaymentId("pay_absent"))).toBeNull();
    await db.query("UPDATE orders SET payment_id=$1 WHERE id='order_foreign'", [s.payment.id]);
    expect(await createOrdersRepo(drizzle(db)).byPaymentId(s.payment.id)).toEqual({
      kind: "ambiguous",
    });
    expect(await uow.run((r) => r.orders.byPaymentId(s.payment.id))).toEqual({ kind: "ambiguous" });
    const before = await snapshot();
    const received = value(
      await s.inbox.receiveWebhook(
        signed({ ...s.envelope, account_id: accountId }, "ambiguous_seller_refund"),
      ),
    );
    expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 0 });
    expect(await uow.run((r) => r.inbox.get(received.row.deliveryId))).toMatchObject({
      status: "quarantined",
    });
    expect(await snapshot()).toEqual(before);
  },
);

it.each([true, false])(
  "defers an early known-checkout refund until payment credit, with an early sweep %s",
  async (earlySweep) => {
    const s = await paid(false);
    const refundEnvelope = {
      ...s.envelope,
      data: { ...s.envelope.data, checkout_configuration_id: "checkout_review" },
    };
    const refund = signed(refundEnvelope, "early_refund");
    const before = await snapshot();
    const received = value(await s.inbox.receiveWebhook(refund));
    expect(received.row.status).toBe("received");
    if (earlySweep) {
      expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 0, deferred: 1 });
      expect(await snapshot()).toEqual(before);
      expect(await uow.run((r) => r.inbox.get(received.row.deliveryId))).toMatchObject({
        status: "received",
      });
    }
    expect(value(await s.inbox.receiveWebhook(refund)).duplicate).toBe(true);
    value(await s.inbox.receiveWebhook(signed(s.paymentEnvelope, "review_payment")));
    const afterPayment = await s.inbox.processInbox({ limit: 10 });
    const afterRefund = await s.inbox.processInbox({ limit: 10 });
    expect(afterPayment.effects + afterRefund.effects).toBe(2);
    const after = await snapshot();
    expect(after.orders).toMatchObject([
      { id: "order_foreign", status: "paid" },
      { id: "order_review", status: "refunded", payment_id: s.payment.id },
    ]);
    expect(after.ledger).toMatchObject([
      { kind: "payment", amount_minor: 2300 },
      { kind: "fee", amount_minor: 200 },
      { kind: "refund", amount_minor: -2300 },
      { kind: "refund_fee", amount_minor: -200 },
    ]);
    expect(after.effects).toHaveLength(2);
    value(await s.inbox.receiveWebhook(signed(refundEnvelope, "early_refund_replay")));
    value(await s.inbox.receiveWebhook(signed(s.paymentEnvelope, "early_payment_replay")));
    expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 0 });
    expect(await snapshot()).toEqual(after);
    expect(await uow.run((r) => r.inbox.get(received.row.deliveryId))).toMatchObject({
      status: "processed",
      envelope: { rawBody: refund.rawBody },
    });
  },
);

it.each([
  ["missing checkout and order", {}],
  ["unknown checkout", { checkout_configuration_id: "checkout_absent" }],
  ["foreign payment", { payment_id: "pay_foreign", checkout_configuration_id: "checkout_review" }],
  [
    "conflicting order",
    { checkout_configuration_id: "checkout_review", metadata: { order_id: "order_foreign" } },
  ],
  [
    "conflicting seller",
    { checkout_configuration_id: "checkout_review", metadata: { seller_id: "seller_foreign" } },
  ],
  [
    "payment never accepted",
    { payment_id: "pay_never_accepted", checkout_configuration_id: "checkout_review" },
  ],
  ["invalid amount", { amount_minor: "1000", checkout_configuration_id: "checkout_review" }],
] as const)(
  "does not apply an early refund with %s after payment arrives",
  async (_name, patch) => {
    const s = await paid(false);
    const received = value(
      await s.inbox.receiveWebhook(
        signed({ ...s.envelope, data: { ...s.envelope.data, ...patch } }, "rejected_early_refund"),
      ),
    );
    expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 0 });
    expect((await snapshot()).ledger).toHaveLength(0);
    value(await s.inbox.receiveWebhook(signed(s.paymentEnvelope, "review_payment")));
    await s.inbox.processInbox({ limit: 10 });
    const paidState = await snapshot();
    expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 0 });
    expect(await snapshot()).toEqual(paidState);
    expect(paidState.ledger).toMatchObject([
      { kind: "payment", amount_minor: 2300 },
      { kind: "fee", amount_minor: 200 },
    ]);
    expect(paidState.effects).toHaveLength(1);
    expect(paidState.orders).toMatchObject([
      { id: "order_foreign", status: "paid" },
      { id: "order_review", status: "paid", payment_id: s.payment.id },
    ]);
    expect(await uow.run((r) => r.inbox.get(received.row.deliveryId))).toMatchObject({
      status: "quarantined",
    });
  },
);

it("defers a refund for a bound payment identity when no accepted credit exists", async () => {
  const s = await paid(false);
  await db.query("UPDATE orders SET payment_id=$1,status='paid' WHERE id='order_review'", [
    s.payment.id,
  ]);
  const before = await snapshot();
  const received = value(await s.inbox.receiveWebhook(s.delivery));
  expect(received.row.status).toBe("received");
  expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ effects: 0, deferred: 1 });
  expect(await snapshot()).toEqual(before);
});

it("resolves a retained early refund through a fresh service instance and stable order hint", async () => {
  const s = await paid(false);
  const refund = signed(
    {
      ...s.envelope,
      data: {
        ...s.envelope.data,
        metadata: { order_id: "order_review", seller_id: "seller_review" },
      },
    },
    "early_order_hint",
  );
  const received = value(await s.inbox.receiveWebhook(refund));
  expect(received.row.status).toBe("received");
  expect(await s.inbox.processInbox({ limit: 10 })).toMatchObject({ deferred: 1, effects: 0 });
  const restarted = service();
  value(await restarted.receiveWebhook(signed(s.paymentEnvelope, "review_payment")));
  await restarted.processInbox({ limit: 10 });
  await restarted.processInbox({ limit: 10 });
  const after = await snapshot();
  expect(after.effects).toHaveLength(2);
  expect(after.orders).toMatchObject([
    { id: "order_foreign", status: "paid" },
    { id: "order_review", status: "refunded", payment_id: s.payment.id },
  ]);
  expect(await uow.run((r) => r.inbox.get(received.row.deliveryId))).toMatchObject({
    status: "processed",
    envelope: { rawBody: refund.rawBody },
  });
});
