import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runId, sellerId, whopAccountId } from "../../../../packages/core/src/ids";
import type { Result } from "../../../../packages/core/src/result";
import { createReconciliationProvider } from "../../../../packages/core/src/services/provider-reads";
import { createReconciliationService } from "../../../../packages/core/src/services/reconciliation";
import {
  createResolutionService,
  injectSimulatedFault,
  type ResolutionCase,
} from "../../../../packages/core/src/services/resolution";
import { getLocalRuntime } from "../../../../packages/db/src/local-runtime";
import { createMockAdapter } from "../../../../packages/whop/src/mock-adapter";
import { serializeIssue } from "../../src/app/api/admin/issues/serialize";
import {
  demoReadFaultEnabled,
  demoReadFaultMarker,
  providerForDemoReadFault,
} from "../../src/lib/demo-resolution-provider";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error(`Unexpected failure: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe("explicit mock resolution read failure", () => {
  it.each([
    { DEMO_MODE: "0", WHOP_DEMO_FALLBACK: "1" },
    { DEMO_MODE: "1", WHOP_DEMO_FALLBACK: "0" },
    {},
  ])("requires both demo flags %j", (env) => {
    expect(demoReadFaultEnabled(env)).toBe(false);
  });

  it("persists one mock issue across restart, records unknown reads, and preserves financial state", async () => {
    const work = resolve("../../work");
    mkdirSync(work, { recursive: true });
    const directory = mkdtempSync(resolve(work, "resolution-read-fixture-"));
    const env = {
      LEDGERLY_LOCAL_RUNTIME: "1",
      LEDGERLY_TEST_MODE: "1",
      NODE_ENV: "test",
      WHOP_MODE: "mock",
      APP_BASE_URL: "http://127.0.0.1:0",
      LEDGERLY_LOCAL_DB_DIR: directory,
      DEMO_MODE: "1",
      WHOP_DEMO_FALLBACK: "1",
    };
    let runtime = getLocalRuntime(env);
    try {
      const run = value(runId("run_readfixture"));
      const accountId = value(whopAccountId("biz_mock_readfixture"));
      const simulator = createMockAdapter({ accounts: [{ id: accountId, raw: {} }] });
      const reader = createReconciliationProvider(simulator);
      const created = await runtime.uow.run((r) =>
        r.sellers.createOrFetch(
          {
            runId: run,
            externalId: "readfixture",
            email: "readfixture@example.invalid",
            country: "US",
          },
          value(sellerId("seller_readfixture")),
        ),
      );
      await runtime.uow.run((r) => r.sellers.attach(created.id, accountId));
      let sequence = 0;
      const clock = { now: () => new Date("2026-09-09T12:00:00Z") };
      const ids = {
        case: () => `case_read_${++sequence}`,
        action: () => `action_read_${++sequence}`,
      };
      const injected = value(
        await injectSimulatedFault(
          {
            uow: runtime.resolutionUow,
            provider: { ...reader, seedDemoPayment: simulator.seedDemoPayment.bind(simulator) },
            clock,
            ids,
            demoMode: true,
          },
          { sellerId: created.id, fresh: true, runId: run, provenance: "mock" },
        ),
      );
      const marker = demoReadFaultMarker(injected, ids.action(), clock.now());
      await runtime.resolutionUow.run((r) => r.actions.insert(marker));
      const ledgerBefore = await runtime.uow.run((r) => r.ledger.forSeller(created.id));
      const paymentsBefore = await reader.listPayments({ accountId, limit: 100 });
      expect(ledgerBefore).toEqual([]);

      // Reopen the same disposable database. Reader selection must not rely on memory.
      await runtime.close();
      runtime = getLocalRuntime(env);
      const kase = await runtime.resolutionUow.run((r) => r.cases.get(injected.id));
      const actions = await runtime.resolutionUow.run((r) => r.actions.listForCase(injected.id));
      const seller = await runtime.uow.run((r) => r.sellers.get(created.id));
      if (!kase) throw new Error("Persisted fixture issue missing after restart");
      const before = serializeIssue(kase, seller, actions, clock.now());
      expect(before).toMatchObject({
        kind: "missing_local_payment",
        status: "detected",
        simulated: true,
        provenance: "mock",
        amounts: { provider: { amountMinor: 2500, currency: "USD" } },
      });
      expect(before.amounts).not.toHaveProperty("local");
      expect(before.history).toContainEqual(
        expect.objectContaining({
          actor: "system:demo-read-fault",
          action: "mock provider read timeout injected",
          provenance: "mock",
        }),
      );

      let underlyingReads = 0;
      const underlying = {
        listPayments: async (...args: Parameters<typeof reader.listPayments>) => {
          underlyingReads++;
          return reader.listPayments(...args);
        },
        listTransfers: async (...args: Parameters<typeof reader.listTransfers>) => {
          underlyingReads++;
          return reader.listTransfers(...args);
        },
      };
      const fixture = providerForDemoReadFault(
        underlying,
        kase,
        actions,
        accountId,
        demoReadFaultEnabled(env),
      );
      const service = createResolutionService({
        uow: runtime.resolutionUow,
        reconcileSeller: createReconciliationService(runtime.uow),
        clock,
        ids,
      });
      for (const action of ["refetch", "import_confirmed", "recheck", "recheck"] as const) {
        const result = value(
          await service.runAction(fixture, {
            caseId: injected.id,
            action,
            actorUserId: "operator_readfixture",
            idempotencyKey: `request_${++sequence}`,
          }),
        );
        expect(result.action).toMatchObject({
          action,
          outcome: action === "recheck" ? "failed" : "uncertain",
          detail: { reason: "network" },
        });
        const freshCase = await runtime.resolutionUow.run((r) => r.cases.get(injected.id));
        const freshActions = await runtime.resolutionUow.run((r) =>
          r.actions.listForCase(injected.id),
        );
        if (!freshCase) throw new Error("Fixture issue missing after action");
        const after = serializeIssue(freshCase, seller, freshActions, clock.now());
        expect(after.status).toBe(before.status);
        expect(after.amounts).toEqual(before.amounts);
        expect(after.history.some((entry) => entry.action === "resolve")).toBe(false);
      }
      expect(underlyingReads).toBe(0);
      expect(await runtime.uow.run((r) => r.ledger.forSeller(created.id))).toEqual(ledgerBefore);
      expect(await reader.listPayments({ accountId, limit: 100 })).toEqual(paymentsBefore);
      expect(
        await fixture.listPayments({ accountId: value(whopAccountId("biz_foreign")), limit: 100 }),
      ).toEqual({ ok: false, error: { kind: "invalid_request" } });
      expect(underlyingReads).toBe(0);

      // Reusing or forging a marker cannot divert an ordinary issue or another seller.
      const ordinary: Partial<ResolutionCase>[] = [
        { simulated: false },
        { provenance: "sandbox" },
        { providerResourceId: "pay_real" },
        { id: "case_foreign" },
        { sellerId: value(sellerId("seller_foreign")) },
        { kind: "unconfirmed_transfer", providerResourceType: "transfer" },
      ];
      for (const change of ordinary) {
        expect(
          providerForDemoReadFault(underlying, { ...kase, ...change }, actions, accountId, true),
        ).toBe(underlying);
      }
      expect(providerForDemoReadFault(underlying, kase, [], accountId, true)).toBe(underlying);
      expect(providerForDemoReadFault(underlying, kase, actions, accountId, false)).toBe(
        underlying,
      );
      expect(
        providerForDemoReadFault(
          underlying,
          kase,
          actions.map((entry) => ({ ...entry, actorUserId: "operator_forged_note" })),
          accountId,
          true,
        ),
      ).toBe(underlying);
      expect(() =>
        demoReadFaultMarker({ ...kase, provenance: "sandbox" }, ids.action(), clock.now()),
      ).toThrow();
    } finally {
      await runtime.close();
    }
  }, 30000);
});
