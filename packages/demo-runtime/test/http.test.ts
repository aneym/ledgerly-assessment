import { assert, test } from "vitest";
import { FixtureAdapter } from "../src/adapters";
import type { DemoEvent, RunSnapshot } from "../src/contract";
import { commandHandler, eventsHandler, snapshotHandler, toSSE } from "../src/http";
import { EventLog, MemoryStore } from "../src/log";
import type { StepOutcome } from "../src/runner";
import { DemoRunner } from "../src/runner";

function make() {
  const runner = new DemoRunner({
    log: new EventLog(new MemoryStore()),
    adapter: new FixtureAdapter(),
  });
  return runner;
}

test("command handler runs a step, snapshot reflects it, SSE replays from Last-Event-ID", async () => {
  const runner = make();
  await runner.start();
  const cmd = commandHandler(runner);
  const res = await cmd(
    new Request("http://x/api/demo/command", {
      method: "POST",
      body: JSON.stringify({ action: "run-step", step_id: "C01" }),
    }),
  );
  assert.equal(res.status, 200);
  const outcome = (await res.json()) as StepOutcome;
  assert.equal(outcome.state, "passed");
  const snap = (await (
    await snapshotHandler(runner)(new Request("http://x/api/demo/snapshot"))
  ).json()) as RunSnapshot;
  assert.equal(snap.steps[0]?.state, "passed");

  const ac = new AbortController();
  const sse = eventsHandler(runner)(
    new Request("http://x/api/demo/events", {
      headers: { "last-event-id": "2" },
      signal: ac.signal,
    }),
  );
  assert.equal(sse.headers.get("content-type"), "text/event-stream");
  assert.ok(sse.body);
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (!buf.includes(`id: ${snap.last_seq}\n`)) buf += dec.decode((await reader.read()).value);
  ac.abort();
  assert.ok(!buf.includes("id: 1\n"), "replayed after seq 2 only");
  assert.ok(buf.includes("id: 3\n"));
  assert.match(buf, /event: step\.finished/);
});

test("command handler rejects bad input and unknown steps", async () => {
  const runner = make();
  await runner.start();
  const cmd = commandHandler(runner);
  assert.equal((await cmd(new Request("http://x", { method: "POST", body: "nope" }))).status, 400);
  assert.equal(
    (
      await cmd(
        new Request("http://x", {
          method: "POST",
          body: JSON.stringify({ action: "run-step", step_id: "C99" }),
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await cmd(
        new Request("http://x", {
          method: "POST",
          body: JSON.stringify({ action: "switch-role", role: "root" }),
        }),
      )
    ).status,
    400,
  );
});

test("reset through the command route stays local", async () => {
  const runner = make();
  await runner.start();
  const before = runner.run_id;
  const res = await commandHandler(runner)(
    new Request("http://x", { method: "POST", body: JSON.stringify({ action: "reset" }) }),
  );
  const ev = (await res.json()) as DemoEvent;
  assert.equal(ev.kind, "run.reset");
  assert.equal(ev.payload.local_only, true);
  assert.notEqual(runner.run_id, before);
});

test("toSSE frames carry seq as id", () => {
  const frame = toSSE({ seq: 7, kind: "step.started" } as never);
  assert.ok(frame.startsWith("id: 7\nevent: step.started\ndata: "));
  assert.ok(frame.endsWith("\n\n"));
});
