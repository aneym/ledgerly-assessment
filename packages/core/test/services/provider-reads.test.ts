import { expect, it } from "vitest";
import { whopAccountId, whopPaymentId, whopTransferId } from "../../src/ids";
import type { WhopPort } from "../../src/ports/whop";
import { ok, type Result } from "../../src/result";
import { createReconciliationProvider } from "../../src/services/provider-reads";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Invalid fixture");
  return result.value;
}
const accountId = value(whopAccountId("biz_reader"));
const payment = {
  id: value(whopPaymentId("pay_reader")),
  accountId,
  status: "succeeded",
  amount: { amountMinor: 2500, currency: "USD" as const },
  currency: "USD" as const,
  createdAt: "2026-09-08T00:00:00Z",
};
const transfer = {
  id: value(whopTransferId("tsf_reader")),
  status: "completed",
  amount: { amountMinor: 2300, currency: "USD" as const },
  currency: "USD" as const,
  createdAt: payment.createdAt,
  origin: { id: "biz_platform", type: "Company" as const },
  destination: { id: accountId, type: "Company" as const },
};
function provider(
  overrides: Partial<Pick<WhopPort, "listPayments" | "listTransfers">> = {},
): Pick<WhopPort, "listPayments" | "listTransfers"> {
  return {
    async listPayments() {
      return ok({ items: [payment], nextCursor: null });
    },
    async listTransfers() {
      return ok({ items: [transfer], nextCursor: null });
    },
    ...overrides,
  };
}
it("normalizes canonical payment and transfer pages without losing resource identity", async () => {
  const reader = createReconciliationProvider(provider());
  expect(value(await reader.listPayments({ accountId, limit: 100 })).data).toEqual([
    {
      id: "pay_reader",
      accountId,
      amount: { amountMinor: 2500, currency: "USD" },
      status: "succeeded",
    },
  ]);
  expect(value(await reader.listTransfers({ accountId, limit: 100 })).data).toEqual([
    {
      id: "tsf_reader",
      accountId,
      amount: { amountMinor: 2300, currency: "USD" },
      status: "completed",
    },
  ]);
});
it('reads the sandbox\'s "paid" payment status as the confirmed state', async () => {
  const reader = createReconciliationProvider(
    provider({
      listPayments: async () => ok({ items: [{ ...payment, status: "paid" }], nextCursor: null }),
    }),
  );
  expect(value(await reader.listPayments({ accountId, limit: 100 })).data[0]?.status).toBe(
    "succeeded",
  );
});
it("preserves the pagination cursor through both read contracts", async () => {
  const reader = createReconciliationProvider(
    provider({
      async listPayments(input) {
        expect(input.cursor).toBe("previous");
        return ok({ items: [payment], nextCursor: "next" });
      },
    }),
  );
  expect(
    value(await reader.listPayments({ accountId, limit: 100, cursor: "previous" })).nextCursor,
  ).toBe("next");
});
it("does not invent zero money for an absent provider amount", async () => {
  const reader = createReconciliationProvider(
    provider({
      async listPayments() {
        return ok({ items: [{ ...payment, amount: null }], nextCursor: null });
      },
    }),
  );
  expect(await reader.listPayments({ accountId, limit: 100 })).toEqual({
    ok: false,
    error: { kind: "decode" },
  });
});
it("rejects a provider payment belonging to a different seller", async () => {
  const reader = createReconciliationProvider(
    provider({
      async listPayments() {
        return ok({
          items: [{ ...payment, accountId: value(whopAccountId("biz_other")) }],
          nextCursor: null,
        });
      },
    }),
  );
  expect((await reader.listPayments({ accountId, limit: 100 })).ok).toBe(false);
});
it("rejects transfers to a different destination instead of counting them as seller income", async () => {
  const reader = createReconciliationProvider(
    provider({
      async listTransfers() {
        return ok({
          items: [{ ...transfer, destination: { id: "biz_other", type: "Company" } }],
          nextCursor: null,
        });
      },
    }),
  );
  expect((await reader.listTransfers({ accountId, limit: 100 })).ok).toBe(false);
});
it("rejects unknown provider statuses rather than silently clearing drift", async () => {
  const reader = createReconciliationProvider(
    provider({
      async listPayments() {
        return ok({ items: [{ ...payment, status: "new_status" }], nextCursor: null });
      },
    }),
  );
  expect((await reader.listPayments({ accountId, limit: 100 })).ok).toBe(false);
});
