// Integration coverage for packages/db/src/repos/admin-ledger.ts against a real (PGlite)
// Postgres instance. packages/core/test/services/admin-ledger.test.ts already exercises the
// business rules (kind -> type mapping, status derivation, row shaping) against fake data; this
// file exercises the SQL side those rules sit on top of - filters, the order-resolution join
// replayed from webhook_inbox/business_effects, keyset pagination, and the per-currency
// summary - against real rows, migrated through the actual schema and migrations.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { effectKey } from "../../core/src/effects";
import { orderId, sellerId, whopAccountId } from "../../core/src/ids";
import type { InstrumentationEvent } from "../../core/src/instrumentation";
import type { Result } from "../../core/src/result";
import { createTestDb } from "../src/client";
import { createAdminLedgerRepo, getAdminLedgerEntry } from "../src/repos/admin-ledger";
import { insertInstrumentationEvent } from "../src/repos/instrumentation";
import { businessEffects, ledgerEntries, orders, sellers, webhookInbox } from "../src/schema";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});
beforeEach(async () => {
  await db.$client.exec(
    "TRUNCATE ledger_entries, business_effects, webhook_inbox, instrumentation_events, orders, sellers RESTART IDENTITY",
  );
});

const aliceId = value(sellerId("seller_alice"));
const bobId = value(sellerId("seller_bob"));
const orderAliceId = value(orderId("order_alice_1"));
const orderBobId = value(orderId("order_bob_1"));

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const at = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000);

// Seeds a full, self-consistent fixture: two sellers (Alice in USD with a direct sale policy
// and a display name, Bob in EUR with no display name so his row falls back to externalId),
// one order each, and a payment/fee/refund/refund_fee/transfer spread of ledger entries.
// Alice's payment and fee link to her order two ways at once (checkout_configuration_id and
// metadata.order_id, on two separate webhook deliveries) so both resolution paths get
// exercised; Bob's payment links only via metadata.order_id. The refund is real - resolving to
// the same order - so Alice's payment/fee are expected to derive "refunded", not "settled".
// The transfer entry deliberately has no business_effects/webhook_inbox row at all, proving
// order resolution is optional plumbing, not a hard requirement, for a transfer kind.
async function seedFixture() {
  await db.insert(sellers).values([
    {
      id: aliceId,
      runId: "run_1",
      externalId: "alice",
      email: "alice@example.invalid",
      country: "US",
      whopAccountId: value(whopAccountId("biz_alice")),
      salePolicy: "direct",
      displayName: "Alice's Shop",
    },
    {
      id: bobId,
      runId: "run_1",
      externalId: "bob",
      email: "bob@example.invalid",
      country: "DE",
      salePolicy: "platform_only",
    },
  ]);

  await db.insert(orders).values([
    {
      id: orderAliceId,
      runId: "run_1",
      sellerId: aliceId,
      productTitle: "Alice's Course",
      grossMinor: 2500,
      currency: "USD",
      feeMinor: 200,
      flow: "direct",
      checkoutConfigurationId: "cfg_alice_1",
      status: "checkout_created",
      provenance: "mock",
    },
    {
      id: orderBobId,
      runId: "run_1",
      sellerId: bobId,
      productTitle: "Bob's Ebook",
      grossMinor: 900,
      currency: "EUR",
      feeMinor: 90,
      flow: "platform_transfer",
      checkoutConfigurationId: "cfg_bob_1",
      status: "checkout_created",
      provenance: "sandbox",
    },
  ]);

  await db.insert(webhookInbox).values([
    {
      deliveryId: "delivery_alice_payment",
      eventType: "payment.succeeded",
      apiVersionDate: "2026-06-01",
      accountField: "company_id",
      accountId: "biz_alice",
      rawBody: JSON.stringify({ data: { checkout_configuration_id: "cfg_alice_1" } }),
      headers: {},
    },
    {
      deliveryId: "delivery_alice_refund",
      eventType: "refund.succeeded",
      apiVersionDate: "2026-06-01",
      accountField: "company_id",
      accountId: "biz_alice",
      rawBody: JSON.stringify({ data: { metadata: { order_id: orderAliceId } } }),
      headers: {},
    },
    {
      deliveryId: "delivery_bob_payment",
      eventType: "payment.succeeded",
      apiVersionDate: "2026-06-01",
      accountField: "company_id",
      accountId: "biz_bob",
      rawBody: JSON.stringify({ data: { metadata: { order_id: orderBobId } } }),
      headers: {},
    },
  ]);

  const alicePaymentKey = effectKey("payment", "pay_alice_1", "succeeded");
  const aliceFeeKey = effectKey("fee", "pay_alice_1", "succeeded");
  const aliceRefundKey = effectKey("refund", "refund_alice_1", "succeeded");
  const aliceRefundFeeKey = effectKey("refund_fee", "refund_alice_1", "succeeded");
  const bobPaymentKey = effectKey("payment", "pay_bob_1", "succeeded");
  const aliceTransferKey = effectKey("transfer", "transfer_alice_1", "completed");

  await db.insert(businessEffects).values([
    {
      effectKey: alicePaymentKey,
      deliveryId: "delivery_alice_payment",
      resourceType: "payment",
      resourceId: "pay_alice_1",
      transition: "succeeded",
    },
    {
      effectKey: aliceFeeKey,
      deliveryId: "delivery_alice_payment",
      resourceType: "payment",
      resourceId: "pay_alice_1",
      transition: "succeeded",
    },
    {
      effectKey: aliceRefundKey,
      deliveryId: "delivery_alice_refund",
      resourceType: "refund",
      resourceId: "refund_alice_1",
      transition: "succeeded",
    },
    {
      effectKey: aliceRefundFeeKey,
      deliveryId: "delivery_alice_refund",
      resourceType: "refund",
      resourceId: "refund_alice_1",
      transition: "succeeded",
    },
    {
      effectKey: bobPaymentKey,
      deliveryId: "delivery_bob_payment",
      resourceType: "payment",
      resourceId: "pay_bob_1",
      transition: "succeeded",
    },
    // Deliberately no row for aliceTransferKey - transfer/payout kinds are structurally
    // unresolvable to an order (see admin-ledger.ts's module comment), so a real webhook
    // pipeline never produces a matching business_effects row for one either.
  ]);

  const [alicePayment] = await db
    .insert(ledgerEntries)
    .values({
      runId: "run_1",
      sellerId: aliceId,
      accountSide: "platform",
      currency: "USD",
      amountMinor: 2300,
      kind: "payment",
      providerResourceType: "payment",
      providerResourceId: "pay_alice_1",
      effectKey: alicePaymentKey,
      occurredAt: at(0),
      provenance: "mock",
      correlationId: "corr_alice_payment",
    })
    .returning();
  const [aliceFee] = await db
    .insert(ledgerEntries)
    .values({
      runId: "run_1",
      sellerId: aliceId,
      accountSide: "platform",
      currency: "USD",
      amountMinor: 200,
      kind: "fee",
      providerResourceType: "payment",
      providerResourceId: "pay_alice_1",
      effectKey: aliceFeeKey,
      occurredAt: at(1),
      provenance: "mock",
    })
    .returning();
  const [bobPayment] = await db
    .insert(ledgerEntries)
    .values({
      runId: "run_1",
      sellerId: bobId,
      accountSide: "platform",
      currency: "EUR",
      amountMinor: 810,
      kind: "payment",
      providerResourceType: "payment",
      providerResourceId: "pay_bob_1",
      effectKey: bobPaymentKey,
      occurredAt: at(2),
      provenance: "sandbox",
    })
    .returning();
  const [aliceRefund] = await db
    .insert(ledgerEntries)
    .values({
      runId: "run_1",
      sellerId: aliceId,
      accountSide: "platform",
      currency: "USD",
      amountMinor: -2300,
      kind: "refund",
      providerResourceType: "refund",
      providerResourceId: "refund_alice_1",
      effectKey: aliceRefundKey,
      occurredAt: at(3),
      provenance: "mock",
    })
    .returning();
  const [aliceRefundFee] = await db
    .insert(ledgerEntries)
    .values({
      runId: "run_1",
      sellerId: aliceId,
      accountSide: "platform",
      currency: "USD",
      amountMinor: -200,
      kind: "refund_fee",
      providerResourceType: "refund",
      providerResourceId: "refund_alice_1",
      effectKey: aliceRefundFeeKey,
      occurredAt: at(4),
      provenance: "mock",
    })
    .returning();
  const [aliceTransfer] = await db
    .insert(ledgerEntries)
    .values({
      runId: "run_1",
      sellerId: aliceId,
      accountSide: "platform",
      currency: "USD",
      amountMinor: 2100,
      kind: "transfer",
      providerResourceType: "transfer",
      providerResourceId: "transfer_alice_1",
      effectKey: aliceTransferKey,
      occurredAt: at(5),
      provenance: "mock",
    })
    .returning();

  if (
    !alicePayment ||
    !aliceFee ||
    !bobPayment ||
    !aliceRefund ||
    !aliceRefundFee ||
    !aliceTransfer
  )
    throw new Error("Expected every seeded ledger entry row back");
  return { alicePayment, aliceFee, bobPayment, aliceRefund, aliceRefundFee, aliceTransfer };
}

describe("createAdminLedgerRepo().query", () => {
  it("resolves the order for a payment/fee pair and derives refunded once a sibling refund resolves", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const { rows } = await repo.query({});
    const alicePaymentRow = rows.find(
      (row) => row.providerResourceId === "pay_alice_1" && row.type === "payment",
    );
    const aliceFeeRow = rows.find(
      (row) => row.providerResourceId === "pay_alice_1" && row.type === "fee",
    );
    expect(alicePaymentRow?.orderId).toBe(orderAliceId);
    expect(alicePaymentRow?.gross).toEqual({ amountMinor: 2500, currency: "USD" });
    expect(alicePaymentRow?.fee).toEqual({ amountMinor: 200, currency: "USD" });
    expect(alicePaymentRow?.net).toEqual({ amountMinor: 2300, currency: "USD" });
    // A real refund resolved to the same order, so both payment and fee flip to refunded -
    // this is the join this file exists to prove, not just the status table core already covers.
    expect(alicePaymentRow?.status).toBe("refunded");
    expect(aliceFeeRow?.status).toBe("refunded");
  });

  it("resolves an order via metadata.order_id alone, with no checkout_configuration_id match", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const { rows } = await repo.query({});
    const bobRow = rows.find((row) => row.providerResourceId === "pay_bob_1");
    expect(bobRow?.orderId).toBe(orderBobId);
    expect(bobRow?.gross).toEqual({ amountMinor: 900, currency: "EUR" });
    expect(bobRow?.status).toBe("settled");
  });

  it("leaves a transfer row with no order and a currency-only net", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const { rows } = await repo.query({});
    const transferRow = rows.find((row) => row.providerResourceId === "transfer_alice_1");
    expect(transferRow?.orderId).toBeNull();
    expect(transferRow?.gross).toBeNull();
    expect(transferRow?.fee).toBeNull();
    expect(transferRow?.net).toEqual({ amountMinor: 2100, currency: "USD" });
    expect(transferRow?.status).toBe("settled");
  });

  it("resolves each seller's display name, falling back to externalId when unset", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const { rows } = await repo.query({});
    const aliceRow = rows.find((row) => row.seller.id === aliceId);
    const bobRow = rows.find((row) => row.seller.id === bobId);
    expect(aliceRow?.seller.name).toBe("Alice's Shop");
    expect(bobRow?.seller.name).toBe("bob");
  });

  it("filters by free-text search across provider resource id, seller name, and order id", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const byResourceId = await repo.query({ q: "pay_bob_1" });
    expect(byResourceId.rows).toHaveLength(1);
    expect(byResourceId.rows[0]?.providerResourceId).toBe("pay_bob_1");

    const bySellerName = await repo.query({ q: "alice" });
    expect(bySellerName.rows.every((row) => row.seller.id === aliceId)).toBe(true);
    expect(bySellerName.rows.length).toBeGreaterThan(0);

    const byOrderId = await repo.query({ q: "order_alice_1" });
    expect(byOrderId.rows.every((row) => row.orderId === orderAliceId)).toBe(true);
    expect(byOrderId.rows.length).toBeGreaterThan(0);
  });

  it("filters by type, mapping fee to both fee and refund_fee kinds", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const { rows } = await repo.query({ type: "fee" });
    expect(rows.map((row) => row.providerResourceId).sort()).toEqual([
      "pay_alice_1",
      "refund_alice_1",
    ]);
    expect(rows.every((row) => row.type === "fee")).toBe(true);
  });

  it("filters by status, using the same derivation the rows themselves show", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const refunded = await repo.query({ status: "refunded" });
    expect(refunded.rows).toHaveLength(4); // Alice payment, fee, refund, refund_fee
    expect(refunded.rows.every((row) => row.status === "refunded")).toBe(true);

    const settled = await repo.query({ status: "settled" });
    expect(settled.rows.map((row) => row.providerResourceId).sort()).toEqual([
      "pay_bob_1",
      "transfer_alice_1",
    ]);
  });

  it("filters by seller id", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const { rows } = await repo.query({ sellerId: bobId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seller.id).toBe(bobId);
  });

  it("filters by provenance", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const { rows } = await repo.query({ provenance: "sandbox" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerResourceId).toBe("pay_bob_1");
  });

  it("filters by currency", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const { rows } = await repo.query({ currency: "EUR" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.currency).toBe("EUR");
  });

  it("filters by an occurred_at range", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const { rows } = await repo.query({ from: at(1), to: at(3) });
    // fee(1), bobPayment(2), refund(3) fall in range; payment(0), refund_fee(4), transfer(5) don't.
    expect(rows.map((row) => row.providerResourceId).sort()).toEqual([
      "pay_alice_1",
      "pay_bob_1",
      "refund_alice_1",
    ]);
  });

  it("paginates with a keyset cursor, most-recent-first, covering every row exactly once", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const firstPage = await repo.query({ limit: 4 });
    expect(firstPage.rows).toHaveLength(4);
    expect(firstPage.nextCursor).not.toBeNull();
    // Most-recent-first: transfer(5), refund_fee(4), refund(3), bobPayment(2).
    expect(firstPage.rows.map((row) => row.providerResourceId)).toEqual([
      "transfer_alice_1",
      "refund_alice_1",
      "refund_alice_1",
      "pay_bob_1",
    ]);

    const cursor = firstPage.nextCursor;
    if (!cursor) throw new Error("Expected a next cursor after the first page");
    const secondPage = await repo.query({ limit: 4, cursor });
    expect(secondPage.rows).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.rows.map((row) => row.providerResourceId)).toEqual([
      "pay_alice_1",
      "pay_alice_1",
    ]);

    const allIds = [...firstPage.rows, ...secondPage.rows].map((row) => row.id);
    expect(new Set(allIds).size).toBe(6); // no row repeated or skipped across pages
  });
});

describe("createAdminLedgerRepo().summarize", () => {
  it("sums gross/fee/net per currency without ever combining currencies", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const summary = await repo.summarize({});
    // USD: payment(gross 2500/fee 200/net 2300) + fee(gross 2500/fee 200/net 200) +
    // refund(gross 2500/fee 200/net -2300) + refund_fee(gross 2500/fee 200/net -200) +
    // transfer(gross 0/fee 0/net 2100) - the summary totals the same rows the list renders,
    // including a payment and its fee both quoting the same order's gross, on purpose.
    expect(summary.USD).toEqual({ gross: 10000, fee: 800, net: 2100 });
    expect(summary.EUR).toEqual({ gross: 900, fee: 90, net: 810 });
    expect(Object.keys(summary).sort()).toEqual(["EUR", "USD"]);
  });

  it("summarizes the whole filtered set, honoring the same filters as query()", async () => {
    await seedFixture();
    const repo = createAdminLedgerRepo(db);
    const summary = await repo.summarize({ sellerId: bobId });
    expect(summary.EUR).toEqual({ gross: 900, fee: 90, net: 810 });
    expect(summary.USD).toBeUndefined();
  });
});

describe("getAdminLedgerEntry", () => {
  it("returns the row, its order, and every sibling row resolving to the same order", async () => {
    const { alicePayment, aliceFee, aliceRefund, aliceRefundFee } = await seedFixture();
    const detail = await getAdminLedgerEntry(db, String(alicePayment.id));
    expect(detail?.row.providerResourceId).toBe("pay_alice_1");
    expect(detail?.order).toEqual({
      id: orderAliceId,
      productTitle: "Alice's Course",
      gross: { amountMinor: 2500, currency: "USD" },
      fee: { amountMinor: 200, currency: "USD" },
      status: "checkout_created",
    });
    const siblingIds = detail?.siblings.map((row) => row.id).sort() ?? [];
    expect(siblingIds).toEqual([aliceFee.id, aliceRefund.id, aliceRefundFee.id].map(String).sort());
    // The transfer entry has no resolved order, so it can never be a "sibling" of an order-
    // bearing row - it simply never has an order_id to match against.
    expect(detail?.siblings.some((row) => row.providerResourceId === "transfer_alice_1")).toBe(
      false,
    );
  });

  it("includes the instrumentation events recorded under the row's correlation id", async () => {
    const { alicePayment } = await seedFixture();
    const event: InstrumentationEvent = {
      correlationId: "corr_alice_payment",
      source: "app_api",
      phase: "start",
      path: "/api/checkout",
      status: null,
      provenance: "app",
      safeIds: {},
      summary: "app_api started",
      at: at(0),
    };
    await insertInstrumentationEvent(db, event);
    const detail = await getAdminLedgerEntry(db, String(alicePayment.id));
    expect(detail?.instrumentationEvents).toHaveLength(1);
    expect(detail?.instrumentationEvents[0]?.summary).toBe("app_api started");
  });

  it("returns an empty instrumentation list when the row has no correlation id", async () => {
    const { aliceFee } = await seedFixture();
    const detail = await getAdminLedgerEntry(db, String(aliceFee.id));
    expect(detail?.instrumentationEvents).toEqual([]);
  });

  it("returns null for an id that does not exist", async () => {
    await seedFixture();
    const detail = await getAdminLedgerEntry(db, "999999");
    expect(detail).toBeNull();
  });

  it("returns null for a non-numeric id rather than throwing", async () => {
    await seedFixture();
    const detail = await getAdminLedgerEntry(db, "not-a-number");
    expect(detail).toBeNull();
  });

  it("reports a null order and empty siblings for a row that never resolves one", async () => {
    const { aliceTransfer } = await seedFixture();
    const detail = await getAdminLedgerEntry(db, String(aliceTransfer.id));
    expect(detail?.order).toBeNull();
    expect(detail?.siblings).toEqual([]);
  });
});
