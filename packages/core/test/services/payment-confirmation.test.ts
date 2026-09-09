import { expect, it } from "vitest";
import { orderId, runId, sellerId, whopAccountId, whopPaymentId } from "../../src/ids";
import { err, type Result } from "../../src/result";
import type { Order } from "../../src/services/orders";
import { createPaymentConfirmationService } from "../../src/services/payment-confirmation";
import type { Repositories, UnitOfWork } from "../../src/services/ports";

function value<T>(r: Result<T, unknown>): T {
  if (!r.ok) throw new Error("Invalid fixture");
  return r.value;
}
const unused = async (): Promise<never> => {
  throw new Error("Unexpected repository write");
};
function setup(change: Partial<Order> = {}) {
  const order: Order = {
    id: value(orderId("owned")),
    runId: value(runId("run")),
    sellerId: value(sellerId("seller")),
    buyerUserId: "buyer",
    productTitle: "Product",
    productExternalId: null,
    gross: { amountMinor: 2500, currency: "USD" },
    fee: { amountMinor: 200, currency: "USD" },
    flow: "platform_transfer",
    checkoutConfigurationId: "ch_owned",
    paymentId: null,
    status: "checkout_created",
    provenance: "sandbox",
    purchaseUrl: null,
    createdAt: new Date(),
    ...change,
  };
  const repos: Repositories = {
    lock: unused,
    orders: {
      forPaymentConfirmation: async () => order,
      byId: unused,
      byCheckoutConfigurationId: unused,
      byPaymentId: unused,
    },
    sellers: {
      get: async () => ({
        id: order.sellerId,
        runId: order.runId,
        externalId: "seller",
        email: "fixture@example.invalid",
        country: "BR",
        whopAccountId: value(whopAccountId("biz_seller")),
      }),
      byAccount: unused,
      createOrFetch: unused,
      attach: unused,
      list: unused,
      count: unused,
    },
    operations: { createOrFetch: unused, get: unused, finish: unused },
    effects: { insert: unused },
    ledger: {
      forPaymentConfirmation: async () => [],
      append: unused,
      forSeller: unused,
      resolveOrder: unused,
      settleOrder: unused,
    },
    inbox: { insert: unused, pending: unused, get: unused, mark: unused },
  };
  const uow: UnitOfWork = { run: async (fn) => fn(repos), exclusive: unused };
  let reads = 0;
  const confirm = createPaymentConfirmationService({
    uow,
    platformAccountId: value(whopAccountId("biz_platform")),
    clock: { now: () => new Date() },
    readPayment: async () => {
      reads++;
      return err({ kind: "provider_read_failed" });
    },
  });
  return {
    repos,
    confirm: () =>
      confirm({
        orderId: order.id,
        paymentId: value(whopPaymentId("pay_owned")),
        buyerUserId: "buyer",
      }),
    reads: () => reads,
  };
}
it.each([
  { buyerUserId: null },
  { buyerUserId: "foreign" },
  { status: "refunded" },
  { status: "pending" },
  { provenance: "mock" },
  { checkoutConfigurationId: null },
  { paymentId: "pay_foreign" },
] satisfies Partial<Order>[])(
  "rejects unavailable or foreign orders before provider I/O %#",
  async (change) => {
    const s = setup(change);
    expect((await s.confirm()).ok).toBe(false);
    expect(s.reads()).toBe(0);
  },
);
it("returns a provider refusal without attempting a local repair", async () => {
  const s = setup();
  expect(await s.confirm()).toEqual({ ok: false, error: { kind: "provider_read_failed" } });
  expect(s.reads()).toBe(1);
});
it("fails closed on an older repository without a locked full-order read", async () => {
  const s = setup();
  delete s.repos.orders.forPaymentConfirmation;
  expect(await s.confirm()).toEqual({ ok: false, error: { kind: "not_available" } });
  expect(s.reads()).toBe(0);
});
