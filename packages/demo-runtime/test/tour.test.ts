import { assert, test } from "vitest";
import type { DemoEvent } from "../src/contract";
import { EventLog, MemoryStore } from "../src/log";
import { STEPS } from "../src/steps";
import { reduceTour, tourHeaders } from "../src/tour";
import {
  type Result,
  TOUR_STEP_HEADER,
  type TraceContext,
  Tracer,
  tracePort,
  withTrace,
} from "../src/trace";
import { fixedClock } from "./helpers";

type Meta = { source: "sandbox" | "mock"; status?: number | null; requestId?: string };
type AccountPort = {
  createOrFetchAccount(): Promise<Result<{ id: string }, { kind: string }>>;
};

/** Drives the real instrumentation to produce the events a tour would see. */
function harness() {
  const log = new EventLog(new MemoryStore());
  let t = 0;
  const tracer = new Tracer({
    log,
    run_id: "run_tour1",
    environment: "hybrid",
    clock: fixedClock(),
    now: () => {
      t += 3;
      return t;
    },
  });
  let current: TraceContext = tracer.begin("POST", "/", new Headers());
  const call = async (
    step: string,
    route: string,
    body: (ctx: TraceContext) => Promise<number>,
  ) => {
    const handler = withTrace(
      tracer,
      route,
      async (_req, ctx) => new Response(null, { status: await body(ctx) }),
    );
    await handler(
      new Request(`http://x${route}`, { method: "POST", headers: { [TOUR_STEP_HEADER]: step } }),
    );
  };
  const port = (meta: Meta, ok = true): AccountPort =>
    tracePort<AccountPort>(
      {
        async createOrFetchAccount() {
          return ok
            ? { ok: true, value: { id: "biz_abcdef" } }
            : { ok: false, error: { kind: "capability_inactive" } };
        },
      },
      tracer,
      () => current,
      () => meta,
    );
  return {
    log,
    tracer,
    call,
    port,
    setCurrent: (c: TraceContext) => {
      current = c;
    },
  };
}

test("a fresh tour starts at C01 active with every other step pending", () => {
  const state = reduceTour([]);
  assert.equal(state.active_index, 0);
  assert.equal(state.steps[0]?.status, "active");
  assert.ok(state.steps.slice(1).every((s) => s.status === "pending"));
  assert.equal(state.outcome, "in-progress");
});

test("C01 passes as sandbox-ok after the seller write and provider response; C02 becomes active", async () => {
  const h = harness();
  await h.call("C01", "/api/sellers", async (ctx) => {
    await h.tracer.db(ctx, "sellers", ["sel_t1000001"]);
    h.setCurrent(ctx);
    await h.port({ source: "sandbox", status: 200 }).createOrFetchAccount();
    return 201;
  });
  const state = reduceTour(await h.log.list("run_tour1"));
  assert.equal(state.steps[0]?.status, "passed");
  assert.equal(state.steps[0]?.proof.level, "sandbox-ok");
  assert.deepEqual(state.steps[0]?.proof.db, [{ table: "sellers", ids: ["sel_t1000001"], keys: [] }]);
  assert.equal(state.steps[0]?.proof.request?.http_status, 201);
  assert.equal(state.active_index, 1);
});

test("a step with a provider expectation stays observing until the provider responds; sandbox-ok needs a status", async () => {
  const h = harness();
  await h.call("C01", "/api/sellers", async (ctx) => {
    await h.tracer.db(ctx, "sellers", ["sel_a1b2c3"]);
    await h.tracer.db(ctx, "operations", ["k1"]);
    return 201;
  });
  let state = reduceTour(await h.log.list("run_tour1"));
  const w02 = () => state.steps.find((s) => s.step.id === "C01");
  assert.equal(w02()?.status, "observing");
  assert.deepEqual(w02()?.proof.missing, ["provider createOrFetchAccount"]);

  const ctx = h.tracer.begin("POST", "/api/sellers", new Headers({ [TOUR_STEP_HEADER]: "C01" }));
  h.setCurrent(ctx);
  await h.port({ source: "sandbox", status: null }).createOrFetchAccount();
  state = reduceTour(await h.log.list("run_tour1"));
  assert.equal(w02()?.status, "passed");
  assert.equal(w02()?.proof.level, "sandbox-unconfirmed");

  const h2 = harness();
  await h2.call("C01", "/api/sellers", async (ctx2) => {
    await h2.tracer.db(ctx2, "sellers", ["sel_a1b2c3"]);
    await h2.tracer.db(ctx2, "operations", ["k1"]);
    h2.setCurrent(ctx2);
    await h2.port({ source: "sandbox", status: 200, requestId: "req_w1" }).createOrFetchAccount();
    return 201;
  });
  const s2 = reduceTour(await h2.log.list("run_tour1")).steps.find((s) => s.step.id === "C01");
  assert.equal(s2?.status, "passed");
  assert.equal(s2?.proof.level, "sandbox-ok");
  assert.deepEqual(s2?.proof.provider[0]?.resource_ids, ["biz_abcdef"]);
});

test("mock provider responses pass the step as mock-ok, never sandbox", async () => {
  const h = harness();
  await h.call("C01", "/api/sellers", async (ctx) => {
    await h.tracer.db(ctx, "sellers", ["sel_m1"]);
    await h.tracer.db(ctx, "operations", ["k1"]);
    h.setCurrent(ctx);
    await h.port({ source: "mock", status: 200 }).createOrFetchAccount();
    return 201;
  });
  const s = reduceTour(await h.log.list("run_tour1")).steps.find((x) => x.step.id === "C01");
  assert.equal(s?.status, "passed");
  assert.equal(s?.proof.level, "mock-ok");
});

test("a gated provider error blocks the step; the journey is not completed", async () => {
  const h = harness();
  await h.call("C03", "/api/checkouts", async (ctx) => {
    h.setCurrent(ctx);
    await h.port({ source: "sandbox", status: 200 }, false).createOrFetchAccount();
    return 200;
  });
  const state = reduceTour(await h.log.list("run_tour1"));
  const w06 = state.steps.find((s) => s.step.id === "C03");
  assert.equal(w06?.status, "blocked");
  assert.equal(w06?.gate?.id, "G01");
  assert.equal(state.outcome, "in-progress");
});

test("a 4xx holds the tour on the failed step with the observed error until it is retried or skipped", async () => {
  const h = harness();
  await h.call("C01", "/api/sellers", async () => 409);
  let state = reduceTour(await h.log.list("run_tour1"));
  assert.equal(state.steps[0]?.status, "failed");
  assert.equal(state.active_index, 0, "the failed step stays active; nothing advances on its own");
  assert.equal(state.steps[0]?.failure?.http_status, 409);
  assert.equal(state.steps[0]?.failure?.route, "POST /api/sellers");
  assert.match(state.steps[0]?.failure?.summary ?? "", /409/);
  const skipped = new Set(STEPS.map((s) => s.id));
  state = reduceTour(await h.log.list("run_tour1"), STEPS, { skipped });
  assert.equal(state.steps[0]?.status, "skipped");
  assert.equal(state.active_index, -1);
  assert.equal(state.outcome, "partial");
});

test("Retry permits another attempt but requires a successful response with seller identity", async () => {
  const h = harness();
  await h.call("C01", "/api/sellers", async () => 409);
  const failed = reduceTour(await h.log.list("run_tour1"));
  const cutoff = failed.steps[0]?.last_seq ?? 0;
  const retried = reduceTour(await h.log.list("run_tour1"), STEPS, { retryAfter: { C01: cutoff } });
  assert.equal(retried.steps[0]?.status, "active");
  assert.equal(retried.steps[0]?.failure, null);
  await h.call("C01", "/api/sellers", async (ctx) => {
    await h.tracer.db(ctx, "sellers", ["sel_retry1"]);
    h.setCurrent(ctx);
    await h.port({ source: "sandbox", status: 200 }).createOrFetchAccount();
    return 201;
  });
  const events = await h.log.list("run_tour1");
  const response = events.findLast((event) => event.kind === "request.finished");
  if (response) response.payload.safe_ids = { tour_seller_id: "sel_retry1" };
  const passed = reduceTour(events, STEPS, { retryAfter: { C01: cutoff } });
  assert.equal(reduceTour(events).steps[0]?.status, "passed");
  assert.equal(passed.steps[0]?.status, "passed");
  assert.equal(passed.active_index, 1);
});

test("events from other steps or without a tour header do not advance a step", async () => {
  const h = harness();
  await h.call("C03", "/api/checkouts", async (ctx) => {
    await h.tracer.db(ctx, "orders", ["ord_zz"]);
    return 201;
  });
  const handler = withTrace(h.tracer, "/api/sellers", async (_r, ctx) => {
    await h.tracer.db(ctx, "sellers", ["usr_untagged"]);
    return new Response(null, { status: 201 });
  });
  await handler(new Request("http://x/api/sellers", { method: "POST" }));
  const state = reduceTour(await h.log.list("run_tour1"));
  assert.equal(state.steps[0]?.status, "active", "C01 untouched by untagged traffic");
  assert.equal(state.steps.find((s) => s.step.id === "C03")?.status, "observing");
});

test("reset returns every step to pending", async () => {
  const h = harness();
  await h.call("C01", "/api/sellers", async (ctx) => {
    await h.tracer.db(ctx, "sellers", ["sel_r1"]);
    h.setCurrent(ctx);
    await h.port({ source: "sandbox", status: 200 }).createOrFetchAccount();
    return 201;
  });
  const events = await h.log.list("run_tour1");
  const last = events.at(-1);
  if (!last) throw new Error("no events");
  const reset: DemoEvent = {
    ...last,
    event_id: "evt_reset",
    seq: last.seq + 1,
    kind: "run.reset" as const,
    step_id: null,
    request: null,
    db: null,
    state: "pending" as const,
  };
  const state = reduceTour([...events, reset]);
  assert.ok(state.steps.every((s) => s.status === "pending" || s.status === "active"));
  assert.equal(state.active_index, 0);
});

test("tourHeaders carries step, role and run for the app's fetch calls", () => {
  assert.deepEqual(tourHeaders("C07", "admin", "run_1"), {
    "x-demo-role": "admin",
    "x-tour-step": "C07",
    "x-demo-run": "run_1",
  });
  assert.deepEqual(tourHeaders(null, "buyer", null), { "x-demo-role": "buyer" });
});

test("purchase has an explicit product destination after the buyer role switch", () => {
  assert.equal(STEPS.find((s) => s.id === "C03")?.path, "/p/grain-and-gradient");
});

test("C07 does not pass on a successful refetch, import, or unresolved recheck", async () => {
  const h = harness();
  for (const action of ["refetch", "import_confirmed", "recheck"]) {
    await h.call("C07", `/api/admin/issues/case_demo/actions/${action}`, async () => 200);
    assert.equal(reduceTour(await h.log.list("run_tour1")).steps[6]?.status, "observing");
  }
});

async function proofTrace(calls: { step: string; route: string; facts?: Record<string, string>; method?: string; status?: number }[]) {
  const h = harness();
  const events: DemoEvent[] = [];
  for (const call of calls) {
    await h.call(call.step, call.route, async (ctx) => {
      await h.tracer.db(ctx, "resolution_run", ["case_demo"]);
      return call.status ?? 200;
    });
    const batch = (await h.log.list("run_tour1")).filter((e) => e.seq > (events.at(-1)?.seq ?? 0));
    for (const event of batch) {
      if (event.kind === "request.finished") {
        event.payload = { ...event.payload, safe_ids: call.facts ?? {} };
        if (call.method && event.request) event.request.method = call.method;
      }
    }
    events.push(...batch);
  }
  return events;
}
const sellerCreated = { step: "C01", route: "/api/sellers", facts: { tour_seller_id: "sel_demo" } };
const injected = { step: "C06", route: "/api/admin/issues/demo-fault", facts: { tour_case_id: "case_demo", tour_source: "mock", tour_seller_id: "sel_demo" } };
const repair = (action: string, facts: Record<string, string> = {}, id = "case_demo") => ({
  step: "C07", route: `/api/admin/issues/${id}/actions/${action}`,
  facts: { tour_case_id: id, tour_issue_action: action, tour_action_succeeded: "true", tour_source: "mock", ...facts },
});

test("C07 passes only the injected case after refetch, import and confirmed resolved recheck", async () => {
  const events = await proofTrace([sellerCreated, injected, repair("refetch"), repair("import_confirmed"), repair("recheck", { tour_issue_resolved: "true" })]);
  const state = reduceTour(events);
  assert.equal(state.steps[6]?.status, "passed");
  assert.equal(state.steps[6]?.proof.level, "mock-ok");
});

test("wrong-case, out-of-order, unknown and failed action results cannot complete repair", async () => {
  for (const actions of [
    [repair("refetch"), repair("import_confirmed"), repair("recheck", { tour_issue_resolved: "true" }, "case_other")],
    [repair("import_confirmed"), repair("refetch"), repair("recheck", { tour_issue_resolved: "true" })],
    [repair("refetch"), repair("import_confirmed"), repair("recheck", { tour_issue_resolved: "true", tour_action_succeeded: "false" })],
    [repair("refetch"), repair("import_confirmed"), repair("recheck", {})],
  ]) {
    const state = reduceTour(await proofTrace([sellerCreated, injected, ...actions]));
    assert.equal(state.steps[6]?.status, "observing");
    assert.ok(state.steps[6]?.proof.missing.includes("confirmed resolved-case"));
  }
});

test("checkout creation alone and a different paid order cannot advance purchase", async () => {
  const events = await proofTrace([
    { step: "C03", route: "/api/checkouts", facts: { tour_order_id: "ord_created" } },
    { step: "C03", method: "GET", route: "/api/orders/ord_other", facts: { tour_order_id: "ord_other", tour_order_paid: "true", tour_payment_id: "pay_other" } },
  ]);
  const state = reduceTour(events);
  assert.equal(state.steps[2]?.status, "observing");
  assert.equal(state.steps[2]?.step.path, "/checkout/ord_created");
  assert.ok(state.steps[2]?.proof.missing.includes("confirmed paid-order"));
});

test("sample start alone does not satisfy the requested payout terminal", async () => {
  const events = await proofTrace([sellerCreated, { step: "C05", route: "/api/sellers/sel_demo/payouts/simulation", facts: { tour_sample_started: "true", tour_source: "mock" } }]);
  assert.equal(reduceTour(events).steps[4]?.status, "observing");
  assert.equal(reduceTour(events).steps[4]?.step.anchor, "sell.payouts.sample.withdraw");
});
