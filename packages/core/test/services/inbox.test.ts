import { expect, it } from "vitest";
import { deliveryId, runId, sellerId, whopAccountId } from "../../src/ids";
import { ok, type Result } from "../../src/result";
import type { Seller } from "../../src/seller";
import { createInboxService, type ReceiveInput } from "../../src/services/inbox";
import type {
  Envelope,
  InboxRow,
  LedgerEntry,
  Repositories,
  UnitOfWork,
} from "../../src/services/ports";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}
const now = new Date("2026-09-08T12:00:00Z");
const platformAccountId = "biz_platform";
function setup() {
  const seller: Seller = {
    id: value(sellerId("seller_br")),
    runId: value(runId("run_inbox")),
    externalId: "br",
    email: "br@example.invalid",
    country: "BR",
    whopAccountId: value(whopAccountId("biz_br")),
    salePolicy: "platform_only",
    status: "active",
  };
  const order = {
    id: "order_br",
    runId: seller.runId,
    flow: "platform_transfer" as "direct" | "platform_transfer",
    sellerId: seller.id,
    checkoutConfigurationId: "ch_br",
    status: "checkout_created",
    paymentId: null as string | null,
    provenance: "mock",
  };
  const rows = new Map<string, InboxRow>();
  const effects = new Set<string>();
  const ledger: LedgerEntry[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected repository call");
  };
  const repos: Repositories = {
    lock: async () => {},
    sellers: {
      get: async (id) => (id === seller.id ? seller : null),
      byAccount: async (id) => (id === seller.whopAccountId ? seller : null),
      createOrFetch: unused,
      attach: unused,
      list: unused,
      count: unused,
    },
    orders: {
      byPaymentId: async (id) => (id === order.paymentId ? order : null),
      byId: async (id) => (id === order.id ? order : null),
      byCheckoutConfigurationId: async (id) =>
        id === order.checkoutConfigurationId ? order : null,
    },
    operations: { createOrFetch: unused, get: unused, finish: unused },
    inbox: {
      async insert(row) {
        const existing = rows.get(row.deliveryId);
        if (existing) return { row: existing, duplicate: true };
        rows.set(row.deliveryId, row);
        return { row, duplicate: false };
      },
      pending: async (limit) =>
        [...rows.values()].filter((row) => row.status === "received").slice(0, limit),
      async get(id) {
        const row = rows.get(id);
        if (!row) throw new Error("Missing inbox row");
        return row;
      },
      async mark(id, status) {
        const row = rows.get(id);
        if (!row) throw new Error("Missing inbox row");
        row.status = status;
      },
    },
    effects: {
      async insert(effect) {
        if (effects.has(effect.key)) return false;
        effects.add(effect.key);
        return true;
      },
    },
    ledger: {
      async append(entries) {
        ledger.push(...entries);
      },
      forSeller: async (id) => ledger.filter((entry) => entry.sellerId === id),
      async resolveOrder(owner, input, options) {
        if (
          owner.id !== order.sellerId ||
          !(
            input.checkoutId === order.checkoutConfigurationId ||
            input.orderId === order.id ||
            input.paymentId === order.paymentId
          )
        )
          return { matched: false, allocation: null };
        if (
          options?.requirePostedPayment &&
          !ledger.some(
            (entry) => entry.resourceType === "payment" && entry.resourceId === input.paymentId,
          )
        )
          return { matched: true, allocation: null };
        return {
          matched: true,
          allocation: {
            gross: { amountMinor: 5000, currency: "USD" },
            fee: { amountMinor: 400, currency: "USD" },
          },
        };
      },
      async settleOrder(owner, input, update) {
        const settlement = await this.resolveOrder(owner, input);
        if (settlement.matched && !(order.status === "refunded" && update.status === "paid"))
          Object.assign(order, update);
        return settlement;
      },
    },
  };
  const uow: UnitOfWork = { run: (fn) => fn(repos), exclusive: (_key, fn) => fn(uow) };
  const service = createInboxService({
    uow,
    clock: { now: () => now },
    platformAccountId,
    provenance: "sandbox",
    decoder: {
      verifyStandardWebhook: () => ok(true),
      decodeEnvelope: (raw) => ok(JSON.parse(raw) as Envelope),
    },
  });
  function delivery(
    data: Record<string, unknown>,
    accountId = platformAccountId,
    eventType = "payment.succeeded",
    id = "msg_platform",
  ): ReceiveInput {
    const raw = { type: eventType, timestamp: now.toISOString(), data: { id: "pay_br", ...data } };
    return {
      rawBody: JSON.stringify({
        accountId,
        eventType,
        originalAccountField: "account_id",
        apiVersionDate: "2026-08-21",
        rawBody: JSON.stringify(raw),
        raw,
      }),
      now,
      secret: "test-only",
      headers: {
        "webhook-id": id,
        "webhook-timestamp": String(now.getTime() / 1000),
        "webhook-signature": "test-only",
      },
    };
  }
  return { service, delivery, order, rows, ledger, effects, seller, repos };
}

it("settles a platform-only order from its checkout and posts seller share and platform fee once", async () => {
  const s = setup();
  const received = value(
    await s.service.receiveWebhook(s.delivery({ checkout_configuration_id: "ch_br" })),
  );
  expect(received.row.status).toBe("received");
  expect(await s.service.processInbox({ limit: 10 })).toMatchObject({ processed: 1, effects: 1 });
  expect(s.order).toMatchObject({ status: "paid", paymentId: "pay_br", provenance: "sandbox" });
  expect(s.ledger).toMatchObject([
    {
      sellerId: s.seller.id,
      accountSide: "seller",
      kind: "payment",
      amount: { amountMinor: 4600, currency: "USD" },
    },
    {
      sellerId: s.seller.id,
      accountSide: "platform",
      kind: "fee",
      amount: { amountMinor: 400, currency: "USD" },
    },
  ]);
  await s.service.receiveWebhook(
    s.delivery(
      { checkout_configuration_id: "ch_br" },
      platformAccountId,
      "payment.succeeded",
      "msg_replay",
    ),
  );
  expect(await s.service.processInbox({ limit: 10 })).toMatchObject({ processed: 1, effects: 0 });
  expect(s.ledger).toHaveLength(2);
});

it("quarantines a platform payment with no matching order at receipt and processing", async () => {
  const s = setup();
  const received = value(
    await s.service.receiveWebhook(s.delivery({ checkout_configuration_id: "ch_missing" })),
  );
  expect(received.row.status).toBe("quarantined");
  // Exercise processing of a previously received row whose order cannot be resolved.
  received.row.status = "received";
  expect(await s.service.processInbox({ limit: 10 })).toMatchObject({ quarantined: 1, effects: 0 });
  expect(s.rows.get(value(deliveryId("msg_platform")))?.status).toBe("quarantined");
  expect(s.order).toMatchObject({ status: "checkout_created", paymentId: null });
  expect(s.ledger).toHaveLength(0);
});

it.each([undefined, "ch_missing"])(
  "uses metadata.order_id only when checkout %s is absent or agrees",
  async (checkout) => {
    const s = setup();
    await s.service.receiveWebhook(
      s.delivery({ checkout_configuration_id: checkout, metadata: { order_id: "order_br" } }),
    );
    expect(await s.service.processInbox({ limit: 10 })).toMatchObject({
      effects: checkout ? 0 : 1,
    });
    expect(s.order.status).toBe(checkout ? "checkout_created" : "paid");
  },
);

it("does not use an order to resolve a non-platform unknown account", async () => {
  const s = setup();
  const received = value(
    await s.service.receiveWebhook(
      s.delivery({ checkout_configuration_id: "ch_br" }, "biz_unknown"),
    ),
  );
  expect(received.row.status).toBe("quarantined");
});

it.each(["transfer.completed", "payout.updated"])(
  "does not change platform-account routing for %s",
  async (type) => {
    const s = setup();
    const received = value(
      await s.service.receiveWebhook(
        s.delivery({ checkout_configuration_id: "ch_br" }, platformAccountId, type),
      ),
    );
    expect(received.row.status).toBe("quarantined");
  },
);

it("preserves seller-account payment settlement", async () => {
  const s = setup();
  s.order.flow = "direct";
  await s.service.receiveWebhook(s.delivery({ checkout_configuration_id: "ch_br" }, "biz_br"));
  expect(await s.service.processInbox({ limit: 10 })).toMatchObject({ effects: 1 });
  expect(s.order).toMatchObject({ status: "paid", paymentId: "pay_br" });
});

it("quarantining a partial refund preserves the paid order and original financial effect", async () => {
  const s = setup();
  await s.service.receiveWebhook(s.delivery({ checkout_configuration_id: "ch_br" }));
  await s.service.processInbox({ limit: 10 });
  const before = { ...s.order };
  await s.service.receiveWebhook(
    s.delivery(
      { id: "refund_1", payment_id: "pay_br", amount_minor: "1000", currency: "usd" },
      platformAccountId,
      "refund.created",
      "msg_partial",
    ),
  );
  expect(await s.service.processInbox({ limit: 10 })).toMatchObject({ quarantined: 1, effects: 0 });
  expect(s.order).toEqual(before);
  expect(s.ledger).toHaveLength(2);
  expect(s.effects.size).toBe(1);
});

it("a regenerated payment delivery after full refund preserves refunded state", async () => {
  const s = setup();
  await s.service.receiveWebhook(s.delivery({ checkout_configuration_id: "ch_br" }));
  await s.service.processInbox({ limit: 10 });
  await s.service.receiveWebhook(
    s.delivery(
      { id: "refund_1", payment_id: "pay_br", amount_minor: "5000", currency: "usd" },
      platformAccountId,
      "refund.created",
      "msg_refund",
    ),
  );
  expect(await s.service.processInbox({ limit: 10 })).toMatchObject({ effects: 1 });
  const before = { ...s.order };
  expect(before.status).toBe("refunded");
  await s.service.receiveWebhook(
    s.delivery(
      { checkout_configuration_id: "ch_br" },
      platformAccountId,
      "payment.succeeded",
      "msg_old_paid",
    ),
  );
  expect(await s.service.processInbox({ limit: 10 })).toMatchObject({ effects: 0 });
  expect(s.order).toEqual(before);
  expect(s.ledger).toHaveLength(4);
});

it("an unmatched payment posts its accepted allocation without resolving a later order for mutation", async () => {
  const s = setup();
  s.repos.ledger.resolveOrder = async () => ({ matched: false, allocation: null });
  s.repos.ledger.settleOrder = async () => {
    throw new Error("Unmatched order must not be settled");
  };
  const before = { ...s.order };
  await s.service.receiveWebhook(s.delivery({ amount_minor: "2500", currency: "usd" }, "biz_br"));
  expect(await s.service.processInbox({ limit: 10 })).toMatchObject({ effects: 1 });
  expect(s.order).toEqual(before);
  expect(s.ledger).toMatchObject([
    { accountSide: "seller", amount: { amountMinor: 2300, currency: "USD" } },
    { accountSide: "platform", amount: { amountMinor: 200, currency: "USD" } },
  ]);
});
