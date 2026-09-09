import {
  type Earnings,
  type LedgerEntry,
  money,
  parseEffectKey,
  type Result,
  runId,
  type Seller,
  sellerId,
  whopAccountId,
} from "@ledgerly/core";
import { createMockAdapter, createSandboxAdapter, createWhopClient } from "@ledgerly/whop";
import { describe, expect, it, vi } from "vitest";
import {
  createGetEarningsHandler,
  type GetEarningsDeps,
} from "../../src/app/api/sellers/[id]/earnings/route";

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

function earnings(): Earnings {
  return {
    totals: [{ currency: "USD", total: value(money(2300, "USD")) }],
    recent: [],
  };
}

function ledgerEntries(): LedgerEntry[] {
  const key = value(parseEffectKey("payment:pay_1:seller"));
  return [
    {
      runId: RUN_ID,
      sellerId: SELLER_ID,
      accountSide: "seller",
      amount: value(money(2300, "USD")),
      kind: "payment",
      resourceType: "payment",
      resourceId: "pay_1",
      effectKey: key,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      runId: RUN_ID,
      sellerId: SELLER_ID,
      accountSide: "platform",
      amount: value(money(200, "USD")),
      kind: "fee",
      resourceType: "payment",
      resourceId: "pay_1",
      effectKey: key,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ];
}

function baseDeps(overrides: Partial<GetEarningsDeps> = {}): GetEarningsDeps {
  return {
    provider: createMockAdapter(),
    getSession: () => Promise.resolve({ userId: "user_1", role: "buyer" }),
    getSellerOwner: () => Promise.resolve("user_1"),
    getSeller: () => Promise.resolve(seller()),
    getEarnings: () => Promise.resolve(earnings()),
    getLedgerEntries: () => Promise.resolve(ledgerEntries()),
    env: { WHOP_MODE: "mock" as const },
    ...overrides,
  };
}

function get() {
  return new Request("https://example.invalid/api/sellers/seller_1/earnings");
}

describe("createGetEarningsHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createGetEarningsHandler(baseDeps({ getSession: () => Promise.resolve(null) }));
    const response = await handler(get(), SELLER_ID);
    expect(response.status).toBe(401);
  });

  it("returns 403 for a caller who does not own the seller", async () => {
    const handler = createGetEarningsHandler(
      baseDeps({ getSellerOwner: () => Promise.resolve("someone_else") }),
    );
    const response = await handler(get(), SELLER_ID);
    expect(response.status).toBe(403);
  });

  it("returns 404 when the seller does not exist", async () => {
    const handler = createGetEarningsHandler(baseDeps({ getSeller: () => Promise.resolve(null) }));
    const response = await handler(get(), SELLER_ID);
    expect(response.status).toBe(404);
  });

  it("returns the exact JSON shape, pairing a fee counterpart onto its seller row", async () => {
    const handler = createGetEarningsHandler(baseDeps());
    const response = await handler(get(), SELLER_ID);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      available: { amountMinor: number; currency: string };
      pending: { amountMinor: number; currency: string };
      held: { amountMinor: number; currency: string };
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
      charge_model: string;
    };
    expect(body.available).toEqual({ amountMinor: 2300, currency: "USD" });
    expect(body.pending).toEqual({ amountMinor: 0, currency: "USD" });
    expect(body.held).toEqual({ amountMinor: 0, currency: "USD" });
    expect(body.rows).toEqual([
      {
        date: "2026-01-01T00:00:00.000Z",
        order_id: null,
        item: "payment",
        status: "settled",
        gross: { amountMinor: 2500, currency: "USD" },
        fee: { amountMinor: 200, currency: "USD" },
        net: { amountMinor: 2300, currency: "USD" },
        provider_resource_id: "pay_1",
        provenance: "mock",
      },
    ]);
    expect(body.charge_model).toBe("direct");
  });

  it("reports platform_transfer for a platform_only seller", async () => {
    const handler = createGetEarningsHandler(
      baseDeps({ getSeller: () => Promise.resolve(seller({ salePolicy: "platform_only" })) }),
    );
    const response = await handler(get(), SELLER_ID);
    const body = (await response.json()) as { charge_model: string };
    expect(body.charge_model).toBe("platform_transfer");
  });

  it("allows an operator regardless of ownership", async () => {
    const handler = createGetEarningsHandler(
      baseDeps({
        getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
        getSellerOwner: () => Promise.resolve("someone_else"),
      }),
    );
    const response = await handler(get(), SELLER_ID);
    expect(response.status).toBe(200);
  });
});

describe("provider earnings", () => {
  it("uses the mock adapter's seller-scoped first page without changing local figures", async () => {
    const provider = createMockAdapter();
    const accountId = seller().whopAccountId;
    if (!accountId) throw new Error("test seller has no Whop account id");
    value(provider.seedPayment(value(money(900, "USD")), accountId));
    value(provider.seedPayment(value(money(700, "EUR")), accountId));
    value(provider.seedPayment(value(money(9999, "USD")), value(whopAccountId("biz_other"))));
    const read = vi.spyOn(provider, "listFinancialActivity");
    const response = await createGetEarningsHandler(baseDeps({ provider }))(get(), SELLER_ID);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.rows[0].provenance).toBe("mock");
    expect(read).toHaveBeenCalledExactlyOnceWith({ accountId, limit: 100 });
    expect(body.provider).toMatchObject({
      provenance: "mock",
      line_count: 2,
      has_more: false,
      basis: "first_page_activity",
    });
    expect(body.provider.available).toEqual(
      expect.arrayContaining([
        { currency: "USD", total: { amountMinor: 900, currency: "USD" } },
        { currency: "EUR", total: { amountMinor: 700, currency: "EUR" } },
      ]),
    );
    expect(body.provider_error).toBeNull();
    expect(body.available).toEqual({ amountMinor: 2300, currency: "USD" });
    expect(body.rows[0].net.amountMinor).toBe(2300);
  });

  it("preserves sandbox provenance through the real route and synthetic adapter response", async () => {
    // Synthetic response for adapter/route provenance, never provider evidence.
    const fixture = {
      response: {
        body: {
          data: [
            {
              id: "line_fixture",
              line_type: "payment",
              amount: "2300",
              usd_amount: "23.00",
              currency: { code: "usd", precision: "100" },
              posted_at: "2026-09-01T00:00:00Z",
              available_at: null,
              payment_id: "pay_fixture",
              source: null,
            },
          ],
          page_info: { end_cursor: null, has_next_page: false },
        },
      },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(fixture.response.body));
    const provider = createSandboxAdapter({
      client: createWhopClient({
        baseUrl: "https://sandbox.invalid/api/v1",
        apiKey: "fixture-key",
        apiVersionDate: "2026-08-21",
        fetch,
      }),
      parentAccountId: value(whopAccountId("biz_platform")),
    });
    const response = await createGetEarningsHandler(
      baseDeps({ provider, env: { WHOP_MODE: "sandbox" } }),
    )(get(), SELLER_ID);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.provider).toMatchObject({ provenance: "sandbox", basis: "first_page_activity" });
    expect(body.provider.line_count).toBeGreaterThan(0);
    expect(body.provider_error).toBeNull();
    expect(body.rows[0].provenance).toBe("sandbox");
    expect(body.available).toEqual({ amountMinor: 2300, currency: "USD" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { mode: "hybrid", source: "mock", expected: "mock", rowSource: "sandbox" },
    { mode: "mock", source: "sandbox", expected: "sandbox", rowSource: "mock" },
    { mode: "hybrid", source: "unknown", expected: null, rowSource: "sandbox" },
  ])(
    "prefers operation source $source to configured $mode",
    async ({ mode, source, expected, rowSource }) => {
      // Inject only result metadata; the activity still comes from the real mock adapter.
      const mock = createMockAdapter();
      const accountId = seller().whopAccountId;
      if (!accountId) throw new Error("missing fixture account");
      value(mock.seedPayment(value(money(900, "USD")), accountId));
      const provider: GetEarningsDeps["provider"] = {
        async listFinancialActivity(input) {
          const result = await mock.listFinancialActivity(input);
          return result.ok ? { ok: true, value: { ...result.value, meta: { source } } } : result;
        },
      };
      const response = await createGetEarningsHandler(
        baseDeps({ provider, env: { WHOP_MODE: mode } }),
      )(get(), SELLER_ID);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.provider).toMatchObject({
        provenance: expected,
        available: [{ currency: "USD", total: { currency: "USD", amountMinor: 900 } }],
      });
      expect(body.provider_error).toBeNull();
      expect(body.rows[0].provenance).toBe(rowSource);
      expect(body.rows[0].net).toEqual({ amountMinor: 2300, currency: "USD" });
    },
  );

  it("does not call the provider for a disconnected seller", async () => {
    const provider = createMockAdapter();
    const read = vi.spyOn(provider, "listFinancialActivity");
    const response = await createGetEarningsHandler(
      baseDeps({ provider, getSeller: async () => seller({ whopAccountId: null }) }),
    )(get(), SELLER_ID);
    expect(await response.json()).toMatchObject({
      provider: null,
      provider_error: "seller_not_connected",
      available: { amountMinor: 2300 },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "mock", kind: "network" },
    { mode: "sandbox", kind: "network" },
    { mode: "mock", kind: "credential_missing" },
    { mode: "sandbox", kind: "credential_missing" },
  ] as const)(
    "reports $kind in $mode without exposing provider error bodies",
    async ({ mode, kind }) => {
      const provider = createMockAdapter();
      vi.spyOn(provider, "listFinancialActivity").mockResolvedValue({
        ok: false,
        error: { kind, body: "private provider detail" },
      });
      const response = await createGetEarningsHandler(
        baseDeps({ provider, env: { WHOP_MODE: mode } }),
      )(get(), SELLER_ID);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        provider: null,
        provider_error: kind,
        available: { amountMinor: 2300 },
      });
      expect(JSON.stringify(body)).not.toContain("private provider detail");
    },
  );

  it.each(["mock", "sandbox"])("keeps decode failures safe in %s mode", async (mode) => {
    const provider = createMockAdapter();
    const accountId = seller().whopAccountId;
    if (!accountId) throw new Error("missing fixture account");
    value(provider.seedPayment(value(money(900, "USD")), accountId));
    const page = value(await provider.listFinancialActivity({ accountId }));
    vi.spyOn(provider, "listFinancialActivity").mockResolvedValue({
      ok: true,
      value: { ...page, items: page.items.map((line) => ({ ...line, amount: null })) },
    });
    const response = await createGetEarningsHandler(
      baseDeps({ provider, env: { WHOP_MODE: mode } }),
    )(get(), SELLER_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      provider: null,
      provider_error: "decode",
      available: { amountMinor: 2300, currency: "USD" },
      rows: [{ net: { amountMinor: 2300, currency: "USD" }, provenance: mode }],
    });
  });

  it("contains a rejected provider call", async () => {
    const provider = createMockAdapter();
    vi.spyOn(provider, "listFinancialActivity").mockRejectedValue(new Error("private detail"));
    const response = await createGetEarningsHandler(baseDeps({ provider }))(get(), SELLER_ID);
    expect(await response.json()).toMatchObject({
      provider: null,
      provider_error: "provider_unavailable",
    });
  });
});

it("limits provider earnings to 100 raw lines and discloses another page", async () => {
  const provider = createMockAdapter();
  const bulkAccountId = seller().whopAccountId;
  if (!bulkAccountId) throw new Error("test seller has no Whop account id");
  for (let index = 0; index < 101; index++)
    value(provider.seedPayment(value(money(1, "USD")), bulkAccountId));
  const read = vi.spyOn(provider, "listFinancialActivity");
  const response = await createGetEarningsHandler(baseDeps({ provider }))(get(), SELLER_ID);
  expect((await response.json()).provider).toMatchObject({
    line_count: 100,
    has_more: true,
    available: [{ currency: "USD", total: { currency: "USD", amountMinor: 100 } }],
  });
  expect(read).toHaveBeenCalledTimes(1);
});
