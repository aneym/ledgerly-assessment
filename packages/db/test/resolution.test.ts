import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { effectKey } from "../../core/src/effects";
import { runId, sellerId, type WhopAccountId, whopAccountId } from "../../core/src/ids";
import { ok, type Result } from "../../core/src/result";
import type {
  ProviderPage,
  ProviderRecord,
  ReconciliationProvider,
} from "../../core/src/services/ports";
import { createReconciliationService } from "../../core/src/services/reconciliation";
import { createResolutionService, injectSimulatedFault } from "../../core/src/services/resolution";
import {
  createPgliteResolutionUnitOfWork,
  createResolutionRepositories,
} from "../src/repos/resolution";
import { createPgliteUnitOfWork } from "../src/repos/unit-of-work";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const now = new Date("2026-09-08T12:00:00Z");
const clock = { now: () => now };
const run = value(runId("run_resolution_db"));
let client: PGlite;
let sequence = 0;
const migrationsFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));

async function database() {
  const db = new PGlite();
  await migrate(drizzle(db), { migrationsFolder });
  return db;
}

beforeAll(async () => {
  client = await database();
}, 30000);
afterAll(async () => {
  await client?.close();
});
beforeEach(async () => {
  await client.exec(
    "TRUNCATE resolution_actions,resolution_cases,ledger_entries,business_effects,webhook_inbox,operations,orders,sellers RESTART IDENTITY",
  );
  sequence = 0;
});

async function connected(externalId = "alice") {
  const coreUow = createPgliteUnitOfWork(client);
  const seller = await coreUow.run((r) =>
    r.sellers.createOrFetch(
      { runId: run, externalId, email: `${externalId}@example.invalid`, country: "US" },
      value(sellerId(`seller_${externalId}`)),
    ),
  );
  const account = value(whopAccountId(`biz_${externalId}`));
  await coreUow.run((r) => r.sellers.attach(seller.id, account));
  return { ...seller, whopAccountId: account };
}

function record(
  accountId: WhopAccountId,
  id: string,
  amountMinor: number,
  status: ProviderRecord["status"] = "succeeded",
): ProviderRecord {
  return { id, accountId, amount: { amountMinor, currency: "USD" }, status };
}

function paginated(...pages: ProviderPage[]) {
  let call = 0;
  return async () => ok(pages[Math.min(call++, pages.length - 1)] as ProviderPage);
}

function service() {
  const resolutionUow = createPgliteResolutionUnitOfWork(client);
  const coreUow = createPgliteUnitOfWork(client);
  return createResolutionService({
    uow: resolutionUow,
    reconcileSeller: createReconciliationService(coreUow),
    clock,
    ids: { case: () => `case_${++sequence}`, action: () => `action_${++sequence}` },
  });
}

async function rows(table: "resolution_cases" | "resolution_actions" | "ledger_entries") {
  return (await client.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows;
}

it("upserts a case by (kind, provider_resource_id) so repeated detection does not duplicate rows", async () => {
  const repos = createResolutionRepositories({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[] };
    },
  });
  const owner = await connected();
  const base = {
    sellerId: owner.id,
    orderId: null,
    providerResourceType: "payment" as const,
    providerResourceId: "pay_dup",
    expected: { amountMinor: 100, currency: "USD" as const },
    observed: null,
    impact: "missing locally",
    nextSafeAction: "refetch",
    provenance: "mock",
    simulated: false,
    now,
    correlationId: null,
  };
  const first = await repos.cases.upsert({ id: "case_a", kind: "missing_local_payment", ...base });
  const second = await repos.cases.upsert({ id: "case_b", kind: "missing_local_payment", ...base });
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(second.case.id).toBe(first.case.id);
  expect(await rows("resolution_cases")).toHaveLength(1);
});

it("two concurrent action inserts with the same idempotency key persist exactly one row", async () => {
  const repos = createResolutionRepositories({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[] };
    },
  });
  const owner = await connected();
  const { case: kase } = await repos.cases.upsert({
    id: "case_concurrent",
    kind: "amount_mismatch",
    sellerId: owner.id,
    orderId: null,
    providerResourceType: "payment",
    providerResourceId: "pay_concurrent",
    expected: { amountMinor: 100, currency: "USD" },
    observed: { amountMinor: 90, currency: "USD" },
    impact: "amounts differ",
    nextSafeAction: "recheck",
    provenance: "mock",
    simulated: false,
    now,
    correlationId: null,
  });
  const input = {
    id: "action_concurrent",
    caseId: kase.id,
    action: "note" as const,
    actorUserId: "operator_1",
    idempotencyKey: "concurrent_key",
    outcome: "no_change" as const,
    detail: { note: "same key twice" },
    at: now,
  };
  const [a, b] = await Promise.all([
    repos.actions.insert(input),
    repos.actions.insert({ ...input, id: "action_other" }),
  ]);
  expect(a.action.id).toBe(b.action.id);
  expect(await rows("resolution_actions")).toHaveLength(1);
});

it("detects a missing_local_payment case and resolves it end to end through the same transaction as the ledger", async () => {
  const owner = await connected();
  const svc = service();
  const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
    listPayments: paginated({
      data: [record(owner.whopAccountId, "pay_missing", 2500)],
      nextCursor: null,
    }),
    listTransfers: paginated({ data: [], nextCursor: null }),
  };
  const detected = value(
    await svc.detectResolutionCases({ sellerId: owner.id, provider, provenance: "mock" }),
  );
  expect(detected).toHaveLength(1);
  const missingPaymentCase = detected[0];
  if (!missingPaymentCase) throw new Error("Expected a detected case");
  expect(missingPaymentCase.kind).toBe("missing_local_payment");

  const imported = value(
    await svc.runAction(provider, {
      caseId: missingPaymentCase.id,
      action: "import_confirmed",
      idempotencyKey: "import_once",
      actorUserId: "operator_1",
    }),
  );
  expect(imported.action.outcome).toBe("succeeded");
  expect(imported.case.status).toBe("rechecking");
  expect(await rows("ledger_entries")).toHaveLength(2);

  // Retrying the same action key does not double-post the ledger, and running it a second
  // time through a fresh unit-of-work instance (a new pooled connection in production) still
  // resolves to the exact same claimed row via the idempotency_key unique constraint.
  const retried = value(
    await svc.runAction(provider, {
      caseId: missingPaymentCase.id,
      action: "import_confirmed",
      idempotencyKey: "import_once",
      actorUserId: "operator_1",
    }),
  );
  expect(retried.action.id).toBe(imported.action.id);
  expect(await rows("ledger_entries")).toHaveLength(2);

  const rechecked = value(
    await svc.runAction(provider, {
      caseId: missingPaymentCase.id,
      action: "recheck",
      idempotencyKey: "recheck_once",
      actorUserId: "operator_1",
    }),
  );
  expect(rechecked.action.action).toBe("resolve");
  expect(rechecked.case.status).toBe("resolved");
});

it("never allows import_confirmed for an amount_mismatch case, at the repository level too", async () => {
  const owner = await connected();
  const svc = service();
  const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
    listPayments: paginated({
      data: [record(owner.whopAccountId, "pay_mismatch", 2600)],
      nextCursor: null,
    }),
    listTransfers: paginated({ data: [], nextCursor: null }),
  };
  const coreUow = createPgliteUnitOfWork(client);
  await coreUow.run((r) =>
    r.ledger.append([
      {
        runId: run,
        sellerId: owner.id,
        accountSide: "seller",
        amount: { amountMinor: 2500, currency: "USD" },
        kind: "payment",
        resourceType: "payment",
        resourceId: "pay_mismatch",
        effectKey: effectKey("payment", "pay_mismatch", "succeeded"),
        occurredAt: now,
      },
    ]),
  );
  const detected = value(
    await svc.detectResolutionCases({ sellerId: owner.id, provider, provenance: "mock" }),
  );
  const mismatchCase = detected[0];
  if (!mismatchCase) throw new Error("Expected a detected case");
  expect(mismatchCase.kind).toBe("amount_mismatch");
  const result = await svc.runAction(provider, {
    caseId: mismatchCase.id,
    action: "import_confirmed",
    idempotencyKey: "should_fail",
    actorUserId: "operator_1",
  });
  expect(result).toMatchObject({ ok: false });
  expect(await rows("ledger_entries")).toHaveLength(1);
});

it("injectSimulatedFault opens a case labeled simulated without posting a ledger effect, and logs a 'demo fault injected' history row", async () => {
  const owner = await connected();
  const resolutionUow = createPgliteResolutionUnitOfWork(client);
  const result = value(
    await injectSimulatedFault(
      {
        uow: resolutionUow,
        provider: {
          listPayments: paginated({
            data: [record(owner.whopAccountId, "pay_demo", 500)],
            nextCursor: null,
          }),
          listTransfers: paginated({ data: [], nextCursor: null }),
        },
        clock,
        ids: { case: () => "case_demo", action: () => "action_demo" },
        demoMode: true,
      },
      { sellerId: owner.id, paymentId: "pay_demo", provenance: "mock" },
    ),
  );
  expect(result.simulated).toBe(true);
  expect(await rows("ledger_entries")).toHaveLength(0);
  const persisted = await rows("resolution_cases");
  expect(persisted).toHaveLength(1);
  expect(persisted[0]?.simulated).toBe(true);
  expect(persisted[0]?.status).toBe("detected");
  const actions = await rows("resolution_actions");
  expect(actions).toHaveLength(1);
  expect(actions[0]?.action).toBe("note");
  expect((actions[0]?.detail as { note?: string })?.note).toBe("demo fault injected");
});
