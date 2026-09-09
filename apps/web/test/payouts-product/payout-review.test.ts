import { runId, sellerId } from "@ledgerly/core";
import { expect, it } from "vitest";
import {
  createPayoutSimulationStore,
  type PayoutSimulationDeps,
} from "../../src/lib/payout-simulation";

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw Error("fixture");
  return r.value;
}
const seller = {
  id: value(sellerId("seller_review")),
  runId: value(runId("run_review")),
  externalId: "review",
  email: "review@example.invalid",
  country: "US" as const,
  whopAccountId: null,
  salePolicy: "direct" as const,
  status: "active" as const,
};
const url = "https://ledgerly.example/api/sellers/seller_review/payouts/simulation";
function request(body?: unknown) {
  return new Request(
    url,
    body
      ? {
          method: "POST",
          headers: { origin: "https://ledgerly.example", "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
}
function setup() {
  const store = createPayoutSimulationStore();
  const deps: PayoutSimulationDeps = {
    enabled: true,
    authorize: async () => ({ ok: true, userId: "reviewer" }),
    getSeller: async () => seller,
    now: () => new Date("2026-09-09T12:00:00Z"),
  };
  return {
    store,
    deps,
    call: async (body?: unknown) => {
      const response = await store.handle(request(body), seller.id, deps);
      return { status: response.status, body: await response.json() };
    },
  };
}
it("serializes concurrent reset, start, withdraw and GET snapshots", async () => {
  const { call } = setup();
  await call({ action: "start" });
  await call({
    action: "withdraw",
    amount: "25.00",
    requestId: "11111111-1111-4111-8111-111111111111",
  });
  const results = await Promise.all([
    call({ action: "reset" }),
    call({ action: "start" }),
    call({
      action: "withdraw",
      amount: "25.00",
      requestId: "22222222-2222-4222-8222-222222222222",
    }),
    call(),
  ]);
  expect(results.map((r) => [r.body.available.amountMinor, r.body.payouts.length])).toEqual([
    [10000, 0],
    [10000, 0],
    [7500, 1],
    [7500, 1],
  ]);
});
it("releases a session after a rejected overdraft", async () => {
  const { call } = setup();
  await call({ action: "start" });
  const results = await Promise.all([
    call({
      action: "withdraw",
      amount: "101.00",
      requestId: "11111111-1111-4111-8111-111111111111",
    }),
    call({
      action: "withdraw",
      amount: "25.00",
      requestId: "22222222-2222-4222-8222-222222222222",
    }),
    call(),
  ]);
  expect(results.map((r) => r.status)).toEqual([409, 200, 200]);
  expect([10000, 7500]).toContain(results[2].body.available.amountMinor);
  const final = await call();
  expect(final.body.available.amountMinor).toBe(7500);
  expect(final.body.payouts).toHaveLength(1);
});
it("returns coherent concurrent snapshots across four payout pages", async () => {
  const { call } = setup();
  await call({ action: "start" });
  const results = await Promise.all(
    Array.from({ length: 151 }, (_, i) =>
      call({
        action: "withdraw",
        amount: "0.01",
        requestId: `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
      }),
    ),
  );
  for (let i = 0; i < 151; i++) {
    expect(results[i].status).toBe(200);
    expect(results[i].body.available.amountMinor).toBe(9999 - i);
    expect(results[i].body.payouts).toHaveLength(i + 1);
    expect(new Set(results[i].body.payouts.map((p: { id: string }) => p.id)).size).toBe(i + 1);
  }
  const final = await call();
  expect(final.body.payouts).toHaveLength(151);
  expect(final.body.available.amountMinor).toBe(9849);
});
