import { assert, test } from "vitest";
import { validateEvent } from "../src/contract";
import {
  CORRELATION_HEADER,
  CorrelationTable,
  fromInstrumentationEvent,
  type InstrumentationEvent,
} from "../src/instrumentation";
import { EventLog, MemoryStore } from "../src/log";
import { reduceTour, tourHeaders } from "../src/tour";
import { type Result, Tracer, tracePort, withTrace } from "../src/trace";

function ev(over: Partial<InstrumentationEvent>): InstrumentationEvent {
  return {
    id: "ie1",
    seq: 1,
    correlation_id: "corr_w02a",
    run_id: "run_h1",
    source: "app_api",
    phase: "start",
    method: "POST",
    path: "/api/sellers",
    status: null,
    duration_ms: null,
    provenance: "app",
    safe_ids: {},
    summary: "POST /api/sellers received",
    at: "2026-09-08T19:30:00.000Z",
    ...over,
  };
}

/** Plays a list of architecture events through the mapper and the log, then reduces the tour. */
async function play(list: InstrumentationEvent[], table: CorrelationTable) {
  const log = new EventLog(new MemoryStore());
  for (const e of list) {
    const d = fromInstrumentationEvent(e, { stepOf: (c) => table.stepOf(c), run_id: "run_h1" });
    if (d) await log.append(d);
  }
  const events = await log.list("run_h1");
  for (const e of events) assert.equal(validateEvent(e).ok, true, validateEvent(e).errors.join());
  return { events, state: reduceTour(events, undefined, { stepOf: (c) => table.stepOf(c) }) };
}

test("a full C01 slice from architecture's stream passes as sandbox-ok with ids and durations carried through", async () => {
  const table = new CorrelationTable(() => "corr_w02a");
  const corr = table.begin("C01");
  const { events, state } = await play(
    [
      ev({ id: "a", seq: 1, correlation_id: corr }),
      ev({
        id: "b",
        seq: 2,
        correlation_id: corr,
        source: "whop",
        phase: "start",
        path: "/accounts",
        provenance: "sandbox",
        summary: "POST /accounts",
      }),
      ev({
        id: "c",
        seq: 3,
        correlation_id: corr,
        source: "whop",
        phase: "end",
        path: "/accounts",
        provenance: "sandbox",
        status: 200,
        duration_ms: 412,
        safe_ids: { whop_account_id: "biz_abc123" },
        summary: "POST /accounts 200",
      }),
      ev({
        id: "d",
        seq: 4,
        correlation_id: corr,
        source: "db",
        phase: "end",
        method: "commit",
        path: "sellers",
        provenance: "neon",
        status: "ok",
        duration_ms: 9,
        safe_ids: { seller_id: "sel_1a2b3c" },
        summary: "sellers committed",
      }),
      ev({
        id: "e",
        seq: 5,
        correlation_id: corr,
        source: "db",
        phase: "end",
        method: "commit",
        path: "operations",
        provenance: "neon",
        status: "ok",
        duration_ms: 3,
        safe_ids: { idempotency_key: "k1" },
        summary: "operations committed",
      }),
      ev({
        id: "f",
        seq: 6,
        correlation_id: corr,
        phase: "end",
        status: 201,
        duration_ms: 480,
        summary: "POST /api/sellers 201",
      }),
    ],
    table,
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    [
      "request.started",
      "operation.requested",
      "operation.responded",
      "db.written",
      "db.written",
      "request.finished",
    ],
  );
  assert.ok(events.every((e) => e.step_id === "C01" && e.correlation_id === corr));
  const w02 = state.steps.find((s) => s.step.id === "C01");
  assert.equal(w02?.status, "passed");
  assert.equal(w02?.proof.level, "sandbox-ok");
  assert.equal(w02?.proof.request?.duration_ms, 480);
  assert.deepEqual(w02?.proof.provider[0]?.resource_ids, ["biz_abc123"]);
  assert.deepEqual(
    w02?.proof.db.map((d) => d.table),
    ["sellers", "operations"],
  );
  assert.equal(state.active_index, 1, "C01 passed; C02 is now active");
});

test("a mock provenance end event yields mock-ok and a gate field yields blocked; a sandbox end without status is unconfirmed", async () => {
  const table = new CorrelationTable();
  const c1 = table.begin("C01");
  const c2 = table.begin("C03");
  const c3 = table.begin("C02");
  const base = (corr: string, id: string, over: Partial<InstrumentationEvent>) =>
    ev({ id, correlation_id: corr, source: "whop", phase: "end", ...over });
  const { events, state } = await play(
    [
      ev({
        id: "r1",
        correlation_id: c1,
        phase: "end",
        status: 201,
        duration_ms: 1,
        summary: "ok",
      }),
      base(c1, "m1", {
        path: "/accounts",
        provenance: "mock",
        status: 200,
        duration_ms: 2,
        safe_ids: { whop_account_id: "mock_biz1" },
        summary: "mock",
      }),
      ev({
        id: "d1",
        correlation_id: c1,
        source: "db",
        phase: "end",
        path: "sellers",
        status: "ok",
        provenance: "pglite",
        safe_ids: { seller_id: "sel_x" },
        summary: "db",
      }),
      ev({
        id: "d2",
        correlation_id: c1,
        source: "db",
        phase: "end",
        path: "operations",
        status: "ok",
        provenance: "pglite",
        safe_ids: {},
        summary: "db",
      }),
      base(c2, "g1", {
        path: "/transfers",
        provenance: "sandbox",
        status: 422,
        duration_ms: 5,
        gate: { id: "G01", reason: "transfer capability inactive" },
        summary: "gated",
      }),
      base(c3, "u1", {
        path: "/accounts",
        provenance: "sandbox",
        status: null,
        duration_ms: 7,
        summary: "no status",
      }),
    ],
    table,
  );
  const w02 = state.steps.find((s) => s.step.id === "C01");
  assert.equal(w02?.status, "passed");
  assert.equal(w02?.proof.level, "mock-ok");
  const w06 = state.steps.find((s) => s.step.id === "C03");
  assert.equal(w06?.status, "blocked");
  assert.equal(w06?.gate?.id, "G01");
  const unc = events.find((e) => e.event_id === "evt_u1");
  assert.equal(unc?.payload.unconfirmed, true);
  assert.equal(state.steps.find((s) => s.step.id === "C02")?.proof.level, "sandbox-unconfirmed");
});

test("db start frames and untracked correlations map to nothing the tour counts", async () => {
  const table = new CorrelationTable();
  const d = fromInstrumentationEvent(ev({ source: "db", phase: "start", path: "sellers" }), {
    stepOf: (c) => table.stepOf(c),
    run_id: "run_h1",
  });
  assert.equal(d, null);
  const { state } = await play(
    [ev({ id: "z", correlation_id: "corr_unknown", phase: "end", status: 201, summary: "stray" })],
    table,
  );
  assert.ok(state.steps.every((s) => s.status === "pending" || s.status === "active"));
});

test("the correlation table survives a dump and load, and tourHeaders carries the id", () => {
  const t1 = new CorrelationTable(() => "corr_fixed");
  t1.begin("C03");
  const t2 = new CorrelationTable();
  t2.load(t1.dump());
  assert.equal(t2.stepOf("corr_fixed"), "C03");
  assert.equal(
    tourHeaders("C03", "buyer", "run_1", "corr_fixed")["x-ledgerly-correlation-id"],
    "corr_fixed",
  );
});

test("withTrace prefers x-ledgerly-correlation-id and echoes it; tracePort reads value.meta by default", async () => {
  const log = new EventLog(new MemoryStore());
  const tracer = new Tracer({ log, run_id: "run_h2", environment: "hybrid" });
  const handler = withTrace(
    tracer,
    "/api/sellers",
    async () => new Response(null, { status: 200 }),
  );
  const res = await handler(
    new Request("http://x/api/sellers", {
      headers: { [CORRELATION_HEADER]: "corr_from_client", "x-request-id": "req_ignored" },
    }),
  );
  assert.equal(res.headers.get(CORRELATION_HEADER), "corr_from_client");
  assert.equal(res.headers.get("x-request-id"), "corr_from_client");
  const port = {
    async createTransfer(): Promise<
      Result<
        {
          id: string;
          raw: unknown;
          meta: { source: "mock"; status: number; gate: { id: string; reason: string } };
        },
        never
      >
    > {
      return {
        ok: true,
        value: {
          id: "mock_trf1",
          raw: {},
          meta: {
            source: "mock",
            status: 200,
            gate: { id: "G01", reason: "transfer inactive; mock transport" },
          },
        },
      };
    },
  };
  const ctx = tracer.begin("POST", "/api/checkouts", new Headers({ "x-tour-step": "C03" }));
  await tracePort(port, tracer, () => ctx).createTransfer();
  const resp = (await log.list("run_h2")).at(-1);
  assert.equal(resp?.source, "mock");
  assert.equal(
    resp?.state,
    "running",
    "a labelled mock fallback is not a block and not a sandbox pass",
  );
  assert.match(resp?.summary ?? "", /mock because G01/);
  const state = reduceTour(await log.list("run_h2"));
  const w06 = state.steps.find((s) => s.step.id === "C03");
  assert.equal(w06?.proof.provider[0]?.fallback_gate?.id, "G01");
  assert.equal(w06?.proof.level, "mock-ok");
});

test("a unit-of-work commit that reports seller_id satisfies the sellers table expectation, and an uncorrelated provider call leaves the step observing", async () => {
  const table = new CorrelationTable(() => "corr_w02uow");
  const corr = table.begin("C01");
  const { state } = await play(
    [
      ev({ id: "u1", seq: 1, correlation_id: corr }),
      ev({
        id: "u2",
        seq: 2,
        correlation_id: corr,
        source: "db",
        phase: "end",
        method: "commit",
        path: "db transaction committed",
        provenance: "neon",
        status: "ok",
        duration_ms: 5,
        safe_ids: { seller_id: "ee0586da-9c8d-40df-a634-0453b0e77b61" },
        summary: "db transaction committed",
      }),
      ev({ id: "u3", seq: 3, correlation_id: corr, phase: "end", status: 201, duration_ms: 3538, summary: "POST /api/sellers 201" }),
    ],
    table,
  );
  const w02 = state.steps.find((s) => s.step.id === "C01");
  assert.equal(w02?.status, "observing");
  assert.deepEqual(w02?.proof.missing, ["provider createOrFetchAccount"], "the sellers row is observed through seller_id; only the provider call is missing");
  assert.equal(w02?.proof.level, "local-ok");
});


test("default tour correlations survive UUID-only navigation parameters", () => {
  const table = new CorrelationTable();
  const id = table.begin("C03");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(table.stepOf(id), "C03");
});
