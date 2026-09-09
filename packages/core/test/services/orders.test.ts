import { describe, expect, it } from "vitest";
import { orderId, runId, sellerId, whopAccountId } from "../../src/ids";
import { money } from "../../src/money";
import type { WhopPort } from "../../src/ports/whop";
import type { Result } from "../../src/result";
import { ok } from "../../src/result";
import type { Seller } from "../../src/seller";
import {
  createOrderService,
  type NewOrder,
  type Order,
  type OrdersRepo,
  type SellerLookup,
} from "../../src/services/orders";
import type { UnitOfWork } from "../../src/services/ports";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const run = value(runId("run_orders"));
const gross25 = value(money(2500, "USD"));

function seller(overrides: Partial<Seller> = {}): Seller {
  return {
    id: value(sellerId("seller_1")),
    runId: run,
    externalId: "alice",
    email: "alice@example.invalid",
    country: "US",
    whopAccountId: value(whopAccountId("biz_alice")),
    salePolicy: "direct",
    status: "active",
    ...overrides,
  };
}

function fakeSellers(record: Seller | null): SellerLookup {
  return {
    async get() {
      return record;
    },
  };
}

// In-memory OrdersRepo. Mirrors the real repo's contract: createOrFetch
// keyed by id is idempotent, setCheckout only ever touches an existing row.
function fakeOrders(): OrdersRepo {
  const rows = new Map<string, Order>();
  return {
    async createOrFetch(input: NewOrder, id) {
      const existing = rows.get(id);
      if (existing) return existing;
      const created: Order = {
        id,
        runId: input.runId,
        sellerId: input.sellerId,
        productTitle: input.productTitle,
        productExternalId: input.productExternalId ?? null,
        gross: input.gross,
        fee: input.fee,
        flow: input.flow,
        checkoutConfigurationId: null,
        purchaseUrl: null,
        status: "pending",
        createdAt: new Date(),
        provenance: "mock",
        buyerUserId: input.buyerUserId ?? null,
        paymentId: null,
      };
      rows.set(id, created);
      return created;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async setCheckout(id, update) {
      const current = rows.get(id);
      if (!current) throw new Error("Order not found");
      const updated: Order = { ...current, ...update };
      rows.set(id, updated);
      return updated;
    },
    async listForBuyer(buyerUserId, opts) {
      const all = [...rows.values()]
        .filter((row) => row.buyerUserId === buyerUserId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
      const start = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
      const page = all.slice(start, start + opts.limit);
      const nextStart = start + page.length;
      return { orders: page, nextCursor: nextStart < all.length ? String(nextStart) : null };
    },
  };
}

type CheckoutInput = Parameters<WhopPort["createCheckoutConfiguration"]>[0];

// Stands in for packages/whop's mock adapter: this test lives in
// packages/core, which depends on nothing outside itself, so the provider
// double is written by hand instead of imported across a package boundary.
function fakeProvider() {
  let calls = 0;
  let lastInput: CheckoutInput | undefined;
  let lastKey: string | undefined;
  return {
    get calls() {
      return calls;
    },
    get lastInput() {
      return lastInput;
    },
    get lastKey() {
      return lastKey;
    },
    async createCheckoutConfiguration(input: CheckoutInput, idempotencyKey: string) {
      calls++;
      lastInput = input;
      lastKey = idempotencyKey;
      return ok({
        id: `chk_${idempotencyKey}`,
        raw: input,
        purchaseUrl: `https://pay.example.invalid/${idempotencyKey}`,
        applicationFee: input.applicationFee,
      });
    },
  } satisfies Pick<WhopPort, "createCheckoutConfiguration"> & {
    calls: number;
    lastInput: CheckoutInput | undefined;
    lastKey: string | undefined;
  };
}

function fakeUow(): Pick<UnitOfWork, "exclusive"> {
  return {
    async exclusive(_key, fn) {
      return fn({
        async run() {
          throw new Error("orders service should not need work.run");
        },
      });
    },
  };
}

function idGen(fixed?: string) {
  let n = 0;
  return { order: () => value(orderId(fixed ?? `order_${++n}`)) };
}

function service(opts: { sellerRecord: Seller | null; fixedOrderId?: string }) {
  const orders = fakeOrders();
  const provider = fakeProvider();
  const createOrder = createOrderService({
    uow: fakeUow(),
    provider,
    sellers: fakeSellers(opts.sellerRecord),
    orders,
    ids: idGen(opts.fixedOrderId),
    redirectUrl: (id) => `https://app.example.invalid/orders/${id}`,
  });
  return { createOrder, orders, provider };
}

describe("createOrderService", () => {
  it("computes an 8% fee and checks out on the seller's own account when the seller can sell direct", async () => {
    const record = seller();
    const { createOrder, provider } = service({ sellerRecord: record });
    const order = value(
      await createOrder({
        runId: run,
        sellerId: record.id,
        productTitle: "Course",
        productExternalId: "prod_1",
        gross: gross25,
      }),
    );
    expect(order.fee).toEqual({ amountMinor: 200, currency: "USD" });
    expect(order.gross).toEqual(gross25);
    expect(order.flow).toBe("direct");
    expect(order.checkoutConfigurationId).toBeTruthy();
    expect(order.purchaseUrl).toBeTruthy();
    expect(provider.calls).toBe(1);
    expect(provider.lastKey).toBe(`checkout:${order.id}`);
    expect(provider.lastInput?.accountId).toBe(record.whopAccountId);
    expect(provider.lastInput?.applicationFee).toEqual({ amountMinor: 200, currency: "USD" });
  });

  it("routes platform_only sellers through the platform account with no application fee, but still records the fee", async () => {
    const record = seller({ salePolicy: "platform_only" });
    const { createOrder, provider } = service({ sellerRecord: record });
    const order = value(
      await createOrder({
        runId: run,
        sellerId: record.id,
        productTitle: "Course",
        gross: gross25,
      }),
    );
    expect(order.flow).toBe("platform_transfer");
    expect(order.fee).toEqual({ amountMinor: 200, currency: "USD" });
    expect(provider.lastInput?.accountId).toBeNull();
    expect(provider.lastInput?.applicationFee).toBeNull();
  });

  it("rejects a suspended seller before calling the provider", async () => {
    const record = seller({ status: "suspended" });
    const { createOrder, provider } = service({ sellerRecord: record });
    const result = await createOrder({
      runId: run,
      sellerId: record.id,
      productTitle: "Course",
      gross: gross25,
    });
    expect(result).toEqual({ ok: false, error: { kind: "seller_suspended" } });
    expect(provider.calls).toBe(0);
  });

  it("rejects a direct-policy seller that has not finished onboarding", async () => {
    const record = seller({ whopAccountId: null });
    const { createOrder, provider } = service({ sellerRecord: record });
    const result = await createOrder({
      runId: run,
      sellerId: record.id,
      productTitle: "Course",
      gross: gross25,
    });
    expect(result).toEqual({ ok: false, error: { kind: "seller_not_onboarded" } });
    expect(provider.calls).toBe(0);
  });

  it("fails when the seller does not exist", async () => {
    const { createOrder } = service({ sellerRecord: null });
    const result = await createOrder({
      runId: run,
      sellerId: value(sellerId("seller_missing")),
      productTitle: "Course",
      gross: gross25,
    });
    expect(result).toEqual({ ok: false, error: { kind: "seller_not_found" } });
  });

  it("is idempotent: re-creating the same order id returns the existing checkout without calling the provider again", async () => {
    const record = seller();
    const { createOrder, provider } = service({
      sellerRecord: record,
      fixedOrderId: "order_fixed",
    });
    const first = value(
      await createOrder({
        runId: run,
        sellerId: record.id,
        productTitle: "Course",
        gross: gross25,
      }),
    );
    const second = value(
      await createOrder({
        runId: run,
        sellerId: record.id,
        productTitle: "Course",
        gross: gross25,
      }),
    );
    expect(second).toEqual(first);
    expect(provider.calls).toBe(1);
  });

  it("records the buyer who created the order when one is given, and null for a guest checkout", async () => {
    const record = seller();
    const { createOrder: createAsBuyer } = service({ sellerRecord: record });
    const buyerOrder = value(
      await createAsBuyer({
        runId: run,
        sellerId: record.id,
        productTitle: "Course",
        gross: gross25,
        buyerUserId: "user_1",
      }),
    );
    expect(buyerOrder.buyerUserId).toBe("user_1");

    const { createOrder: createAsGuest } = service({
      sellerRecord: record,
      fixedOrderId: "order_guest",
    });
    const guestOrder = value(
      await createAsGuest({
        runId: run,
        sellerId: record.id,
        productTitle: "Course",
        gross: gross25,
      }),
    );
    expect(guestOrder.buyerUserId).toBeNull();
  });
});
