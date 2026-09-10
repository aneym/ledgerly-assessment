// Run the reconciliation job for one seller by hand.
//
//   pnpm reconcile --seller <sellerId|biz_...> [--json] [--max-pages N] [--env-file PATH]
//   pnpm reconcile --mock [--json]
//
// Sandbox mode builds the real Whop adapter and the Neon unit of work from the
// environment. Missing WHOP_* and DATABASE_URL values are read from --env-file, or from
// apps/web/.env.local (allowlisted keys only, process.env wins). Every provider call is a
// read; the local ledger is read inside one unit of work and never written. Nothing here
// prints a secret.
//
// Mock mode uses the in-memory mock adapter and a PGlite database seeded with one
// seller, so the job runs end to end without credentials.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import {
  createReconciliationProvider,
  createReconciliationService,
  parseEffectKey,
  type Result,
  runId,
  type SellerId,
  sellerId,
  type UnitOfWork,
  type WhopPort,
  whopAccountId,
} from "@ledgerly/core";
import { createNeonUnitOfWork, createPgliteUnitOfWork, createTestDb } from "@ledgerly/db";
import { createMockAdapter, createWhopAdapter } from "@ledgerly/whop";
import {
  formatFailure,
  formatOutcome,
  parseArgs,
  type ReconcileOutcome,
  USAGE,
} from "./reconcile-format";

function value<T>(result: Result<T, unknown>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  return result.value;
}

const ENV_KEYS = [
  "WHOP_API_KEY",
  "WHOP_API_BASE",
  "WHOP_API_VERSION_DATE",
  "WHOP_PLATFORM_ACCOUNT_ID",
  "DATABASE_URL",
] as const;
type Env = Partial<Record<(typeof ENV_KEYS)[number], string>>;

// Parse only the allowlisted keys. Never evaluate shell syntax or load the file into
// process.env, and never echo a value.
async function loadEnv(envFile: string | null): Promise<Env> {
  const fromFile: Record<string, string> = {};
  const source = envFile
    ? pathToFileURL(resolve(envFile))
    : new URL("../.env.local", import.meta.url);
  try {
    const text = await readFile(source, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (ENV_KEYS.some((key) => new RegExp(`^(?:export\\s+)?${key}\\s*=`).test(line)))
        Object.assign(fromFile, parseEnv(line));
    }
  } catch (error) {
    // The default file is optional; a named one must exist.
    if (envFile) throw new Error(`Cannot read --env-file ${envFile}`, { cause: error });
  }
  const env: Env = {};
  for (const key of ENV_KEYS) {
    const picked = process.env[key] ?? fromFile[key];
    if (picked) env[key] = picked;
  }
  return env;
}

// `seller` is the seeded seller in mock mode; sandbox mode resolves --seller against the database.
type Target = {
  uow: UnitOfWork;
  provider: WhopPort;
  seller: SellerId | null;
  close(): Promise<void>;
};

async function sandboxTarget(envFile: string | null): Promise<Target> {
  const env = await loadEnv(envFile);
  for (const key of ENV_KEYS)
    if (!env[key] && key !== "WHOP_API_BASE") throw new Error(`Missing ${key}`);
  // Reconciliation compares against the real sandbox, so the adapter runs in sandbox
  // mode even when the app itself is configured as hybrid.
  const provider = createWhopAdapter({
    WHOP_MODE: "sandbox",
    WHOP_API_BASE: env.WHOP_API_BASE,
    WHOP_API_KEY: env.WHOP_API_KEY,
    WHOP_API_VERSION_DATE: env.WHOP_API_VERSION_DATE,
    WHOP_PLATFORM_ACCOUNT_ID: env.WHOP_PLATFORM_ACCOUNT_ID,
  });
  const uow = createNeonUnitOfWork(env.DATABASE_URL as string);
  return { uow, provider, seller: null, close: () => uow.close() };
}

// One US seller with a $25.00 paid payment that both sides agree on, a $10.00 provider
// payment the ledger never posted, and a $5.00 local transfer the provider does not list.
export const MOCK_SELLER_ID = "reconcile-mock-seller";
async function mockTarget(requestedSeller: string | null): Promise<Target> {
  const db = await createTestDb();
  const uow = createPgliteUnitOfWork(db.$client);
  const platform = value(whopAccountId("biz_mock_platform"), "platform id");
  const provider = createMockAdapter({ parentAccountId: platform });
  const account = value(
    await provider.createOrFetchAccount(
      {
        externalId: "reconcile-mock",
        email: "reconcile-mock@example.invalid",
        country: "US",
        title: "Reconcile mock seller",
      },
      "reconcile-mock-account",
    ),
    "mock account",
  );
  const matched = value(
    provider.seedPayment({ amountMinor: 2500, currency: "USD" }, account.id, "matched"),
    "seed matched payment",
  );
  value(
    provider.seedPayment({ amountMinor: 1000, currency: "USD" }, account.id, "provider-only"),
    "seed provider-only payment",
  );
  const seller = value(sellerId(requestedSeller ?? MOCK_SELLER_ID), "seller id");
  const run = value(runId("reconcile-mock"), "run id");
  const occurredAt = new Date("2026-09-09T00:00:00Z");
  await uow.run(async (r) => {
    const row = await r.sellers.createOrFetch(
      {
        runId: run,
        externalId: "reconcile-mock",
        email: "reconcile-mock@example.invalid",
        country: "US",
      },
      seller,
    );
    await r.sellers.attach(row.id, account.id);
    const base = { runId: run, sellerId: row.id, occurredAt, provenance: "mock" as const };
    const paymentKey = value(parseEffectKey("reconcile-mock-payment"), "effect key");
    await r.ledger.append([
      {
        ...base,
        accountSide: "seller",
        kind: "payment",
        resourceType: "payment",
        resourceId: matched.id,
        effectKey: paymentKey,
        amount: { amountMinor: 2300, currency: "USD" },
      },
      {
        ...base,
        accountSide: "platform",
        kind: "fee",
        resourceType: "payment",
        resourceId: matched.id,
        effectKey: paymentKey,
        amount: { amountMinor: 200, currency: "USD" },
      },
      {
        ...base,
        accountSide: "seller",
        kind: "transfer",
        resourceType: "transfer",
        resourceId: "trf_mock_local_only",
        effectKey: value(parseEffectKey("reconcile-mock-transfer"), "effect key"),
        amount: { amountMinor: 500, currency: "USD" },
      },
    ]);
  });
  return { uow, provider, seller, close: () => db.$client.close() };
}

async function resolveSeller(uow: UnitOfWork, requested: string): Promise<SellerId> {
  const seller = await uow.run((r) =>
    requested.startsWith("biz_")
      ? r.sellers.byAccount(requested)
      : r.sellers.get(value(sellerId(requested), "seller id")),
  );
  if (!seller) throw new Error(`No local seller for ${requested}`);
  return seller.id;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const mode = args.mock ? "mock" : "sandbox";
  const target = args.mock ? await mockTarget(args.seller) : await sandboxTarget(args.envFile);
  try {
    const seller = target.seller ?? (await resolveSeller(target.uow, args.seller as string));
    const account = await target.uow.run(async (r) => (await r.sellers.get(seller))?.whopAccountId);
    const reconcile = createReconciliationService(target.uow, mode);
    // Financial-activity lines are the optional third source, as in apps/web/src/lib/server.ts.
    const reader = {
      ...createReconciliationProvider(target.provider),
      listFinancialActivity: target.provider.listFinancialActivity.bind(target.provider),
    };
    const result = await reconcile({ sellerId: seller, provider: reader, maxPages: args.maxPages });
    if (!result.ok) {
      console.error(formatFailure({ mode, seller, error: result.error }, args.json));
      return 1;
    }
    const outcome: ReconcileOutcome = {
      mode,
      sellerId: seller,
      // A successful report implies a connected account (the service refuses otherwise).
      whopAccountId: account ?? "unknown",
      generatedAt: new Date().toISOString(),
      report: result.value,
    };
    console.log(formatOutcome(outcome, args.json));
    return 0;
  } finally {
    await target.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (/^(Usage|--|Unknown argument)/.test(message)) console.error(USAGE);
    process.exitCode = 2;
  },
);
