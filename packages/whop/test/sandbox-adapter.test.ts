import { type Result, whopAccountId, whopPaymentId } from "@ledgerly/core";
import { expect, it, vi } from "vitest";
import { createSandboxAdapter, createWhopClient } from "../src/index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const accountId = value(whopAccountId("biz_seller"));
const parentAccountId = value(whopAccountId("biz_platform"));
const paymentId = value(whopPaymentId("pay_test"));
function setup(response: unknown) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(response)));
  const client = createWhopClient({
    baseUrl: "https://sandbox.invalid/api/v1",
    apiKey: "fixture-key",
    apiVersionDate: "2026-08-21",
    fetch,
  });
  return {
    adapter: createSandboxAdapter({
      client,
      parentAccountId,
      now: () => new Date("2026-09-08T12:00:00Z"),
    }),
    fetch,
    body: () => JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as unknown,
  };
}
it("keeps parent_company_id and tolerates omitted parent readback", async () => {
  const { adapter, body } = setup({ id: accountId, extra: "kept" });
  const result = await adapter.createOrFetchAccount(
    {
      externalId: "external",
      runId: "run1",
      email: "fixture@example.invalid",
      country: "US",
      title: "Fixture",
    },
    "op-account",
  );
  expect(result).toEqual({
    ok: true,
    value: { id: accountId, raw: { id: accountId, extra: "kept" }, disposition: "unknown" },
  });
  expect(body()).toEqual({
    parent_company_id: parentAccountId,
    email: "fixture@example.invalid",
    title: "Fixture",
    country: "US",
    metadata: { external_id: "external", run_id: "run1" },
  });
});
it("sends decimal strings in the direct checkout plan", async () => {
  const { adapter, body } = setup({ id: "ch_test" });
  expect(
    (
      await adapter.createCheckoutConfiguration(
        {
          accountId,
          productTitle: "Product",
          productExternalId: "product1",
          price: { amountMinor: 2500, currency: "USD" },
          applicationFee: { amountMinor: 200, currency: "USD" },
          redirectUrl: "https://example.invalid/done",
        },
        "checkout",
      )
    ).ok,
  ).toBe(true);
  expect(body()).toEqual({
    account_id: accountId,
    plan: {
      product: { title: "Product", external_identifier: "product1" },
      plan_type: "one_time",
      initial_price: "25.00",
      currency: "usd",
      application_fee_amount: "2.00",
    },
    redirect_url: "https://example.invalid/done",
  });
});
it("omits account and fee fields for platform checkout", async () => {
  const { adapter, body } = setup({ id: "ch_test" });
  await adapter.createCheckoutConfiguration(
    {
      accountId: null,
      productTitle: "Product",
      productExternalId: "product1",
      price: { amountMinor: 2500, currency: "USD" },
      applicationFee: null,
      redirectUrl: "https://example.invalid/done",
    },
    "checkout",
  );
  expect(body()).not.toHaveProperty("account_id");
  expect(body()).not.toHaveProperty("plan.application_fee_amount");
});
it("rejects checkout currency mismatch before fetch", async () => {
  const { adapter, fetch } = setup({ id: "ch_test" });
  expect(
    (
      await adapter.createCheckoutConfiguration(
        {
          accountId,
          productTitle: "Product",
          productExternalId: "product1",
          price: { amountMinor: 2500, currency: "USD" },
          applicationFee: { amountMinor: 200, currency: "EUR" },
          redirectUrl: "https://example.invalid",
        },
        "checkout",
      )
    ).ok,
  ).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
it("sends the onboarding and hosted payout use cases", async () => {
  const first = setup({ url: "https://example.invalid/link" });
  await first.adapter.createOnboardingLink(
    {
      accountId,
      returnUrl: "https://example.invalid/done",
      refreshUrl: "https://example.invalid/refresh",
    },
    "onboarding",
  );
  expect(first.body()).toEqual({
    account_id: accountId,
    use_case: "account_onboarding",
    return_url: "https://example.invalid/done",
    refresh_url: "https://example.invalid/refresh",
  });
  const second = setup({ url: "https://example.invalid/link" });
  await second.adapter.createPayoutPortalLink(
    { accountId, returnUrl: "https://example.invalid/done" },
    "portal",
  );
  expect(second.body()).toEqual({
    account_id: accountId,
    use_case: "payouts_portal",
    return_url: "https://example.invalid/done",
    refresh_url: "https://example.invalid/done",
  });
});
it("sends transfers and partial refunds in decimal units", async () => {
  const transfer = setup({ id: "ctt_test" });
  transfer.fetch.mockImplementationOnce(
    async () => new Response(JSON.stringify({ id: "ldgr_origin", owner: { id: parentAccountId } })),
  );
  const result = await transfer.adapter.createTransfer(
    {
      originId: parentAccountId,
      destinationId: accountId,
      amount: { amountMinor: 2300, currency: "USD" },
      metadata: { order: "order1" },
    },
    "transfer",
  );
  expect(value(result).id).toBe("ctt_test");
  expect(new Headers(transfer.fetch.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe(
    "transfer",
  );
  expect(String(transfer.fetch.mock.calls[0]?.[0])).toBe(
    "https://sandbox.invalid/api/v1/ledger_accounts/biz_platform",
  );
  expect(JSON.parse(String(transfer.fetch.mock.calls[1]?.[1]?.body))).toEqual({
    origin_id: "ldgr_origin",
    type: "ledger",
    destination_id: accountId,
    amount: "23.00",
    currency: "usd",
    metadata: { order: "order1" },
  });
  const refund = setup({ id: "ref_test" });
  await refund.adapter.refundPayment(paymentId, "refund", { amountMinor: 500, currency: "USD" });
  expect(refund.body()).toEqual({ partial_amount: "5.00" });
});
it("sends explicit token scopes and expiry", async () => {
  const { adapter, body } = setup({ token: "fixture-token" });
  await adapter.createAccessToken(
    { accountId, scopedActions: ["payout:read"], expiresAt: new Date("2026-09-08T12:05:00Z") },
    "token",
  );
  expect(body()).toEqual({
    account_id: accountId,
    scoped_actions: ["payout:read"],
    expires_at: "2026-09-08T12:05:00.000Z",
  });
});
it("decodes account, payment and fee reads", async () => {
  expect(value(await setup({ id: accountId }).adapter.getAccount(accountId, "read")).id).toBe(
    accountId,
  );
  expect(value(await setup({ id: paymentId }).adapter.getPayment(paymentId, "read")).id).toBe(
    paymentId,
  );
  expect(
    value(
      await setup({
        data: [{ amount: { amount: "2.00", currency: "usd" }, extra: "kept" }],
      }).adapter.listPaymentFees(paymentId, "fees"),
    ),
  ).toEqual([
    {
      amount: { amountMinor: 200, currency: "USD" },
      raw: { amount: { amount: "2.00", currency: "usd" }, extra: "kept" },
    },
  ]);
});
it("rejects fractional minor units in provider fees", async () => {
  expect(
    (
      await setup({
        data: [{ amount: { amount: "2.001", currency: "usd" } }],
      }).adapter.listPaymentFees(paymentId, "fees")
    ).ok,
  ).toBe(false);
});

it("decodes country and parent, and treats repeated 201 IDs as fetched", async () => {
  const { adapter, fetch } = setup(null);
  fetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          id: accountId,
          country: "de",
          parent_account: { id: parentAccountId, title: "Parent", route: null, logo_url: null },
        }),
        { status: 201 },
      ),
  );
  const input = {
    externalId: "seller",
    runId: "run1",
    email: "seller@example.invalid",
    title: "Seller",
    country: "DE" as const,
  };
  expect(value(await adapter.createAccount(input, "first"))).toMatchObject({
    country: "DE",
    parentAccountId,
    disposition: "unknown",
  });
  expect(value(await adapter.createAccount(input, "first")).disposition).toBe("fetched");
  expect(value(await adapter.createAccount(input, "fresh")).disposition).toBe("fetched");
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    country: "DE",
    metadata: { external_id: "seller", run_id: "run1" },
  });
});
it("recognizes a prior ID across adapter restarts and account reads", async () => {
  const input = {
    externalId: "seller",
    runId: "run1",
    email: "seller@example.invalid",
    title: "Seller",
    country: "BR" as const,
  };
  const first = setup({ id: accountId });
  expect(
    value(await first.adapter.createAccount({ ...input, priorAccountId: accountId }, "create"))
      .disposition,
  ).toBe("fetched");
  const second = setup({ id: accountId });
  await second.adapter.getAccount(accountId, "read");
  expect(value(await second.adapter.createAccount(input, "create")).disposition).toBe("fetched");
});
it("patches account country, title and metadata with the operation key", async () => {
  const { adapter, fetch, body } = setup({ id: accountId, country: "br", parent_account: null });
  const result = value(
    await adapter.updateAccount(
      accountId,
      { country: "BR", title: "Brazil", metadata: { run_id: "run2" } },
      "correct",
    ),
  );
  expect(result).toMatchObject({ country: "BR", parentAccountId: null });
  expect(String(fetch.mock.calls[0]?.[0])).toBe(
    "https://sandbox.invalid/api/v1/accounts/biz_seller",
  );
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: "PATCH",
    headers: { "Idempotency-Key": "correct" },
  });
  expect(body()).toEqual({ country: "BR", title: "Brazil", metadata: { run_id: "run2" } });
});
it("decodes purchase URL and only the returned plan fee", async () => {
  const input = {
    accountId,
    productTitle: "Product",
    productExternalId: "product1",
    price: { amountMinor: 2500, currency: "USD" as const },
    applicationFee: { amountMinor: 200, currency: "USD" as const },
    redirectUrl: "https://example.invalid",
  };
  const echoed = value(
    await setup({
      id: "ch_test",
      purchase_url: "/checkout/ch_test/",
      plan: { currency: "usd", application_fee_amount: "1.50" },
    }).adapter.createCheckoutConfiguration(input, "key"),
  );
  expect(echoed.purchaseUrl).toBe("/checkout/ch_test/");
  expect(echoed.applicationFee).toEqual({ amountMinor: 150, currency: "USD" });
  expect(
    value(
      await setup({ id: "ch_test", plan: { currency: "usd" } }).adapter.createCheckoutConfiguration(
        input,
        "key",
      ),
    ),
  ).not.toHaveProperty("applicationFee");
  expect(
    (
      await setup({
        id: "ch_test",
        plan: { currency: "usd", application_fee_amount: "1.001" },
      }).adapter.createCheckoutConfiguration(input, "key")
    ).ok,
  ).toBe(false);
});
const paymentRow = {
  id: "pay_list",
  account_id: accountId,
  status: "paid",
  total: { amount: "25.00", currency: "usd" },
  currency: "usd",
  created_at: "2026-09-08T12:00:00Z",
  ignored: "private data",
};
it("lists payments with an encoded account filter and cursor", async () => {
  const { adapter, fetch } = setup({
    data: [paymentRow],
    page_info: { end_cursor: "next", has_next_page: true },
  });
  expect(value(await adapter.listPayments({ accountId, cursor: "a&b=?" }))).toEqual({
    items: [
      {
        id: "pay_list",
        accountId,
        status: "paid",
        amount: { amountMinor: 2500, currency: "USD" },
        currency: "USD",
        createdAt: "2026-09-08T12:00:00Z",
      },
    ],
    nextCursor: "next",
  });
  const url = new URL(String(fetch.mock.calls[0]?.[0]));
  expect(url.searchParams.get("account_id")).toBe(accountId);
  expect(url.searchParams.get("after")).toBe("a&b=?");
  expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
});
it("handles empty and nullable payment results without inventing amounts", async () => {
  expect(
    value(
      await setup({
        data: [],
        page_info: { end_cursor: null, has_next_page: false },
      }).adapter.listPayments({ accountId }),
    ),
  ).toEqual({ items: [], nextCursor: null });
  const result = value(
    await setup({
      data: [{ ...paymentRow, total: null, account_id: null }],
      page_info: { end_cursor: "ignored", has_next_page: false },
    }).adapter.listPayments({ accountId }),
  );
  expect(result.items[0]).toMatchObject({ amount: null, accountId: null });
  expect(result.nextCursor).toBeNull();
});
it("rejects malformed or cross-account payment pages", async () => {
  for (const row of [
    { ...paymentRow, total: { amount: "2.001", currency: "usd" } },
    { ...paymentRow, total: { amount: "2.00", currency: "eur" } },
    { ...paymentRow, account_id: parentAccountId },
    { ...paymentRow, created_at: "invalid" },
  ]) {
    expect(
      (
        await setup({
          data: [row],
          page_info: { end_cursor: null, has_next_page: false },
        }).adapter.listPayments({ accountId })
      ).ok,
    ).toBe(false);
  }
  expect(
    (
      await setup({
        data: [],
        page_info: { end_cursor: null, has_next_page: true },
      }).adapter.listPayments({ accountId })
    ).ok,
  ).toBe(false);
});

it("caches each origin ledger lookup for the adapter instance", async () => {
  const { adapter, fetch } = setup({ id: "ctt_test" });
  fetch.mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    return new Response(
      JSON.stringify(
        path.includes("ledger_accounts")
          ? { id: path.endsWith("biz_platform") ? "ldgr_platform" : "ldgr_other" }
          : { id: "ctt_test" },
      ),
    );
  });
  for (const originId of [parentAccountId, parentAccountId, value(whopAccountId("biz_other"))]) {
    expect(
      (
        await adapter.createTransfer(
          {
            originId,
            destinationId: accountId,
            amount: { amountMinor: 2300, currency: "USD" },
            metadata: {},
          },
          "transfer-fixture",
        )
      ).ok,
    ).toBe(true);
  }
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(2);
  expect(
    fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).origin_id),
  ).toEqual(["ldgr_platform", "ldgr_platform", "ldgr_other"]);
});

it.each([{}, { id: "biz_wrong" }])(
  "rejects an invalid origin ledger response %j without a transfer",
  async (response) => {
    const { adapter, fetch } = setup(response);
    const result = await adapter.createTransfer(
      {
        originId: parentAccountId,
        destinationId: accountId,
        amount: { amountMinor: 2300, currency: "USD" },
        metadata: {},
      },
      "transfer-fixture",
    );
    expect(result.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("retries a failed ledger lookup without posting the unresolved transfer", async () => {
  const { adapter, fetch } = setup({ id: "ctt_test" });
  fetch
    .mockImplementationOnce(async () => new Response("unavailable", { status: 503 }))
    .mockImplementationOnce(async () => new Response(JSON.stringify({ id: "ldgr_origin" })));
  const input = {
    originId: parentAccountId,
    destinationId: accountId,
    amount: { amountMinor: 2300, currency: "USD" as const },
    metadata: {},
  };
  expect((await adapter.createTransfer(input, "transfer-retry")).ok).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(value(await adapter.createTransfer(input, "transfer-retry")).id).toBe("ctt_test");
  expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "POST"]);
});
