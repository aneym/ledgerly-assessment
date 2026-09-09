import { describe, expect, it } from "vitest";
import { FixtureAdapter } from "../../../packages/demo-runtime/src/adapters";
import { journeyHandlers } from "../../../packages/demo-runtime/src/http";
import { EventLog, MemoryStore } from "../../../packages/demo-runtime/src/log";
import { DemoRunner } from "../../../packages/demo-runtime/src/runner";
import { FIRST_STEP_PATH, gated, publicHealthHandler, RETURN_ALLOWLIST } from "../src/lib/demo";

const operator = async () => ({ role: "operator" });
const buyer = async () => ({ role: "buyer" });
const nobody = async () => null;

function demo(health = async () => ({ available: true, reason: null as string | null })) {
  const runner = new DemoRunner({
    log: new EventLog(new MemoryStore()),
    adapter: new FixtureAdapter(),
  });
  return {
    runner,
    journey: journeyHandlers(runner, {
      firstStepPath: FIRST_STEP_PATH,
      allowlist: RETURN_ALLOWLIST,
      health,
    }),
  };
}

describe("demo routes gate", () => {
  it("answers 404 outside demo mode, 401 without an operator session, and passes through otherwise", async () => {
    const ok = async () => new Response("hit", { status: 200 });
    expect(
      (
        await gated(ok, { isDemoMode: () => false, getSession: operator })(
          new Request("http://x/demo/start"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await gated(ok, { isDemoMode: () => true, getSession: buyer })(
          new Request("http://x/demo/start"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await gated(ok, { isDemoMode: () => true, getSession: nobody })(
          new Request("http://x/demo/start"),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await gated(ok, { isDemoMode: () => true, getSession: operator })(
          new Request("http://x/demo/start"),
        )
      ).status,
    ).toBe(200);
  });
});

describe("demo journey on the app's allowlist", () => {
  it("starts into the first chapter screen with the run cookie and the deck's return path", async () => {
    const { runner, journey } = demo();
    const res = await gated(journey.start, { isDemoMode: () => true, getSession: operator })(
      new Request("http://x/demo/start?return=%2Fdocs%2Fpresentation%2F&from=intro-2"),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/sell?tour=C01&return=%2Fdocs%2Fpresentation%2F&run=${runner.run_id}&from=intro-2`,
    );
    expect(res.headers.get("set-cookie")).toContain(`ledgerly_demo_run=${runner.run_id}`);
  });

  it("refuses an external return target and sends an unavailable demo to the closing slide", async () => {
    const { journey } = demo();
    expect(
      (await journey.start(new Request("http://x/demo/start?return=https%3A%2F%2Fevil.example")))
        .status,
    ).toBe(400);
    const down = demo(async () => ({ available: false, reason: "no database configured" }));
    const res = await down.journey.start(new Request("http://x/demo/start?return=/deck&from=s1"));
    expect(res.headers.get("location")).toMatch(
      /^\/deck\?demo=unavailable&run=run_[a-f0-9]+&from=s1#closing-unavailable$/,
    );
  });

  it("return mid-run is skipped; finish on a fresh run is partial, never completed", async () => {
    const { runner, journey } = demo();
    const cookie = `ledgerly_demo_run=${runner.run_id}`;
    const ret = await journey.return(
      new Request("http://x/demo/return?return=/deck", { headers: { cookie } }),
    );
    expect(ret.headers.get("location")).toBe(
      `/deck?demo=skipped&run=${runner.run_id}&step=C01#closing-skipped`,
    );
    const fin = await journey.finish(
      new Request("http://x/demo/finish?return=/deck", { headers: { cookie } }),
    );
    expect(fin.headers.get("location")).toBe(
      `/deck?demo=partial&run=${runner.run_id}&step=C01#closing-partial`,
    );
  });
});

describe("presenter entry and the deck's probe", () => {
  it("sends an anonymous presenter to the demo intro with the deck target kept, a signed-in non-operator to the intro with the reason, and API callers get 401/403", async () => {
    const start = gated(async () => new Response("hit"), {
      isDemoMode: () => true,
      getSession: nobody,
      redirectToSignIn: true,
    });
    const res = await start(new Request("http://x/demo/start?return=%2Fdeck&from=intro-1"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/demo?return=%2Fdeck&from=intro-1");
    const asBuyer = gated(async () => new Response("hit"), {
      isDemoMode: () => true,
      getSession: buyer,
      redirectToSignIn: true,
    });
    const buyerRes = await asBuyer(new Request("http://x/demo/start?return=%2Fdeck"));
    expect(buyerRes.status).toBe(303);
    expect(buyerRes.headers.get("location")).toBe("/demo?return=%2Fdeck&why=role");
    const api = gated(async () => new Response("hit"), {
      isDemoMode: () => true,
      getSession: buyer,
    });
    expect((await api(new Request("http://x/api/demo/snapshot"))).status).toBe(403);
    const anonApi = gated(async () => new Response("hit"), {
      isDemoMode: () => true,
      getSession: nobody,
    });
    expect((await anonApi(new Request("http://x/api/demo/snapshot"))).status).toBe(401);
  });

  it("answers the public health probe with CORS for an allowed deck origin only", async () => {
    const env = {
      DEMO_MODE: "1",
      DATABASE_URL: "postgresql://x@neon.tech/db",
    } as unknown as NodeJS.ProcessEnv;
    const health = publicHealthHandler(env);
    const ok = await health(
      new Request("http://x/api/demo/health", {
        headers: { origin: "http://127.0.0.1:4412" },
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4412");
    const body = await ok.json();
    expect(body.mounted).toBe(true);
    expect(body.available).toBe(true);
    expect(body.start_url).toBe("/demo/start");
    const other = await health(
      new Request("http://x/api/demo/health", { headers: { origin: "http://evil.example" } }),
    );
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const off = await publicHealthHandler({ DEMO_MODE: "0" } as unknown as NodeJS.ProcessEnv)(
      new Request("http://x/api/demo/health"),
    );
    expect(off.status).toBe(404);
  });
});

it("allows the server-minted demo role through the demo entry gate before a run is created", async () => {
  const handler = gated(() => new Response("demo entry"), {
    isDemoMode: () => true,
    getSession: async () => ({ role: "demo" }),
    redirectToSignIn: true,
  });
  const response = await handler(new Request("http://app.test/demo/start"));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("demo entry");
});

describe("one run per take", () => {
  it("mints a different run id for each start", async () => {
    const { getDemo } = await import("../src/lib/demo");
    const demo = getDemo({ DEMO_MODE: "1" } as NodeJS.ProcessEnv);
    const a = demo.journeyFor();
    const b = demo.journeyFor();
    const resA = await a.start(new Request("http://x/demo/start?return=%2Fdeck"));
    const resB = await b.start(new Request("http://x/demo/start?return=%2Fdeck"));
    expect(resA.status).toBe(303);
    expect(resB.status).toBe(303);
    const runA = /run=([^&#]+)/.exec(resA.headers.get("location") ?? "")?.[1];
    const runB = /run=([^&#]+)/.exec(resB.headers.get("location") ?? "")?.[1];
    expect(resA.headers.get("location")).not.toBe(resB.headers.get("location"));
    if (runA && runB) expect(runA).not.toBe(runB);
  });
});
