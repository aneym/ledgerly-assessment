import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { deliveryId, runId, sellerId, whopAccountId } from "../../../core/src/ids";
import { ok, type Result } from "../../../core/src/result";
import { createInboxService } from "../../../core/src/services/inbox";
import { createOnboardingService } from "../../../core/src/services/onboarding";
import type {
  AccountLookup,
  InboxOrdersRepo,
  ProviderPage,
  ProviderRecord,
  ReconciliationProvider,
  UnitOfWork,
  WhopPort,
} from "../../../core/src/services/ports";
import { createReconciliationService } from "../../../core/src/services/reconciliation";
import { decodeEnvelope } from "../../../whop/src/envelope";
import { createMockAdapter } from "../../../whop/src/mock-adapter";
import { signStandardWebhook, verifyStandardWebhook } from "../../../whop/src/webhooks";
import { createOrdersRepo } from "../../src/repos/orders";
import { createPgliteUnitOfWork } from "../../src/repos/unit-of-work";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}
const now = new Date("2026-09-08T12:00:00Z");
const clock = { now: () => now };
const run = value(runId("run_services"));
const input = {
  runId: run,
  externalId: "alice",
  email: "alice@example.invalid",
  country: "US" as const,
};
const decoder = { decodeEnvelope, verifyStandardWebhook };
const secret = "test-only-secret";
let client: PGlite;
let uow: UnitOfWork;
let sequence = 0;
const ids = { seller: () => value(sellerId(`seller_${++sequence}`)) };
const options = {
  clock,
  ids,
  apiVersionDate: "2026-08-21",
  returnUrl: "https://example.invalid/return",
  refreshUrl: "https://example.invalid/refresh",
};
const migrationsFolder = fileURLToPath(new URL("../../drizzle/", import.meta.url));
async function database(path?: string) {
  const db = new PGlite(path);
  await migrate(drizzle(db), { migrationsFolder });
  return db;
}
beforeAll(async () => {
  client = await database();
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
async function connected(externalId = "alice") {
  const seller = await uow.run((r) =>
    r.sellers.createOrFetch({ ...input, externalId }, ids.seller()),
  );
  const account = value(whopAccountId(`biz_${externalId}`));
  await uow.run((r) => r.sellers.attach(seller.id, account));
  return { ...seller, whopAccountId: account };
}
function signed(
  id = "msg_1",
  type = "payment.succeeded",
  data: Record<string, unknown> = {},
  account = "biz_alice",
  date = "2026-08-21",
) {
  const timestamp = String(now.getTime() / 1000);
  const rawBody = JSON.stringify({
    id,
    type,
    api_version: "v1",
    api_version_date: date,
    timestamp: now.toISOString(),
    [date >= "2026-08-14" ? "account_id" : "company_id"]: account,
    data: { id: "pay_1", amount_minor: "2500", currency: "usd", ...data },
  });
  return {
    rawBody,
    secret,
    now,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signStandardWebhook({ rawBody, id, timestamp, secret }),
    },
  };
}
// A signed delivery whose body is missing the required `id` field, so the signature verifies
// but the envelope fails to decode — the shape Whop's dashboard "send test event" produces.
function signedUndecodable(id = "msg_undecodable") {
  const timestamp = String(now.getTime() / 1000);
  const rawBody = JSON.stringify({
    type: "payment.succeeded",
    api_version: "v1",
    api_version_date: "2026-08-21",
    timestamp: now.toISOString(),
    account_id: "biz_alice",
    data: { id: "pay_1", amount_minor: "2500", currency: "usd" },
  });
  return {
    rawBody,
    secret,
    now,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signStandardWebhook({ rawBody, id, timestamp, secret }),
    },
  };
}
const inbox = (provenance: "sandbox" | "mock" = "sandbox") =>
  createInboxService({ uow, clock, decoder, provenance, platformAccountId: "biz_platform" });
async function rows(
  table:
    | "ledger_entries"
    | "business_effects"
    | "webhook_inbox"
    | "operations"
    | "sellers"
    | "orders",
) {
  return (await client.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows;
}

it("creates the local seller before the account and persists the exact operation", async () => {
  const mock = createMockAdapter();
  let calls = 0;
  const provider = {
    ...mock,
    async createOrFetchAccount(
      request: Parameters<WhopPort["createOrFetchAccount"]>[0],
      key: string,
    ) {
      calls++;
      expect(key).toBe("onboard:run_services:alice");
      return mock.createOrFetchAccount(request, key);
    },
  };
  const onboard = createOnboardingService({ ...options, uow, provider });
  const result = value(await onboard(input));
  expect(result.seller.whopAccountId).toBeTruthy();
  expect(result.onboardingUrl).toContain("onboarding/");
  expect(await rows("operations")).toMatchObject([
    {
      status: "succeeded",
      request: {
        externalId: "run_services:alice",
        email: input.email,
        country: "US",
        title: "alice",
      },
    },
  ]);
  expect(value(await onboard(input)).seller.id).toBe(result.seller.id);
  expect(calls).toBe(1);
});
it("two simultaneous onboarding calls create one account and one operation", async () => {
  const mock = createMockAdapter();
  let calls = 0;
  const provider = {
    ...mock,
    async createOrFetchAccount(
      request: Parameters<WhopPort["createOrFetchAccount"]>[0],
      key: string,
    ) {
      calls++;
      return mock.createOrFetchAccount(request, key);
    },
  };
  const onboard = createOnboardingService({ ...options, uow, provider });
  const concurrent = createOnboardingService({
    ...options,
    uow: createPgliteUnitOfWork(client),
    provider,
  });
  const results = await Promise.all([onboard(input), concurrent(input)]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(value(results[0] ?? { ok: false, error: null }).seller).toEqual(
    value(results[1] ?? { ok: false, error: null }).seller,
  );
  expect(calls).toBe(1);
  expect(await rows("operations")).toHaveLength(1);
  expect(await rows("sellers")).toHaveLength(1);
});
it("rejects conflicting seller attributes without another provider call", async () => {
  const onboard = createOnboardingService({ ...options, uow, provider: createMockAdapter() });
  value(await onboard(input));
  expect(await onboard({ ...input, country: "DE" })).toEqual({
    ok: false,
    error: { kind: "identity_conflict" },
  });
});
it("separates external identities across runs", async () => {
  const onboard = createOnboardingService({ ...options, uow, provider: createMockAdapter() });
  const first = value(await onboard(input));
  const second = value(
    await onboard({
      ...input,
      runId: value(runId("run_two")),
      email: "alice-second-run@example.invalid",
    }),
  );
  expect(first.seller.whopAccountId).not.toBe(second.seller.whopAccountId);
});
it("persists a pending operation through a fresh disk-backed client and reads before retry", async () => {
  const path = await mkdtemp(join(tmpdir(), "ledgerly-restart-"));
  let disk: PGlite | undefined;
  try {
    disk = await database(path);
    const mock = createMockAdapter();
    const crash = {
      ...mock,
      async createOrFetchAccount(): Promise<never> {
        throw new Error("simulated crash after durable operation");
      },
    };
    await expect(
      createOnboardingService({ ...options, uow: createPgliteUnitOfWork(disk), provider: crash })(
        input,
      ),
    ).rejects.toThrow("simulated crash");
    await disk.close();
    disk = await database(path);
    expect((await disk.query("SELECT status FROM operations")).rows).toEqual([
      { status: "pending" },
    ]);
    const calls: string[] = [];
    const lookup: AccountLookup = {
      async findAccount(_request, key) {
        calls.push(`read:${key}`);
        return ok(null);
      },
    };
    const provider = {
      ...mock,
      async createOrFetchAccount(
        request: Parameters<WhopPort["createOrFetchAccount"]>[0],
        key: string,
      ) {
        calls.push(`create:${key}`);
        return mock.createOrFetchAccount(request, key);
      },
    };
    const result = await createOnboardingService({
      ...options,
      uow: createPgliteUnitOfWork(disk),
      provider,
      lookup,
    })(input);
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["read:onboard:run_services:alice", "create:onboard:run_services:alice"]);
    expect((await disk.query("SELECT * FROM operations")).rows).toHaveLength(1);
  } finally {
    await disk?.close();
    await rm(path, { recursive: true, force: true });
  }
}, 30000);
it("recovers a provider success lost before local commit without creating again", async () => {
  const mock = createMockAdapter();
  let account: Awaited<ReturnType<WhopPort["createOrFetchAccount"]>> | undefined;
  const crash = {
    ...mock,
    async createOrFetchAccount(
      request: Parameters<WhopPort["createOrFetchAccount"]>[0],
      key: string,
    ): Promise<never> {
      account = await mock.createOrFetchAccount(request, key);
      throw new Error("lost outcome");
    },
  };
  await expect(
    createOnboardingService({ ...options, uow, provider: crash })(input),
  ).rejects.toThrow("lost outcome");
  const lookup: AccountLookup = {
    async findAccount() {
      if (!account) throw new Error("Missing fixture account");
      return account;
    },
  };
  const result = await createOnboardingService({ ...options, uow, provider: crash, lookup })(input);
  expect(result.ok).toBe(true);
});
it("does not blindly recreate an unknown account without a read lookup", async () => {
  const provider = {
    ...createMockAdapter(),
    async createOrFetchAccount(): Promise<never> {
      throw new Error("unknown");
    },
  };
  const onboard = createOnboardingService({ ...options, uow, provider });
  await expect(onboard(input)).rejects.toThrow("unknown");
  expect(await onboard(input)).toEqual({ ok: false, error: { kind: "reconciliation_required" } });
});
it("rejects a tampered signature without persisting an inbox row", async () => {
  const request = signed();
  expect(
    await inbox().receiveWebhook({ ...request, rawBody: `${request.rawBody} ` }),
  ).toMatchObject({ ok: false, error: { kind: "signature" } });
  expect(await rows("webhook_inbox")).toHaveLength(0);
});
it("rejects stale signed timestamps before persistence", async () => {
  expect(
    await inbox().receiveWebhook({ ...signed(), now: new Date(now.getTime() + 301000) }),
  ).toMatchObject({ ok: false, error: { reason: "stale_timestamp" } });
  expect(await rows("webhook_inbox")).toHaveLength(0);
});
it("quarantines an unknown seller without any effect", async () => {
  const result = value(await inbox().receiveWebhook(signed()));
  expect(result.row.status).toBe("quarantined");
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ effects: 0 });
  expect(await rows("ledger_entries")).toHaveLength(0);
});
it("persists receipt before processing and credits the literal 2300 and 200 allocation", async () => {
  await connected();
  const request = signed();
  expect(value(await inbox().receiveWebhook(request)).decoded).toBe(true);
  expect(await rows("ledger_entries")).toHaveLength(0);
  expect(await rows("webhook_inbox")).toMatchObject([
    { raw_body: request.rawBody, status: "received" },
  ]);
  expect(JSON.stringify(await rows("webhook_inbox"))).not.toContain(
    request.headers["webhook-signature"],
  );
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ effects: 1, processed: 1 });
  expect(await rows("ledger_entries")).toMatchObject([
    { account_side: "seller", amount_minor: 2300 },
    { account_side: "platform", amount_minor: 200 },
  ]);
});
it("duplicate delivery IDs return duplicate without effects", async () => {
  await connected();
  value(await inbox().receiveWebhook(signed()));
  expect(value(await inbox().receiveWebhook(signed())).duplicate).toBe(true);
  await inbox().processInbox({ limit: 20 });
  expect(await rows("business_effects")).toHaveLength(1);
});
it("regenerated delivery IDs do not duplicate a business effect", async () => {
  await connected();
  value(await inbox().receiveWebhook(signed("first")));
  value(await inbox().receiveWebhook(signed("replayed")));
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ processed: 2, effects: 1 });
  expect(await rows("ledger_entries")).toHaveLength(2);
});
it("stores a signed but undecodable delivery as failed, recording the issue paths", async () => {
  const request = signedUndecodable();
  const result = value(await inbox().receiveWebhook(request));
  expect(result.decoded).toBe(false);
  expect(result.duplicate).toBe(false);
  expect(result.row.status).toBe("failed");
  const stored = (await rows("webhook_inbox")) as { error: string }[];
  expect(stored).toMatchObject([
    { status: "failed", raw_body: request.rawBody, event_type: "payment.succeeded" },
  ]);
  expect(stored[0]?.error).toContain("id");
  expect(stored[0]?.error).not.toContain("biz_alice");
  expect(await rows("ledger_entries")).toHaveLength(0);
});
it("processInbox skips a failed delivery without reprocessing or overwriting its error", async () => {
  await connected();
  value(await inbox().receiveWebhook(signedUndecodable()));
  const before = await rows("webhook_inbox");
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ skipped: 1, processed: 0 });
  expect(await rows("webhook_inbox")).toEqual(before);
});
it("a duplicate of a failed delivery returns duplicate:true without re-marking it", async () => {
  const request = signedUndecodable("dup_failed");
  value(await inbox().receiveWebhook(request));
  const second = value(await inbox().receiveWebhook(request));
  expect(second.duplicate).toBe(true);
  expect(second.decoded).toBe(false);
  expect(await rows("webhook_inbox")).toHaveLength(1);
});
it("withdrawal.updated and payout.updated collapse to one effect", async () => {
  await connected();
  value(
    await inbox().receiveWebhook(
      signed("first", "withdrawal.updated", { id: "po_1", status: "completed" }),
    ),
  );
  value(
    await inbox().receiveWebhook(
      signed("replay", "payout.updated", { id: "po_1", status: "completed" }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  expect(await rows("business_effects")).toMatchObject([{ effect_key: "payout:po_1:completed" }]);
  expect(await rows("ledger_entries")).toMatchObject([
    { kind: "payout_completed", amount_minor: -2500 },
  ]);
});
it("payout pending and completion are separate effects", async () => {
  await connected();
  value(
    await inbox().receiveWebhook(signed("a", "payout.created", { id: "po_1", status: "pending" })),
  );
  await inbox().processInbox({ limit: 20 });
  value(
    await inbox().receiveWebhook(
      signed("b", "payout.updated", { id: "po_1", status: "completed" }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  expect(await rows("ledger_entries")).toMatchObject([
    { kind: "payout_pending", amount_minor: 0 },
    { kind: "payout_completed", amount_minor: -2500 },
  ]);
});
it("completed before pending cannot restore a payout balance", async () => {
  await connected();
  value(
    await inbox().receiveWebhook(
      signed("a", "payout.updated", { id: "po_1", status: "completed" }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  value(
    await inbox().receiveWebhook(signed("b", "payout.created", { id: "po_1", status: "pending" })),
  );
  await inbox().processInbox({ limit: 20 });
  expect(
    (await client.query("SELECT sum(amount_minor)::int AS balance FROM ledger_entries")).rows,
  ).toEqual([{ balance: -2500 }]);
  expect(await rows("business_effects")).toHaveLength(2);
});
it("current payout vocabulary is accepted and only completed moves the balance", async () => {
  await connected();
  value(
    await inbox().receiveWebhook(
      signed("a", "payout.created", { id: "po_1", status: "requested" }),
    ),
  );
  value(
    await inbox().receiveWebhook(
      signed("b", "payout.updated", { id: "po_1", status: "in_review" }),
    ),
  );
  value(
    await inbox().receiveWebhook(
      signed("c", "payout.updated", { id: "po_1", status: "processing" }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  expect(await rows("ledger_entries")).toMatchObject([
    { kind: "payout_requested", amount_minor: 0 },
    { kind: "payout_in_review", amount_minor: 0 },
    { kind: "payout_processing", amount_minor: 0 },
  ]);
  value(
    await inbox().receiveWebhook(
      signed("d", "payout.updated", { id: "po_1", status: "completed" }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  expect(await rows("ledger_entries")).toMatchObject([
    { kind: "payout_requested", amount_minor: 0 },
    { kind: "payout_in_review", amount_minor: 0 },
    { kind: "payout_processing", amount_minor: 0 },
    { kind: "payout_completed", amount_minor: -2500 },
  ]);
});
it("denied and reversed payout statuses are accepted without moving the balance", async () => {
  await connected();
  value(
    await inbox().receiveWebhook(signed("a", "payout.updated", { id: "po_1", status: "denied" })),
  );
  value(
    await inbox().receiveWebhook(signed("b", "payout.updated", { id: "po_2", status: "reversed" })),
  );
  const processed = await inbox().processInbox({ limit: 20 });
  expect(processed).toMatchObject({ processed: 2, effects: 2, quarantined: 0 });
  expect(await rows("ledger_entries")).toMatchObject([
    { kind: "payout_denied", amount_minor: 0 },
    { kind: "payout_reversed", amount_minor: 0 },
  ]);
});
it("June company_id payout payloads retain their version and exact decimal amount", async () => {
  await connected();
  value(
    await inbox().receiveWebhook(
      signed(
        "june",
        "withdrawal.updated",
        { id: "po_1", status: "completed", amount: 1240, currency: "eur" },
        "biz_alice",
        "2026-06-01",
      ),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  expect(await rows("ledger_entries")).toMatchObject([{ currency: "EUR", amount_minor: -124000 }]);
});
it("refunds reverse both shares without editing the original entries", async () => {
  await connected();
  value(await inbox().receiveWebhook(signed("payment")));
  await inbox().processInbox({ limit: 20 });
  const before = await rows("ledger_entries");
  value(
    await inbox().receiveWebhook(
      signed("refund", "refund.created", { id: "refund_1", payment_id: "pay_1" }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  const after = await rows("ledger_entries");
  expect(after.slice(0, 2)).toEqual(before);
  expect(after.slice(2)).toMatchObject([{ amount_minor: -2300 }, { amount_minor: -200 }]);
});
it("transfers debit platform and credit the destination seller", async () => {
  await connected();
  value(
    await inbox().receiveWebhook(
      signed("transfer", "transfer.completed", { id: "tsf_1", destination_id: "biz_alice" }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  expect(await rows("ledger_entries")).toMatchObject([
    { account_side: "platform", amount_minor: -2500 },
    { account_side: "seller", amount_minor: 2500 },
  ]);
});
it("payment.succeeded links to the matched order: allocation, payment id, status and provenance", async () => {
  const owner = await connected();
  await client.query(
    "INSERT INTO orders (id,run_id,seller_id,product_title,gross_minor,currency,fee_minor,flow,checkout_configuration_id,status) VALUES ('order_1',$1,$2,'Fixture',5000,'USD',400,'direct','checkout_1','checkout_created')",
    [run, owner.id],
  );
  value(
    await inbox().receiveWebhook(
      signed("order", "payment.succeeded", { checkout_configuration_id: "checkout_1" }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  expect(await rows("ledger_entries")).toMatchObject([
    { amount_minor: 4600 },
    { amount_minor: 400 },
  ]);
  expect(await rows("orders")).toMatchObject([
    { id: "order_1", payment_id: "pay_1", status: "paid", provenance: "sandbox" },
  ]);
  expect(await rows("business_effects")).toMatchObject([{ detail: null }]);
});
it("a mock-provenance inbox stamps orders it settles as mock, not sandbox", async () => {
  const owner = await connected();
  await client.query(
    "INSERT INTO orders (id,run_id,seller_id,product_title,gross_minor,currency,fee_minor,flow,checkout_configuration_id,status) VALUES ('order_mock',$1,$2,'Fixture',5000,'USD',400,'direct','checkout_mock','checkout_created')",
    [run, owner.id],
  );
  value(
    await inbox("mock").receiveWebhook(
      signed("order", "payment.succeeded", { checkout_configuration_id: "checkout_mock" }),
    ),
  );
  await inbox("mock").processInbox({ limit: 20 });
  expect(await rows("orders")).toMatchObject([{ id: "order_mock", provenance: "mock" }]);
});
it("cannot use another seller's order allocation, and records unmatched_order on the effect", async () => {
  await connected();
  const other = await connected("bob");
  await client.query(
    "INSERT INTO orders (id,run_id,seller_id,product_title,gross_minor,currency,fee_minor,flow,status) VALUES ('other_order',$1,$2,'Fixture',5000,'USD',400,'direct','checkout_created')",
    [run, other.id],
  );
  value(
    await inbox().receiveWebhook(
      signed("order", "payment.succeeded", { metadata: { order_id: "other_order" } }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  expect(await rows("ledger_entries")).toMatchObject([
    { amount_minor: 2300 },
    { amount_minor: 200 },
  ]);
  expect(await rows("business_effects")).toMatchObject([{ detail: { unmatched_order: true } }]);
  expect(await rows("orders")).toMatchObject([{ id: "other_order", status: "checkout_created" }]);
});
it("no order at all: unmatched_order is recorded and no orders row is touched", async () => {
  await connected();
  value(await inbox().receiveWebhook(signed()));
  await inbox().processInbox({ limit: 20 });
  expect(await rows("business_effects")).toMatchObject([{ detail: { unmatched_order: true } }]);
  expect(await rows("orders")).toHaveLength(0);
});
it("redelivering the same payment.succeeded event is idempotent: one order update, no duplicate entries", async () => {
  const owner = await connected();
  await client.query(
    "INSERT INTO orders (id,run_id,seller_id,product_title,gross_minor,currency,fee_minor,flow,checkout_configuration_id,status) VALUES ('order_redeliver',$1,$2,'Fixture',5000,'USD',400,'direct','checkout_redeliver','checkout_created')",
    [run, owner.id],
  );
  const request = signed("order", "payment.succeeded", {
    checkout_configuration_id: "checkout_redeliver",
  });
  value(await inbox().receiveWebhook(request));
  value(await inbox().receiveWebhook(request));
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ processed: 1, effects: 1 });
  expect(await rows("ledger_entries")).toHaveLength(2);
  expect(await rows("orders")).toMatchObject([
    { id: "order_redeliver", payment_id: "pay_1", status: "paid", provenance: "sandbox" },
  ]);
  // A distinct delivery for the same business effect must not update the order again.
  value(
    await inbox().receiveWebhook(
      signed("order-redelivered", "payment.succeeded", {
        checkout_configuration_id: "checkout_redeliver",
      }),
    ),
  );
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ processed: 1, effects: 0 });
  expect(await rows("ledger_entries")).toHaveLength(2);
  expect(await rows("orders")).toMatchObject([
    { id: "order_redeliver", payment_id: "pay_1", status: "paid", provenance: "sandbox" },
  ]);
});
it("rolls back the effect and both entries if a ledger write fails, then retries", async () => {
  await connected();
  value(await inbox().receiveWebhook(signed()));
  await client.exec(
    "CREATE FUNCTION reject_platform() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.account_side='platform' THEN RAISE EXCEPTION 'injected ledger failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_platform BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_platform()",
  );
  try {
    await expect(inbox().processInbox({ limit: 20 })).rejects.toThrow("injected ledger failure");
    expect(await rows("business_effects")).toHaveLength(0);
    expect(await rows("ledger_entries")).toHaveLength(0);
    expect(await rows("webhook_inbox")).toMatchObject([{ status: "received" }]);
  } finally {
    await client.exec(
      "DROP TRIGGER reject_platform ON ledger_entries; DROP FUNCTION reject_platform()",
    );
  }
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ effects: 1 });
});
it("concurrent inbox processors commit a single ledger effect", async () => {
  await connected();
  value(await inbox().receiveWebhook(signed("a")));
  value(await inbox().receiveWebhook(signed("b")));
  await Promise.all([inbox().processInbox({ limit: 20 }), inbox().processInbox({ limit: 20 })]);
  expect(await rows("business_effects")).toHaveLength(1);
  expect(await rows("ledger_entries")).toHaveLength(2);
});
it("quarantines malformed financial data instead of posting guessed amounts", async () => {
  await connected();
  value(
    await inbox().receiveWebhook(signed("bad", "payment.succeeded", { amount_minor: "25.00" })),
  );
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ quarantined: 1 });
  expect(await rows("business_effects")).toHaveLength(0);
});
it("reconciles paginated drift without changing any local row", async () => {
  const owner = await connected();
  value(await inbox().receiveWebhook(signed("a")));
  value(await inbox().receiveWebhook(signed("b", "payment.succeeded", { id: "pay_local_only" })));
  await inbox().processInbox({ limit: 20 });
  const before = await rows("ledger_entries");
  const record = (
    id: string,
    amountMinor: number,
    status: ProviderRecord["status"] = "succeeded",
  ): ProviderRecord => ({
    id,
    accountId: owner.whopAccountId,
    amount: { amountMinor, currency: "USD" },
    status,
  });
  const cursors: (string | undefined)[] = [];
  const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
    async listPayments(input) {
      cursors.push(input.cursor);
      return ok<ProviderPage>(
        input.cursor
          ? {
              data: [record("pay_pending", 100, "pending"), record("pay_reserve", 200, "reserve")],
              nextCursor: null,
            }
          : { data: [record("pay_1", 2600), record("pay_remote_only", 500)], nextCursor: "page2" },
      );
    },
    async listTransfers() {
      return ok({ data: [record("tsf_remote", 2300, "completed")], nextCursor: null });
    },
  };
  const report = value(await createReconciliationService(uow)({ sellerId: owner.id, provider }));
  expect(cursors).toEqual([undefined, "page2"]);
  expect(report.missingLocally.map((r) => r.resourceId)).toEqual(["pay_remote_only", "tsf_remote"]);
  expect(report.missingAtProvider.map((r) => r.resourceId)).toEqual(["pay_local_only"]);
  expect(report.amountMismatch).toMatchObject([
    { local: { amount: { amountMinor: 2500 } }, provider: { amount: { amountMinor: 2600 } } },
  ]);
  expect(report.pendingOrReserve.map((r) => r.status)).toEqual(["pending", "reserve"]);
  expect(await rows("ledger_entries")).toEqual(before);
});

it("webhook receipt and business dedupe survive a fresh disk-backed client", async () => {
  const path = await mkdtemp(join(tmpdir(), "ledgerly-inbox-restart-"));
  let disk: PGlite | undefined;
  try {
    disk = await database(path);
    let work = createPgliteUnitOfWork(disk);
    await work.run(async (r) => {
      const owner = await r.sellers.createOrFetch(input, ids.seller());
      await r.sellers.attach(owner.id, value(whopAccountId("biz_alice")));
    });
    value(
      await createInboxService({
        uow: work,
        clock,
        decoder,
        provenance: "sandbox",
        platformAccountId: "biz_platform",
      }).receiveWebhook(signed()),
    );
    await disk.close();
    disk = await database(path);
    work = createPgliteUnitOfWork(disk);
    const restarted = createInboxService({
      uow: work,
      clock,
      decoder,
      provenance: "sandbox",
      platformAccountId: "biz_platform",
    });
    expect(await restarted.processInbox({ limit: 20 })).toMatchObject({ effects: 1 });
    expect(value(await restarted.receiveWebhook(signed())).duplicate).toBe(true);
    value(await restarted.receiveWebhook(signed("regenerated")));
    expect(await restarted.processInbox({ limit: 20 })).toMatchObject({ effects: 0 });
    expect((await disk.query("SELECT * FROM ledger_entries")).rows).toHaveLength(2);
  } finally {
    await disk?.close();
    await rm(path, { recursive: true, force: true });
  }
}, 30000);
it("refund before payment leaves zero net balance after both arrive", async () => {
  await connected();
  value(
    await inbox().receiveWebhook(
      signed("refund", "refund.created", { id: "refund_1", payment_id: "pay_1" }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  value(await inbox().receiveWebhook(signed("payment")));
  await inbox().processInbox({ limit: 20 });
  await inbox().processInbox({ limit: 20 });
  expect(
    (
      await client.query(
        "SELECT account_side,sum(amount_minor)::int AS balance FROM ledger_entries GROUP BY account_side ORDER BY account_side",
      )
    ).rows,
  ).toEqual([
    { account_side: "platform", balance: 0 },
    { account_side: "seller", balance: 0 },
  ]);
});
it("a refund uses the original posted allocation when its payment was matched by checkout", async () => {
  const owner = await connected();
  await client.query(
    "INSERT INTO orders (id,run_id,seller_id,product_title,gross_minor,currency,fee_minor,flow,checkout_configuration_id,status) VALUES ('order_refund',$1,$2,'Fixture',5000,'USD',300,'direct','checkout_refund','paid')",
    [run, owner.id],
  );
  value(
    await inbox().receiveWebhook(
      signed("paid", "payment.succeeded", {
        checkout_configuration_id: "checkout_refund",
        amount_minor: "5000",
      }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  value(
    await inbox().receiveWebhook(
      signed("refunded", "refund.created", {
        id: "refund_1",
        payment_id: "pay_1",
        amount_minor: "5000",
      }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  expect(await rows("ledger_entries")).toMatchObject([
    { amount_minor: 4700 },
    { amount_minor: 300 },
    { amount_minor: -4700 },
    { amount_minor: -300 },
  ]);
  expect(await rows("orders")).toMatchObject([
    { id: "order_refund", payment_id: "pay_1", status: "refunded", provenance: "sandbox" },
  ]);
  expect(await rows("business_effects")).toMatchObject([{ detail: null }, { detail: null }]);
});
it("rejects a partial refund when only full-refund allocation is supported", async () => {
  await connected();
  value(await inbox().receiveWebhook(signed("paid")));
  await inbox().processInbox({ limit: 20 });
  value(
    await inbox().receiveWebhook(
      signed("partial", "refund.created", {
        id: "refund_1",
        payment_id: "pay_1",
        amount_minor: "1000",
      }),
    ),
  );
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ quarantined: 1 });
  expect(await rows("ledger_entries")).toHaveLength(2);
});
it("an account already attached to another local seller is a recorded conflict", async () => {
  const onboard = createOnboardingService({ ...options, uow, provider: createMockAdapter() });
  value(await onboard(input));
  const result = await onboard({ ...input, runId: value(runId("second_run")) });
  expect(result).toEqual({ ok: false, error: { kind: "account_already_mapped" } });
  expect(await rows("operations")).toMatchObject([
    { status: "succeeded" },
    { status: "succeeded" },
  ]);
});
it("onboarding an already connected local seller does not create an operation", async () => {
  const mock = createMockAdapter();
  const account = value(
    await mock.createOrFetchAccount(
      { externalId: input.externalId, email: input.email, country: input.country, title: "Alice" },
      "fixture_account",
    ),
  );
  const seller = await uow.run((r) => r.sellers.createOrFetch(input, ids.seller()));
  await uow.run((r) => r.sellers.attach(seller.id, account.id));
  expect((await createOnboardingService({ ...options, uow, provider: mock })(input)).ok).toBe(true);
  expect(await rows("operations")).toHaveLength(0);
});
it("reconciliation stops pagination cycles and never returns a partial clean report", async () => {
  const owner = await connected();
  const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
    async listPayments() {
      return ok({ data: [], nextCursor: "loop" });
    },
    async listTransfers() {
      return ok({ data: [], nextCursor: null });
    },
  };
  expect(await createReconciliationService(uow)({ sellerId: owner.id, provider })).toEqual({
    ok: false,
    error: { kind: "pagination_cycle" },
  });
});
it("reconciliation stops at its explicit page bound", async () => {
  const owner = await connected();
  let page = 0;
  const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
    async listPayments() {
      return ok({ data: [], nextCursor: `page_${++page}` });
    },
    async listTransfers() {
      return ok({ data: [], nextCursor: null });
    },
  };
  expect(
    await createReconciliationService(uow)({ sellerId: owner.id, provider, maxPages: 2 }),
  ).toEqual({ ok: false, error: { kind: "page_limit" } });
  expect(page).toBe(2);
});
it("reconciliation keeps currencies separate for the same resource ID", async () => {
  const owner = await connected();
  value(await inbox().receiveWebhook(signed()));
  await inbox().processInbox({ limit: 20 });
  const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
    async listPayments() {
      return ok({
        data: [
          {
            id: "pay_1",
            accountId: owner.whopAccountId,
            amount: { amountMinor: 2500, currency: "EUR" },
            status: "succeeded",
          },
        ],
        nextCursor: null,
      });
    },
    async listTransfers() {
      return ok({ data: [], nextCursor: null });
    },
  };
  const report = value(await createReconciliationService(uow)({ sellerId: owner.id, provider }));
  expect(report.missingLocally).toMatchObject([{ amount: { currency: "EUR" } }]);
  expect(report.missingAtProvider).toMatchObject([{ amount: { currency: "USD" } }]);
});

it("persists an unknown provider outcome and reuses its key after authoritative lookup", async () => {
  const mock = createMockAdapter();
  let calls = 0;
  const keys: string[] = [];
  const provider = {
    ...mock,
    async createOrFetchAccount(
      request: Parameters<WhopPort["createOrFetchAccount"]>[0],
      key: string,
    ) {
      keys.push(key);
      if (++calls === 1) return { ok: false as const, error: { kind: "network" as const } };
      return mock.createOrFetchAccount(request, key);
    },
  };
  const lookup: AccountLookup = {
    async findAccount(_request, key) {
      expect(key).toBe("onboard:run_services:alice");
      return ok(null);
    },
  };
  const onboard = createOnboardingService({ ...options, uow, provider, lookup });
  expect(await onboard(input)).toEqual({ ok: false, error: { kind: "network" } });
  expect(await rows("operations")).toMatchObject([{ status: "unknown" }]);
  expect((await onboard(input)).ok).toBe(true);
  expect(keys).toEqual(["onboard:run_services:alice", "onboard:run_services:alice"]);
});
it("reads a stored provider account ID before restoring a missing local mapping", async () => {
  const mock = createMockAdapter();
  const request = {
    externalId: "run_services:alice",
    email: input.email,
    country: input.country,
    title: "alice",
  };
  const account = value(await mock.createOrFetchAccount(request, "fixture_readback"));
  await uow.run(async (r) => {
    await r.sellers.createOrFetch(input, ids.seller());
    await r.operations.createOrFetch({
      key: "onboard:run_services:alice",
      request,
      apiVersionDate: options.apiVersionDate,
      status: "pending",
      providerResourceId: null,
    });
    await r.operations.finish("onboard:run_services:alice", "unknown", account.id, now);
  });
  let reads = 0;
  const provider = {
    ...mock,
    async getAccount(id: Parameters<WhopPort["getAccount"]>[0], key: string) {
      reads++;
      return mock.getAccount(id, key);
    },
    async createOrFetchAccount(): Promise<never> {
      throw new Error("Must read, not create");
    },
  };
  expect((await createOnboardingService({ ...options, uow, provider })(input)).ok).toBe(true);
  expect(reads).toBe(1);
  expect(await rows("operations")).toHaveLength(1);
});

it("resolves platform-only checkout orders through both repositories and settles signed payments once", async () => {
  const seller = await uow.run((r) =>
    r.sellers.createOrFetch({ ...input, externalId: "br", country: "BR" }, ids.seller()),
  );
  await uow.run((r) => r.sellers.attach(seller.id, value(whopAccountId("biz_br"))));
  await client.query(
    "INSERT INTO orders (id,run_id,seller_id,product_title,gross_minor,currency,fee_minor,flow,checkout_configuration_id,status) VALUES ('order_platform',$1,$2,'Fixture',5000,'USD',400,'platform_transfer','ch_platform','checkout_created')",
    [run, seller.id],
  );
  const drizzleOrders = createOrdersRepo(drizzle(client));
  async function assertLookups(repo: InboxOrdersRepo) {
    expect(await repo.byCheckoutConfigurationId("ch_platform")).toMatchObject({
      id: "order_platform",
      sellerId: seller.id,
    });
    expect(await repo.byId("order_platform")).toMatchObject({
      id: "order_platform",
      sellerId: seller.id,
    });
    expect(await repo.byCheckoutConfigurationId("ch_absent")).toBeNull();
    expect(await repo.byId("order_absent")).toBeNull();
  }
  await assertLookups(drizzleOrders);
  await uow.run((r) => assertLookups(r.orders));
  const service = inbox();
  const event = signed(
    "msg_platform",
    "payment.succeeded",
    { id: "pay_platform", checkout_configuration_id: "ch_platform" },
    "biz_platform",
  );
  expect(value(await service.receiveWebhook(event)).row.status).toBe("received");
  expect(await service.processInbox({ limit: 10 })).toMatchObject({ processed: 1, effects: 1 });
  expect(await rows("orders")).toMatchObject([
    { id: "order_platform", status: "paid", payment_id: "pay_platform", provenance: "sandbox" },
  ]);
  expect(await rows("ledger_entries")).toMatchObject([
    { seller_id: seller.id, account_side: "seller", amount_minor: 4600, kind: "payment" },
    { seller_id: seller.id, account_side: "platform", amount_minor: 400, kind: "fee" },
  ]);
  await service.receiveWebhook(
    signed(
      "msg_platform_replay",
      "payment.succeeded",
      { id: "pay_platform", checkout_configuration_id: "ch_platform" },
      "biz_platform",
    ),
  );
  expect(await service.processInbox({ limit: 10 })).toMatchObject({ processed: 1, effects: 0 });
  expect(await rows("ledger_entries")).toHaveLength(2);
});

it("quarantines a signed platform payment without an order", async () => {
  const service = inbox();
  expect(
    value(
      await service.receiveWebhook(
        signed(
          "msg_platform_missing",
          "payment.succeeded",
          { checkout_configuration_id: "ch_absent", metadata: { order_id: "order_absent" } },
          "biz_platform",
        ),
      ),
    ).row.status,
  ).toBe("quarantined");
  expect(await service.processInbox({ limit: 10 })).toMatchObject({ processed: 0, effects: 0 });
  expect(await rows("ledger_entries")).toHaveLength(0);
});

async function paidOrderForStateRegression() {
  const owner = await connected();
  await client.query(
    "INSERT INTO orders (id,run_id,seller_id,product_title,gross_minor,currency,fee_minor,flow,checkout_configuration_id,status) VALUES ('order_state',$1,$2,'Fixture',2500,'USD',200,'direct','checkout_state','checkout_created')",
    [run, owner.id],
  );
  value(
    await inbox().receiveWebhook(
      signed("paid_state", "payment.succeeded", { checkout_configuration_id: "checkout_state" }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  return owner;
}

it("partial refund quarantine leaves the matched order and financial effect unchanged", async () => {
  await paidOrderForStateRegression();
  const before = await rows("orders");
  value(
    await inbox().receiveWebhook(
      signed("partial_state", "refund.created", {
        id: "refund_state",
        payment_id: "pay_1",
        amount_minor: "1000",
      }),
    ),
  );
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ quarantined: 1, effects: 0 });
  expect(await rows("orders")).toEqual(before);
  expect(await rows("ledger_entries")).toHaveLength(2);
  expect(await rows("business_effects")).toHaveLength(1);
});

it("regenerated payment delivery cannot revive a refunded order", async () => {
  await paidOrderForStateRegression();
  value(
    await inbox().receiveWebhook(
      signed("refund_state", "refund.created", { id: "refund_state", payment_id: "pay_1" }),
    ),
  );
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ effects: 1 });
  const before = await rows("orders");
  expect(before).toMatchObject([{ status: "refunded" }]);
  value(
    await inbox().receiveWebhook(
      signed("old_paid_state", "payment.succeeded", {
        checkout_configuration_id: "checkout_state",
      }),
    ),
  );
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ effects: 0 });
  expect(await rows("orders")).toEqual(before);
  expect(await rows("ledger_entries")).toHaveLength(4);
  expect(await rows("business_effects")).toHaveLength(2);
});

it("allocation lookup locks but does not change order state or provenance", async () => {
  const owner = await paidOrderForStateRegression();
  const before = await rows("orders");
  expect(await uow.run((r) => r.ledger.resolveOrder(owner, { paymentId: "pay_1" }))).toEqual({
    matched: true,
    allocation: {
      gross: { amountMinor: 2500, currency: "USD" },
      fee: { amountMinor: 200, currency: "USD" },
    },
  });
  expect(await rows("orders")).toEqual(before);
});

it.each(["order", "inbox"])(
  "rolls back refund order, effect and entries when the %s write fails",
  async (failure) => {
    await paidOrderForStateRegression();
    const before = await rows("orders");
    value(
      await inbox().receiveWebhook(
        signed("refund_atomic", "refund.created", { id: "refund_atomic", payment_id: "pay_1" }),
      ),
    );
    const table = failure === "order" ? "orders" : "webhook_inbox";
    await client.exec(
      `CREATE FUNCTION reject_state_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected state failure'; END $$; CREATE TRIGGER reject_state_write BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_state_write()`,
    );
    try {
      await expect(inbox().processInbox({ limit: 20 })).rejects.toThrow("injected state failure");
      expect(await rows("orders")).toEqual(before);
      expect(await rows("business_effects")).toHaveLength(1);
      expect(await rows("ledger_entries")).toHaveLength(2);
      expect(await uow.run((r) => r.inbox.get(value(deliveryId("refund_atomic"))))).toMatchObject({
        status: "received",
      });
    } finally {
      await client.exec(
        `DROP TRIGGER reject_state_write ON ${table}; DROP FUNCTION reject_state_write()`,
      );
    }
    expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ effects: 1 });
    expect(await rows("orders")).toMatchObject([{ status: "refunded" }]);
    expect(await rows("business_effects")).toHaveLength(2);
    expect(await rows("ledger_entries")).toHaveLength(4);
  },
);

it("concurrent processors converge a refund and regenerated payment deliveries", async () => {
  await paidOrderForStateRegression();
  for (const id of ["old_paid_a", "old_paid_b"])
    value(
      await inbox().receiveWebhook(
        signed(id, "payment.succeeded", { checkout_configuration_id: "checkout_state" }),
      ),
    );
  value(
    await inbox().receiveWebhook(
      signed("refund_concurrent", "refund.created", {
        id: "refund_concurrent",
        payment_id: "pay_1",
      }),
    ),
  );
  await Promise.all([inbox().processInbox({ limit: 20 }), inbox().processInbox({ limit: 20 })]);
  expect(await rows("orders")).toMatchObject([
    { status: "refunded", payment_id: "pay_1", provenance: "sandbox" },
  ]);
  expect(await rows("business_effects")).toHaveLength(2);
  expect(await rows("ledger_entries")).toHaveLength(4);
  expect((await rows("webhook_inbox")).every((row) => row.status === "processed")).toBe(true);
});

it("an order matched by a refund before payment stays refunded when the payment arrives", async () => {
  const owner = await connected();
  await client.query(
    "INSERT INTO orders (id,run_id,seller_id,product_title,gross_minor,currency,fee_minor,flow,checkout_configuration_id,status) VALUES ('order_early_refund',$1,$2,'Fixture',2500,'USD',200,'direct','checkout_early_refund','checkout_created')",
    [run, owner.id],
  );
  value(
    await inbox().receiveWebhook(
      signed("refund_first", "refund.created", {
        id: "refund_first",
        payment_id: "pay_1",
        checkout_configuration_id: "checkout_early_refund",
      }),
    ),
  );
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ effects: 1 });
  const before = await rows("orders");
  expect(before).toMatchObject([{ status: "refunded" }]);
  value(
    await inbox().receiveWebhook(
      signed("paid_late", "payment.succeeded", {
        checkout_configuration_id: "checkout_early_refund",
      }),
    ),
  );
  expect(await inbox("mock").processInbox({ limit: 20 })).toMatchObject({ effects: 1 });
  expect(await rows("orders")).toEqual(before);
  const entries = await uow.run((r) => r.ledger.forSeller(owner.id));
  for (const side of ["platform", "seller"])
    expect(
      entries
        .filter((entry) => entry.accountSide === side)
        .reduce((sum, entry) => sum + entry.amount.amountMinor, 0),
    ).toBe(0);
});

it("a failed older payment replay stays failed after a refund", async () => {
  await paidOrderForStateRegression();
  const replay = signed("failed_old_payment", "payment.succeeded", {
    checkout_configuration_id: "checkout_state",
  });
  value(await inbox().receiveWebhook(replay));
  await uow.run((r) =>
    r.inbox.mark(value(deliveryId("failed_old_payment")), "failed", now, "operator-held"),
  );
  value(
    await inbox().receiveWebhook(
      signed("refund_after_failed", "refund.created", {
        id: "refund_after_failed",
        payment_id: "pay_1",
      }),
    ),
  );
  await inbox().processInbox({ limit: 20 });
  const before = await rows("orders");
  expect(before).toMatchObject([{ status: "refunded" }]);
  expect(value(await inbox().receiveWebhook(replay))).toMatchObject({
    duplicate: true,
    row: { status: "failed" },
  });
  expect(await inbox().processInbox({ limit: 20 })).toMatchObject({ processed: 0, effects: 0 });
  expect(await rows("orders")).toEqual(before);
  expect(
    (await rows("webhook_inbox")).find((row) => row.delivery_id === "failed_old_payment"),
  ).toMatchObject({ status: "failed", error: "operator-held" });
});
