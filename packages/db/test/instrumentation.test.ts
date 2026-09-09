import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { InstrumentationEvent } from "../../core/src/instrumentation";
import { createTestDb } from "../src/client";
import {
  insertInstrumentationEvent,
  listInstrumentationEvents,
} from "../src/repos/instrumentation";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});
beforeEach(async () => {
  await db.$client.exec("TRUNCATE instrumentation_events");
});
function event(overrides: Partial<InstrumentationEvent> = {}): InstrumentationEvent {
  return {
    correlationId: "corr_1",
    source: "app_api",
    phase: "start",
    path: "/api/thing",
    status: null,
    provenance: "app",
    safeIds: {},
    summary: "app_api started",
    at: new Date("2026-09-08T12:00:00Z"),
    ...overrides,
  };
}
it("inserts an event and assigns id and seq", async () => {
  const row = await insertInstrumentationEvent(db, event());
  expect(row.id).toBeTruthy();
  expect(row.seq).toBeGreaterThan(0);
  expect(row).toMatchObject({ correlationId: "corr_1", source: "app_api", phase: "start" });
});
it("round-trips a numeric status, a db status, and undefined optional fields", async () => {
  await insertInstrumentationEvent(db, event({ correlationId: "corr_status", status: 200 }));
  await insertInstrumentationEvent(
    db,
    event({ correlationId: "corr_status", source: "db", phase: "end", status: "ok" }),
  );
  const rows = await listInstrumentationEvents(db, { correlationId: "corr_status" });
  expect(rows.map((row) => row.status)).toEqual([200, "ok"]);
  expect(rows[0]?.runId).toBeUndefined();
  expect(rows[0]?.durationMs).toBeUndefined();
});
it("lists events by correlation id in seq order", async () => {
  await insertInstrumentationEvent(db, event({ correlationId: "corr_a", summary: "first" }));
  await insertInstrumentationEvent(db, event({ correlationId: "corr_b", summary: "other" }));
  await insertInstrumentationEvent(db, event({ correlationId: "corr_a", summary: "second" }));
  const rows = await listInstrumentationEvents(db, { correlationId: "corr_a" });
  expect(rows.map((row) => row.summary)).toEqual(["first", "second"]);
  expect(rows[0]?.seq ?? 0).toBeLessThan(rows[1]?.seq ?? 0);
});
it("lists events by run id", async () => {
  await insertInstrumentationEvent(db, event({ correlationId: "corr_c", runId: "run_1" }));
  await insertInstrumentationEvent(db, event({ correlationId: "corr_d", runId: "run_2" }));
  const rows = await listInstrumentationEvents(db, { runId: "run_1" });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.correlationId).toBe("corr_c");
});
it("filters by afterSeq to support resuming a stream", async () => {
  const first = await insertInstrumentationEvent(db, event({ correlationId: "corr_e" }));
  await insertInstrumentationEvent(db, event({ correlationId: "corr_e", summary: "second" }));
  const rows = await listInstrumentationEvents(db, {
    correlationId: "corr_e",
    afterSeq: first.seq,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.summary).toBe("second");
});
it("round-trips gate without leaking it into safeIds, and omits it when unset", async () => {
  await insertInstrumentationEvent(
    db,
    event({
      correlationId: "corr_gate",
      source: "whop",
      phase: "end",
      status: 403,
      safeIds: { sellerId: "seller_1" },
      gate: { id: "G01", reason: "Whop capability is not active on this account" },
    }),
  );
  await insertInstrumentationEvent(
    db,
    event({ correlationId: "corr_gate", source: "whop", phase: "end", summary: "ungated" }),
  );
  const rows = await listInstrumentationEvents(db, { correlationId: "corr_gate" });
  expect(rows[0]?.gate).toEqual({
    id: "G01",
    reason: "Whop capability is not active on this account",
  });
  expect(rows[0]?.safeIds).toEqual({ sellerId: "seller_1" });
  expect(rows[1]?.gate).toBeUndefined();
});
