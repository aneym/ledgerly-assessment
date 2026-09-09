import { assert, test } from "vitest";
import { type Adapter, FixtureAdapter } from "../src/adapters";
import { EventLog, MemoryStore } from "../src/log";
import { DemoRunner } from "../src/runner";
import { fixedClock } from "./helpers";

test("reset clears local events, mints a new run id and touches no adapter call", async () => {
  const adapter = new FixtureAdapter();
  const log = new EventLog(new MemoryStore());
  const runner = new DemoRunner({ log, adapter, clock: fixedClock() });
  await runner.start();
  await runner.runStep("C01");
  const before = runner.run_id;
  const callsBefore = adapter.calls.length;
  const ev = await runner.reset("clean slate");
  assert.notEqual(runner.run_id, before);
  assert.equal(adapter.calls.length, callsBefore, "reset made no provider call");
  assert.equal((await log.list(before)).length, 0, "old local run cleared");
  assert.equal(ev.kind, "run.reset");
  assert.equal(ev.payload.remote_untouched, true);
  assert.equal(ev.payload.previous_run_id, before);
  const snap = await runner.snapshot();
  assert.ok(snap.steps.every((s) => s.state === "pending" && s.attempt === 0));
});

test("the adapter seam exposes no destructive member", () => {
  const keys = Object.getOwnPropertyNames(FixtureAdapter.prototype).concat(
    Object.keys(new FixtureAdapter()),
  );
  const destructive = keys.filter((k) => /delete|remove|destroy|purge|wipe/i.test(k));
  assert.deepEqual(destructive, []);
  const a: Adapter = new FixtureAdapter();
  assert.deepEqual(Object.keys(a).sort(), ["calls", "counter", "kind", "overrides"]);
});
