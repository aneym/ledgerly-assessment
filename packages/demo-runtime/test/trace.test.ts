import { assert, expect, test } from "vitest";
import { validateEvent } from "../src/contract";
import { EventLog, MemoryStore } from "../src/log";
import { type Result, TOUR_STEP_HEADER, Tracer, tracePort, withTrace } from "../src/trace";
import { fixedClock } from "./helpers";

function make() {
  const log = new EventLog(new MemoryStore());
  let t = 0;
  const tracer = new Tracer({
    log,
    run_id: "run_trace1",
    environment: "hybrid",
    clock: fixedClock(),
    now: () => {
      t += 12;
      return t;
    },
  });
  return { log, tracer };
}

test("withTrace emits request.started and request.finished with the tour step, request id and duration", async () => {
  const { log, tracer } = make();
  const handler = withTrace(tracer, "/api/sellers", async (_req, ctx) => {
    await tracer.db(ctx, "sellers", ["sel_abc123"]);
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  });
  const res = await handler(
    new Request("http://x/api/sellers", {
      method: "POST",
      headers: { [TOUR_STEP_HEADER]: "C01", "x-demo-role": "creator" },
    }),
  );
  assert.equal(res.status, 201);
  const rid = res.headers.get("x-request-id");
  assert.ok(rid?.startsWith("req_"));
  const events = await log.list("run_trace1");
  assert.deepEqual(
    events.map((e) => e.kind),
    ["request.started", "db.written", "request.finished"],
  );
  for (const e of events) {
    assert.equal(validateEvent(e).ok, true, validateEvent(e).errors.join());
    assert.equal(e.step_id, "C01");
    assert.equal(e.role, "creator");
    assert.equal(e.correlation_id, rid);
    assert.equal(e.source, "local");
  }
  const fin = events[2];
  assert.equal(fin?.request?.http_status, 201);
  assert.ok((fin?.request?.duration_ms ?? 0) > 0);
  assert.deepEqual(events[1]?.db, { table: "sellers", ids: ["sel_abc123"] });
});

test("a handler that throws still closes the request as 500 and rethrows", async () => {
  const { log, tracer } = make();
  const handler = withTrace(tracer, "/api/boom", async () => {
    throw new Error("db down");
  });
  await expect(handler(new Request("http://x/api/boom"))).rejects.toThrow(/db down/);
  const fin = (await log.list("run_trace1")).at(-1);
  assert.equal(fin?.kind, "request.finished");
  assert.equal(fin?.request?.http_status, 500);
  assert.equal(fin?.state, "failed");
});

type Meta = { source: "sandbox" | "mock"; status?: number; requestId?: string };
type AccountValue = { id: string; raw: unknown; meta?: Meta };
type Port = {
  createOrFetchAccount(
    input: { externalId: string; email: string },
    key: string,
  ): Promise<Result<AccountValue, { kind: string; status?: number }>>;
};

test("tracePort labels responses from the port result, keeps the raw body out, and marks unconfirmed sandbox status", async () => {
  const { log, tracer } = make();
  const port: Port = {
    async createOrFetchAccount() {
      return {
        ok: true,
        value: {
          id: "biz_abc123",
          raw: { secret: "sk_fake_should_not_leak" },
          meta: { source: "sandbox", status: 200, requestId: "req_whop1" },
        },
      };
    },
  };
  const ctx = tracer.begin("POST", "/api/sellers", new Headers({ [TOUR_STEP_HEADER]: "C01" }));
  const traced = tracePort(
    port,
    tracer,
    () => ctx,
    (r) =>
      r.ok
        ? ((r.value as AccountValue | undefined)?.meta ?? { source: "sandbox" })
        : { source: "sandbox" },
  );
  const result = await traced.createOrFetchAccount({ externalId: "s1", email: "a@b.c" }, "k1");
  assert.equal(result.ok, true);
  const events = await log.list("run_trace1");
  assert.deepEqual(
    events.map((e) => e.kind),
    ["operation.requested", "operation.responded"],
  );
  const resp = events[1];
  assert.equal(resp?.source, "sandbox");
  assert.equal(resp?.provider?.http_status, 200);
  assert.equal(resp?.provider?.request_id, "req_whop1");
  assert.deepEqual(resp?.provider?.resource_ids, ["biz_abc123"]);
  assert.equal(resp?.provider?.operation, "createOrFetchAccount");
  assert.ok(!JSON.stringify(events).includes("sk_fake"), "raw body never enters the log");
  assert.equal(validateEvent(resp).ok, true, validateEvent(resp).errors.join());

  const port2: Port = {
    async createOrFetchAccount() {
      return { ok: true, value: { id: "biz_x1y2z3", raw: null } };
    },
  };
  const traced2 = tracePort(
    port2,
    tracer,
    () => ctx,
    () => ({ source: "sandbox" }),
  );
  await traced2.createOrFetchAccount({ externalId: "s2", email: "b@b.c" }, "k2");
  const unc = (await log.list("run_trace1")).at(-1);
  assert.equal(unc?.payload.unconfirmed, true);
  assert.equal(unc?.provider?.http_status, null);
  assert.equal(validateEvent(unc).ok, true, validateEvent(unc).errors.join());
});

test("tracePort turns capability and credential errors into gates and other errors into failed", async () => {
  const { log, tracer } = make();
  const ctx = tracer.begin("POST", "/api/transfers", new Headers({ [TOUR_STEP_HEADER]: "C03" }));
  const port = {
    async createTransfer(): Promise<Result<never, { kind: string; status?: number }>> {
      return { ok: false, error: { kind: "capability_inactive" } };
    },
    async refundPayment(): Promise<Result<never, { kind: string; status?: number }>> {
      return { ok: false, error: { kind: "http", status: 422 } };
    },
  };
  const traced = tracePort(
    port,
    tracer,
    () => ctx,
    (r) => ({
      source: "sandbox",
      status: r.ok ? 200 : ((r.error as { status?: number }).status ?? null),
    }),
  );
  await traced.createTransfer();
  await traced.refundPayment();
  const [, gated, , failed] = await log.list("run_trace1");
  assert.equal(gated?.state, "blocked");
  assert.equal(gated?.gate?.id, "G01");
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.provider?.http_status, 422);
});
