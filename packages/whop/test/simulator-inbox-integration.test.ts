// Verifies the simulator's own signed webhook deliveries are exactly what the real inbox
// service (packages/core/src/services/inbox.ts) accepts and posts to the ledger — not a
// second, hand-rolled envelope shape that only looks right. Runs against a real PGlite
// database through the same createPgliteUnitOfWork the app uses in production, mirroring the
// wiring convention already established in packages/db/test/services/services.test.ts (which
// imports whop's source the same way, in the opposite direction).
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createInboxService, type Result, runId, sellerId } from "@ledgerly/core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createPgliteUnitOfWork } from "../../db/src/repos/unit-of-work";
import { decodeEnvelope } from "../src/envelope";
import { createSimulatorAdapter } from "../src/simulator";
import { verifyStandardWebhook } from "../src/webhooks";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const secret = "ws_integration_secret";
const now = new Date("2026-09-08T12:00:00Z");
const clock = { now: () => now };
const decoder = { decodeEnvelope, verifyStandardWebhook };
let client: PGlite;
let uow: ReturnType<typeof createPgliteUnitOfWork>;
let sequence = 0;

const migrationsFolder = fileURLToPath(new URL("../../db/drizzle/", import.meta.url));
beforeAll(async () => {
  client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder });
  uow = createPgliteUnitOfWork(client);
}, 30000);
afterAll(async () => {
  await client?.close();
});
beforeEach(async () => {
  await client.exec(
    "TRUNCATE ledger_entries,business_effects,webhook_inbox,operations,orders,sellers RESTART IDENTITY",
  );
});

it("posts a signed transfer.completed delivery from the simulator through the real inbox service", async () => {
  const deliveries: { rawBody: string; headers: Record<string, string> }[] = [];
  const sim = createSimulatorAdapter({
    webhookSecret: secret,
    now: () => now,
    deliver: (delivery) => void deliveries.push(delivery),
  });
  const platform = value(
    await sim.createAccount(
      {
        externalId: "platform",
        runId: "run_sim_inbox",
        email: "platform@example.invalid",
        country: "US",
        title: "Platform",
      },
      "create-platform",
    ),
  ).id;
  const destination = value(
    await sim.createAccount(
      {
        externalId: "alice",
        runId: "run_sim_inbox",
        email: "alice@example.invalid",
        country: "US",
        title: "Alice",
      },
      "create-alice",
    ),
  ).id;
  // Attach the seller fixture to the exact account id the simulator just minted for it, so the
  // inbox service's seller-by-account lookup resolves the transfer to this seller.
  const seller = await uow.run((r) =>
    r.sellers.createOrFetch(
      {
        runId: value(runId("run_sim_inbox")),
        externalId: "alice",
        email: "alice@example.invalid",
        country: "US",
      },
      value(sellerId(`seller_${++sequence}`)),
    ),
  );
  await uow.run((r) => r.sellers.attach(seller.id, destination));

  sim.seedBalance(platform, { amountMinor: 10_000, currency: "USD" });
  const transfer = value(
    await sim.createTransfer(
      {
        originId: platform,
        destinationId: destination,
        amount: { amountMinor: 2500, currency: "USD" },
        metadata: {},
      },
      "inbox-tick-key",
    ),
  );
  await sim.tick();
  expect(deliveries).toHaveLength(1);
  const delivery = deliveries[0];
  if (!delivery) throw new Error("Expected a delivery");

  const inbox = createInboxService({ uow, clock, decoder, provenance: "mock" });
  const received = await inbox.receiveWebhook({
    rawBody: delivery.rawBody,
    headers: delivery.headers as {
      "webhook-id": string;
      "webhook-timestamp": string;
      "webhook-signature": string;
    },
    secret,
    now,
  });
  if (!received.ok) throw new Error(JSON.stringify(received.error));
  expect(received.value.decoded).toBe(true);

  const processed = await inbox.processInbox({ limit: 10 });
  expect(processed).toMatchObject({ processed: 1, effects: 1, quarantined: 0 });

  const ledger = await uow.run((r) => r.ledger.forSeller(seller.id));
  expect(ledger).toHaveLength(2);
  const sellerEntry = ledger.find((entry) => entry.accountSide === "seller");
  const platformEntry = ledger.find((entry) => entry.accountSide === "platform");
  expect(sellerEntry).toMatchObject({
    amount: { amountMinor: 2500, currency: "USD" },
    kind: "transfer",
    resourceId: transfer.id,
  });
  expect(platformEntry).toMatchObject({
    amount: { amountMinor: -2500, currency: "USD" },
    kind: "transfer",
  });
});
