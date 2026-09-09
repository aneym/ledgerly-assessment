import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { orderId, sellerId } from "../../core/src/ids";
import type { Result } from "../../core/src/result";
import { createTestDb } from "../src/client";
import { createRefundRequestsRepo } from "../src/repos/refund-requests";
import { orders, refundRequests, sellers } from "../src/schema";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const SELLER_ID = value(sellerId("seller_1"));
const ORDER_ID = value(orderId("order_1"));

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
    id: SELLER_ID,
    runId: "run_1",
    externalId: "alice",
    email: "alice@example.invalid",
    country: "US",
    salePolicy: "direct",
  });
  await db.insert(orders).values({
    id: ORDER_ID,
    runId: "run_1",
    sellerId: SELLER_ID,
    productTitle: "Course",
    grossMinor: 2500,
    currency: "USD",
    feeMinor: 200,
    flow: "platform_transfer",
    status: "paid",
    paymentId: "pay_1",
    provenance: "mock",
    buyerUserId: "buyer_1",
  });
});

const input = { orderId: ORDER_ID, buyerUserId: "buyer_1", reason: null };
describe("createRefundRequestsRepo", () => {
  it("returns one stable request for concurrent submissions", async () => {
    const repo = createRefundRequestsRepo(db);
    const requests = await Promise.all(Array.from({ length: 6 }, () => repo.create(input)));
    expect(requests.every(Boolean)).toBe(true);
    expect(new Set(requests.map((row) => row?.id)).size).toBe(1);
    expect(await repo.listForBuyer("buyer_1")).toHaveLength(1);
    expect(await repo.listForBuyer("buyer_2")).toEqual([]);
  });
  it.each(["pending", "checkout_created", "failed", "refunded", "unknown"])(
    "rejects latest persisted %s state",
    async (status) => {
      await db.update(orders).set({ status });
      expect(await createRefundRequestsRepo(db).create(input)).toBeNull();
    },
  );
  it("rejects direct flow, missing payment identity and wrong buyer at insertion", async () => {
    const repo = createRefundRequestsRepo(db);
    expect(await repo.create({ ...input, buyerUserId: "buyer_2" })).toBeNull();
    await db.update(orders).set({ flow: "direct" });
    expect(await repo.create(input)).toBeNull();
    await db.update(orders).set({ flow: "platform_transfer", paymentId: null });
    expect(await repo.create(input)).toBeNull();
    expect(await repo.listForBuyer("buyer_1")).toEqual([]);
  });
  it("keeps the earliest legacy request, including after refund, without deleting duplicates", async () => {
    await db.insert(refundRequests).values([
      {
        id: "legacy_a",
        orderId: ORDER_ID,
        buyerUserId: "buyer_1",
        sellerId: SELLER_ID,
        amountMinor: 2500,
        currency: "USD",
        reason: "original",
        status: "requested",
        createdAt: new Date("2026-01-01"),
      },
      {
        id: "legacy_b",
        orderId: ORDER_ID,
        buyerUserId: "buyer_1",
        sellerId: SELLER_ID,
        amountMinor: 2500,
        currency: "USD",
        reason: "second",
        status: "requested",
        createdAt: new Date("2026-01-02"),
      },
    ]);
    await db.update(orders).set({ status: "refunded" });
    const repo = createRefundRequestsRepo(db);
    const retried = await repo.create({ ...input, reason: "changed" });
    expect(retried).toMatchObject({
      id: "legacy_a",
      reason: "original",
      amountMinor: 2500,
      status: "requested",
    });
    expect((await repo.listForBuyer("buyer_1")).map((row) => row.id)).toEqual([
      "legacy_b",
      "legacy_a",
    ]);
  });
  it("stores a requested ask with the order amount and first reason", async () => {
    const repo = createRefundRequestsRepo(db);
    const first = await repo.create({ ...input, reason: "wrong item" });
    expect(first).toMatchObject({
      status: "requested",
      reason: "wrong item",
      amountMinor: 2500,
      currency: "USD",
    });
    expect(await repo.create({ ...input, reason: "replacement" })).toEqual(first);
  });
});
