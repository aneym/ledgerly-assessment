import { type Result, runId, type Seller, sellerId } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import {
  createPayoutSimulationStore,
  type PayoutSimulationDeps,
} from "../../src/lib/payout-simulation";

function value<T>(r: Result<T, unknown>): T {
  if (!r.ok) throw new Error("bad fixture");
  return r.value;
}
const seller: Seller = {
  id: value(sellerId("seller_a")),
  runId: value(runId("run_a")),
  externalId: "a",
  email: "a@example.invalid",
  country: "US",
  whopAccountId: null,
  salePolicy: "direct",
  status: "active",
};
const time = new Date("2026-09-09T12:00:00Z");
const requestId = "11111111-1111-4111-8111-111111111111";
function deps(overrides: Partial<PayoutSimulationDeps> = {}): PayoutSimulationDeps {
  return {
    enabled: true,
    authorize: async () => ({ ok: true, userId: "owner_a" }),
    getSeller: async () => seller,
    now: () => time,
    ...overrides,
  };
}
function req(body?: unknown, origin = "https://ledgerly.example") {
  return new Request(
    "https://ledgerly.example/api/sellers/seller_a/payouts/simulation",
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
}
function delayedRequest(input: unknown) {
  let entered!: () => void;
  const parsing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: (value: unknown) => void;
  const body = new Promise((resolve) => {
    release = resolve;
  });
  const request = req(input);
  request.json = () => {
    entered();
    return body;
  };
  return { request, parsing, release: () => release(input) };
}
describe("explicit payout simulation through the real mock adapter", () => {
  it.each([51, 101])("returns all %i accepted sample withdrawals across pages", async (count) => {
    const store = createPayoutSimulationStore();
    const d = deps();
    await store.handle(req({ action: "start" }), seller.id, d);
    for (let n = 1; n <= count; n++) {
      const response = await store.handle(
        req({
          action: "withdraw",
          amount: "0.01",
          requestId: `${n.toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
        }),
        seller.id,
        d,
      );
      expect(response.status).toBe(200);
    }
    const final = await (await store.handle(req(), seller.id, d)).json();
    expect(final.available.amountMinor).toBe(count === 51 ? 9949 : 9899);
    expect(final.payouts).toHaveLength(count);
    expect(new Set(final.payouts.map((p: { id: string }) => p.id)).size).toBe(count);
    expect(
      final.payouts.every((p: { amount: { amountMinor: number } }) => p.amount.amountMinor === 1),
    ).toBe(true);
  });
  it("keeps accepted withdrawals when a duplicate start body arrives late", async () => {
    const store = createPayoutSimulationStore();
    const d = deps();
    const slow = delayedRequest({ action: "start" });
    const pending = store.handle(slow.request, seller.id, d);
    await slow.parsing;
    await store.handle(req({ action: "start" }), seller.id, d);
    await store.handle(req({ action: "withdraw", amount: "25.00", requestId }), seller.id, d);
    slow.release();
    await pending;
    const final = await (await store.handle(req(), seller.id, d)).json();
    expect(final.available.amountMinor).toBe(7500);
    expect(final.payouts).toHaveLength(1);
  });
  it("returns a consistent balance and history for concurrent withdrawals and retries", async () => {
    const store = createPayoutSimulationStore();
    const d = deps();
    await store.handle(req({ action: "start" }), seller.id, d);
    const responses = await Promise.all(
      [1, 2, 2, 3].map((n) =>
        store.handle(
          req({
            action: "withdraw",
            amount: "25.00",
            requestId: `${n.toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
          }),
          seller.id,
          d,
        ),
      ),
    );
    const snapshots = await Promise.all(responses.map((r) => r.json()));
    expect(snapshots.map((s) => [s.available.amountMinor, s.payouts.length])).toEqual([
      [7500, 1],
      [5000, 2],
      [5000, 2],
      [2500, 3],
    ]);
  });
  it("checks expiry after a delayed withdrawal body has arrived", async () => {
    const store = createPayoutSimulationStore();
    let now = time;
    const d = deps({ now: () => now });
    await store.handle(req({ action: "start" }), seller.id, d);
    const slow = delayedRequest({ action: "withdraw", amount: "25.00", requestId });
    const pending = store.handle(slow.request, seller.id, d);
    await slow.parsing;
    now = new Date("2026-09-09T12:30:00Z");
    slow.release();
    expect((await pending).status).toBe(409);
    expect(await (await store.handle(req(), seller.id, d)).json()).toMatchObject({
      kind: "not_started",
    });
  });
  it("applies a delayed withdrawal to the current sample after an explicit reset", async () => {
    const store = createPayoutSimulationStore();
    const d = deps();
    await store.handle(req({ action: "start" }), seller.id, d);
    await store.handle(req({ action: "withdraw", amount: "100.00", requestId }), seller.id, d);
    const slow = delayedRequest({
      action: "withdraw",
      amount: "25.00",
      requestId: "22222222-2222-4222-8222-222222222222",
    });
    const pending = store.handle(slow.request, seller.id, d);
    await slow.parsing;
    await store.handle(req({ action: "reset" }), seller.id, d);
    slow.release();
    expect((await pending).status).toBe(200);
    const final = await (await store.handle(req(), seller.id, d)).json();
    expect(final.available.amountMinor).toBe(7500);
    expect(final.payouts).toHaveLength(1);
  });
  it("starts at 100, debits 25 once on retry and shows a requested payout", async () => {
    const store = createPayoutSimulationStore();
    const d = deps();
    expect(await (await store.handle(req(), seller.id, d)).json()).toMatchObject({
      kind: "not_started",
      source: "mock",
    });
    const started = await store.handle(req({ action: "start" }), seller.id, d);
    expect(await started.json()).toMatchObject({
      source: "mock",
      available: { amountMinor: 10000, currency: "USD" },
      payouts: [],
    });
    const input = { action: "withdraw", amount: "25.00", requestId };
    for (let i = 0; i < 2; i++) {
      const response = await store.handle(req(input), seller.id, d);
      expect(await response.json()).toMatchObject({
        available: { amountMinor: 7500, currency: "USD" },
        payouts: [{ status: "requested", amount: { amountMinor: 2500, currency: "USD" } }],
      });
    }
    const after = await (await store.handle(req(), seller.id, d)).json();
    expect(after.payouts).toHaveLength(1);
  });
  it("rejects overdraft without changing the balance or payout history", async () => {
    const store = createPayoutSimulationStore();
    const d = deps();
    await store.handle(req({ action: "start" }), seller.id, d);
    const response = await store.handle(
      req({ action: "withdraw", amount: "100.01", requestId }),
      seller.id,
      d,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "insufficient_balance", source: "mock" });
    expect(await (await store.handle(req(), seller.id, d)).json()).toMatchObject({
      available: { amountMinor: 10000 },
      payouts: [],
    });
  });
  it("rejects changed input under a prior idempotency key", async () => {
    const store = createPayoutSimulationStore();
    const d = deps();
    await store.handle(req({ action: "start" }), seller.id, d);
    await store.handle(req({ action: "withdraw", amount: "25.00", requestId }), seller.id, d);
    const response = await store.handle(
      req({ action: "withdraw", amount: "30.00", requestId }),
      seller.id,
      d,
    );
    expect(await response.json()).toMatchObject({ error: "idempotency_conflict" });
  });
  it("isolates both viewer and seller identity", async () => {
    const store = createPayoutSimulationStore();
    await store.handle(req({ action: "start" }), seller.id, deps());
    expect(
      await (
        await store.handle(
          req(),
          seller.id,
          deps({ authorize: async () => ({ ok: true, userId: "owner_b" }) }),
        )
      ).json(),
    ).toMatchObject({ kind: "not_started" });
    expect(
      await (
        await store.handle(
          req(),
          "seller_b",
          deps({ getSeller: async () => ({ ...seller, id: value(sellerId("seller_b")) }) }),
        )
      ).json(),
    ).toMatchObject({ kind: "not_started" });
  });
  it("requires demo mode and the normal seller authorization", async () => {
    const store = createPayoutSimulationStore();
    for (const [override, status] of [
      [{ enabled: false }, 404],
      [{ authorize: async () => ({ ok: false as const, status: 401 }) }, 401],
      [{ authorize: async () => ({ ok: false as const, status: 403 }) }, 403],
    ] as const)
      expect((await store.handle(req({ action: "start" }), seller.id, deps(override))).status).toBe(
        status,
      );
  });
  it.each([
    { action: "withdraw", amount: "-1", requestId },
    { action: "withdraw", amount: "1.001", requestId },
    { action: "withdraw", amount: "NaN", requestId },
    { action: "withdraw", amount: "1", requestId, accountId: "biz_live" },
    { action: "start", source: "sandbox" },
  ])("rejects malformed/expanded commands %j", async (body) => {
    expect((await createPayoutSimulationStore().handle(req(body), seller.id, deps())).status).toBe(
      400,
    );
  });
  it("rejects cross-site sample mutations", async () => {
    expect(
      (
        await createPayoutSimulationStore().handle(
          req({ action: "start" }, "https://evil.example"),
          seller.id,
          deps(),
        )
      ).status,
    ).toBe(403);
  });
  it("expires instead of silently re-funding a withdrawal retry", async () => {
    const store = createPayoutSimulationStore();
    await store.handle(req({ action: "start" }), seller.id, deps());
    const response = await store.handle(
      req({ action: "withdraw", amount: "25.00", requestId }),
      seller.id,
      deps({ now: () => new Date("2026-09-09T12:30:00Z") }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "simulation_expired" });
  });
  it("resets only the current user's sample after an explicit reset", async () => {
    const store = createPayoutSimulationStore();
    const d = deps();
    await store.handle(req({ action: "start" }), seller.id, d);
    await store.handle(req({ action: "withdraw", amount: "100.00", requestId }), seller.id, d);
    expect(await (await store.handle(req({ action: "reset" }), seller.id, d)).json()).toMatchObject(
      { available: { amountMinor: 10000 }, payouts: [] },
    );
  });
  it("uses the sample seller currency and prevents concurrent overspending", async () => {
    const store = createPayoutSimulationStore();
    const d = deps({ getSeller: async () => ({ ...seller, country: "DE" }) });
    await store.handle(req({ action: "start" }), seller.id, d);
    const results = await Promise.all([
      store.handle(req({ action: "withdraw", amount: "60.00", requestId }), seller.id, d),
      store.handle(
        req({
          action: "withdraw",
          amount: "60.00",
          requestId: "22222222-2222-4222-8222-222222222222",
        }),
        seller.id,
        d,
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await (await store.handle(req(), seller.id, d)).json()).toMatchObject({
      available: { amountMinor: 4000, currency: "EUR" },
    });
  });
});
