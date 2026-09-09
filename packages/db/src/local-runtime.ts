import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { type Emitter, noopEmitter } from "../../core/src/instrumentation";
import type { UnitOfWork } from "../../core/src/services/ports";
import type { ResolutionUnitOfWork } from "../../core/src/services/resolution";
import { createPgliteResolutionUnitOfWork } from "./repos/resolution";
import { createPgliteUnitOfWork } from "./repos/unit-of-work";
import * as schema from "./schema";

type Environment = Readonly<Record<string, string | undefined>>;
export type ApplicationDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** This adapter is opt-in and must never select a provider or production database. */
export function assertLocalRuntimeEnvironment(env: Environment): void {
  if (
    env.LEDGERLY_LOCAL_RUNTIME !== "1" ||
    env.LEDGERLY_TEST_MODE !== "1" ||
    !["development", "test"].includes(env.NODE_ENV ?? "") ||
    env.WHOP_MODE !== "mock"
  )
    throw new Error(
      "Local runtime requires explicit local/test flags, development or test NODE_ENV, and mock Whop",
    );
  if (env.DATABASE_URL || env.WHOP_API_KEY) {
    throw new Error("Local runtime refuses DATABASE_URL and WHOP_API_KEY");
  }
  if (
    Object.keys(env).some(
      (key) =>
        /^(VERCEL|NETLIFY|AWS_LAMBDA|AWS_EXECUTION_ENV|K_SERVICE|FLY_APP_NAME|RAILWAY_|RENDER)/.test(
          key,
        ) && env[key] !== undefined,
    )
  )
    throw new Error("Local runtime refuses hosted environments");
  let base: URL;
  try {
    base = new URL(env.APP_BASE_URL ?? "");
  } catch {
    throw new Error("Local runtime requires an explicit loopback APP_BASE_URL");
  }
  if (
    base.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    env.APP_BASE_URL !== base.origin ||
    (env.BETTER_AUTH_URL !== undefined && env.BETTER_AUTH_URL !== base.origin)
  )
    throw new Error("Local runtime requires matching HTTP loopback origins");
  if (!env.LEDGERLY_LOCAL_DB_DIR || !isAbsolute(env.LEDGERLY_LOCAL_DB_DIR)) {
    throw new Error("Local runtime requires an absolute LEDGERLY_LOCAL_DB_DIR");
  }
}

export type LocalRuntime = {
  db: ReturnType<typeof createLocalDb>;
  ready: Promise<void>;
  uow: UnitOfWork;
  resolutionUow: ResolutionUnitOfWork;
  setEmitter(emitter: Emitter): void;
  configuration: string;
  newDatabase: boolean;
  close(): Promise<void>;
};
function createLocalDb(client: PGlite) {
  return drizzle(client, { schema });
}

// Next development reloads modules. A process-wide registry keeps one PGlite session
// and one transaction queue per canonical directory across those reloads.
const registryKey = Symbol.for("ledgerly.local-runtime.databases");
const globals = globalThis as typeof globalThis & { [registryKey]?: Map<string, LocalRuntime> };
globals[registryKey] ??= new Map<string, LocalRuntime>();
const runtimes = globals[registryKey];

export function getLocalRuntime(env: Environment, emitter: Emitter = noopEmitter): LocalRuntime {
  assertLocalRuntimeEnvironment(env);
  const requested = env.LEDGERLY_LOCAL_DB_DIR as string;
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const directory = realpathSync(requested);
  const configuration = createHash("sha256")
    .update(JSON.stringify([env.APP_BASE_URL, env.BETTER_AUTH_SECRET, env.WHOP_WEBHOOK_SECRET]))
    .digest("hex");
  const cached = runtimes.get(directory);
  if (cached) {
    if (cached.configuration !== configuration)
      throw new Error("Active local runtime configuration differs");
    return cached;
  }

  // PGlite's disk backend is single-process. Never remove an existing lock, even
  // after a crash: an operator must verify that its recorded process has stopped.
  const lock = join(directory, ".ledgerly-runtime.lock");
  let descriptor: number;
  try {
    descriptor = openSync(lock, "wx", 0o600);
  } catch {
    throw new Error("Local database is locked; close its owner or use a new disposable directory");
  }
  writeFileSync(descriptor, `${process.pid}\n`);
  closeSync(descriptor);
  const newDatabase = !existsSync(join(directory, "postgres"));
  let client: PGlite;
  try {
    client = new PGlite(join(directory, "postgres"));
  } catch (error) {
    unlinkSync(lock);
    throw error;
  }
  const db = createLocalDb(client);
  let sink = emitter;
  const forward: Emitter = { emit: (event) => sink.emit(event) };
  const work = createPgliteUnitOfWork(client, forward);
  const resolution = createPgliteResolutionUnitOfWork(client, forward);
  let closing: Promise<void> | undefined;
  const ready = migrate(db, {
    migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle"),
  }).catch(async (error: unknown) => {
    await client.close();
    runtimes.delete(directory);
    unlinkSync(lock);
    throw error;
  });
  const runtime: LocalRuntime = {
    db,
    configuration,
    newDatabase,
    setEmitter(emitter) {
      sink = emitter;
    },
    ready,
    uow: {
      async run(fn) {
        await ready;
        return work.run(fn);
      },
      async exclusive(key, fn) {
        await ready;
        return work.exclusive(key, fn);
      },
    },
    resolutionUow: {
      async run(fn) {
        await ready;
        return resolution.run(fn);
      },
    },
    close() {
      closing ??= (async () => {
        await ready;
        await client.close();
        runtimes.delete(directory);
        unlinkSync(lock);
      })();
      return closing;
    },
  };
  runtimes.set(directory, runtime);
  return runtime;
}
