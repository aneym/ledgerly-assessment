import { describe, expect, it } from "vitest";
import { demoScopeFor, filterSellers, sellerInScope } from "../src/lib/demo-scope";

const request = (run?: string) =>
  new Request("http://app.test/admin", {
    headers: run === undefined ? {} : { "x-demo-run": run },
  });

describe("demo scope", () => {
  it("grants an unrestricted scope to a real operator without a run", () => {
    expect(demoScopeFor({ role: "operator" }, request())).toEqual({ kind: "operator" });
  });
  it("rejects anonymous and other roles even with a valid run", () => {
    for (const session of [null, { role: "buyer" }, { role: "seller" }])
      expect(demoScopeFor(session, request("run_A1"))).toBeNull();
  });
  it("grants the authenticated run when selectors agree", () => {
    expect(demoScopeFor({ role: "demo", demoRunId: "run_A1" }, request("run_A1"))).toEqual({
      kind: "demo",
      runId: "run_A1",
    });
    expect(
      demoScopeFor(
        { role: "demo", demoRunId: "run_B2" },
        new Request("http://app.test", {
          headers: { cookie: "other=x; ledgerly_demo_run=run_B2" },
        }),
      ),
    ).toEqual({ kind: "demo", runId: "run_B2" });
  });
  it.each([undefined, "run_", "wrong_A", "run_a-b", `run_${"a".repeat(33)}`, "run_a/b"])(
    "rejects missing or malformed run %s",
    (run) => {
      expect(demoScopeFor({ role: "demo" }, request(run))).toBeNull();
    },
  );
  it("rejects malformed cookie encoding and invalid header overriding a valid cookie", () => {
    for (const headers of [
      { cookie: "ledgerly_demo_run=%ZZ" },
      { cookie: "ledgerly_demo_run=run_valid", "x-demo-run": "bad" },
    ] as Record<string, string>[])
      expect(
        demoScopeFor({ role: "demo" }, new Request("http://app.test", { headers })),
      ).toBeNull();
  });
  it("accepts exactly 32 alphanumeric run characters", () => {
    expect(
      demoScopeFor(
        { role: "demo", demoRunId: `run_${"A".repeat(32)}` },
        request(`run_${"A".repeat(32)}`),
      )?.kind,
    ).toBe("demo");
  });
  it("restricts sellers to the demo run, including missing sellers", () => {
    const scope = { kind: "demo", runId: "run_A" } as const;
    expect(sellerInScope(scope, { runId: "run_A" })).toBe(true);
    expect(sellerInScope(scope, { runId: "run_B" })).toBe(false);
    expect(sellerInScope(scope, null)).toBe(false);
    expect(sellerInScope({ kind: "operator" }, null)).toBe(true);
  });
  it("filters without mutating or copying the seller records", () => {
    const sellers = [
      { id: "a", runId: "run_A" },
      { id: "b", runId: "run_B" },
    ];
    expect(filterSellers({ kind: "demo", runId: "run_A" }, sellers)).toEqual([sellers[0]]);
    expect(filterSellers({ kind: "operator" }, sellers)).toEqual(sellers);
    expect(sellers).toHaveLength(2);
  });
});

describe("seller authorization for the demo persona", () => {
  it("requires the seller's current run even when the persona owns a seller in another run", async () => {
    const { authorizeSeller } = await import("../src/lib/authz");
    const deps = {
      getSession: async () => ({ userId: "sample", role: "demo", demoRunId: "run_A" }),
      getSellerOwner: async () => "sample",
      getRequest: async () => request("run_A"),
      getSellerRunId: async () => "run_B",
    };
    expect(await authorizeSeller(deps, "seller_B")).toEqual({ ok: false, status: 403 });
    expect(
      await authorizeSeller({ ...deps, getSellerRunId: async () => "run_A" }, "seller_A"),
    ).toEqual({ ok: true, userId: "sample" });
    expect(
      await authorizeSeller({ ...deps, getRequest: async () => request() }, "seller_A"),
    ).toEqual({ ok: false, status: 403 });
  });
});

it("rejects a foreign run selected by a caller with an authenticated own run", () => {
  expect(demoScopeFor({ role: "demo", demoRunId: "run_A" }, request("run_B"))).toBeNull();
});

it.each([
  { "x-demo-run": "run_B" },
  { cookie: "ledgerly_demo_run=run_B" },
  { "x-demo-run": "run_A", cookie: "ledgerly_demo_run=run_B" },
  { "x-demo-run": "run_B", cookie: "ledgerly_demo_run=run_A" },
  { cookie: "ledgerly_demo_run=run_A; ledgerly_demo_run=run_B" },
  { "x-demo-run": "run_A", cookie: "ledgerly_demo_run=%ZZ" },
] as Record<string, string>[])("rejects conflicting or foreign selectors %j", (headers) => {
  expect(
    demoScopeFor({ role: "demo", demoRunId: "run_A" }, new Request("http://x", { headers })),
  ).toBeNull();
});
