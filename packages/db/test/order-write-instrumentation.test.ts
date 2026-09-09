import type { NewOrder, OrderId } from "@ledgerly/core";
import { expect, it, vi } from "vitest";
import type { InstrumentationEvent } from "../../core/src/instrumentation";
import { createOrdersRepo } from "../src/repos/orders";

const row = {
  id: "order_proof",
  runId: "run_proof",
  sellerId: "seller_proof",
  productTitle: "Private title",
  productExternalId: null,
  grossMinor: 1000,
  feeMinor: 100,
  currency: "USD",
  flow: "platform_transfer",
  checkoutConfigurationId: null,
  purchaseUrl: null,
  status: "pending",
  createdAt: new Date(),
  provenance: "mock",
  buyerUserId: null,
  paymentId: null,
};

function fixture() {
  const events: InstrumentationEvent[] = [];
  const returning = vi.fn().mockResolvedValue([row]);
  const where = vi.fn().mockResolvedValue([row]);
  const db = {
    insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning }) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning }) }) }),
    select: () => ({ from: () => ({ where }) }),
  };
  const repo = createOrdersRepo(db as unknown as Parameters<typeof createOrdersRepo>[0], {
    emitter: { emit: (event) => events.push(event) },
    provenance: "pglite",
  });
  const input = {
    runId: row.runId,
    sellerId: row.sellerId,
    productTitle: row.productTitle,
    gross: { currency: "USD", amountMinor: 1000 },
    fee: { currency: "USD", amountMinor: 100 },
    flow: "platform_transfer",
  } as NewOrder;
  const create = () => repo.createOrFetch(input, row.id as OrderId);
  const update = () =>
    repo.setCheckout(row.id as OrderId, {
      checkoutConfigurationId: "chk_proof",
      purchaseUrl: null,
      status: "checkout_created",
      provenance: "mock",
    });
  return { events, returning, where, create, update };
}

it.each(["create", "update"] as const)(
  "emits %s only after the autocommit RETURNING resolves",
  async (method) => {
    const f = fixture();
    let release!: (rows: (typeof row)[]) => void;
    f.returning.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f[method]();
    expect(f.events).toEqual([]);
    release([row]);
    await pending;
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({
      source: "db",
      phase: "end",
      path: "orders",
      status: "ok",
      runId: row.runId,
      safeIds: { order_id: row.id },
    });
    expect(JSON.stringify(f.events)).not.toContain("Private title");
  },
);

it("does not label conflict readback as a write", async () => {
  const f = fixture();
  f.returning.mockResolvedValue([]);
  expect((await f.create()).id).toBe(row.id);
  expect(f.events).toEqual([]);
});

it.each(["create", "update"] as const)(
  "does not emit committed proof for a rejected %s write",
  async (method) => {
    const f = fixture();
    f.returning.mockRejectedValue(new Error("write rolled back"));
    await expect(f[method]()).rejects.toThrow("write rolled back");
    expect(f.events).toEqual([]);
  },
);

it.each(["create", "update"] as const)(
  "does not emit %s proof for missing or invalid RETURNING",
  async (method) => {
    const f = fixture();
    f.returning.mockResolvedValue([]);
    f.where.mockResolvedValue([]);
    await expect(f[method]()).rejects.toThrow("Order disappeared");
    f.returning.mockResolvedValue([{ ...row, status: "invalid" }]);
    await expect(f[method]()).rejects.toThrow("Invalid persisted order status");
    expect(f.events).toEqual([]);
  },
);
