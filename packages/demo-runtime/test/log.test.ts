import { assert, expect, test } from "vitest";
import { EventLog, MemoryStore } from "../src/log";
import { sampleEvent } from "./helpers";

function draft(id: string, over = {}) {
  const { seq: _s, contract_version: _c, ...rest } = sampleEvent({ event_id: id, ...over });
  return rest;
}

test("seq is assigned by the log and is strictly increasing per run", async () => {
  const log = new EventLog(new MemoryStore());
  const a = await log.append(draft("evt_1"));
  const b = await log.append(draft("evt_2"));
  const c = await log.append(draft("evt_3", { run_id: "run_other" }));
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 1]);
});

test("a duplicate event id is ignored and the stored copy returned", async () => {
  const log = new EventLog(new MemoryStore());
  const first = await log.append(draft("evt_dup", { summary: "first" }));
  const again = await log.append(draft("evt_dup", { summary: "second delivery" }));
  assert.equal(again.seq, first.seq);
  assert.equal(again.summary, "first");
  assert.equal((await log.list("run_a1")).length, 1);
});

test("concurrent appends still get unique sequential seqs", async () => {
  const log = new EventLog(new MemoryStore());
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) => log.append(draft(`evt_c${i}`))),
  );
  assert.deepEqual(
    results.map((e) => e.seq).sort((x, y) => x - y),
    Array.from({ length: 25 }, (_, i) => i + 1),
  );
});

test("consumers reading out of order still see seq order from list()", async () => {
  const store = new MemoryStore();
  const log = new EventLog(store);
  await log.append(draft("evt_o1"));
  await log.append(draft("evt_o2"));
  // Simulate a store that returns arrival order scrambled.
  const scrambled = (await store.list("run_a1")).reverse();
  assert.deepEqual(
    scrambled.map((e) => e.seq),
    [2, 1],
  );
  assert.deepEqual(
    (await log.list("run_a1")).map((e) => e.seq),
    [1, 2],
  );
});

test("stream replays after a seq and then delivers live events", async () => {
  const log = new EventLog(new MemoryStore());
  await log.append(draft("evt_s1"));
  await log.append(draft("evt_s2"));
  const ac = new AbortController();
  const seen: number[] = [];
  const consumer = (async () => {
    for await (const e of log.stream("run_a1", 1, ac.signal)) {
      seen.push(e.seq);
      if (seen.length === 2) ac.abort();
    }
  })();
  await new Promise((r) => setTimeout(r, 10));
  await log.append(draft("evt_s3"));
  await consumer;
  assert.deepEqual(seen, [2, 3]);
});

test("invalid drafts are rejected before storage", async () => {
  const log = new EventLog(new MemoryStore());
  await expect(log.append(draft("evt_bad", { state: "verified" }))).rejects.toThrow(
    /verified cannot be emitted/,
  );
  assert.equal((await log.list("run_a1")).length, 0);
});

test("snapshot derives step state from the log, never from a counter", async () => {
  const log = new EventLog(new MemoryStore());
  await log.append(draft("evt_r0", { kind: "run.started", step_id: null, state: "pending" }));
  await log.append(draft("evt_r1"));
  await log.append(draft("evt_r2", { kind: "step.finished", state: "failed", summary: "failed" }));
  const snap = await log.snapshot("run_a1", ["C01", "C02"]);
  assert.equal(snap.last_seq, 3);
  assert.deepEqual(
    snap.steps.map((s) => [s.step_id, s.state]),
    [
      ["C01", "failed"],
      ["C02", "pending"],
    ],
  );
});
