import { assert, test } from "vitest";
import {
  type Adapter,
  FixtureAdapter,
  type OperationResult,
  SandboxAdapter,
} from "../src/adapters";
import { SANDBOX_API_BASE, validateEvent } from "../src/contract";
import { EventLog, MemoryStore } from "../src/log";
import { DemoRunner } from "../src/runner";
import { STEP_IDS, STEPS } from "../src/steps";
import { fixedClock, withOwnerGate } from "./helpers";

function make(adapter: Adapter = new FixtureAdapter()) {
  const log = new EventLog(new MemoryStore());
  const runner = new DemoRunner({ log, adapter, clock: fixedClock(), role: "buyer" });
  return { log, runner, adapter };
}

test("fixture run passes every step and every event validates and is labelled fixture", async () => {
  const { runner } = make();
  await runner.start();
  const outcomes = await runner.runAll();
  assert.equal(outcomes.length, STEPS.length);
  for (const o of outcomes) assert.equal(o.state, "passed", o.step_id);
  const events = await runner.log.list(runner.run_id);
  for (const e of events) {
    assert.equal(validateEvent(e).ok, true, validateEvent(e).errors.join());
    assert.ok(e.source === "mock" || e.source === "local", e.kind);
    assert.equal(e.environment, "local");
  }
  const snap = await runner.snapshot();
  assert.deepEqual(
    snap.steps.map((s) => s.state),
    STEP_IDS.map(() => "passed"),
  );
});

test("every step's events share one correlation id and are contiguous in seq", async () => {
  const { runner } = make();
  await runner.start();
  const o = await runner.runStep("C03");
  const ids = new Set(o.events.map((e) => e.correlation_id));
  assert.equal(ids.size, 1);
  const seqs = o.events.map((e) => e.seq);
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], (seqs[i - 1] as number) + 1);
  assert.deepEqual(o.events.map((e) => e.kind).slice(0, 3), [
    "step.started",
    "operation.requested",
    "operation.responded",
  ]);
  assert.ok(
    o.events.some((e) => e.kind === "db.written" && e.db?.table === "ledger_entries"),
    "money step writes a ledger row",
  );
});

test("the runner switches the presentation role to match the step", async () => {
  const { runner } = make();
  await runner.start();
  assert.equal(runner.currentRole, "buyer");
  const o = await runner.runStep("C01");
  assert.equal(runner.currentRole, "creator");
  const sw = (await runner.log.list(runner.run_id)).find((e) => e.kind === "role.switched");
  assert.ok(sw);
  assert.equal(sw.payload.scope, "presentation");
  assert.ok(o.events.every((e) => e.role === "creator"));
});

test("a sandbox adapter without a credential blocks on the credential gate; nothing is simulated", async () => {
  const { runner } = make(new SandboxAdapter({ apiKey: null, apiVersionDate: null }));
  await runner.start();
  const o = await runner.runStep("C01");
  assert.equal(o.state, "blocked");
  assert.equal(o.gate?.id, "CRED");
  assert.equal(o.source, "sandbox");
  assert.ok(o.events.every((e) => e.environment === "sandbox"));
  assert.ok(!o.events.some((e) => e.state === "passed"));
});

test("a sandbox adapter with a credential but no provider client blocks on wiring", async () => {
  const { runner } = make(
    new SandboxAdapter({ apiKey: "sk_test_placeholder_not_real", apiVersionDate: "2026-08-21" }),
  );
  await runner.start();
  const o = await runner.runStep("C01");
  assert.equal(o.state, "blocked");
  assert.equal(o.gate?.id, "WIRE");
  const leaked = o.events.some((e) => JSON.stringify(e).includes("sk_test_placeholder"));
  assert.equal(leaked, false, "credential never enters the log");
});

test("gated steps block on the owner gate before any sandbox call", async () => {
  let calls = 0;
  const client = async (): Promise<OperationResult> => {
    calls++;
    return {
      outcome: "ok",
      output: {},
      provider: {
        base_url: SANDBOX_API_BASE,
        http_status: 200,
        request_id: null,
        resource_ids: [],
        api_version_date: null,
        operation: null,
        duration_ms: null,
      },
      gate: null,
    };
  };
  const { runner } = make(new SandboxAdapter({ apiKey: "sk_x", apiVersionDate: null }, client));
  await runner.start();
  const o = await withOwnerGate("C05", () => runner.runStep("C05"));
  assert.equal(o.state, "blocked");
  assert.equal(o.gate?.id, "G01");
  assert.equal(calls, 0);
});

test("a sandbox client that claims success without an observed sandbox response is rejected as failed", async () => {
  const lying = async (): Promise<OperationResult> => ({
    outcome: "ok",
    output: { id: "acc_fake" },
    provider: null,
    gate: null,
  });
  const { runner } = make(new SandboxAdapter({ apiKey: "sk_x", apiVersionDate: null }, lying));
  await runner.start();
  const o = await runner.runStep("C01");
  assert.equal(o.state, "failed");
  assert.match(o.events.at(-1)?.summary ?? "", /without an observed response/);
});

test("a sandbox client with a real observed response passes and the pass carries the provider ref", async () => {
  const honest = async (): Promise<OperationResult> => ({
    outcome: "ok",
    output: { id: "biz_1" },
    provider: {
      base_url: SANDBOX_API_BASE,
      http_status: 200,
      request_id: "req_9",
      resource_ids: ["biz_1"],
      api_version_date: "2026-08-21",
      operation: null,
      duration_ms: null,
    },
    gate: null,
  });
  const { runner } = make(
    new SandboxAdapter({ apiKey: "sk_x", apiVersionDate: "2026-08-21" }, honest),
  );
  await runner.start();
  const o = await runner.runStep("C01");
  assert.equal(o.state, "passed");
  assert.equal(o.source, "sandbox");
  assert.equal(o.events.at(-1)?.provider?.http_status, 200);
});

test("a provider error ends the step as failed with the error in the log", async () => {
  const adapter = new FixtureAdapter({
    "accountLink.create": () => ({
      outcome: "error",
      output: { error: "onboarding link rejected" },
      provider: {
        base_url: "mock://local",
        http_status: 422,
        request_id: null,
        resource_ids: [],
        api_version_date: null,
        operation: null,
        duration_ms: null,
      },
      gate: null,
    }),
  });
  const { runner } = make(adapter);
  await runner.start();
  const o = await runner.runStep("C02");
  assert.equal(o.state, "failed");
  assert.equal(o.events.filter((e) => e.kind === "operation.responded").length, 1);
});

test("retrying a step increments attempt and keeps the earlier attempt in the log", async () => {
  const { runner } = make();
  await runner.start();
  const a = await runner.runStep("C01");
  const b = await runner.runStep("C01");
  assert.deepEqual([a.attempt, b.attempt], [1, 2]);
  assert.notEqual(a.correlation_id, b.correlation_id);
  const snap = await runner.snapshot();
  assert.equal(snap.steps[0]?.attempt, 2);
});
