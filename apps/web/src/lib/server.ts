import { randomUUID } from "node:crypto";
import type { Emitter } from "@ledgerly/core";
import {
  createInboxService,
  createOnboardingService,
  createReconciliationProvider,
  createReconciliationService,
  createTransferReleaseService,
  deliveryId,
  sellerId,
  whopAccountId,
} from "@ledgerly/core";
import {
  type ApplicationDatabase,
  createDb,
  createNeonUnitOfWork,
  createSellerLookup,
  createTransferOrdersRepo,
  getLocalRuntime,
  insertInstrumentationEvent,
} from "@ledgerly/db";
import {
  createSimulatorAdapter,
  createWhopAdapter,
  decodeEnvelope,
  verifyStandardWebhook,
} from "@ledgerly/whop";
import { bindInstrumentationEmitter, correlatedEmitter } from "./instrument";
import { persistLocalProvider } from "./local-provider";
// Reused rather than re-derived: apps/web/src/lib/commerce.ts's own defaultProvenanceFor
// treats WHOP_MODE=hybrid as "sandbox", while this one (the only exported, reusable copy)
// treats it as "mock" by falling through its `!== "sandbox"` check. That is a real
// inconsistency between two independently-wired provenance defaults; flagged to team-lead
// rather than resolved here, since neither commerce.ts nor seller-view.ts is in this
// round's ownership.
import { createLocalRefundIsolation } from "./local-refund-isolation";
import { provenanceOf } from "./seller-view";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
// Persists every instrumentation event fire-and-forget: emit() is synchronous by contract
// (packages/core/src/instrumentation/emitter.ts), so a write failure here must never surface
// to the caller whose real request produced the event, only to the server log.
function createPersistingEmitter(db: ApplicationDatabase): Emitter {
  return {
    emit(event) {
      insertInstrumentationEvent(db, event).catch((cause: unknown) => {
        console.error("Failed to persist instrumentation event:", cause);
      });
    },
  };
}
export function createServer(env: NodeJS.ProcessEnv = process.env) {
  const local = env.LEDGERLY_LOCAL_RUNTIME !== undefined ? getLocalRuntime(env) : undefined;
  const db: ApplicationDatabase = local?.db ?? createDb(required(env, "DATABASE_URL"));
  // correlatedEmitter stamps a db event (which the unit of work cannot attribute to a
  // request without changing the shared UnitOfWork port) with the ambient correlation id
  // that apps/web/src/lib/instrument.ts's `instrumented` wrapper set for this request.
  const emitter = correlatedEmitter(createPersistingEmitter(db));
  local?.setEmitter(emitter);
  const baseUow = local?.uow ?? createNeonUnitOfWork(required(env, "DATABASE_URL"), emitter);
  const clock = { now: () => new Date() };
  // Sandbox/hybrid mode already requires WHOP_PLATFORM_ACCOUNT_ID (createWhopAdapter throws
  // without it below); a mock-only local run may not have set one, so this falls back to a
  // fixed id the simulator seeds an account for itself, a few lines down.
  const platformAccountIdResult = whopAccountId(env.WHOP_PLATFORM_ACCOUNT_ID ?? "biz_platform_sim");
  if (!platformAccountIdResult.ok) throw new Error("Invalid WHOP_PLATFORM_ACCOUNT_ID");
  const platformAccountId = platformAccountIdResult.value;
  const isolation = local
    ? createLocalRefundIsolation({
        client: local.db.$client,
        env,
        baseUow,
        databaseReady: local.ready,
        platformAccountId,
        now: clock.now,
        emitter,
      })
    : undefined;
  const uow = isolation?.ordinaryUow ?? baseUow;
  const inbox = createInboxService({
    platformAccountId,
    uow,
    clock,
    decoder: { decodeEnvelope, verifyStandardWebhook },
    provenance: provenanceOf(env),
  });
  const mode = env.WHOP_MODE ?? "mock";
  // Mock mode gets a stateful simulator instead of the stateless createMockAdapter()
  // createWhopAdapter would otherwise build, so the failure/recovery metadata flags,
  // tick-based transfer/payout progression, and signed webhook delivery all work end to end
  // in local/dev testing (see docs/lanes/architecture/platform-simulation.md). Every other
  // mode is unaffected: createWhopAdapter only reads options.mock as a substitute for its
  // own createMockAdapter() call, and sandbox/hybrid never take that branch.
  let simulator: ReturnType<typeof createSimulatorAdapter> | undefined;
  if (mode === "mock") {
    const simulatorWebhookSecret = env.WHOP_WEBHOOK_SECRET ?? "ws_sim_only";
    simulator = createSimulatorAdapter({
      webhookSecret: simulatorWebhookSecret,
      ...(env.WHOP_API_VERSION_DATE ? { apiVersionDate: env.WHOP_API_VERSION_DATE } : {}),
      now: () => clock.now(),
      parentAccountId: platformAccountId,
      // Gives releaseTransfers a real account to draw from without a separate setup step.
      // This does not model real fund inflow (payments settling into a transferable
      // balance are a separate, unlinked balances map inside the simulator) — a documented
      // simplification, not a bug: see the architecture doc's known-limitations section.
      accounts: [{ id: platformAccountId, raw: { email: "platform@ledgerly.simulated" } }],
      // Delivers a simulated webhook the same way a real inbound HTTP call would, minus the
      // transport: straight into receiveWebhook, in-process, using the exact secret the
      // simulator itself just signed with.
      deliver: async (delivery) => {
        await inbox.receiveWebhook({
          rawBody: delivery.rawBody,
          headers: delivery.headers as {
            "webhook-id": string;
            "webhook-timestamp": string;
            "webhook-signature": string;
          },
          secret: simulatorWebhookSecret,
          now: clock.now(),
        });
      },
    });
    // Seed before restoring. A saved zero balance is a real mock balance, never a reset signal.
    simulator.seedBalance(platformAccountId, { amountMinor: 100_000_000, currency: "USD" });
    if (local) simulator = persistLocalProvider(simulator, env, local.newDatabase);
    if (isolation) {
      const persisted = simulator;
      // This outer guard runs before the persistence wrapper starts a provider mutation.
      // Both provider and simulator exports receive this same guarded object.
      simulator = new Proxy(persisted, {
        get(target, key) {
          if (key === "refundPayment")
            return async (...args: Parameters<typeof persisted.refundPayment>) => {
              try {
                return await isolation.guardRefund(args[0], () => persisted.refundPayment(...args));
              } catch (error) {
                if (error instanceof Error && error.message === "local_refund_isolated")
                  return { ok: false as const, error: { kind: "invalid_request" as const } };
                throw error;
              }
            };
          return Reflect.get(target, key, target);
        },
      });
    }
  }
  const provider = createWhopAdapter(
    {
      WHOP_MODE: env.WHOP_MODE,
      WHOP_API_BASE: env.WHOP_API_BASE,
      WHOP_API_KEY: env.WHOP_API_KEY,
      WHOP_API_VERSION_DATE: env.WHOP_API_VERSION_DATE,
      WHOP_WEBHOOK_SECRET: env.WHOP_WEBHOOK_SECRET,
      WHOP_PLATFORM_ACCOUNT_ID: env.WHOP_PLATFORM_ACCOUNT_ID,
    },
    // Sandbox HTTP calls do not yet carry the request's correlation id (see
    // packages/whop/src/sandbox-adapter.ts, out of this round's ownership), so each whop
    // event mints its own via packages/whop/src/client.ts's default — a known gap, not one
    // correlatedEmitter can close, since it only rewrites the "uncorrelated" sentinel.
    { onEvent: emitter.emit, ...(simulator ? { mock: simulator } : {}) },
  );
  const reconcileSeller = createReconciliationService(
    uow,
    provenanceOf({ WHOP_MODE: env.WHOP_MODE }),
  );
  const releaseTransfers = createTransferReleaseService({
    uow,
    provider,
    orders: createTransferOrdersRepo(db),
    sellers: createSellerLookup(db),
    // transfers.ts calls this from inside uow.exclusive's callback, not through work.run, so
    // it needs its own path to the ledger rather than the one exclusive's callback receives.
    ledger: { append: (entries) => uow.run((r) => r.ledger.append(entries)) },
    clock,
    platformAccountId,
  });
  return {
    db,
    instrumentationEmitter: emitter,
    ready: isolation?.ready ?? local?.ready ?? Promise.resolve(),
    localRefundIsolation: isolation,
    provider,
    uow,
    simulator,
    ...inbox,
    async processLocalDelivery(id: string) {
      if (!local) throw new Error("Exact local delivery processing requires local runtime");
      const parsed = deliveryId(id);
      if (!parsed.ok) throw new Error("Invalid delivery ID");
      const scoped = createInboxService({
        platformAccountId,
        clock,
        decoder: { decodeEnvelope, verifyStandardWebhook },
        provenance: "mock",
        uow: {
          ...uow,
          run: (fn) =>
            uow.run((repos) =>
              fn({
                ...repos,
                inbox: {
                  ...repos.inbox,
                  pending: async () => {
                    const row = await repos.inbox.get(parsed.value);
                    return row.status === "received" || row.status === "failed" ? [row] : [];
                  },
                },
              }),
            ),
        },
      });
      return scoped.processInbox({ limit: 1 });
    },
    webhookSecret: () => required(env, "WHOP_WEBHOOK_SECRET"),
    releaseTransfers,
    ...(simulator ? { tick: () => (simulator as NonNullable<typeof simulator>).tick() } : {}),
    async onboardSeller(input: Parameters<ReturnType<typeof createOnboardingService>>[0]) {
      const onboard = createOnboardingService({
        uow,
        provider,
        clock,
        ids: {
          seller() {
            const id = sellerId(randomUUID());
            if (!id.ok) throw new Error("Invalid generated seller ID");
            return id.value;
          },
        },
        apiVersionDate: required(env, "WHOP_API_VERSION_DATE"),
        returnUrl: required(env, "ONBOARDING_RETURN_URL"),
        refreshUrl: required(env, "ONBOARDING_REFRESH_URL"),
      });
      return onboard(input);
    },
    async reconcileBounded() {
      if (
        typeof provider.listPayments !== "function" ||
        typeof provider.listTransfers !== "function"
      )
        return {
          status: "provider_reads_unavailable" as const,
          sellers: 0,
          failed: 0,
          missingLocally: 0,
          missingAtProvider: 0,
          amountMismatch: 0,
          pendingOrReserve: 0,
        };
      const batch = await uow.run(async (r) => {
        const count = await r.sellers.count();
        const offset = count ? (Math.floor(clock.now().getTime() / 60000) * 10) % count : 0;
        return r.sellers.list(10, offset);
      });
      // Financial-activity lines are an optional third source for the per-seller report; the
      // sandbox adapter exposes the method, the reconciliation wrapper does not.
      const reader = {
        ...createReconciliationProvider(provider),
        ...(typeof provider.listFinancialActivity === "function"
          ? { listFinancialActivity: provider.listFinancialActivity.bind(provider) }
          : {}),
      };
      const counts = {
        status: "completed" as const,
        sellers: 0,
        failed: 0,
        missingLocally: 0,
        missingAtProvider: 0,
        amountMismatch: 0,
        pendingOrReserve: 0,
      };
      for (const seller of batch) {
        const result = await reconcileSeller({
          sellerId: seller.id,
          provider: reader,
          maxPages: 3,
        });
        counts.sellers++;
        if (!result.ok) {
          counts.failed++;
          continue;
        }
        counts.missingLocally += result.value.missingLocally.length;
        counts.missingAtProvider += result.value.missingAtProvider.length;
        counts.amountMismatch += result.value.amountMismatch.length;
        counts.pendingOrReserve += result.value.pendingOrReserve.length;
      }
      return counts;
    },
  };
}
let server: ReturnType<typeof createServer> | undefined;
// Runtime identity couples the provider cache to canonical DB aliases and close/reopen.
const localServers = globalThis as typeof globalThis & {
  __ledgerlyLocalServersV2?: WeakMap<object, ReturnType<typeof createServer>>;
};
export function getServer(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof createServer> {
  if (env.LEDGERLY_LOCAL_RUNTIME !== undefined) {
    const local = getLocalRuntime(env);
    localServers.__ledgerlyLocalServersV2 ??= new WeakMap<
      object,
      ReturnType<typeof createServer>
    >();
    const cache = localServers.__ledgerlyLocalServersV2;
    let instance = cache.get(local);
    if (!instance) {
      instance = createServer(env);
      cache.set(local, instance);
    }
    bindInstrumentationEmitter(instance.instrumentationEmitter);
    return instance;
  }
  server ??= createServer(env);
  bindInstrumentationEmitter(server.instrumentationEmitter);
  return server;
}
