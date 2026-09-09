import { assert, test } from "vitest";
import { FixtureAdapter } from "../src/adapters";
import { journeyHandlers } from "../src/http";
import { EventLog, MemoryStore } from "../src/log";
import { DemoRunner } from "../src/runner";
import { STEPS } from "../src/steps";
import { TOUR_STEP_HEADER, Tracer, tracePort, withTrace } from "../src/trace";

function make(health?: () => Promise<{ available: boolean; reason: string | null }>) {
  const log = new EventLog(new MemoryStore());
  const runner = new DemoRunner({ log, adapter: new FixtureAdapter() });
  const handlers = journeyHandlers(runner, {
    firstStepPath: "/sell",
    ...(health ? { health } : {}),
  });
  return { log, runner, handlers };
}

test("start validates the return target, sets the run cookie and redirects to the first step screen", async () => {
  const { runner, handlers } = make();
  const res = await handlers.start(new Request("http://x/demo/start?return=%2Fdeck&from=intro-3"));
  assert.equal(res.status, 303);
  assert.equal(
    res.headers.get("location"),
    `/sell?tour=C01&return=%2Fdeck&run=${runner.run_id}&from=intro-3`,
  );
  assert.match(
    res.headers.get("set-cookie") ?? "",
    new RegExp(`ledgerly_demo_run=${runner.run_id}; Path=/; SameSite=Lax; HttpOnly`),
  );
  const bad = await handlers.start(
    new Request("http://x/demo/start?return=https%3A%2F%2Fevil.example"),
  );
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("location"), null);
});

test("an unavailable demo sends the deck straight to the unavailable closing slide", async () => {
  const { runner, handlers } = make(async () => ({ available: false, reason: "no database" }));
  const res = await handlers.start(new Request("http://x/demo/start?return=/deck&from=s2"));
  assert.equal(res.status, 303);
  assert.equal(
    res.headers.get("location"),
    `/deck?demo=unavailable&run=${runner.run_id}&from=s2#closing-unavailable`,
  );
  assert.equal(res.headers.get("set-cookie"), null, "no run cookie for a demo that cannot start");
});

test("return mid-run lands on the skipped slide; finish on an incomplete run lands on partial; never completed", async () => {
  const { log, runner, handlers } = make();
  const tracer = new Tracer({ log, run_id: runner.run_id, environment: "hybrid" });
  const seller = withTrace(tracer, "/api/sellers", async (_r, ctx) => {
    await tracer.db(ctx, "sellers", ["sel_j1"]);
    await tracePort({ async createOrFetchAccount() { return { ok: true as const, value: { id: "biz_j1" } }; } }, tracer, () => ctx, () => ({ source: "sandbox" as const, status: 200 })).createOrFetchAccount();
    return new Response(null, { status: 201 });
  });
  await seller(
    new Request("http://x/api/sellers", {
      method: "POST",
      headers: { [TOUR_STEP_HEADER]: "C01" },
    }),
  );
  const cookie = `ledgerly_demo_run=${runner.run_id}`;
  const ret = await handlers.return(
    new Request("http://x/demo/return?return=/deck&from=s1", { headers: { cookie } }),
  );
  assert.equal(
    ret.headers.get("location"),
    `/deck?demo=skipped&run=${runner.run_id}&step=C02&from=s1#closing-skipped`,
  );
  const fin = await handlers.finish(
    new Request("http://x/demo/finish?return=/deck", { headers: { cookie } }),
  );
  assert.equal(
    fin.headers.get("location"),
    `/deck?demo=partial&run=${runner.run_id}&step=C02#closing-partial`,
  );
  const bad = await handlers.finish(
    new Request("http://x/demo/finish?return=//evil.example", { headers: { cookie } }),
  );
  assert.equal(bad.status, 400);
});

test("health reports what the host says", async () => {
  const { handlers } = make(async () => ({ available: false, reason: "auth not wired" }));
  assert.deepEqual(await (await handlers.health(new Request("http://x/api/demo/health"))).json(), {
    available: false,
    reason: "auth not wired",
  });
});

test("finish with every step skipped reports partial with no step, honouring the client's skip list", async () => {
  const { runner, handlers } = make();
  await runner.start();
  const cookie = `ledgerly_demo_run=${runner.run_id}`;
  const all = STEPS.map((s) => s.id).join(",");
  const fin = await handlers.finish(
    new Request(`http://x/demo/finish?return=/deck&skipped=${all}`, { headers: { cookie } }),
  );
  assert.equal(fin.headers.get("location"), `/deck?demo=partial&run=${runner.run_id}#closing-partial`);
  const some = await handlers.finish(
    new Request("http://x/demo/finish?return=/deck&skipped=C01,C02", { headers: { cookie } }),
  );
  assert.equal(some.headers.get("location"), `/deck?demo=partial&run=${runner.run_id}&step=C03#closing-partial`);
});

