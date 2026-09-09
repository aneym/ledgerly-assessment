import { assert, test } from "vitest";
import {
  type Adapter,
  FixtureAdapter,
  type OperationRequest,
  type OperationResult,
} from "../src/adapters";
import { validateEvent } from "../src/contract";
import { eventsHandler } from "../src/http";
import { EventLog, MemoryStore } from "../src/log";
import { DemoRunner } from "../src/runner";

/** Fixture adapter whose calls resolve only when the test says so. */
class SlowAdapter implements Adapter {
  readonly kind = "mock" as const;
  readonly pending: (() => void)[] = [];
  private readonly inner = new FixtureAdapter();
  async call(req: OperationRequest): Promise<OperationResult> {
    await new Promise<void>((resolve) => this.pending.push(resolve));
    return this.inner.call(req);
  }
  release() {
    const all = this.pending.splice(0);
    for (const r of all) r();
  }
}

test("reset while a step is in flight drains the step first; no old-run event lands in the new run", async () => {
  const adapter = new SlowAdapter();
  const log = new EventLog(new MemoryStore());
  const runner = new DemoRunner({ log, adapter });
  await runner.start();
  const old = runner.run_id;
  const step = runner.runStep("C01");
  await new Promise((r) => setTimeout(r, 5));
  const reset = runner.reset("mid-flight");
  let resetDone = false;
  reset.then(() => {
    resetDone = true;
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(resetDone, false, "reset waits for the in-flight step");
  adapter.release();
  const outcome = await step;
  const resetEvent = await reset;
  assert.equal(outcome.state, "passed");
  assert.ok(
    outcome.events.every((e) => e.run_id === old),
    "every step event belongs to the old run",
  );
  assert.equal(resetEvent.run_id, runner.run_id);
  assert.notEqual(resetEvent.run_id, old);
  const fresh = await log.list(runner.run_id);
  assert.deepEqual(
    fresh.map((e) => e.kind),
    ["run.reset"],
    "new run holds only the reset event",
  );
  assert.equal((await log.list(old)).length, 0);
});

test("two concurrent runs of the same step get distinct attempts and correlation ids, all events valid", async () => {
  const runner = new DemoRunner({
    log: new EventLog(new MemoryStore()),
    adapter: new FixtureAdapter(),
  });
  await runner.start();
  const [a, b] = await Promise.all([runner.runStep("C01"), runner.runStep("C01")]);
  assert.deepEqual([a.attempt, b.attempt].sort(), [1, 2]);
  assert.notEqual(a.correlation_id, b.correlation_id);
  const all = await runner.log.list(runner.run_id);
  for (const e of all) assert.equal(validateEvent(e).ok, true, validateEvent(e).errors.join());
  const seqs = all.map((e) => e.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((x, y) => x - y),
    "seq order is total even when attempts interleave",
  );
  assert.equal(new Set(seqs).size, seqs.length, "no duplicate seq");
  const byCorr = new Map<string, number>();
  for (const e of all)
    if (e.step_id) byCorr.set(e.correlation_id, (byCorr.get(e.correlation_id) ?? 0) + 1);
  assert.equal(byCorr.size, 2);
});

test("a panel that reconnects after a reset with a stale Last-Event-ID from the old run gets a full replay", async () => {
  const runner = new DemoRunner({
    log: new EventLog(new MemoryStore()),
    adapter: new FixtureAdapter(),
  });
  await runner.start();
  await runner.runStep("C01");
  const oldRun = runner.run_id;
  const oldLast = (await runner.snapshot()).last_seq;
  assert.ok(oldLast > 3);
  await runner.reset();
  await runner.runStep("C01");
  const handler = eventsHandler(runner);
  const read = async (headers: Record<string, string>) => {
    const ac = new AbortController();
    const res = handler(new Request("http://x/api/demo/events", { headers, signal: ac.signal }));
    assert.ok(res.body);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!buf.includes("event: step.finished")) buf += dec.decode((await reader.read()).value);
    ac.abort();
    return buf.match(/^id: (\d+)$/gm)?.map((l) => Number(l.slice(4))) ?? [];
  };
  const stale = await read({ "last-event-id": String(oldLast), "x-demo-run": oldRun });
  assert.equal(stale[0], 1, "stale run id resets the cursor to the start of the new run");
  const same = await read({ "last-event-id": "2", "x-demo-run": runner.run_id });
  assert.equal(same[0], 3, "same run id resumes after the cursor");
  const noRun = await read({ "last-event-id": "2" });
  assert.equal(noRun[0], 3, "no run header keeps the old behaviour");
});

test("a duplicate delivery of the same event id through the log never produces a second row or a second listener call", async () => {
  const log = new EventLog(new MemoryStore());
  let calls = 0;
  log.subscribe(() => calls++);
  const runner = new DemoRunner({ log, adapter: new FixtureAdapter() });
  const started = await runner.start();
  const { seq: _s, contract_version: _c, ...draft } = started;
  await log.append({ ...draft, summary: "redelivered" });
  await log.append({ ...draft, summary: "redelivered again" });
  assert.equal(calls, 1);
  assert.equal((await log.list(runner.run_id)).length, 1);
});
