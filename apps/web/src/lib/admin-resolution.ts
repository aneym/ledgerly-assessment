// Local runtime shares the onboarding provider for recovery reads.

import { randomUUID } from "node:crypto";
import { getLocalRuntime } from "@ledgerly/db";
import type { SellerId } from "../../../../packages/core/src/ids";
import { noopEmitter } from "../../../../packages/core/src/instrumentation";
import { createReconciliationProvider } from "../../../../packages/core/src/services/provider-reads";
import { createReconciliationService } from "../../../../packages/core/src/services/reconciliation";
import {
  createResolutionService,
  type DemoPaymentSeeder,
  injectSimulatedFault,
  type ResolutionCaseFilter,
} from "../../../../packages/core/src/services/resolution";
import { createNeonResolutionUnitOfWork } from "../../../../packages/db/src/repos/resolution";
import { createNeonUnitOfWork } from "../../../../packages/db/src/repos/unit-of-work";
import { createWhopAdapter } from "../../../../packages/whop/src/index";
import {
  type DemoReadFaultInput,
  demoReadFaultEnabled,
  demoReadFaultMarker,
  providerForDemoReadFault,
} from "./demo-resolution-provider";
import { bindInstrumentationEmitter, correlatedEmitter } from "./instrument";
import { getServer } from "./server";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function createAdminResolution(env: NodeJS.ProcessEnv = process.env) {
  // Reuse the selected server and bind its emitter to the current instrumented request.
  const server = getServer(env);
  const local = env.LEDGERLY_LOCAL_RUNTIME !== undefined ? getLocalRuntime(env) : undefined;
  const emitter = correlatedEmitter(noopEmitter);
  const provider = local
    ? server.provider
    : createWhopAdapter(
        {
          WHOP_MODE: env.WHOP_MODE,
          WHOP_API_BASE: env.WHOP_API_BASE,
          WHOP_API_KEY: env.WHOP_API_KEY,
          WHOP_API_VERSION_DATE: env.WHOP_API_VERSION_DATE,
          WHOP_WEBHOOK_SECRET: env.WHOP_WEBHOOK_SECRET,
          WHOP_PLATFORM_ACCOUNT_ID: env.WHOP_PLATFORM_ACCOUNT_ID,
        },
        { onEvent: server.instrumentationEmitter.emit },
      );
  const reader = createReconciliationProvider(provider);
  const resolutionUow =
    local?.resolutionUow ?? createNeonResolutionUnitOfWork(required(env, "DATABASE_URL"), emitter);
  // A second unit of work over the same shared Repositories port (packages/core/src/services/
  // ports.ts), used only for reconcileSeller's own uow.run calls inside detect/recheck:
  // resolution.ts requires exactly ReturnType<typeof createReconciliationService>, which is
  // built from the wider UnitOfWork port, not the narrower ResolutionUnitOfWork resolutionUow
  // implements.
  const coreUow = local ? server.uow : createNeonUnitOfWork(required(env, "DATABASE_URL"), emitter);
  const reconcileSeller = createReconciliationService(coreUow);
  const clock = { now: () => new Date() };
  const resolution = createResolutionService({
    uow: resolutionUow,
    reconcileSeller,
    clock,
    ids: {
      case: () => `case_${randomUUID()}`,
      action: () => `action_${randomUUID()}`,
    },
  });
  const isDemoMode = () => env.DEMO_MODE === "1";

  // Bounded "detect for every seller" batch, mirroring apps/web/src/lib/server.ts's own
  // reconcileBounded(): a time-rotating window of 10 sellers per call (so repeated cron/API
  // calls sweep the whole seller base over time instead of one unbounded scan), reusing
  // this module's own coreUow rather than server.ts's private one, since server.ts exports
  // neither its uow nor a sellers repo for another module to share.
  async function detectBounded() {
    const batch = await coreUow.run(async (r) => {
      const count = await r.sellers.count();
      const offset = count ? (Math.floor(clock.now().getTime() / 60000) * 10) % count : 0;
      return r.sellers.list(10, offset);
    });
    let sellers = 0;
    let failed = 0;
    let casesDetected = 0;
    for (const seller of batch) {
      const result = await resolution.detectResolutionCases({
        sellerId: seller.id,
        provider: reader,
        provenance: env.WHOP_MODE ?? "mock",
        maxPages: 3,
      });
      sellers++;
      if (!result.ok) {
        failed++;
        continue;
      }
      casesDetected += result.value.length;
    }
    return { sellers, failed, casesDetected };
  }

  return {
    instrumentationEmitter: server.instrumentationEmitter,
    provider: reader,
    resolution,
    clock,
    isDemoMode,
    isDemoReadFaultEnabled: () => demoReadFaultEnabled(env),
    async providerForCase(caseId: string, operator: boolean) {
      if (!operator || !demoReadFaultEnabled(env)) return reader;
      return resolutionUow.run(async (r) => {
        const kase = await r.cases.get(caseId);
        const seller = kase?.sellerId ? await r.sellers.get(kase.sellerId) : null;
        return providerForDemoReadFault(
          reader,
          kase,
          await r.actions.listForCase(caseId),
          seller?.whopAccountId ?? null,
          true,
        );
      });
    },
    listCases: (filter: ResolutionCaseFilter) => resolutionUow.run((r) => r.cases.list(filter)),
    getCase: (id: string) => resolutionUow.run((r) => r.cases.get(id)),
    listActionsForCase: (caseId: string) => resolutionUow.run((r) => r.actions.listForCase(caseId)),
    getSeller: (id: SellerId) => resolutionUow.run((r) => r.sellers.get(id)),
    detectBounded,
    injectFault: async (input: DemoReadFaultInput) => {
      if (
        input.providerOutcome &&
        (!demoReadFaultEnabled(env) ||
          !input.fresh ||
          input.paymentId ||
          !input.runId ||
          !/^run_[A-Za-z0-9]{1,32}$/.test(input.runId))
      )
        return {
          ok: false as const,
          error: {
            kind: "payment_required" as const,
            message: "Read faults require a fresh demo payment and both demo flags.",
          },
        };
      const result = await injectSimulatedFault(
        {
          uow: resolutionUow,
          provider: {
            ...reader,
            ...(local && server.simulator
              ? ({
                  seedDemoPayment: (accountId, key) => {
                    const simulator = server.simulator;
                    if (!simulator) throw new Error("Local simulator unavailable");
                    // This explicit mock boundary is used only to create a recoverable demo issue.
                    return simulator.seedPayment(
                      { amountMinor: 2500, currency: "USD" },
                      accountId,
                      key,
                    );
                  },
                } satisfies Partial<DemoPaymentSeeder>)
              : {}),
            ...(env.WHOP_DEMO_FALLBACK === "1" && (provider as DemoPaymentSeeder).seedDemoPayment
              ? { seedDemoPayment: (provider as DemoPaymentSeeder).seedDemoPayment?.bind(provider) }
              : {}),
          },
          clock,
          ids: { case: () => `case_${randomUUID()}`, action: () => `action_${randomUUID()}` },
          demoMode: isDemoMode(),
        },
        input,
      );
      if (result.ok && input.providerOutcome === "uncertain") {
        await resolutionUow.run((r) =>
          r.actions.insert(
            demoReadFaultMarker(result.value, `action_${randomUUID()}`, clock.now()),
          ),
        );
      }
      return result;
    },
  };
}

let adminResolution: ReturnType<typeof createAdminResolution> | undefined;
export function getAdminResolution() {
  if (process.env.LEDGERLY_LOCAL_RUNTIME !== undefined) return createAdminResolution();
  adminResolution ??= createAdminResolution();
  bindInstrumentationEmitter(adminResolution.instrumentationEmitter);
  return adminResolution;
}
