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
import { describe, expect, it } from "vitest";
import { createGetOrderHandler, type GetOrderDeps } from "../../src/app/api/orders/[id]/route";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const SELLER_ID = value(sellerId("seller_1"));
const ORDER_ID = value(orderId("order_1"));

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
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
    buyerUserId: null,
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

function baseDeps(overrides: Partial<GetOrderDeps> = {}): GetOrderDeps {
  return {
    getSession: () => Promise.resolve({ userId: "user_1", role: "buyer" }),
    getSellerOwner: () => Promise.resolve("user_1"),
    getOrder: () => Promise.resolve(order()),
    getSeller: () => Promise.resolve(seller()),
    ...overrides,
  };
}

function get() {
  return new Request("https://example.invalid/api/orders/order_1");
}

describe("createGetOrderHandler", () => {
  it("returns 404 before authorizing when the order does not exist", async () => {
    const handler = createGetOrderHandler(baseDeps({ getOrder: () => Promise.resolve(null) }));
    const response = await handler(get(), ORDER_ID);
    expect(response.status).toBe(404);
  });

  it("returns 401 when signed out", async () => {
    const handler = createGetOrderHandler(baseDeps({ getSession: () => Promise.resolve(null) }));
    const response = await handler(get(), ORDER_ID);
    expect(response.status).toBe(401);
  });

  it("returns 403 for a signed-in user who does not own the order's seller", async () => {
    const handler = createGetOrderHandler(
      baseDeps({ getSellerOwner: () => Promise.resolve("someone_else") }),
    );
    const response = await handler(get(), ORDER_ID);
    expect(response.status).toBe(403);
  });

  it("allows an operator regardless of ownership", async () => {
    const handler = createGetOrderHandler(
      baseDeps({
        getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
        getSellerOwner: () => Promise.resolve("someone_else"),
      }),
    );
    const response = await handler(get(), ORDER_ID);
    expect(response.status).toBe(200);
  });

  it("returns 404 when the order's seller has vanished", async () => {
    const handler = createGetOrderHandler(baseDeps({ getSeller: () => Promise.resolve(null) }));
    const response = await handler(get(), ORDER_ID);
    expect(response.status).toBe(404);
  });

  it("resolves product.slug from the product row, and from the bundled catalog by id", async () => {
    const fromRow = createGetOrderHandler(
      baseDeps({ getProduct: () => Promise.resolve({ slug: "course-deluxe" }) }),
    );
    const rowBody = (await (await fromRow(get(), ORDER_ID)).json()) as {
      product: { id: string | null; slug: string | null };
    };
    expect(rowBody.product).toEqual(
      expect.objectContaining({ id: "prod_1", slug: "course-deluxe" }),
    );

    const seeded = createGetOrderHandler(
      baseDeps({ getOrder: () => Promise.resolve(order({ productExternalId: "prd_grain" })) }),
    );
    const seededBody = (await (await seeded(get(), ORDER_ID)).json()) as {
      product: { id: string | null; slug: string | null };
    };
    expect(seededBody.product).toEqual(
      expect.objectContaining({ id: "prd_grain", slug: "grain-and-gradient" }),
    );
  });

  it("returns the order in the exact JSON shape", async () => {
    const handler = createGetOrderHandler(baseDeps());
    const response = await handler(get(), ORDER_ID);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      product: { id: string | null; slug: string | null; title: string };
      seller: { id: string; name: string; sale_policy: string };
      gross: { amountMinor: number; currency: string };
      fee: { amountMinor: number; currency: string };
      seller_share: { amountMinor: number; currency: string };
      status: string;
      created_at: string;
      provenance: string;
    };
    expect(body).toEqual({
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
      purchase_url: "https://pay.example.invalid/1",
      checkout_configuration_id: "chk_1",
      payment_id: null,
    });
  });

  it("includes the settled payment id once one exists", async () => {
    const handler = createGetOrderHandler(
      baseDeps({ getOrder: () => Promise.resolve(order({ paymentId: "pay_1" })) }),
    );
    const response = await handler(get(), ORDER_ID);
    const body = (await response.json()) as { payment_id: string | null };
    expect(body.payment_id).toBe("pay_1");
  });

  it("allows the buyer who created the order to read it, even without seller ownership", async () => {
    const handler = createGetOrderHandler(
      baseDeps({
        getSession: () => Promise.resolve({ userId: "buyer_1", role: "buyer" }),
        getSellerOwner: () => Promise.resolve("someone_else"),
        getOrder: () => Promise.resolve(order({ buyerUserId: "buyer_1" })),
      }),
    );
    const response = await handler(get(), ORDER_ID);
    expect(response.status).toBe(200);
  });

  it("still enforces seller ownership for a signed-in user who is not the order's buyer", async () => {
    const handler = createGetOrderHandler(
      baseDeps({
        getSession: () => Promise.resolve({ userId: "someone_else", role: "buyer" }),
        getSellerOwner: () => Promise.resolve("user_1"),
        getOrder: () => Promise.resolve(order({ buyerUserId: "buyer_1" })),
      }),
    );
    const response = await handler(get(), ORDER_ID);
    expect(response.status).toBe(403);
  });

  it("falls back to the seller-owner-or-operator rule for a guest order with no buyer identity", async () => {
    const handler = createGetOrderHandler(
      baseDeps({ getOrder: () => Promise.resolve(order({ buyerUserId: null })) }),
    );
    const response = await handler(get(), ORDER_ID);
    expect(response.status).toBe(200);
  });
});
