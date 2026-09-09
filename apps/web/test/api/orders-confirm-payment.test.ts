import {
  type ConfirmedPaymentRead,
  createPaymentConfirmationService,
  ok,
  whopAccountId,
} from "@ledgerly/core";
import { createPgliteUnitOfWork, createTestDb } from "@ledgerly/db";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createConfirmPaymentHandler } from "../../src/app/api/orders/[id]/confirm-payment/route";

let db: Awaited<ReturnType<typeof createTestDb>>;
let reads = 0;
const base = "https://ledgerly.example.invalid";
beforeAll(async () => {
  db = await createTestDb();
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});
beforeEach(async () => {
  reads = 0;
  await db.$client.exec("TRUNCATE orders,sellers,ledger_entries,business_effects RESTART IDENTITY");
  await db.$client.exec(
    "INSERT INTO sellers(id,run_id,external_id,email,country,whop_account_id,sale_policy) VALUES ('seller','run','seller','fixture@example.invalid','BR','biz_seller','platform_only'); INSERT INTO orders(id,run_id,seller_id,product_title,gross_minor,fee_minor,currency,flow,checkout_configuration_id,status,provenance,buyer_user_id) VALUES ('order','run','seller','Product',2500,200,'USD','platform_transfer','ch_owned','checkout_created','sandbox','buyer')",
  );
});
function handler(user = "buyer", role = "buyer") {
  const platform = whopAccountId("biz_platform");
  if (!platform.ok) throw new Error("Invalid fixture account");
  const confirm = createPaymentConfirmationService({
    uow: createPgliteUnitOfWork(db.$client),
    platformAccountId: platform.value,
    clock: { now: () => new Date() },
    readPayment: async (input) => {
      reads++;
      const observation: ConfirmedPaymentRead = {
        ...input,
        source: "sandbox",
        accountId: platform.value,
        parentAccountId: platform.value,
        checkoutId: "ch_owned",
        gross: { amountMinor: 2500, currency: "USD" },
        refunded: { amountMinor: 0, currency: "USD" },
        status: "paid",
        substatus: "succeeded",
        paidAt: new Date(),
        observedAt: new Date(),
        refundedAt: null,
        autoRefunded: false,
        metadata: {},
      };
      return ok(observation);
    },
  });
  return createConfirmPaymentHandler({
    appBaseUrl: () => base,
    getSession: async () => (user ? { userId: user, role } : null),
    confirm,
  });
}
function request(
  body: unknown = { payment_id: "pay_owned" },
  headers: Record<string, string> = {},
) {
  return new Request(`${base}/api/orders/order/confirm-payment`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
it.each([
  ["", "buyer", 401],
  ["foreign", "buyer", 403],
  ["operator", "operator", 403],
  ["seller", "seller", 403],
  ["buyer", "demo", 403],
] as const)("denies %s %s before reading the provider", async (user, role, status) => {
  expect((await handler(user, role)(request(), "order")).status).toBe(status);
  expect(reads).toBe(0);
});
it.each<Record<string, string>>([
  { origin: "https://foreign.invalid" },
  { origin: "null" },
  { origin: "" },
  { "sec-fetch-site": "cross-site" },
])("rejects foreign or missing origin %#", async (headers) => {
  expect((await handler()(request(undefined, headers), "order")).status).toBe(403);
  expect(reads).toBe(0);
});
it.each([
  {},
  { payment_id: "pay_owned", amount: 2500 },
  { payment_id: "sim_pay_1" },
  { payment_id: "pay_" },
  { payment_id: 42 },
  [],
])("accepts only a strict payment-ID hint %#", async (body) => {
  expect((await handler()(request(body), "order")).status).toBe(400);
  expect(reads).toBe(0);
});
it("confirms and reads back one durable payment through the real service and repository", async () => {
  const response = await handler()(request(), "order");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    order_id: "order",
    payment_id: "pay_owned",
    status: "paid",
    provenance: "sandbox",
    confirmation_source: "provider_read",
    duplicate: false,
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await db.$client.query("SELECT status,payment_id FROM orders")).rows).toEqual([
    { status: "paid", payment_id: "pay_owned" },
  ]);
  expect((await db.$client.query("SELECT * FROM ledger_entries")).rows).toHaveLength(2);
  expect((await handler()(request(), "order")).status).toBe(200);
  expect((await db.$client.query("SELECT * FROM ledger_entries")).rows).toHaveLength(2);
});
