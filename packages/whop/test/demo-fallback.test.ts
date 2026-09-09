import type { Result } from "@ledgerly/core";
import { whopAccountId, whopPaymentId } from "@ledgerly/core";
import { afterEach, expect, it, vi } from "vitest";
import { createWhopClient } from "../src/client";
import { createHybridAdapter } from "../src/hybrid-adapter";
import { createMockAdapter } from "../src/mock-adapter";
import { createSandboxAdapter } from "../src/sandbox-adapter";

function value<R extends Result<unknown, unknown>>(result: R): Extract<R, { ok: true }>["value"];
function value(result: Result<unknown, unknown>): unknown {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const accountId = value(whopAccountId("biz_demo_seller"));
const originId = value(whopAccountId("biz_demo_platform"));
const paymentId = value(whopPaymentId("pay_demo_real"));
const amount = { amountMinor: 100, currency: "USD" as const };
const transfer = { originId, destinationId: accountId, amount, metadata: {} };
const payout = { accountId, amount, payoutMethodId: "potk_demo_reference" };
afterEach(() => vi.unstubAllEnvs());

function setup(
  status = 400,
  error: unknown = { code: "not_enough_balance", type: "bad_request" },
  enabled: string | undefined | null = "1",
) {
  vi.stubEnv("WHOP_DEMO_FALLBACK", enabled ?? undefined);
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify(status === 200 ? error : { error }), { status }),
  );
  const sandbox = createSandboxAdapter({
    client: createWhopClient({
      baseUrl: "https://sandbox.invalid/api/v1",
      apiKey: "fixture-only",
      apiVersionDate: "2026-09-06",
      fetch,
    }),
    parentAccountId: originId,
  });
  const mock = createMockAdapter();
  const demo = mock.forDemoFallback();
  const refund = vi.spyOn(demo, "refundPayment");
  const read = vi.fn(async () => ({
    capabilities: { transfer: "active" as const, standard_payout: "active" as const },
    requiredActions: [],
    readAt: null,
  }));
  const onRouted = vi.fn();
  const adapter = createHybridAdapter({
    sandbox,
    mock,
    capabilities: { read, refresh: read },
    onRouted,
  });
  return { adapter, sandbox, mock, fetch, refund, read, onRouted };
}

it("falls back on the captured refund balance error and preserves the same request", async () => {
  const { adapter, fetch, refund, onRouted } = setup();
  const result = value(await adapter.refundPayment(paymentId, "refund-key", amount));
  expect(result.id).toMatch(/^rf_mock_demo_[a-f0-9]{32}$/);
  expect(result.meta).toEqual({
    source: "mock",
    fallback_gate: {
      id: "settlement-pending",
      reason: expect.any(String),
      observed: { status: 400, code: "not_enough_balance" },
    },
  });
  expect(refund).toHaveBeenCalledWith(paymentId, "refund-key", amount);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(refund.mock.invocationCallOrder[0]).toBeGreaterThan(
    fetch.mock.invocationCallOrder[0] ?? 0,
  );
  expect(onRouted.mock.calls).toEqual([[{ operation: "refundPayment", source: "mock" }]]);
});

it("falls back for a transfer settlement error", async () => {
  const { adapter, fetch } = setup(400, { code: "settlement_pending" });
  const result = value(await adapter.createTransfer(transfer, "transfer-key"));
  expect(result.meta.fallback_gate?.id).toBe("settlement-pending");
  expect(result.id).toMatch(/^tsf_mock_demo_/);
  expect(fetch).toHaveBeenCalledTimes(1);
});

for (const operation of [
  "createPayout",
  "listPayoutMethods",
  "listSupportedPayoutMethods",
  "createPayoutPortalLink",
] as const) {
  it(`falls back for ${operation} only after a no-payout-method error`, async () => {
    const { adapter, fetch } = setup(400, { type: "bad_request", message: "No payout method" });
    const result =
      operation === "createPayout"
        ? await adapter.createPayout(payout, "payout-key")
        : operation === "createPayoutPortalLink"
          ? await adapter.createPayoutPortalLink(
              { accountId, returnUrl: "https://example.invalid" },
              "portal-key",
            )
          : await adapter[operation]({ accountId });
    expect(value(result).meta).toMatchObject({
      source: "mock",
      fallback_gate: { id: "sandbox-no-payouts", observed: { status: 400, code: "bad_request" } },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}

it("requires explicit demoComplete and real pending verification for getAccount", async () => {
  const real = { id: accountId, verification: "pending", title: "Real seller" };
  const { adapter, fetch } = setup(200, real);
  const normal = value(await adapter.getAccount(accountId, "read-key"));
  expect(normal.raw).toEqual(real);
  expect(normal.meta).toEqual({ source: "sandbox", status: undefined, requestId: undefined });
  const demo = value(await adapter.getAccount(accountId, "read-key", { demoComplete: true }));
  expect(demo.meta.fallback_gate).toMatchObject({
    id: "sumsub-pending",
    observed: { status: 200, code: "pending" },
  });
  expect(demo.raw).toMatchObject({
    verification: "verified",
    simulated: true,
    source_account_id: accountId,
  });
  expect(value(await adapter.getAccount(accountId, "read-key")).raw).toEqual(real);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(["verified", "rejected", null, { individual: null, business: null }])(
  "does not infer pending verification from %j",
  async (verification) => {
    const { adapter } = setup(200, { id: accountId, verification });
    expect(
      value(await adapter.getAccount(accountId, "read", { demoComplete: true })).meta.source,
    ).toBe("sandbox");
  },
);

it("recognizes an explicit verification.status pending value", async () => {
  const { adapter } = setup(200, { id: accountId, verification: { status: "pending" } });
  expect(
    value(await adapter.getAccount(accountId, "read", { demoComplete: true })).meta.source,
  ).toBe("mock");
});

for (const status of [401, 403, 404, 500, 502, 503]) {
  it(`never falls back on HTTP ${status}, even with a classified code`, async () => {
    const { adapter, refund } = setup(status);
    expect(await adapter.refundPayment(paymentId, "key")).toEqual({
      ok: false,
      error: {
        kind: "http",
        status,
        body: { error: { code: "not_enough_balance", type: "bad_request" } },
      },
    });
    expect(refund).not.toHaveBeenCalled();
  });
  it(`never turns payout HTTP ${status} into success`, async () => {
    const { adapter } = setup(status, { code: "no_payout_method" });
    expect(await adapter.createPayout(payout, "key")).toMatchObject({
      ok: false,
      error: { status },
    });
  });
}

it.each([
  { code: "unknown" },
  { message: "balance problem" },
  { code: "permission_denied", message: "No payout method" },
  null,
])("propagates unclassified 400 error %j", async (error) => {
  const { adapter, refund } = setup(400, error);
  expect(await adapter.refundPayment(paymentId, "key")).toMatchObject({
    ok: false,
    error: { status: 400, body: { error } },
  });
  expect(await adapter.createPayout(payout, "key")).toMatchObject({
    ok: false,
    error: { status: 400 },
  });
  expect(refund).not.toHaveBeenCalled();
});

it("propagates network errors without simulation", async () => {
  const { adapter, fetch, refund } = setup();
  fetch.mockRejectedValue(new Error("fixture network failure"));
  await expect(adapter.refundPayment(paymentId, "key")).rejects.toThrow("fixture network failure");
  expect(refund).not.toHaveBeenCalled();
});

it.each([undefined, "0", "false", "true", ""])(
  "keeps baseline responses unchanged with env=%s",
  async (enabled) => {
    const { adapter, sandbox, refund } = setup(
      400,
      { code: "not_enough_balance" },
      enabled ?? null,
    );
    const expected = await sandbox.refundPayment(paymentId, "key");
    expect(await adapter.refundPayment(paymentId, "key")).toStrictEqual(expected);
    expect(refund).not.toHaveBeenCalled();
    const pending = setup(200, { id: accountId, verification: "pending" }, enabled ?? null);
    expect(
      value(await pending.adapter.getAccount(accountId, "key", { demoComplete: true })),
    ).toStrictEqual({
      id: accountId,
      raw: { id: accountId, verification: "pending" },
      meta: { source: "sandbox", status: undefined, requestId: undefined },
    });
  },
);

it("retries and reconstructs identical simulated objects independent of call order", async () => {
  const first = setup();
  const original = value(await first.adapter.refundPayment(paymentId, "stable-key", amount));
  await first.adapter.refundPayment(paymentId, "other-key", amount);
  expect(value(await first.adapter.refundPayment(paymentId, "stable-key", amount))).toStrictEqual(
    original,
  );
  const fresh = setup();
  expect(value(await fresh.adapter.refundPayment(paymentId, "stable-key", amount))).toStrictEqual(
    original,
  );
  expect(value(await fresh.adapter.refundPayment(paymentId, "different-key", amount)).id).not.toBe(
    original.id,
  );
  const concurrent = await Promise.all([
    first.adapter.refundPayment(paymentId, "concurrent", amount),
    first.adapter.refundPayment(paymentId, "concurrent", amount),
  ]);
  expect(concurrent[0]).toStrictEqual(concurrent[1]);
  expect(
    await first.adapter.refundPayment(paymentId, "stable-key", { ...amount, amountMinor: 101 }),
  ).toEqual({ ok: false, error: { kind: "idempotency_conflict" } });
});

it("keeps transfer, payout and account IDs stable across adapter reconstruction", async () => {
  for (const operation of ["createTransfer", "createPayout", "getAccount"] as const) {
    const run = async () => {
      const { adapter } =
        operation === "getAccount"
          ? setup(200, { id: accountId, verification: "pending" })
          : setup(400, {
              code: operation === "createTransfer" ? "not_enough_balance" : "no_payout_method",
            });
      return operation === "getAccount"
        ? adapter.getAccount(accountId, "stable", { demoComplete: true })
        : operation === "createTransfer"
          ? adapter.createTransfer(transfer, "stable")
          : adapter.createPayout(payout, "stable");
    };
    expect(await run()).toStrictEqual(await run());
  }
});

it.each([undefined, "1"])(
  "rejects suspended seller before any provider or capability read, env=%s",
  async (enabled) => {
    const { adapter, fetch, read, mock } = setup(400, undefined, enabled ?? null);
    const blocked = value(whopAccountId("biz_fixtureSuspended"));
    const mockTransfer = vi.spyOn(mock, "createTransfer");
    for (const result of [
      await adapter.getAccount(blocked, "key"),
      await adapter.createTransfer({ ...transfer, destinationId: blocked }, "key"),
      await adapter.createTransfer({ ...transfer, originId: blocked }, "key"),
      await adapter.createPayout({ ...payout, accountId: blocked }, "key"),
      await adapter.createApiKey(
        {
          accountId,
          name: "demo",
          permissions: { statements: [{ actions: ["read"], resources: [blocked], grant: true }] },
        },
        "key",
      ),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "invalid_request",
          body: { code: "suspended_seller", message: expect.stringContaining(blocked) },
        },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(mockTransfer).not.toHaveBeenCalled();
  },
);

it("preserves successful sandbox results and empty method lists", async () => {
  const refund = setup(200, { id: "rf_real_success" });
  expect(value(await refund.adapter.refundPayment(paymentId, "key")).meta.source).toBe("sandbox");
  expect(refund.refund).not.toHaveBeenCalled();
  const lists = setup(200, { data: [], page_info: { has_next_page: false, end_cursor: null } });
  expect(value(await lists.adapter.listPayoutMethods({ accountId }))).toStrictEqual({
    items: [],
    nextCursor: null,
    meta: { source: "sandbox", status: undefined, requestId: undefined },
  });
});

it.each([undefined, "0", "false"])(
  "preserves transfer and payout failures with env=%s",
  async (enabled) => {
    const transferCase = setup(400, { code: "not_enough_balance" }, enabled ?? null);
    expect(await transferCase.adapter.createTransfer(transfer, "key")).toStrictEqual(
      await transferCase.sandbox.createTransfer(transfer, "key"),
    );
    const payoutCase = setup(400, { code: "no_payout_method" }, enabled ?? null);
    expect(await payoutCase.adapter.createPayout(payout, "key")).toStrictEqual(
      await payoutCase.sandbox.createPayout(payout, "key"),
    );
    expect(await payoutCase.adapter.listPayoutMethods({ accountId })).toStrictEqual(
      await payoutCase.sandbox.listPayoutMethods({ accountId }),
    );
  },
);

it("does not fall back on a recognized error for the wrong operation", async () => {
  const balanceCase = setup();
  expect(await balanceCase.adapter.createPayout(payout, "key")).toMatchObject({ ok: false });
  const payoutCase = setup(400, { code: "no_payout_method" });
  expect(await payoutCase.adapter.createTransfer(transfer, "key")).toMatchObject({ ok: false });
  expect(await payoutCase.adapter.refundPayment(paymentId, "key")).toMatchObject({ ok: false });
});

it("rejects blank idempotency keys instead of assigning a simulated ID", async () => {
  const { adapter } = setup();
  expect(await adapter.refundPayment(paymentId, " ")).toEqual({
    ok: false,
    error: { kind: "invalid_request" },
  });
});

it("seeds deterministic confirmed demo payments and routes their reads to mock", async () => {
  const { adapter, mock, fetch, onRouted } = setup();
  const seed = adapter.seedDemoPayment;
  expect(seed).toBeTypeOf("function");
  if (!seed) throw new Error("Missing seeder");
  const first = value(await seed(accountId, "run_first"));
  const retry = value(await seed(accountId, "run_first"));
  const next = value(await seed(accountId, "run_next"));
  const otherSeller = value(await seed(originId, "run_first"));
  expect(first.id).toMatch(/^pay_mock_demo_[a-f0-9]{64}$/);
  expect(retry.id).toBe(first.id);
  expect(next.id).not.toBe(first.id);
  expect(otherSeller.id).not.toBe(first.id);
  expect(value(createMockAdapter().seedDemoPayment(accountId, "run_first")).id).toBe(first.id);
  const fetched = value(await adapter.getPayment(first.id, "read"));
  expect(fetched.id).toBe(first.id);
  expect(fetched.meta.source).toBe("mock");
  const page = value(await adapter.listPayments({ accountId }));
  expect(page.items.map((item) => item.id)).toEqual([next.id, first.id]);
  expect(page.items.every((item) => item.status === "paid" && item.accountId === accountId)).toBe(
    true,
  );
  expect(page.meta.source).toBe("mock");
  expect(value(await mock.listPayments({ accountId })).items).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();
  expect(onRouted).toHaveBeenCalledWith({ operation: "getPayment", source: "mock" });
  // The next page still surfaces the sandbox error instead of silently ending the list.
  expect(
    (
      await adapter.listPayments(
        page.nextCursor ? { accountId, cursor: page.nextCursor } : { accountId },
      )
    ).ok,
  ).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([null, "0"])("does not expose demo seeding when fallback is %s", (enabled) => {
  expect(setup(400, {}, enabled).adapter.seedDemoPayment).toBeUndefined();
});
