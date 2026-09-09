import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, createTestDb, ledgerEntries, sellers, webhookInbox } from "../src/index";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});
it("inserts sellers and enforces run plus external identity", async () => {
  const seller = {
    id: "seller_1",
    runId: "run_1",
    externalId: "external_1",
    email: "fiction@example.invalid",
    country: "US" as const,
    salePolicy: "direct" as const,
  };
  await db.insert(sellers).values(seller);
  await expect(db.insert(sellers).values({ ...seller, id: "seller_2" })).rejects.toThrow();
  await db.insert(sellers).values({ ...seller, id: "seller_3", runId: "run_2" });
  expect(await db.select().from(sellers)).toHaveLength(2);
});
it("rejects duplicate webhook delivery IDs and preserves raw bodies", async () => {
  const row = {
    deliveryId: "delivery_1",
    eventType: "payout.updated",
    apiVersionDate: "2026-06-01",
    accountField: "company_id" as const,
    accountId: "biz_mock_1",
    rawBody: '{ "data": {} }',
    headers: {},
  };
  await db.insert(webhookInbox).values(row);
  await expect(db.insert(webhookInbox).values(row)).rejects.toThrow();
  expect((await db.select().from(webhookInbox))[0]?.rawBody).toBe(row.rawBody);
});
it("allows one ledger entry per effect and account side", async () => {
  const row = {
    runId: "run_1",
    currency: "USD" as const,
    amountMinor: 200,
    kind: "fee",
    providerResourceType: "payment",
    providerResourceId: "pay_mock_1",
    effectKey: "payment:pay_mock_1:succeeded",
    occurredAt: new Date("2026-09-08T12:00:00Z"),
  };
  await db.insert(ledgerEntries).values({ ...row, accountSide: "platform" });
  await db.insert(ledgerEntries).values({ ...row, accountSide: "seller", amountMinor: -200 });
  await expect(
    db.insert(ledgerEntries).values({ ...row, accountSide: "platform" }),
  ).rejects.toThrow();
  const entries = await db.select().from(ledgerEntries);
  expect(entries).toHaveLength(2);
  expect(entries.map((entry) => entry.amountMinor).sort((a, b) => a - b)).toEqual([-200, 200]);
});
it("rejects non-Neon hosts without making a connection", () => {
  expect(() => createDb("postgresql://unused:unused@neon.tech.invalid/db")).toThrow("Neon");
});
