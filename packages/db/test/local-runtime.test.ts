import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runId, sellerId } from "../../core/src/ids";
import { createDb } from "../src/client";
import {
  assertLocalRuntimeEnvironment,
  getLocalRuntime,
  type LocalRuntime,
} from "../src/local-runtime";
import { sellers } from "../src/schema";

const environment = {
  NODE_ENV: "test",
  LEDGERLY_LOCAL_RUNTIME: "1",
  LEDGERLY_TEST_MODE: "1",
  WHOP_MODE: "mock",
  APP_BASE_URL: "http://127.0.0.1:4474",
  LEDGERLY_LOCAL_DB_DIR: "/unused/local-runtime-test",
};
const directories: string[] = [];
const databases: LocalRuntime[] = [];
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "ledgerly-runtime-test-"));
  directories.push(directory);
  return { ...environment, LEDGERLY_LOCAL_DB_DIR: directory };
}
function database(env: typeof environment) {
  const db = getLocalRuntime(env);
  databases.push(db);
  return db;
}
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it.each([
  { LEDGERLY_LOCAL_RUNTIME: undefined },
  { LEDGERLY_TEST_MODE: undefined },
  { NODE_ENV: "production" },
  { NODE_ENV: undefined },
  { WHOP_MODE: "sandbox" },
  { WHOP_MODE: undefined },
  { DATABASE_URL: "postgres://example.invalid/db" },
  { WHOP_API_KEY: "dummy-test-value" },
  { VERCEL: "0" },
  { VERCEL_ENV: "preview" },
  { AWS_LAMBDA_FUNCTION_NAME: "local" },
  { RAILWAY_PROJECT_ID: "local" },
  { APP_BASE_URL: "http://example.invalid:4474" },
  { APP_BASE_URL: "http://127.0.0.1.evil.invalid:4474" },
  { APP_BASE_URL: "http://127.0.0.1:4474/path" },
  { APP_BASE_URL: "http://127.0.0.1:4474?query=1" },
  { APP_BASE_URL: "http://user:password@127.0.0.1:4474" },
  { APP_BASE_URL: "https://127.0.0.1:4474" },
  { BETTER_AUTH_URL: "http://localhost:4474" },
  { LEDGERLY_LOCAL_DB_DIR: "relative/path" },
])("rejects unsafe local configuration %#", (patch) => {
  expect(() => assertLocalRuntimeEnvironment({ ...environment, ...patch })).toThrow();
});

it("preserves the production Neon URL guard", () => {
  expect(() => createDb("postgres://localhost/ledgerly")).toThrow("requires a Neon");
});

it("migrates before the first transaction and persists rows after close/reopen", async () => {
  const env = await setup();
  const first = database(env);
  expect(getLocalRuntime(env)).toBe(first);
  const run = runId("run_local_runtime");
  const seller = sellerId("seller_local_runtime");
  if (!run.ok || !seller.ok) throw new Error("invalid fixture IDs");
  // No await ready here: transaction entry must wait for migrations itself.
  await first.uow.run((repos) =>
    repos.sellers.createOrFetch(
      {
        runId: run.value,
        externalId: "fictional-local",
        email: "local@example.invalid",
        country: "US",
      },
      seller.value,
    ),
  );
  await first.close();
  const second = database(env);
  expect(second).not.toBe(first);
  await second.ready;
  expect(await second.db.select().from(sellers)).toMatchObject([
    { id: seller.value, email: "local@example.invalid" },
  ]);
}, 30000);

it("rolls back a service transaction and permits subsequent work", async () => {
  const runtime = database(await setup());
  const run = runId("run_rollback");
  const seller = sellerId("seller_rollback");
  if (!run.ok || !seller.ok) throw new Error("invalid fixture IDs");
  await expect(
    runtime.uow.run(async (repos) => {
      await repos.sellers.createOrFetch(
        {
          runId: run.value,
          externalId: "rollback",
          email: "rollback@example.invalid",
          country: "US",
        },
        seller.value,
      );
      throw new Error("injected rollback");
    }),
  ).rejects.toThrow("injected rollback");
  expect(await runtime.db.select().from(sellers)).toEqual([]);
  await expect(runtime.resolutionUow.run(async () => "ready")).resolves.toBe("ready");
}, 30000);

it("refuses another process lock without deleting or replacing it", async () => {
  const env = await setup();
  await writeFile(join(env.LEDGERLY_LOCAL_DB_DIR, ".ledgerly-runtime.lock"), "12345\n", {
    flag: "wx",
  });
  expect(() => getLocalRuntime(env)).toThrow("database is locked");
  expect(() => getLocalRuntime(env)).toThrow("database is locked");
});

it("shares canonical aliases and refuses a conflicting active origin or secret", async () => {
  const env = await setup();
  const first = database(env);
  await first.ready;
  expect(getLocalRuntime({ ...env, LEDGERLY_LOCAL_DB_DIR: `${env.LEDGERLY_LOCAL_DB_DIR}/.` })).toBe(
    first,
  );
  expect(() => getLocalRuntime({ ...env, APP_BASE_URL: "http://127.0.0.1:4475" })).toThrow(
    "configuration differs",
  );
  expect(() =>
    getLocalRuntime({ ...env, BETTER_AUTH_SECRET: "different-throwaway-test-value" }),
  ).toThrow("configuration differs");
});

it("binds local transaction instrumentation after startup without replacing the database", async () => {
  const env = await setup();
  const local = database(env);
  const events: { source: string; status: number | string | null }[] = [];
  local.setEmitter({ emit: (event) => events.push(event) });
  await local.uow.run((repos) => repos.sellers.count());
  expect(events).toMatchObject([{ source: "db", status: "ok" }]);
  expect(getLocalRuntime(env)).toBe(local);
});
