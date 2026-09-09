import { orderId } from "@ledgerly/core";
import {
  createOrdersRepo,
  createRefundRequestsRepo,
  createTestDb,
  orders,
  sellers,
} from "@ledgerly/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCreateRefundRequestHandler } from "../../src/app/api/orders/[id]/refund-request/route";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});
beforeEach(async () => {
  await db.$client.exec("TRUNCATE refund_requests, orders, sellers RESTART IDENTITY");
  await db.insert(sellers).values({
    id: "seller_1",
    runId: "run_1",
    externalId: "seller",
    email: "seller@example.invalid",
    country: "US",
    salePolicy: "direct",
  });
  await db.insert(orders).values({
    id: "order_1",
    runId: "run_1",
    sellerId: "seller_1",
    productTitle: "Course",
    grossMinor: 2500,
    feeMinor: 200,
    currency: "USD",
    flow: "platform_transfer",
    status: "paid",
    buyerUserId: "buyer_1",
    paymentId: "pay_1",
  });
});
function handler(userId: string | null = "buyer_1", role = "buyer") {
  const repo = createRefundRequestsRepo(db);
  return createCreateRefundRequestHandler({
    getSession: async () => (userId ? { userId, role } : null),
    getOrder: async (id) => {
      const parsed = orderId(id);
      return parsed.ok ? createOrdersRepo(db).get(parsed.value) : null;
    },
    getRefundRequest: repo.getForOrder,
    createRefundRequest: repo.create,
  });
}
function post(body?: unknown) {
  return new Request("https://example.invalid/api/orders/order_1/refund-request", {
    method: "POST",
    headers:
      body === undefined ? { "content-length": "0" } : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
describe("refund request route with the real order and refund repositories", () => {
  it.each(["pending", "checkout_created", "failed", "refunded"])(
    "rejects a %s order without a request",
    async (status) => {
      await db.update(orders).set({ status });
      expect((await handler()(post(), "order_1")).status).toBe(409);
      expect(await createRefundRequestsRepo(db).listForBuyer("buyer_1")).toEqual([]);
    },
  );
  it("rejects paid direct charges even when the seller changes to platform-only", async () => {
    await db.update(orders).set({ flow: "direct" });
    await db.update(sellers).set({ salePolicy: "platform_only" });
    expect((await handler()(post(), "order_1")).status).toBe(409);
  });
  it("rejects an order with no accepted payment identity", async () => {
    await db.update(orders).set({ paymentId: null });
    expect((await handler()(post(), "order_1")).status).toBe(409);
  });
  it.each([
    [null, "buyer", 401],
    ["stranger", "buyer", 403],
    ["seller_1", "seller", 403],
    ["op_1", "operator", 403],
  ] as const)("preserves ownership for %s / %s", async (user, role, status) => {
    expect((await handler(user, role)(post(), "order_1")).status).toBe(status);
    expect(await createRefundRequestsRepo(db).listForBuyer("buyer_1")).toEqual([]);
  });
  it("returns 404 for a missing order", async () => {
    expect((await handler()(post(), "missing")).status).toBe(404);
  });
  it("creates a request for a paid platform order despite current direct seller policy", async () => {
    const response = await handler()(
      post({ reason: "  Wrong files  ", amountMinor: 1, buyerUserId: "stranger" }),
      "order_1",
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: "refreq_order:order_1",
      order_id: "order_1",
      status: "requested",
      amount: { amount_minor: 2500, currency: "USD" },
      reason: "Wrong files",
      created_at: expect.any(String),
    });
    const rows = await createRefundRequestsRepo(db).listForBuyer("buyer_1");
    expect(rows).toHaveLength(1);
    const parsed = orderId("order_1");
    if (!parsed.ok) throw new Error("fixture id");
    expect((await createOrdersRepo(db).get(parsed.value))?.status).toBe("paid");
  });
  it("returns the same request for concurrent retries and after a later refund", async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => handler()(post(), "order_1")),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(bodies.every((b) => JSON.stringify(b) === JSON.stringify(bodies[0]))).toBe(true);
    await db.update(orders).set({ status: "refunded" });
    const retry = await handler()(post({ reason: "changed" }), "order_1");
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(bodies[0]);
    expect((await handler("stranger")(post(), "order_1")).status).toBe(403);
  });
  it("rechecks a stale paid read before insertion", async () => {
    const repo = createRefundRequestsRepo(db);
    const submit = createCreateRefundRequestHandler({
      getSession: async () => ({ userId: "buyer_1", role: "buyer" }),
      getOrder: async () => {
        const parsed = orderId("order_1");
        if (!parsed.ok) throw new Error("fixture id");
        const order = await createOrdersRepo(db).get(parsed.value);
        await db.update(orders).set({ status: "refunded" });
        return order;
      },
      getRefundRequest: repo.getForOrder,
      createRefundRequest: repo.create,
    });
    expect((await submit(post(), "order_1")).status).toBe(409);
    expect(await repo.listForBuyer("buyer_1")).toEqual([]);
  });
  it("rejects invalid JSON and non-string reasons", async () => {
    expect((await handler()(post({ reason: 5 }), "order_1")).status).toBe(400);
    expect(
      (
        await handler()(
          new Request("https://example.invalid", { method: "POST", body: "{" }),
          "order_1",
        )
      ).status,
    ).toBe(400);
  });
});
