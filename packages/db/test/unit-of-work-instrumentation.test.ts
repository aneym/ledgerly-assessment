// Covers the additive instrumentation hook on createPgliteUnitOfWork: an injected emitter
// (default no-op) sees one db event per finished transaction, whether run() or exclusive()
// finished it. The instrumentation_events table and repo are exercised separately in
// instrumentation.test.ts once packages/db/src/schema.ts carries that table; this file only
// needs an Emitter stub, since the unit of work never writes to that table itself.
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { runId, sellerId } from "../../core/src/ids";
import type { Emitter, InstrumentationEvent } from "../../core/src/instrumentation";
import { createPgliteUnitOfWork } from "../src/repos/unit-of-work";

const migrationsFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));
let client: PGlite;
beforeAll(async () => {
  client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder });
}, 30000);
afterAll(async () => {
  await client?.close();
});
beforeEach(async () => {
  await client.exec(
    "TRUNCATE ledger_entries,business_effects,webhook_inbox,operations,orders,sellers RESTART IDENTITY",
  );
});
function id(value: string) {
  const result = sellerId(value);
  if (!result.ok) throw new Error("bad seller id");
  return result.value;
}
function mintRunId(value: string) {
  const result = runId(value);
  if (!result.ok) throw new Error("bad run id");
  return result.value;
}
it("stays a no-op without an emitter, matching prior behavior", async () => {
  const uow = createPgliteUnitOfWork(client);
  await expect(
    uow.run((r) =>
      r.sellers.createOrFetch(
        {
          runId: mintRunId("run_1"),
          externalId: "alice",
          email: "a@example.invalid",
          country: "US",
        },
        id("seller_noop"),
      ),
    ),
  ).resolves.toBeDefined();
});
it("emits one db end event with status ok when run() commits", async () => {
  const events: InstrumentationEvent[] = [];
  const emitter: Emitter = { emit: (event) => events.push(event) };
  const uow = createPgliteUnitOfWork(client, emitter);
  await uow.run((r) =>
    r.sellers.createOrFetch(
      { runId: mintRunId("run_1"), externalId: "bob", email: "b@example.invalid", country: "US" },
      id("seller_ok"),
    ),
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    source: "db",
    phase: "end",
    status: "ok",
    provenance: "pglite",
  });
  expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
});
it("emits a db end event with status error when the transaction throws", async () => {
  const emitter: Emitter = { emit: vi.fn() };
  const uow = createPgliteUnitOfWork(client, emitter);
  await expect(
    uow.run(async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  const emitted = vi.mocked(emitter.emit).mock.calls.map(([event]) => event);
  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({ source: "db", phase: "end", status: "error" });
});
it("emits one event per run() call made inside exclusive()", async () => {
  const events: InstrumentationEvent[] = [];
  const emitter: Emitter = { emit: (event) => events.push(event) };
  const uow = createPgliteUnitOfWork(client, emitter);
  await uow.exclusive("lock_1", async ({ run }) => {
    await run((r) =>
      r.sellers.createOrFetch(
        {
          runId: mintRunId("run_1"),
          externalId: "carol",
          email: "c@example.invalid",
          country: "US",
        },
        id("seller_excl"),
      ),
    );
  });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ source: "db", phase: "end", status: "ok" });
});
