import { expect, it, vi } from "vitest";
import { sellerId, whopAccountId } from "../../src/ids";
import type { WhopLedgerLine, WhopPort } from "../../src/ports/whop";
import { ok } from "../../src/result";
import { getProviderEarnings, summarizeFinancialActivity } from "../../src/services/earnings";
import type { ReconciliationProvider, UnitOfWork } from "../../src/services/ports";
import { createReconciliationService } from "../../src/services/reconciliation";

const now = new Date("2026-09-08T12:00:00Z");
function line(amountMinor: number, overrides: Partial<WhopLedgerLine> = {}): WhopLedgerLine {
  return {
    id: "line_1",
    amount: { currency: "USD", amountMinor },
    lineType: "payment_gross",
    usdAmount: "0",
    postedAt: now.toISOString(),
    availableAt: null,
    paymentId: null,
    source: { type: "payment", id: "pay_1" },
    raw: { private: "not returned" },
    ...overrides,
  };
}
it("separates pending inflows and signed reserve movements without merging currencies", () => {
  const result = summarizeFinancialActivity(
    [
      line(1000, { availableAt: now.toISOString() }),
      line(500, { availableAt: "2026-09-09T00:00:00Z" }),
      line(-200, { lineType: "balance_reservation" }),
      line(50, { lineType: "balance_reservation_reversal" }),
      line(-100, { lineType: "payment_refund" }),
      line(77, { amount: { amountMinor: 77, currency: "EUR" } }),
    ],
    true,
    "mock",
    now,
  );
  expect(result).toMatchObject({ line_count: 6, has_more: true, provenance: "mock" });
  expect(result?.available).toEqual([
    { currency: "USD", total: { currency: "USD", amountMinor: 750 } },
    { currency: "EUR", total: { currency: "EUR", amountMinor: 77 } },
  ]);
  expect(result?.pending[0]?.total.amountMinor).toBe(500);
  expect(result?.reserve[0]?.total.amountMinor).toBe(150);
});
it("does not invent money for undecoded amounts or overflow", () => {
  expect(summarizeFinancialActivity([line(0, { amount: null })], false)).toBeNull();
  expect(summarizeFinancialActivity([line(Number.MAX_SAFE_INTEGER), line(1)], false)).toBeNull();
  expect(summarizeFinancialActivity([line(5, { availableAt: "invalid" })], false)).toBeNull();
});

it.each(["mock", "sandbox"] as const)("preserves explicit %s summary provenance", (source) => {
  expect(summarizeFinancialActivity([line(900)], false, source, now)).toMatchObject({
    provenance: source,
    available: [{ currency: "USD", total: { currency: "USD", amountMinor: 900 } }],
    basis: "first_page_activity",
  });
});

it("leaves a summary source unreported when none was supplied", () => {
  expect(summarizeFinancialActivity([line(900)], false)?.provenance).toBeNull();
});

it.each([
  { fallback: "sandbox", meta: { source: "mock" }, expected: "mock" },
  { fallback: "mock", meta: { source: "sandbox" }, expected: "sandbox" },
  { fallback: "sandbox", meta: { source: "unknown" }, expected: null },
  { fallback: null, meta: undefined, expected: null },
] as const)(
  "resolves operation metadata $meta against fallback $fallback",
  async ({ fallback, meta, expected }) => {
    const accountId = whopAccountId("biz_financial");
    if (!accountId.ok) throw new Error("invalid fixture");
    const provider = {
      listFinancialActivity: async () =>
        ok({ items: [line(900)], nextCursor: null, ...(meta ? { meta } : {}) }),
    };
    const result = await getProviderEarnings(provider, accountId.value, fallback);
    expect(result).toMatchObject({
      provider: {
        provenance: expected,
        available: [{ currency: "USD", total: { currency: "USD", amountMinor: 900 } }],
      },
      provider_error: null,
    });
  },
);

it.each([
  { fallback: "mock", source: undefined, expected: "mock" },
  { fallback: "sandbox", source: undefined, expected: "sandbox" },
  { fallback: "sandbox", source: "mock", expected: "mock" },
  { fallback: "mock", source: "sandbox", expected: "sandbox" },
  { fallback: undefined, source: undefined, expected: null },
] as const)(
  "reconciles with source $expected without writes or double counting",
  async ({ fallback, source, expected }) => {
    const sid = sellerId("seller_financial");
    const aid = whopAccountId("biz_financial");
    if (!sid.ok || !aid.ok) throw new Error("invalid fixture");
    const append = vi.fn();
    const uow = {
      run: async (fn: (r: unknown) => unknown) =>
        fn({
          sellers: { get: async () => ({ whopAccountId: aid.value }) },
          ledger: {
            forSeller: async () => [
              {
                resourceType: "payment",
                resourceId: "pay_1",
                accountSide: "seller",
                amount: { currency: "USD", amountMinor: 900 },
              },
            ],
            append,
          },
        }),
    } as UnitOfWork;
    const listTransfers = vi.fn(async () => ok({ data: [], nextCursor: null }));
    const listFinancialActivity = vi.fn(async () =>
      ok({
        items: [line(1000), line(-100, { id: "line_2", lineType: "application_fee" })],
        nextCursor: "next",
        ...(source ? { meta: { source } } : {}),
      }),
    );
    const provider: ReconciliationProvider & Pick<WhopPort, "listFinancialActivity"> = {
      listPayments: async () =>
        ok({
          data: [
            {
              id: "pay_1",
              accountId: aid.value,
              amount: { currency: "USD", amountMinor: 900 },
              status: "succeeded",
            },
          ],
          nextCursor: null,
        }),
      listTransfers,
      listFinancialActivity,
    };
    const result = await createReconciliationService(
      uow,
      fallback,
    )({ sellerId: sid.value, provider });
    expect(listTransfers).toHaveBeenCalledExactlyOnceWith({
      accountId: aid.value,
      limit: 100,
      direction: "destination",
    });
    expect(listFinancialActivity).toHaveBeenCalledExactlyOnceWith({
      accountId: aid.value,
      limit: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amountMismatch).toEqual([]);
    expect(result.value.missingLocally).toEqual([]);
    expect(result.value.financialActivity?.comparisons).toEqual([
      {
        resourceId: "pay_1",
        provider: { currency: "USD", amountMinor: 900 },
        local: { currency: "USD", amountMinor: 900 },
        matches: true,
      },
    ]);
    expect(result.value.financialActivity?.provider?.has_more).toBe(true);
    expect(result.value.financialActivity?.provider?.provenance).toBe(expected);
    expect(JSON.stringify(result)).not.toContain("not returned");
    expect(append).not.toHaveBeenCalled();
  },
);
