import { afterEach, describe, expect, it } from "vitest";
import { instrumented, setInstrumentationEmitter } from "@/lib/instrument";
import type { InstrumentationEvent } from "../../../packages/core/src/instrumentation";
import { buildEarningsRows } from "../../../packages/core/src/services/earnings";
import type { LedgerEntry } from "../../../packages/core/src/services/ports";

afterEach(() => setInstrumentationEmitter({ emit() {} }));
async function proof(path: string, body: unknown, method = "GET", status = 200) {
  const events: InstrumentationEvent[] = [];
  setInstrumentationEmitter({ emit: (event) => events.push(event) });
  const response = await instrumented(async () => Response.json(body, { status }))(
    new Request(`https://example.invalid${path}`, { method }),
  );
  expect(await response.json()).toEqual(body);
  const { tour_step: _step, ...facts } = events.at(-1)?.safeIds ?? {};
  return facts;
}

describe("tour response proof", () => {
  it("projects only safe seller identity and explicit mock provenance", async () => {
    expect(
      await proof(
        "/api/sellers",
        { id: "seller_1", provenance: "mock", token: "apik_secret", email: "private@example.com" },
        "POST",
        201,
      ),
    ).toEqual({ tour_seller_id: "seller_1", tour_source: "mock" });
  });
  it("requires a paid receipt and a valid payment id", async () => {
    expect(
      await proof("/api/orders/order_1", { id: "order_1", payment_id: "pay_1", status: "paid" }),
    ).toEqual({ tour_order_id: "order_1", tour_payment_id: "pay_1", tour_order_paid: "true" });
    expect(
      await proof("/api/orders/order_1", { id: "order_1", payment_id: null, status: "paid" }),
    ).not.toHaveProperty("tour_order_paid");
  });
});

const resolved = {
  id: "case_1",
  status: "resolved",
  provenance: "mock",
  subject: { provider_resource_id: "pay_1" },
  amounts: {
    local: { currency: "USD", amountMinor: 1000 },
    provider: { currency: "USD", amountMinor: 1000 },
  },
  next_safe_action: { id: null, available: false },
  history: [{ action: "resolve", outcome: "succeeded", actor: "private@example.com" }],
};

describe("tour response proof boundaries", () => {
  it("accepts nested seller, product and checkout contracts", async () => {
    expect(await proof("/api/sellers", { seller: { id: "seller_2" } }, "POST")).toEqual({
      tour_seller_id: "seller_2",
    });
    expect(
      await proof(
        "/api/products",
        { id: "product_1", purchase_url: "https://secret.invalid" },
        "POST",
      ),
    ).toEqual({ tour_product_id: "product_1" });
    expect(
      await proof(
        "/api/checkouts",
        { order_id: "order_1", status: "paid", payment_id: "pay_1" },
        "POST",
      ),
    ).toEqual({ tour_order_id: "order_1" });
  });
  it.each(["pending", "failed", "refunded"])("does not mark %s receipts paid", async (status) => {
    expect(
      await proof("/api/orders/order_1", { id: "order_1", payment_id: "pay_1", status }),
    ).not.toHaveProperty("tour_order_paid");
  });
  it("does not use unrelated receipt body or request headers as proof", async () => {
    expect(
      await proof("/api/orders/order_1", {
        id: "order_other",
        status: "paid",
        payment_id: "pay_other",
      }),
    ).toEqual({});
    const events: InstrumentationEvent[] = [];
    setInstrumentationEmitter({ emit: (event) => events.push(event) });
    await instrumented(async () => Response.json({}))(
      new Request("https://example.invalid/api/orders/order_1", {
        headers: { tour_order_paid: "true", tour_payment_id: "pay_header" },
      }),
    );
    expect(events.at(-1)?.safeIds).toEqual({ tour_step: "C03" });
  });
  it.each([
    "apik_secret",
    "ws_secret",
    "Bearer-secret",
    "npg_secret",
    "sk_secret",
    "private@example.com",
    "https://secret.invalid",
    "a".repeat(129),
  ])("rejects unsafe identifier %s", async (id) => {
    expect(await proof("/api/sellers", { id }, "POST")).toEqual({});
  });
  it("keeps earnings IDs deduplicated, bounded and free of unrelated fields", async () => {
    expect(
      await proof("/api/sellers/seller_1/earnings", {
        rows: [
          { order_id: "order_1", token: "secret" },
          { order_id: "order_1" },
          { order_id: null },
          { order_id: "order_2" },
          { order_id: "apik_secret" },
        ],
      }),
    ).toEqual({ tour_earnings_order_ids: "order_1,order_2" });
    expect(
      await proof("/api/sellers/seller_1/earnings", {
        rows: Array.from({ length: 100 }, (_, i) => ({
          order_id: `order_${i}_${"a".repeat(100)}`,
        })),
      }),
    ).toEqual({});
  });
  it("requires recheck, equal amounts and successful resolve history", async () => {
    expect(await proof("/api/admin/issues/case_1/actions/recheck", resolved, "POST")).toEqual({
      tour_source: "mock",
      tour_case_id: "case_1",
      tour_payment_id: "pay_1",
      tour_issue_action: "recheck",
      tour_action_succeeded: "true",
      tour_issue_resolved: "true",
    });
  });
  it.each([
    { status: "investigating" },
    { amounts: { provider: { currency: "USD", amountMinor: 1000 } } },
    {
      amounts: {
        local: { currency: "EUR", amountMinor: 1000 },
        provider: { currency: "USD", amountMinor: 1000 },
      },
    },
    {
      amounts: {
        local: { currency: "USD", amountMinor: 999 },
        provider: { currency: "USD", amountMinor: 1000 },
      },
    },
    {
      amounts: {
        local: { currency: "USD", amountMinor: "1000" },
        provider: { currency: "USD", amountMinor: "1000" },
      },
    },
    { history: [{ action: "resolve", outcome: "failed" }] },
    {
      history: [
        { action: "resolve", outcome: "succeeded" },
        { action: "recheck", outcome: "no_change" },
      ],
    },
    { history: [{ action: "recheck", outcome: "succeeded" }] },
    { id: "case_other" },
  ])("does not resolve incomplete or failed proof %j", async (override) => {
    expect(
      await proof("/api/admin/issues/case_1/actions/recheck", { ...resolved, ...override }, "POST"),
    ).not.toHaveProperty("tour_issue_resolved");
  });
  it("does not close on import and requires the latest action to succeed", async () => {
    const path = "/api/admin/issues/case_1/actions/import_confirmed";
    expect(await proof(path, resolved, "POST")).not.toHaveProperty("tour_action_succeeded");
    const imported = {
      ...resolved,
      history: [{ action: "import_confirmed", outcome: "succeeded" }],
      next_safe_action: { id: "recheck", available: true },
    };
    expect(await proof(path, imported, "POST")).toMatchObject({
      tour_action_succeeded: "true",
      tour_next_action: "recheck",
    });
    expect(await proof(path, imported, "POST")).not.toHaveProperty("tour_issue_resolved");
    expect(await proof("/api/admin/issues/demo-fault", resolved, "POST")).not.toHaveProperty(
      "tour_issue_resolved",
    );
  });
  it("separates sample start and a single positive mock payout", async () => {
    const path = "/api/sellers/seller_1/payouts/simulation";
    const sample = {
      source: "mock",
      kind: "ready",
      payouts: [
        { id: "payout_1", status: "completed", amount: { currency: "USD", amountMinor: 1000 } },
      ],
    };
    expect(await proof(path, sample, "POST")).toEqual({
      tour_source: "mock",
      tour_sample_payout_id: "payout_1",
      tour_sample_payout_status: "completed",
    });
    expect(await proof(path, { ...sample, source: "sandbox" }, "POST")).toEqual({});
    expect(await proof(path, { ...sample, payouts: [] }, "POST")).toEqual({
      tour_source: "mock",
      tour_sample_started: "true",
    });
    expect(
      await proof(path, { ...sample, payouts: [...sample.payouts, ...sample.payouts] }, "POST"),
    ).not.toHaveProperty("tour_sample_payout_id");
    expect(
      await proof(
        path,
        {
          ...sample,
          payouts: [{ ...sample.payouts[0], amount: { currency: "USD", amountMinor: 0 } }],
        },
        "POST",
      ),
    ).not.toHaveProperty("tour_sample_payout_id");
  });
  it("ignores unrelated paths, wrong methods and failed responses", async () => {
    expect(await proof("/api/admin/unrelated", resolved, "POST")).toEqual({});
    expect(await proof("/api/sellers", { id: "seller_1", provenance: "mock" }, "GET")).toEqual({});
    expect(
      await proof("/api/sellers", { id: "seller_1", provenance: "mock" }, "POST", 422),
    ).toEqual({});
  });
  it("leaves malformed and non-JSON responses readable", async () => {
    for (const type of ["application/json", "text/html"]) {
      const events: InstrumentationEvent[] = [];
      setInstrumentationEmitter({ emit: (event) => events.push(event) });
      const response = await instrumented(
        async () => new Response("not JSON", { headers: { "content-type": type } }),
      )(new Request("https://example.invalid/api/sellers", { method: "POST" }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("not JSON");
      expect(events.at(-1)?.safeIds).toEqual({ tour_step: "C01" });
    }
  });
});

describe("current earnings and payout response contracts", () => {
  it("reads settled payment credit from real earnings serialization without order linkage", async () => {
    const shared = {
      runId: "run_1",
      sellerId: "seller_1",
      resourceType: "payment",
      resourceId: "pay_paid",
      effectKey: "payment:pay_paid:succeeded",
      occurredAt: new Date("2026-09-09T00:00:00Z"),
    };
    const rows = buildEarningsRows(
      [
        {
          ...shared,
          accountSide: "seller",
          kind: "payment",
          amount: { currency: "USD", amountMinor: 920 },
        },
        {
          ...shared,
          accountSide: "platform",
          kind: "fee",
          amount: { currency: "USD", amountMinor: 80 },
        },
      ] as LedgerEntry[],
      "mock",
    );
    expect(rows[0]).toMatchObject({
      order_id: null,
      gross: { amountMinor: 1000 },
      fee: { amountMinor: 80 },
      net: { amountMinor: 920 },
    });
    expect(await proof("/api/sellers/seller_1/earnings", { rows })).toEqual({
      tour_earnings_payment_ids: "pay_paid",
    });
  });
  const paidRow = {
    item: "payment",
    status: "settled",
    provider_resource_id: "pay_paid",
    gross: { currency: "USD", amountMinor: 1000 },
    fee: { currency: "USD", amountMinor: 80 },
    net: { currency: "USD", amountMinor: 920 },
  };
  it.each([
    { status: "pending" },
    { status: "refunded" },
    { item: "refund" },
    { item: "transfer" },
    { gross: { currency: "USD", amountMinor: 0 } },
    {
      gross: { currency: "USD", amountMinor: -1000 },
      fee: { currency: "USD", amountMinor: -80 },
      net: { currency: "USD", amountMinor: -920 },
    },
    { net: { currency: "EUR", amountMinor: 920 } },
    { fee: { currency: "USD", amountMinor: 81 } },
    { fee: { currency: "USD", amountMinor: "80" } },
    { fee: { currency: "USD", amountMinor: -80 }, net: { currency: "USD", amountMinor: 1080 } },
    { provider_resource_id: "apik_secret" },
  ])("rejects a non-credit or invalid split %j", async (override) => {
    expect(
      await proof("/api/sellers/seller_1/earnings", { rows: [{ ...paidRow, ...override }] }),
    ).not.toHaveProperty("tour_earnings_payment_ids");
  });
  it("deduplicates and bounds payment proof", async () => {
    expect(await proof("/api/sellers/seller_1/earnings", { rows: [paidRow, paidRow] })).toEqual({
      tour_earnings_payment_ids: "pay_paid",
    });
    expect(
      await proof("/api/sellers/seller_1/earnings", {
        rows: Array.from({ length: 100 }, (_, i) => ({
          ...paidRow,
          provider_resource_id: `pay_${i}_${"a".repeat(100)}`,
        })),
      }),
    ).not.toHaveProperty("tour_earnings_payment_ids");
  });
  it("preserves the mock adapter requested status instead of inventing completion", async () => {
    expect(
      await proof(
        "/api/sellers/seller_1/payouts/simulation",
        {
          source: "mock",
          kind: "ready",
          payouts: [
            {
              id: "wdrl_mock_1",
              status: "requested",
              amount: { amountMinor: 1000, currency: "USD" },
              createdAt: "2026-09-09T00:00:00Z",
            },
          ],
        },
        "POST",
      ),
    ).toEqual({
      tour_source: "mock",
      tour_sample_payout_id: "wdrl_mock_1",
      tour_sample_payout_status: "requested",
    });
  });
});

it("attributes the executed route rather than a forged caller step", async () => {
  const events: InstrumentationEvent[] = [];
  setInstrumentationEmitter({ emit: (event) => events.push(event) });
  await instrumented(async () => Response.json({ id: "seller_1" }, { status: 201 }))(
    new Request("https://example.invalid/api/sellers", {
      method: "POST",
      headers: { "x-tour-step": "C07", "x-demo-run": "run_1" },
    }),
  );
  expect(events.at(-1)?.safeIds).toEqual({ tour_step: "C01", tour_seller_id: "seller_1" });
});

it("projects durable seller/account agreement only from matching provider readback", async () => {
  const seller = { id: "seller_1", whop_account_id: "biz_owned", account: { id: "biz_owned" } };
  expect(await proof("/api/sellers", seller, "POST", 201)).toEqual({
    tour_seller_id: "seller_1",
    tour_seller_account_readback: "biz_owned",
  });
  for (const body of [
    { ...seller, account: null },
    { ...seller, account: { id: "biz_foreign" } },
    { ...seller, whop_account_id: null },
    { id: "seller_1", tour_seller_account_readback: "biz_owned", tour_durable_account: "true" },
  ])
    expect(await proof("/api/sellers", body, "POST", 201)).not.toHaveProperty(
      "tour_seller_account_readback",
    );
});
