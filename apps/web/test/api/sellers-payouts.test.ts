import {
  type LedgerEntry,
  money,
  parseEffectKey,
  type Result,
  runId,
  type Seller,
  sellerId,
  whopAccountId,
} from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import {
  createGetPayoutsHandler,
  type GetPayoutsDeps,
} from "../../src/app/api/sellers/[id]/payouts/route";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const SELLER_ID = value(sellerId("seller_1"));
const RUN_ID = value(runId("run_1"));

function seller(overrides: Partial<Seller> = {}): Seller {
  return {
    id: SELLER_ID,
    runId: RUN_ID,
    externalId: "alice",
    email: "alice@example.invalid",
    country: "US",
    whopAccountId: value(whopAccountId("biz_alice")),
    salePolicy: "direct",
    status: "active",
    ...overrides,
  };
}

function ledgerEntries(): [LedgerEntry, LedgerEntry] {
  const paymentKey = value(parseEffectKey("payment:pay_1:seller"));
  const payoutKey = value(parseEffectKey("payout:po_1:completed"));
  return [
    {
      runId: RUN_ID,
      sellerId: SELLER_ID,
      accountSide: "seller",
      amount: value(money(2300, "USD")),
      kind: "payment",
      resourceType: "payment",
      resourceId: "pay_1",
      effectKey: paymentKey,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      runId: RUN_ID,
      sellerId: SELLER_ID,
      accountSide: "seller",
      amount: value(money(-2300, "USD")),
      kind: "payout_completed",
      resourceType: "payout",
      resourceId: "po_1",
      effectKey: payoutKey,
      occurredAt: new Date("2026-01-02T00:00:00.000Z"),
    },
  ];
}

function baseDeps(overrides: Partial<GetPayoutsDeps> = {}): GetPayoutsDeps {
  return {
    getSession: () => Promise.resolve({ userId: "user_1", role: "buyer" }),
    getSellerOwner: () => Promise.resolve("user_1"),
    getSeller: () => Promise.resolve(seller()),
    getLedgerEntries: () => Promise.resolve(ledgerEntries()),
    env: { WHOP_MODE: "mock" as const },
    ...overrides,
  };
}

function get() {
  return new Request("https://example.invalid/api/sellers/seller_1/payouts");
}

describe("createGetPayoutsHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createGetPayoutsHandler(baseDeps({ getSession: () => Promise.resolve(null) }));
    const response = await handler(get(), SELLER_ID);
    expect(response.status).toBe(401);
  });

  it("returns 403 for a caller who does not own the seller", async () => {
    const handler = createGetPayoutsHandler(
      baseDeps({ getSellerOwner: () => Promise.resolve("someone_else") }),
    );
    const response = await handler(get(), SELLER_ID);
    expect(response.status).toBe(403);
  });

  it("returns 404 when the seller does not exist", async () => {
    const handler = createGetPayoutsHandler(baseDeps({ getSeller: () => Promise.resolve(null) }));
    const response = await handler(get(), SELLER_ID);
    expect(response.status).toBe(404);
  });

  it("allows an operator regardless of ownership", async () => {
    const handler = createGetPayoutsHandler(
      baseDeps({
        getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
        getSellerOwner: () => Promise.resolve("someone_else"),
      }),
    );
    const response = await handler(get(), SELLER_ID);
    expect(response.status).toBe(200);
  });

  it("keeps only payout rows, dropping payments and other ledger items", async () => {
    const handler = createGetPayoutsHandler(baseDeps());
    const response = await handler(get(), SELLER_ID);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      rows: Array<{
        date: string;
        order_id: string | null;
        item: string;
        status: string;
        gross: { amountMinor: number; currency: string };
        fee: { amountMinor: number; currency: string };
        net: { amountMinor: number; currency: string };
        provider_resource_id: string;
        provenance: string;
      }>;
    };
    expect(body.rows).toEqual([
      {
        date: "2026-01-02T00:00:00.000Z",
        order_id: null,
        item: "payout",
        status: "paid_out",
        gross: { amountMinor: -2300, currency: "USD" },
        fee: { amountMinor: 0, currency: "USD" },
        net: { amountMinor: -2300, currency: "USD" },
        provider_resource_id: "po_1",
        provenance: "mock",
      },
    ]);
  });

  it("returns an empty row list when the seller has no payout history", async () => {
    const handler = createGetPayoutsHandler(
      baseDeps({ getLedgerEntries: () => Promise.resolve([]) }),
    );
    const response = await handler(get(), SELLER_ID);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });
});

describe("payout history projection", () => {
  it("shows one completed payout with its positive amount while preserving accounting rows", async () => {
    const completed = ledgerEntries()[1];
    const pending: LedgerEntry = {
      ...completed,
      kind: "payout_pending",
      effectKey: value(parseEffectKey("payout:po_1:pending")),
      amount: value(money(0, "USD")),
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const handler = createGetPayoutsHandler(
      baseDeps({
        getLedgerEntries: async () => [pending, completed],
      }),
    );
    const body = await (await handler(get(), SELLER_ID)).json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].net.amountMinor).toBe(-2300);
    expect(body.history).toEqual([
      {
        id: "po_1",
        date: "2026-01-02T00:00:00.000Z",
        amount: { amountMinor: 2300, currency: "USD" },
        status: "paid_out",
      },
    ]);
  });

  it("does not mistake a pending zero ledger effect for a known payout amount", async () => {
    const handler = createGetPayoutsHandler(
      baseDeps({
        getLedgerEntries: async () => [
          {
            ...ledgerEntries()[1],
            kind: "payout_pending",
            effectKey: value(parseEffectKey("payout:po_1:pending")),
            amount: value(money(0, "USD")),
          },
        ],
      }),
    );
    const body = await (await handler(get(), SELLER_ID)).json();
    expect(body.history).toEqual([
      {
        id: "po_1",
        date: "2026-01-02T00:00:00.000Z",
        amount: null,
        status: "pending",
      },
    ]);
  });

  it("retains a payout when twenty newer sales fill the earnings activity page", async () => {
    const sale = ledgerEntries()[0];
    const handler = createGetPayoutsHandler(
      baseDeps({
        getLedgerEntries: async () => [
          ledgerEntries()[1],
          ...Array.from({ length: 20 }, (_, i) => ({
            ...sale,
            resourceId: `pay_new_${i}`,
            occurredAt: new Date("2026-02-01T00:00:00.000Z"),
          })),
        ],
      }),
    );
    const body = await (await handler(get(), SELLER_ID)).json();
    expect(body.history).toHaveLength(1);
    expect(body.history[0].id).toBe("po_1");
  });
});

describe("payout inbox vocabulary in API history", () => {
  it.each(["requested", "in_review", "processing", "reversed", "denied"])(
    "includes the %s payout transition",
    async (status) => {
      const handler = createGetPayoutsHandler(
        baseDeps({
          getLedgerEntries: async () => [
            {
              ...ledgerEntries()[1],
              kind: `payout_${status}`,
              effectKey: value(parseEffectKey(`payout:po_1:${status}`)),
              amount: value(money(0, "USD")),
            },
          ],
        }),
      );
      const body = await (await handler(get(), SELLER_ID)).json();
      expect(body.history).toEqual([
        { id: "po_1", date: "2026-01-02T00:00:00.000Z", status, amount: null },
      ]);
    },
  );
});
