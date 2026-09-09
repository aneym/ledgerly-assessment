import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  type HttpServices,
  handleSweep,
  handleWebhook,
} from "../../../../apps/web/src/lib/service-http";
import { runId, sellerId, whopAccountId } from "../../../core/src/ids";
import { createInboxService } from "../../../core/src/services/inbox";
import { decodeEnvelope } from "../../../whop/src/envelope";
import { signStandardWebhook, verifyStandardWebhook } from "../../../whop/src/webhooks";
import { createTestDb } from "../../src/client";
import { createPgliteUnitOfWork } from "../../src/repos/unit-of-work";

let db: Awaited<ReturnType<typeof createTestDb>>;
let services: HttpServices;
const secret = "http-fixture-only";
const deferred: (() => Promise<void>)[] = [];
beforeAll(async () => {
  db = await createTestDb();
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});
beforeEach(async () => {
  await db.$client.exec(
    "TRUNCATE ledger_entries,business_effects,webhook_inbox,operations,orders,sellers",
  );
  deferred.length = 0;
  const uow = createPgliteUnitOfWork(db.$client);
  const id = sellerId("seller_http");
  const run = runId("run_http");
  const account = whopAccountId("biz_http");
  if (!id.ok || !run.ok || !account.ok) throw new Error("Invalid fixture");
  await uow.run(async (r) => {
    await r.sellers.createOrFetch(
      { runId: run.value, externalId: "http", email: "http@example.invalid", country: "US" },
      id.value,
    );
    await r.sellers.attach(id.value, account.value);
  });
  services = {
    ...createInboxService({
      platformAccountId: "biz_platform",
      uow,
      clock: { now: () => new Date() },
      decoder: { decodeEnvelope, verifyStandardWebhook },
      provenance: "sandbox",
    }),
    webhookSecret: () => secret,
    async reconcileBounded() {
      return { status: "provider_reads_unavailable", sellers: 0 };
    },
    // This fixture never seeds a platform_transfer order, so there is never anything
    // eligible to release; a real deploy's services() wires packages/core/src/services/
    // transfers.ts's createTransferReleaseService here instead.
    async releaseTransfers() {
      return { released: 0, retried: 0, failed: 0 };
    },
  };
});
function request(id = "msg_http", tamper = false) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = `{ "id":"${id}","type":"payment.succeeded","api_version":"v1","api_version_date":"2026-08-21","timestamp":"2026-09-08T12:00:00Z","account_id":"biz_http","data":{"id":"pay_http","amount_minor":"2500","currency":"usd"}}`;
  return new Request("https://example.invalid/api/whop/webhook", {
    method: "POST",
    body: tamper ? `${rawBody} ` : rawBody,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signStandardWebhook({ rawBody, id, timestamp, secret }),
    },
  });
}
// Signed correctly but missing the envelope's required `id` field — the shape Whop's dashboard
// "send test event" delivers, which the decoder rejects even though the signature is valid.
function requestUndecodable(id = "msg_http_undecodable") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = `{ "type":"payment.succeeded","api_version":"v1","api_version_date":"2026-08-21","timestamp":"2026-09-08T12:00:00Z","account_id":"biz_http","data":{"id":"pay_http","amount_minor":"2500","currency":"usd"}}`;
  return new Request("https://example.invalid/api/whop/webhook", {
    method: "POST",
    body: rawBody,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signStandardWebhook({ rawBody, id, timestamp, secret }),
    },
  });
}
it("webhook HTTP returns 200 after durable receipt and defers ledger processing", async () => {
  const response = await handleWebhook(request(), services, (work) => {
    deferred.push(work);
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ received: true, duplicate: false });
  expect((await db.$client.query("SELECT status FROM webhook_inbox")).rows).toEqual([
    { status: "received" },
  ]);
  expect((await db.$client.query("SELECT * FROM ledger_entries")).rows).toHaveLength(0);
  expect(deferred).toHaveLength(1);
  await deferred[0]?.();
  expect((await db.$client.query("SELECT * FROM ledger_entries")).rows).toHaveLength(2);
});
it("webhook HTTP returns 401 for tampered raw bytes", async () => {
  expect(
    (
      await handleWebhook(request("bad", true), services, (work) => {
        deferred.push(work);
      })
    ).status,
  ).toBe(401);
  expect(deferred).toHaveLength(0);
  expect((await db.$client.query("SELECT * FROM webhook_inbox")).rows).toHaveLength(0);
});
it("webhook HTTP returns 200 with decoded:false for a signed but undecodable body", async () => {
  const response = await handleWebhook(requestUndecodable(), services, (work) => {
    deferred.push(work);
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ received: true, duplicate: false, decoded: false });
  expect((await db.$client.query("SELECT status FROM webhook_inbox")).rows).toEqual([
    { status: "failed" },
  ]);
  expect(deferred).toHaveLength(0);
});
it("duplicate HTTP deliveries return 200 without scheduling another processor", async () => {
  await handleWebhook(request(), services, (work) => {
    deferred.push(work);
  });
  const response = await handleWebhook(request(), services, (work) => {
    deferred.push(work);
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ received: true, duplicate: true });
  expect(deferred).toHaveLength(1);
});
it("cron rejects missing or wrong authorization before creating services", async () => {
  const never = () => {
    throw new Error("Unauthorized request reached services");
  };
  expect(
    (await handleSweep(new Request("https://example.invalid/cron"), secret, never)).status,
  ).toBe(401);
  expect(
    (
      await handleSweep(
        new Request("https://example.invalid/cron", { headers: { authorization: "Bearer wrong" } }),
        secret,
        never,
      )
    ).status,
  ).toBe(401);
});
it("an unconfigured cron secret cannot accidentally authorize a request", async () => {
  expect(
    (
      await handleSweep(
        new Request("https://example.invalid/cron", {
          headers: { authorization: "Bearer undefined" },
        }),
        undefined,
        () => services,
      )
    ).status,
  ).toBe(503);
});
it("cron sweeps durable receipt even if the after callback never ran", async () => {
  await handleWebhook(request(), services, () => {});
  const response = await handleSweep(
    new Request("https://example.invalid/cron", { headers: { authorization: `Bearer ${secret}` } }),
    secret,
    () => services,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    inbox: { effects: 1, processed: 1 },
    reconciliation: { status: "provider_reads_unavailable" },
  });
  expect((await db.$client.query("SELECT * FROM ledger_entries")).rows).toHaveLength(2);
});
