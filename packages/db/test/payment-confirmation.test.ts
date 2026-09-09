import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { orderId, whopAccountId, whopPaymentId } from "../../core/src/ids";
import { ok, type Result } from "../../core/src/result";
import { createInboxService, type ReceiveInput } from "../../core/src/services/inbox";
import {
  type ConfirmedPaymentRead,
  createPaymentConfirmationService,
} from "../../core/src/services/payment-confirmation";
import type { UnitOfWork } from "../../core/src/services/ports";
import { decodeEnvelope } from "../../whop/src/envelope";
import { signStandardWebhook, verifyStandardWebhook } from "../../whop/src/webhooks";
import { createAdminLedgerRepo } from "../src/repos/admin-ledger";
import { createPgliteUnitOfWork } from "../src/repos/unit-of-work";

// Deterministic sandbox-shaped observations in a local PGlite test, never provider proof.
function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Invalid fixture");
  return result.value;
}
const now = new Date("2026-09-09T12:00:00Z");
const input = {
  orderId: value(orderId("order_owned")),
  paymentId: value(whopPaymentId("pay_observed")),
  buyerUserId: "buyer_owned",
};
const platform = value(whopAccountId("biz_platform"));
const observation: ConfirmedPaymentRead = {
  paymentId: input.paymentId,
  accountId: platform,
  checkoutId: "ch_owned",
  gross: { amountMinor: 2500, currency: "USD" },
  refunded: { amountMinor: 0, currency: "USD" },
  status: "paid",
  substatus: "succeeded",
  paidAt: now,
  refundedAt: null,
  autoRefunded: false,
  metadata: {},
  source: "sandbox",
  sellerAccountId: value(whopAccountId("biz_seller")),
  parentAccountId: platform,
  observedAt: now,
};
let db: PGlite;
let uow: UnitOfWork;
beforeAll(async () => {
  db = new PGlite();
  await migrate(drizzle(db), {
    migrationsFolder: fileURLToPath(new URL("../drizzle/", import.meta.url)),
  });
  uow = createPgliteUnitOfWork(db);
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(
    "TRUNCATE ledger_entries,business_effects,webhook_inbox,orders,sellers RESTART IDENTITY",
  );
  await db.exec(
    "INSERT INTO sellers(id,run_id,external_id,email,country,whop_account_id,sale_policy) VALUES ('seller_owned','run_owned','owned','test@example.invalid','BR','biz_seller','platform_only')",
  );
  await db.exec(
    "INSERT INTO orders(id,run_id,seller_id,product_title,gross_minor,currency,fee_minor,flow,checkout_configuration_id,status,provenance,buyer_user_id) VALUES ('order_owned','run_owned','seller_owned','Owned',2500,'USD',200,'platform_transfer','ch_owned','checkout_created','sandbox','buyer_owned')",
  );
});
function confirm(
  change: Partial<ConfirmedPaymentRead> = {},
  work = uow,
  beforeRead?: () => Promise<void>,
) {
  return createPaymentConfirmationService({
    uow: work,
    platformAccountId: platform,
    clock: { now: () => now },
    readPayment: async () => {
      await beforeRead?.();
      return ok({ ...observation, ...change });
    },
  });
}
async function state() {
  return {
    orders: (await db.query("SELECT * FROM orders ORDER BY id")).rows,
    effects: (await db.query("SELECT * FROM business_effects ORDER BY effect_key")).rows,
    ledger: (await db.query("SELECT * FROM ledger_entries ORDER BY id")).rows,
  };
}
function inbox() {
  return createInboxService({
    uow,
    platformAccountId: platform,
    provenance: "sandbox",
    clock: { now: () => now },
    decoder: { decodeEnvelope, verifyStandardWebhook },
  });
}
function event(type = "payment.succeeded", id = "delivery_fixture"): ReceiveInput {
  const secret = "local-fixture-only";
  const rawBody = JSON.stringify({
    id,
    type,
    account_id: platform,
    api_version_date: "2026-08-21",
    timestamp: now.toISOString(),
    data:
      type === "payment.succeeded"
        ? {
            id: input.paymentId,
            amount_minor: "2500",
            currency: "USD",
            checkout_configuration_id: "ch_owned",
          }
        : {
            id: "ref_fixture",
            payment_id: input.paymentId,
            amount_minor: "2500",
            currency: "USD",
            checkout_configuration_id: "ch_owned",
          },
  });
  const timestamp = String(now.getTime() / 1000);
  return {
    rawBody,
    secret,
    now,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signStandardWebhook({ rawBody, secret, id, timestamp }),
    },
  };
}
async function deliver(type?: string, id?: string) {
  const receiver = inbox();
  expect(value(await receiver.receiveWebhook(event(type, id))).decoded).toBe(true);
  return receiver.processInbox({ limit: 10 });
}

it("binds the exact order and posts its persisted allocation without a webhook row", async () => {
  expect(value(await confirm()(input))).toMatchObject({
    status: "paid",
    duplicate: false,
    provenance: "sandbox",
  });
  const rows = await state();
  expect(rows.orders).toMatchObject([
    { status: "paid", payment_id: "pay_observed", provenance: "sandbox" },
  ]);
  expect(rows.ledger).toMatchObject([
    { amount_minor: 2300, kind: "payment", provenance: "sandbox" },
    { amount_minor: 200, kind: "fee", provenance: "sandbox" },
  ]);
  expect(rows.effects).toMatchObject([
    {
      effect_key: "payment:pay_observed:succeeded",
      delivery_id: "provider_read:pay_observed:order_owned",
      detail: { source: "provider_read", actor_user_id: "buyer_owned", order_id: "order_owned" },
    },
  ]);
  expect((await db.query("SELECT * FROM webhook_inbox")).rows).toEqual([]);
  expect(value(await confirm()(input))).toMatchObject({ duplicate: true });
  expect(await state()).toEqual(rows);
});
it("links provider-read rows to the operator's order, amount and fee filters", async () => {
  value(await confirm()(input));
  const repo = createAdminLedgerRepo(drizzle(db));
  const page = await repo.query({ q: "order_owned" });
  expect(page.rows).toHaveLength(2);
  expect(page.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        orderId: "order_owned",
        gross: { amountMinor: 2500, currency: "USD" },
        fee: { amountMinor: 200, currency: "USD" },
      }),
    ]),
  );
  expect((await db.query("SELECT * FROM webhook_inbox")).rows).toEqual([]);
  await db.exec(
    "UPDATE business_effects SET detail=jsonb_set(detail,'{checkout_configuration_id}','\"ch_wrong\"')",
  );
  expect((await repo.query({ q: "order_owned" })).rows).toEqual([]);
});
it("keeps operator order links and refunded status after a payment-ID-only refund", async () => {
  value(await confirm()(input));
  const delivery = event("refund.created", "refund_by_payment");
  const body = JSON.parse(delivery.rawBody);
  delete body.data.checkout_configuration_id;
  delivery.rawBody = JSON.stringify(body);
  delivery.headers["webhook-signature"] = signStandardWebhook({
    rawBody: delivery.rawBody,
    secret: delivery.secret,
    id: delivery.headers["webhook-id"],
    timestamp: delivery.headers["webhook-timestamp"],
  });
  expect(value(await inbox().receiveWebhook(delivery)).decoded).toBe(true);
  expect(await inbox().processInbox({ limit: 10 })).toMatchObject({ effects: 1 });
  const page = await createAdminLedgerRepo(drizzle(db)).query({ q: "order_owned" });
  expect(page.rows).toHaveLength(4);
  expect(page.rows.every((row) => row.orderId === "order_owned" && row.status === "refunded")).toBe(
    true,
  );
});
it.each([
  ["account", { accountId: value(whopAccountId("biz_foreign")) }],
  ["seller account", { sellerAccountId: value(whopAccountId("biz_foreign")) }],
  ["parent", { parentAccountId: value(whopAccountId("biz_foreign")) }],
  ["checkout", { checkoutId: "ch_foreign" }],
  ["payment", { paymentId: value(whopPaymentId("pay_foreign")) }],
  ["gross", { gross: { amountMinor: 2499, currency: "USD" } }],
  ["currency", { gross: { amountMinor: 2500, currency: "EUR" } }],
  ["unpaid", { status: "open" }],
  ["substatus", { substatus: "pending" }],
  ["refund", { refunded: { amountMinor: 1, currency: "USD" } }],
  ["refund time", { refundedAt: now }],
  ["auto refund", { autoRefunded: true }],
  ["order metadata", { metadata: { order_id: "other" } }],
  ["seller metadata", { metadata: { seller_id: "other" } }],
  ["run metadata", { metadata: { run_id: "other" } }],
] satisfies [string, Partial<ConfirmedPaymentRead>][])(
  "rejects %s without writes",
  async (_name, change) => {
    const before = await state();
    expect((await confirm(change)(input)).ok).toBe(false);
    expect(await state()).toEqual(before);
  },
);
it("denies a foreign buyer before provider access", async () => {
  let reads = 0;
  expect(
    await confirm({}, uow, async () => {
      reads++;
    })({ ...input, buyerUserId: "foreign" }),
  ).toEqual({ ok: false, error: { kind: "forbidden" } });
  expect(reads).toBe(0);
});
it.each([
  "UPDATE orders SET payment_id='pay_other'",
  "UPDATE orders SET status='refunded'",
  "UPDATE orders SET provenance='mock'",
  "UPDATE orders SET buyer_user_id='other'",
  "UPDATE orders SET gross_minor=2600",
  "UPDATE orders SET fee_minor=250",
  "UPDATE orders SET checkout_configuration_id='ch_other'",
  "UPDATE sellers SET whop_account_id='biz_other'",
])("revalidates state changed during the provider read %#", async (mutation) => {
  let changed: Awaited<ReturnType<typeof state>> | undefined;
  const result = await confirm({}, uow, async () => {
    await db.exec(mutation);
    changed = await state();
  })(input);
  expect(result.ok).toBe(false);
  expect(changed).toBeDefined();
  expect(await state()).toEqual(changed);
});
it("uses the stored fee rather than today's fee formula", async () => {
  await db.exec("UPDATE orders SET fee_minor=321");
  value(await confirm()(input));
  expect((await state()).ledger).toMatchObject([{ amount_minor: 2179 }, { amount_minor: 321 }]);
});
it("dedupes simultaneous confirmations", async () => {
  const results = await Promise.all([confirm()(input), confirm()(input)]);
  expect(
    results
      .map(value)
      .map((r) => r.duplicate)
      .sort(),
  ).toEqual([false, true]);
  expect((await state()).effects).toHaveLength(1);
  expect((await state()).ledger).toHaveLength(2);
});
it.each(["checkout", "payment"])("rejects an ambiguous or reused %s binding", async (binding) => {
  await db.exec(`INSERT INTO orders(id,run_id,seller_id,product_title,gross_minor,currency,fee_minor,flow,checkout_configuration_id,payment_id,status,provenance,buyer_user_id)
    VALUES ('order_other','run_owned','seller_owned','Other',2500,'USD',200,'platform_transfer',${binding === "checkout" ? "'ch_owned'" : "'ch_other'"},${binding === "payment" ? "'pay_observed'" : "NULL"},'checkout_created','sandbox','other')`);
  const before = await state();
  expect((await confirm()(input)).ok).toBe(false);
  expect(await state()).toEqual(before);
});
it("dedupes a later webhook after confirmation", async () => {
  value(await confirm()(input));
  const before = await state();
  expect(await deliver()).toMatchObject({ effects: 0 });
  expect(await state()).toEqual(before);
});
it("recognizes an exact webhook payment already applied", async () => {
  expect(await deliver()).toMatchObject({ effects: 1 });
  const before = await state();
  expect(value(await confirm()(input))).toMatchObject({ duplicate: true });
  expect(await state()).toEqual(before);
});
it("serializes webhook and provider-read effects on the order", async () => {
  value(await inbox().receiveWebhook(event()));
  const [confirmed] = await Promise.all([confirm()(input), inbox().processInbox({ limit: 10 })]);
  expect(confirmed.ok).toBe(true);
  expect((await state()).effects).toHaveLength(1);
  expect((await state()).ledger).toHaveLength(2);
});
it("preserves a refund applied while the payment read is pending", async () => {
  await deliver();
  const result = await confirm({}, uow, async () => {
    await deliver("refund.created", "refund_delivery");
  })(input);
  expect(result.ok).toBe(false);
  expect((await state()).orders).toMatchObject([{ status: "refunded" }]);
  expect((await state()).ledger).toHaveLength(4);
});
it("applies an early deferred refund after payment confirmation and rejects later paid reads", async () => {
  expect(await deliver("refund.created", "early_refund")).toMatchObject({ deferred: 1 });
  value(await confirm()(input));
  expect(await inbox().processInbox({ limit: 10 })).toMatchObject({ effects: 1 });
  const before = await state();
  expect((await confirm()(input)).ok).toBe(false);
  expect(await state()).toEqual(before);
});
it("fails closed when an old operator import consumed the effect without binding an order", async () => {
  await db.exec(
    "INSERT INTO business_effects(effect_key,delivery_id,resource_type,resource_id,transition) VALUES ('payment:pay_observed:succeeded','admin_action:old','payment','pay_observed','succeeded')",
  );
  const before = await state();
  expect(await confirm()(input)).toEqual({ ok: false, error: { kind: "invariant_conflict" } });
  expect(await state()).toEqual(before);
});
it.each([
  "UPDATE ledger_entries SET effect_key='other'",
  "UPDATE ledger_entries SET kind='other'",
  "UPDATE ledger_entries SET provenance='mock'",
  "UPDATE ledger_entries SET amount_minor=123",
  "DELETE FROM business_effects",
])("rejects inconsistent duplicate evidence %#", async (mutation) => {
  value(await confirm()(input));
  await db.exec(mutation);
  const before = await state();
  expect((await confirm()(input)).ok).toBe(false);
  expect(await state()).toEqual(before);
});
it("rolls back effect and ledger when settlement storage fails", async () => {
  await db.exec(
    "CREATE FUNCTION reject_paid_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='paid' THEN RAISE EXCEPTION 'fixture settlement failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_paid_fixture BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION reject_paid_fixture()",
  );
  const before = await state();
  try {
    await expect(confirm()(input)).rejects.toThrow("fixture settlement failure");
    expect(await state()).toEqual(before);
  } finally {
    await db.exec(
      "DROP TRIGGER reject_paid_fixture ON orders; DROP FUNCTION reject_paid_fixture()",
    );
  }
});
it("rolls back when a successful storage call fails the locked settlement readback", async () => {
  await db.exec(
    "CREATE FUNCTION suppress_paid_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$; CREATE TRIGGER suppress_paid_fixture BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION suppress_paid_fixture()",
  );
  const before = await state();
  try {
    expect(await confirm()(input)).toEqual({ ok: false, error: { kind: "invariant_conflict" } });
    expect(await state()).toEqual(before);
  } finally {
    await db.exec(
      "DROP TRIGGER suppress_paid_fixture ON orders; DROP FUNCTION suppress_paid_fixture()",
    );
  }
});
