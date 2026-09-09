import { describe, expect, it } from "vitest";
import { type OrderId, orderId, type RunId, runId, sellerId, whopAccountId } from "../../src/ids";
import { money } from "../../src/money";
import type { WhopPort } from "../../src/ports/whop";
import type { WhopError } from "../../src/ports/whop-types";
import type { Result } from "../../src/result";
import { err, ok } from "../../src/result";
import type { Seller } from "../../src/seller";
import type { SellerLookup } from "../../src/services/orders";
import type { LedgerEntry, LedgerRepo, UnitOfWork } from "../../src/services/ports";
import {
  createTransferReleaseService,
  type TransferCandidate,
  type TransferOrdersRepo,
} from "../../src/services/transfers";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const run: RunId = value(runId("run_transfers"));
const platformAccountId = value(whopAccountId("biz_platform"));
const gross25 = value(money(2500, "USD"));
const fee2 = value(money(200, "USD"));

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

function candidate(
  overrides: Partial<TransferCandidate> = {},
  id: OrderId = value(orderId("order_1")),
): TransferCandidate {
  return {
    id,
    runId: run,
    sellerId: value(sellerId("seller_1")),
    gross: gross25,
    fee: fee2,
    createdAt: new Date("2026-09-01T00:00:00Z"),
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

// Mirrors the real repo's contract: findEligible excludes anything already recorded,
// so a released order never comes back, and recordTransfer only ever moves an order
// from untransferred to transferred, never back.
function fakeOrders(rows: TransferCandidate[]) {
  const transferred = new Map<OrderId, string>();
  let recordCalls = 0;
  const repo: TransferOrdersRepo = {
    async findEligible(input) {
      return rows.filter(
        (row) => !transferred.has(row.id) && row.createdAt.getTime() <= input.olderThan.getTime(),
      );
    },
    async recordTransfer(id, transferId) {
      recordCalls++;
      transferred.set(id, transferId);
    },
  };
  return {
    repo,
    get recordCalls() {
      return recordCalls;
    },
    transferIdFor(id: OrderId) {
      return transferred.get(id) ?? null;
    },
  };
}

// Stands in for the simulator's createTransfer: this test lives in packages/core, which
// depends on nothing outside itself, so the provider double is written by hand.
function fakeProvider(outcome: "succeed" | "network" | "insufficient_balance") {
  let calls = 0;
  const lastInputs: Parameters<WhopPort["createTransfer"]>[0][] = [];
  const provider: Pick<WhopPort, "createTransfer"> = {
    async createTransfer(input) {
      calls++;
      lastInputs.push(input);
      if (outcome === "network") return err({ kind: "network" } satisfies WhopError);
      if (outcome === "insufficient_balance")
        return err({ kind: "insufficient_balance" } satisfies WhopError);
      return ok({ id: `sim_tr_${calls}` as never, raw: {} });
    },
  };
  return {
    provider,
    get calls() {
      return calls;
    },
    get lastInputs() {
      return lastInputs;
    },
  };
}

function fakeLedger() {
  const entries: LedgerEntry[] = [];
  const ledger: Pick<LedgerRepo, "append"> = {
    async append(rows) {
      entries.push(...rows);
    },
  };
  return { ledger, entries };
}

function fakeUow(): Pick<UnitOfWork, "exclusive"> {
  return {
    async exclusive(_key, fn) {
      return fn({
        async run() {
          throw new Error("transfers service should not need work.run");
        },
      });
    },
  };
}

const clock = { now: () => new Date("2026-09-08T00:00:00Z") };

describe("createTransferReleaseService", () => {
  it("releases an eligible order: calls the provider for gross-minus-fee, records the transfer id, and posts a zero-amount requested marker", async () => {
    const orders = fakeOrders([candidate()]);
    const provider = fakeProvider("succeed");
    const ledger = fakeLedger();
    const releaseTransfers = createTransferReleaseService({
      uow: fakeUow(),
      provider: provider.provider,
      orders: orders.repo,
      sellers: fakeSellers(seller()),
      ledger: ledger.ledger,
      clock,
      platformAccountId,
    });
    const result = await releaseTransfers();
    expect(result).toEqual({ released: 1, retried: 0, failed: 0 });
    expect(provider.calls).toBe(1);
    expect(provider.lastInputs[0]).toMatchObject({
      originId: platformAccountId,
      destinationId: value(whopAccountId("biz_alice")),
      amount: { amountMinor: 2300, currency: "USD" },
      metadata: { order_id: "order_1" },
    });
    expect(orders.recordCalls).toBe(1);
    expect(orders.transferIdFor(value(orderId("order_1")))).toBe("sim_tr_1");
    expect(ledger.entries).toEqual([
      expect.objectContaining({
        accountSide: "seller",
        amount: { amountMinor: 0, currency: "USD" },
        kind: "transfer_requested",
        resourceType: "order",
        resourceId: "order_1",
      }),
    ]);
  });

  it("passes an idempotency key derived from the order id", async () => {
    const provider = fakeProvider("succeed");
    let seenKey: string | undefined;
    const spyProvider: Pick<WhopPort, "createTransfer"> = {
      async createTransfer(input, idempotencyKey) {
        seenKey = idempotencyKey;
        return provider.provider.createTransfer(input, idempotencyKey);
      },
    };
    const releaseTransfers = createTransferReleaseService({
      uow: fakeUow(),
      provider: spyProvider,
      orders: fakeOrders([candidate()]).repo,
      sellers: fakeSellers(seller()),
      ledger: fakeLedger().ledger,
      clock,
      platformAccountId,
    });
    await releaseTransfers();
    expect(seenKey).toBe("transfer:order_1");
  });

  it("leaves an order not yet past its hold untouched: the provider is never called", async () => {
    const recent = candidate({ createdAt: new Date("2026-09-07T23:59:00Z") });
    const orders = fakeOrders([recent]);
    const provider = fakeProvider("succeed");
    const releaseTransfers = createTransferReleaseService({
      uow: fakeUow(),
      provider: provider.provider,
      orders: orders.repo,
      sellers: fakeSellers(seller()),
      ledger: fakeLedger().ledger,
      clock,
      platformAccountId,
      holdSeconds: 3600,
    });
    const result = await releaseTransfers();
    expect(result).toEqual({ released: 0, retried: 0, failed: 0 });
    expect(provider.calls).toBe(0);
    expect(orders.recordCalls).toBe(0);
  });

  it("counts a network error as retried, without recording a transfer id or posting a ledger entry", async () => {
    const orders = fakeOrders([candidate()]);
    const provider = fakeProvider("network");
    const ledger = fakeLedger();
    const releaseTransfers = createTransferReleaseService({
      uow: fakeUow(),
      provider: provider.provider,
      orders: orders.repo,
      sellers: fakeSellers(seller()),
      ledger: ledger.ledger,
      clock,
      platformAccountId,
    });
    const result = await releaseTransfers();
    expect(result).toEqual({ released: 0, retried: 1, failed: 0 });
    expect(orders.recordCalls).toBe(0);
    expect(ledger.entries).toEqual([]);
  });

  it("counts a non-network provider error (e.g. insufficient_balance) as failed", async () => {
    const orders = fakeOrders([candidate()]);
    const provider = fakeProvider("insufficient_balance");
    const releaseTransfers = createTransferReleaseService({
      uow: fakeUow(),
      provider: provider.provider,
      orders: orders.repo,
      sellers: fakeSellers(seller()),
      ledger: fakeLedger().ledger,
      clock,
      platformAccountId,
    });
    const result = await releaseTransfers();
    expect(result).toEqual({ released: 0, retried: 0, failed: 1 });
    expect(orders.recordCalls).toBe(0);
  });

  it("fails an order whose seller has not finished onboarding, without calling the provider", async () => {
    const orders = fakeOrders([candidate()]);
    const provider = fakeProvider("succeed");
    const releaseTransfers = createTransferReleaseService({
      uow: fakeUow(),
      provider: provider.provider,
      orders: orders.repo,
      sellers: fakeSellers(seller({ whopAccountId: null })),
      ledger: fakeLedger().ledger,
      clock,
      platformAccountId,
    });
    const result = await releaseTransfers();
    expect(result).toEqual({ released: 0, retried: 0, failed: 1 });
    expect(provider.calls).toBe(0);
  });

  it("never sends the same order twice: once recorded, a later run no longer sees it as eligible", async () => {
    const orders = fakeOrders([candidate()]);
    const provider = fakeProvider("succeed");
    const releaseTransfers = createTransferReleaseService({
      uow: fakeUow(),
      provider: provider.provider,
      orders: orders.repo,
      sellers: fakeSellers(seller()),
      ledger: fakeLedger().ledger,
      clock,
      platformAccountId,
    });
    const first = await releaseTransfers();
    expect(first).toEqual({ released: 1, retried: 0, failed: 0 });
    const second = await releaseTransfers();
    expect(second).toEqual({ released: 0, retried: 0, failed: 0 });
    expect(provider.calls).toBe(1);
  });
});
