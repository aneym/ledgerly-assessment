import {
  money,
  type Order,
  orderId,
  type Result,
  runId,
  type Seller,
  sellerId,
  whopAccountId,
} from "@ledgerly/core";
import { describe, expect, it, vi } from "vitest";
import { createListOrdersHandler, type ListOrdersDeps } from "../../src/app/api/orders/route";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const SELLER_ID = value(sellerId("seller_1"));

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: value(orderId("order_1")),
    runId: value(runId("run_1")),
    sellerId: SELLER_ID,
    productTitle: "Course",
    productExternalId: "prod_1",
    gross: value(money(2500, "USD")),
    fee: value(money(200, "USD")),
    flow: "direct",
    checkoutConfigurationId: "chk_1",
    purchaseUrl: "https://pay.example.invalid/1",
    status: "checkout_created",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    provenance: "mock",
    buyerUserId: "buyer_1",
    paymentId: null,
    ...overrides,
  };
}

function seller(overrides: Partial<Seller> = {}): Seller {
  return {
    id: SELLER_ID,
    runId: value(runId("run_1")),
    externalId: "alice",
    email: "alice@example.invalid",
    country: "US",
    whopAccountId: value(whopAccountId("biz_alice")),
    salePolicy: "direct",
    status: "active",
    ...overrides,
  };
}

function baseDeps(overrides: Partial<ListOrdersDeps> = {}): ListOrdersDeps {
  return {
    getSession: () => Promise.resolve({ userId: "buyer_1", role: "buyer" }),
    listOrders: () => Promise.resolve({ orders: [order()], nextCursor: null }),
    getSeller: () => Promise.resolve(seller()),
    ...overrides,
  };
}

function get(query = "") {
  return new Request(`https://example.invalid/api/orders${query}`);
}

describe("createListOrdersHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createListOrdersHandler(baseDeps({ getSession: () => Promise.resolve(null) }));
    const response = await handler(get());
    expect(response.status).toBe(401);
  });

  it("returns the buyer's own orders in the same JSON shape as the single-order route", async () => {
    const handler = createListOrdersHandler(baseDeps());
    const response = await handler(get());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      orders: Array<{ id: string; payment_id: string | null }>;
      next_cursor: string | null;
    };
    expect(body.orders).toEqual([
      {
        id: "order_1",
        product: { id: "prod_1", slug: null, title: "Course" },
        seller: { id: "seller_1", name: "alice", sale_policy: "direct" },
        gross: { amountMinor: 2500, currency: "USD" },
        fee: { amountMinor: 200, currency: "USD" },
        seller_share: { amountMinor: 2300, currency: "USD" },
        status: "checkout_created",
        flow: "direct",
        created_at: "2026-01-01T00:00:00.000Z",
        provenance: "mock",
        payment_id: null,
        purchase_url: "https://pay.example.invalid/1",
        checkout_configuration_id: "chk_1",
      },
    ]);
    expect(body.next_cursor).toBeNull();
  });

  it("passes the caller's own userId, not a query param, as the buyer to list for", async () => {
    const listOrders = vi.fn().mockResolvedValue({ orders: [], nextCursor: null });
    const handler = createListOrdersHandler(
      baseDeps({
        getSession: () => Promise.resolve({ userId: "buyer_1", role: "buyer" }),
        listOrders,
      }),
    );
    await handler(get());
    expect(listOrders).toHaveBeenCalledWith("buyer_1", { limit: 20, cursor: null });
  });

  it("forwards cursor and limit query params through to the repo", async () => {
    const listOrders = vi.fn().mockResolvedValue({ orders: [], nextCursor: null });
    const handler = createListOrdersHandler(baseDeps({ listOrders }));
    await handler(get("?cursor=abc123&limit=5"));
    expect(listOrders).toHaveBeenCalledWith("buyer_1", { limit: 5, cursor: "abc123" });
  });

  it("falls back to the default limit for a non-numeric limit param", async () => {
    const listOrders = vi.fn().mockResolvedValue({ orders: [], nextCursor: null });
    const handler = createListOrdersHandler(baseDeps({ listOrders }));
    await handler(get("?limit=notanumber"));
    expect(listOrders).toHaveBeenCalledWith("buyer_1", { limit: 20, cursor: null });
  });

  it("echoes back a next_cursor when the repo reports more pages", async () => {
    const handler = createListOrdersHandler(
      baseDeps({
        listOrders: () => Promise.resolve({ orders: [order()], nextCursor: "opaque_cursor" }),
      }),
    );
    const response = await handler(get());
    const body = (await response.json()) as { next_cursor: string | null };
    expect(body.next_cursor).toBe("opaque_cursor");
  });

  it("drops an order whose seller has vanished instead of failing the whole page", async () => {
    const handler = createListOrdersHandler(
      baseDeps({
        listOrders: () =>
          Promise.resolve({
            orders: [
              order({ id: value(orderId("order_1")) }),
              order({ id: value(orderId("order_2")) }),
            ],
            nextCursor: null,
          }),
        getSeller: vi.fn().mockResolvedValueOnce(seller()).mockResolvedValueOnce(null),
      }),
    );
    const response = await handler(get());
    const body = (await response.json()) as { orders: Array<{ id: string }> };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]?.id).toBe("order_1");
  });
});
