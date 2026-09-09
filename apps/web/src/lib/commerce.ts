// Local runtime shares one provider and unit of work with onboarding.
import { randomUUID } from "node:crypto";
import {
  createEarningsService,
  createOrderService,
  orderId,
  type ProviderSource,
} from "@ledgerly/core";
import {
  createLedgerReader,
  createNeonUnitOfWork,
  createOrdersRepo,
  createProductsRepo,
  createRefundRequestsRepo,
  createSellerAdminWritesRepo,
  createSellerDisplayNameRepo,
  createSellerIdentityLookup,
  createSellerListRepo,
  createSellerLookup,
  createUsersRepo,
} from "@ledgerly/db";
import { createWhopAdapter } from "@ledgerly/whop";
import { bindInstrumentationEmitter } from "./instrument";
import { getServer } from "./server";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

// The provenance to record when a provider call's own result carries no meta.source (plain
// mock-mode calls attach none at all). Sandbox and hybrid modes both talk to the real Whop
// sandbox API for at least some calls, so both default to "sandbox"; only mock is "mock".
// Mirrors apps/web/src/lib/seller-view.ts's provenanceOf, which resolves the same value for
// the seller/onboarding routes from the same WHOP_MODE.
function defaultProvenanceFor(env: NodeJS.ProcessEnv): ProviderSource {
  return env.WHOP_MODE === "sandbox" || env.WHOP_MODE === "hybrid" ? "sandbox" : "mock";
}

export function createCommerce(env: NodeJS.ProcessEnv = process.env) {
  const server = getServer(env);
  const db = server.db;
  const provider =
    env.LEDGERLY_LOCAL_RUNTIME !== undefined
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
  // The order service's `uow.exclusive` callback never calls `work.run` (see
  // packages/core/src/services/orders.ts), so this unit of work is used purely for its
  // advisory lock; leaving its emitter at the default noop drops no db instrumentation
  // events that would otherwise have fired.
  const uow =
    env.LEDGERLY_LOCAL_RUNTIME !== undefined
      ? server.uow
      : createNeonUnitOfWork(required(env, "DATABASE_URL"));
  const orders = createOrdersRepo(db, {
    emitter: server.instrumentationEmitter,
    provenance: env.LEDGERLY_LOCAL_RUNTIME !== undefined ? "pglite" : "neon",
  });
  const sellers = createSellerLookup(db);
  const sellerIdentity = createSellerIdentityLookup(db);
  const sellerDisplayNames = createSellerDisplayNameRepo(db);
  const sellerAdminWrites = createSellerAdminWritesRepo(db);
  const sellerList = createSellerListRepo(db);
  const users = createUsersRepo(db);
  const ledger = createLedgerReader(db);
  const products = createProductsRepo(db);
  const refundRequests = createRefundRequestsRepo(db);
  const appBaseUrl = required(env, "APP_BASE_URL");

  const createOrder = createOrderService({
    uow,
    provider,
    sellers,
    orders,
    ids: {
      order() {
        const id = orderId(randomUUID());
        if (!id.ok) throw new Error("Invalid generated order ID");
        return id.value;
      },
    },
    redirectUrl: (id) => `${appBaseUrl}/receipt/${id}`,
    defaultProvenance: defaultProvenanceFor(env),
  });
  const getEarnings = createEarningsService({ ledger });

  return {
    db,
    instrumentationEmitter: server.instrumentationEmitter,
    provider,
    orders,
    sellers,
    sellerIdentity,
    sellerDisplayNames,
    sellerAdminWrites,
    sellerList,
    users,
    ledger,
    products,
    refundRequests,
    createOrder,
    getEarnings,
  };
}

let commerce: ReturnType<typeof createCommerce> | undefined;
export function getCommerce() {
  if (process.env.LEDGERLY_LOCAL_RUNTIME !== undefined) return createCommerce();
  commerce ??= createCommerce();
  bindInstrumentationEmitter(commerce.instrumentationEmitter);
  return commerce;
}
