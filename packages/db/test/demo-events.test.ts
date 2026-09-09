import { afterAll, beforeAll, expect, it } from "vitest";
import { CONTRACT_VERSION, type DemoEvent } from "../../demo-runtime/src/contract";
import { EventLog } from "../../demo-runtime/src/log";
import { createTestDb } from "../src/index";
import {
  createDemoEventStore,
  ensureDemoEventsTable,
  listDemoEventsAfter,
} from "../src/repos/demo-events";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
  await ensureDemoEventsTable(db);
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});

function draft(event_id: string, run_id = "run_db1") {
  const e: Omit<DemoEvent, "seq" | "contract_version"> = {
    event_id,
    run_id,
    correlation_id: "corr_1",
    kind: "step.started",
    step_id: "W01",
    attempt: 1,
    at: "2026-09-08T21:00:00.000Z",
    role: "buyer",
    source: "local",
    environment: "hybrid",
    state: "running",
    summary: "signup starts",
    payload: {},
    request: null,
    db: null,
    provider: null,
    gate: null,
    evidence_id: null,
  };
  return e;
}

it("appends through the log with sequential seq per run, dedupes ids, lists in order", async () => {
  const log = new EventLog(createDemoEventStore(db));
  const a = await log.append(draft("evt_1"));
  const b = await log.append(draft("evt_2"));
  const other = await log.append(draft("evt_3", "run_db2"));
  expect([a.seq, b.seq, other.seq]).toEqual([1, 2, 1]);
  const again = await log.append({ ...draft("evt_1"), summary: "redelivered" });
  expect(again.seq).toBe(1);
  expect(again.summary).toBe("signup starts");
  const listed = await log.list("run_db1");
  expect(listed.map((e) => e.seq)).toEqual([1, 2]);
  expect(listed[0]?.contract_version).toBe(CONTRACT_VERSION);
  expect(await listDemoEventsAfter(db, "run_db1", 1)).toHaveLength(1);
});

it("rejects a duplicate (run, seq) at the database and clears one run only", async () => {
  const store = createDemoEventStore(db);
  await expect(
    store.append({ ...draft("evt_dup"), seq: 1, contract_version: CONTRACT_VERSION }),
  ).rejects.toThrow();
  await store.clearRun("run_db1");
  expect(await store.list("run_db1")).toHaveLength(0);
  expect(await store.list("run_db2")).toHaveLength(1);
  expect(await store.lastSeq("run_db1")).toBe(0);
});
