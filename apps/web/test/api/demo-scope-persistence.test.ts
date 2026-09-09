import { afterAll, beforeAll, expect, it } from "vitest";
import { runId, type SellerId, sellerId, whopAccountId } from "../../../../packages/core/src/ids";
import type { Result } from "../../../../packages/core/src/result";
import { createReconciliationProvider } from "../../../../packages/core/src/services/provider-reads";
import { createReconciliationService } from "../../../../packages/core/src/services/reconciliation";
import {
  createResolutionService,
  injectSimulatedFault,
} from "../../../../packages/core/src/services/resolution";
import { createTestDb } from "../../../../packages/db/src/client";
import { createPgliteResolutionUnitOfWork } from "../../../../packages/db/src/repos/resolution";
import { createPgliteUnitOfWork } from "../../../../packages/db/src/repos/unit-of-work";
import { createMockAdapter } from "../../../../packages/whop/src/mock-adapter";
import { createRunIssueActionHandler } from "../../src/app/api/admin/issues/[id]/actions/[action]/route";
import { createGetIssueHandler } from "../../src/app/api/admin/issues/[id]/route";
import { createDemoFaultHandler } from "../../src/app/api/admin/issues/demo-fault/route";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Invalid fixture");
  return result.value;
}
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});

it("persists own-run faults and notes, denies foreign reads/writes, and preserves true operator access", async () => {
  const core = createPgliteUnitOfWork(db.$client);
  const uow = createPgliteResolutionUnitOfWork(db.$client);
  const adapter = createMockAdapter();
  const provider = {
    ...createReconciliationProvider(adapter),
    seedDemoPayment: adapter.seedDemoPayment.bind(adapter),
  };
  const clock = { now: () => new Date("2026-09-09T12:00:00Z") };
  let sequence = 0;
  const ids = { case: () => `case_${++sequence}`, action: () => `action_${++sequence}` };
  const resolution = createResolutionService({
    uow,
    reconcileSeller: createReconciliationService(core),
    clock,
    ids,
  });
  for (const suffix of ["A", "B"]) {
    const seller = await core.run((r) =>
      r.sellers.createOrFetch(
        {
          runId: value(runId(`run_${suffix}`)),
          externalId: suffix,
          email: `${suffix}@example.invalid`,
          country: "US",
        },
        value(sellerId(`seller_${suffix}`)),
      ),
    );
    await core.run((r) => r.sellers.attach(seller.id, value(whopAccountId(`biz_${suffix}`))));
  }
  const base = {
    getSession: async () => ({ userId: "issued_A", role: "demo", demoRunId: "run_A" }),
    getCase: (id: string) => uow.run((r) => r.cases.get(id)),
    getSeller: (id: SellerId) => uow.run((r) => r.sellers.get(id)),
    listActionsForCase: (id: string) => uow.run((r) => r.actions.listForCase(id)),
    now: clock.now,
  };
  const faultDeps = {
    ...base,
    isDemoMode: () => true,
    injectFault: (input: Parameters<typeof injectSimulatedFault>[1]) =>
      injectSimulatedFault({ uow, provider, clock, ids, demoMode: true }, input),
  };
  const fault = createDemoFaultHandler(faultDeps);
  const action = createRunIssueActionHandler({
    ...base,
    runAction: (input) => resolution.runAction(provider, input),
  });
  const post = (run: string, body: unknown, key = "own-note") =>
    new Request("http://x/api/admin/issues", {
      method: "POST",
      headers: { "x-demo-run": run, "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
  const own = await fault(post("run_A", { seller_id: "seller_A", fresh: true }));
  expect(own.status).toBe(201);
  const ownCase = (await own.json()).id as string;
  expect((await action(post("run_A", { note: "owned note" }), ownCase, "note")).status).toBe(200);
  expect((await base.listActionsForCase(ownCase)).map((entry) => entry.detail)).toEqual([
    { note: "demo fault injected" },
    { note: "owned note" },
  ]);
  const operatorFault = createDemoFaultHandler({
    ...faultDeps,
    getSession: async () => ({ userId: "real_operator", role: "operator" }),
  });
  const foreign = await operatorFault(post("run_B", { seller_id: "seller_B", fresh: true }));
  expect(foreign.status).toBe(201);
  const foreignCase = (await foreign.json()).id as string;
  const before = await base.listActionsForCase(foreignCase);
  for (const run of ["run_A", "run_B"]) {
    expect((await createGetIssueHandler(base)(post(run, {}), foreignCase)).status).toBe(403);
    expect(
      (await action(post(run, { note: "foreign note" }, `foreign-${run}`), foreignCase, "note"))
        .status,
    ).toBe(403);
    expect((await fault(post(run, { seller_id: "seller_B", fresh: true }))).status).toBe(403);
  }
  expect(await base.listActionsForCase(foreignCase)).toEqual(before);
  expect(await uow.run((r) => r.cases.list({ limit: 10 }))).toHaveLength(2);
  const operatorAction = createRunIssueActionHandler({
    ...base,
    getSession: async () => ({ userId: "real_operator", role: "operator" }),
    runAction: (input) => resolution.runAction(provider, input),
  });
  expect(
    (
      await operatorAction(
        post("run_B", { note: "operator note" }, "operator-note"),
        foreignCase,
        "note",
      )
    ).status,
  ).toBe(200);
  expect((await base.listActionsForCase(foreignCase)).at(-1)).toMatchObject({
    actorUserId: "real_operator",
    detail: { note: "operator note" },
  });
});
