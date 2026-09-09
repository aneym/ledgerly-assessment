import { describe, expect, it } from "vitest";
import { profileSessionHandler } from "../src/app/demo/profile/[role]/route";
import { PROFILE_BINDING_COOKIE, profileBinding } from "../src/lib/demo-profile-binding";
import {
  demoProfilesEnabled,
  isValidRunId,
  mintRunId,
  parseProfileEmail,
  profileEmail,
  profileHome,
  profilePassword,
  profileRoleFor,
  profileUrl,
  safeProfileNext,
} from "../src/lib/demo-profiles";

const env = (over: Record<string, string>) => over as unknown as NodeJS.ProcessEnv;

describe("demo profile configuration", () => {
  it("is on only with DEMO_MODE=1 and DEMO_PROFILES_ENABLED=1", () => {
    expect(demoProfilesEnabled(env({}))).toBe(false);
    expect(demoProfilesEnabled(env({ DEMO_MODE: "1" }))).toBe(false);
    expect(demoProfilesEnabled(env({ DEMO_PROFILES_ENABLED: "1" }))).toBe(false);
    expect(demoProfilesEnabled(env({ DEMO_MODE: "1", DEMO_PROFILES_ENABLED: "1" }))).toBe(true);
  });

  it("mints run ids the demo scope accepts and rejects other shapes", () => {
    const run = mintRunId();
    expect(run).toMatch(/^run_[0-9a-f]{16}$/);
    expect(isValidRunId(run)).toBe(true);
    expect(isValidRunId("dev-2026-09-08")).toBe(false);
    expect(isValidRunId("run_../x")).toBe(false);
    expect(isValidRunId(null)).toBe(false);
  });

  it("names accounts per run on the reserved test domain and reads them back", () => {
    const email = profileEmail("operator", "run_ab12");
    expect(email).toBe("demo-operator+run_ab12@ledgerly.test");
    expect(parseProfileEmail(email)).toEqual({ profile: "operator", run: "run_ab12" });
    expect(parseProfileEmail("Demo-Buyer+run_ab12@LEDGERLY.test")).toEqual({
      profile: "buyer",
      run: "run_ab12",
    });
    expect(parseProfileEmail("ops.demo@ledgerly.test")).toBeNull();
    expect(parseProfileEmail("demo-operator+run_ab12@ledgerly.test.evil")).toBeNull();
    expect(parseProfileEmail(null)).toBeNull();
  });

  it("derives a stable, secret-keyed password per profile and run", () => {
    const a = profilePassword("buyer", "run_1", "secret-a");
    expect(a).toBe(profilePassword("buyer", "run_1", "secret-a"));
    expect(a).not.toBe(profilePassword("seller", "run_1", "secret-a"));
    expect(a).not.toBe(profilePassword("buyer", "run_2", "secret-a"));
    expect(a).not.toBe(profilePassword("buyer", "run_1", "secret-b"));
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(() => profilePassword("buyer", "run_1", "")).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("maps only the operator profile to the restricted demo role", () => {
    expect(profileRoleFor("demo-operator+run_1@ledgerly.test")).toBe("demo");
    expect(profileRoleFor("demo-buyer+run_1@ledgerly.test")).toBeNull();
    expect(profileRoleFor("demo-seller+run_1@ledgerly.test")).toBeNull();
    expect(profileRoleFor("operator@ledgerly.test")).toBeNull();
    expect(profileRoleFor(undefined)).toBeNull();
  });

  it("builds same-origin switch links and homes", () => {
    expect(profileUrl("buyer")).toBe("/demo/profile/buyer");
    expect(profileUrl("seller", "/sell/products")).toBe(
      "/demo/profile/seller?next=%2Fsell%2Fproducts",
    );
    expect(profileUrl("operator", "https://evil.test/x")).toBe("/demo/profile/operator");
    expect(safeProfileNext("//evil.test")).toBeNull();
    expect(safeProfileNext("/admin/ledger")).toBe("/admin/ledger");
    expect(profileHome("buyer", false)).toBe("/browse");
    expect(profileHome("seller", false)).toBe("/sell");
    expect(profileHome("seller", true)).toBe("/sell/products");
    expect(profileHome("operator", false)).toBe("/admin/sellers");
  });
});

type Call = { email: string; password: string; name: string };

function authResponse(userId: string, cookie: string, status = 200): Response {
  const h = new Headers({ "content-type": "application/json" });
  h.append("set-cookie", cookie);
  return new Response(JSON.stringify({ token: "t", user: { id: userId } }), { status, headers: h });
}

function deps(over: Partial<Parameters<typeof profileSessionHandler>[0]> = {}) {
  const calls: { signIn: Call[]; signUp: Call[]; roles: string[] } = {
    signIn: [],
    signUp: [],
    roles: [],
  };
  const handler = profileSessionHandler({
    enabled: () => true,
    getSession: async () => null,
    secret: () => "secret",
    mintRun: () => "run_minted00000001",
    signIn: async (call) => {
      calls.signIn.push({ email: call.email, password: call.password, name: call.name });
      return call.email.startsWith("demo-buyer+run_existing")
        ? authResponse("u_existing", "better-auth.session_token=in.sig; Path=/; HttpOnly")
        : new Response('{"code":"INVALID_EMAIL_OR_PASSWORD"}', { status: 401 });
    },
    signUp: async (call) => {
      calls.signUp.push({ email: call.email, password: call.password, name: call.name });
      return authResponse("u_new", "better-auth.session_token=up.sig; Path=/; HttpOnly");
    },
    setSellerRole: async (userId) => {
      calls.roles.push(userId);
    },
    ownsSeller: async () => false,
    ...over,
  });
  return { handler, calls };
}

const params = (role: string) => ({ params: Promise.resolve({ role }) });

describe("profile switch route", () => {
  it("signs an existing profile in with the derived password and keeps the run cookie", async () => {
    const { handler, calls } = deps({
      getSession: async () => ({
        userId: "u_existing",
        role: "buyer",
        demoRunId: "run_existing01",
      }),
    });
    const res = await handler(
      new Request("http://x/demo/profile/buyer?next=%2Flibrary", {
        headers: { cookie: "ledgerly_demo_run=run_existing01" },
      }),
      params("buyer"),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/library");
    expect(calls.signIn).toEqual([
      {
        email: "demo-buyer+run_existing01@ledgerly.test",
        password: profilePassword("buyer", "run_existing01", "secret"),
        name: "Ada Buyer",
      },
    ]);
    expect(calls.signUp).toEqual([]);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toContain("better-auth.session_token=in.sig; Path=/; HttpOnly");
    expect(cookies).toContain(
      `${PROFILE_BINDING_COOKIE}=${profileBinding("u_existing", "run_existing01", "secret")}; Path=/; SameSite=Lax; HttpOnly`,
    );
  });

  it("mints a run and the account on first use, gives the seller its role and lands on /sell", async () => {
    const { handler, calls } = deps();
    const res = await handler(new Request("http://x/demo/profile/seller"), params("seller"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sell");
    expect(calls.signIn[0]?.email).toBe("demo-seller+run_minted00000001@ledgerly.test");
    expect(calls.signUp).toEqual([
      {
        email: "demo-seller+run_minted00000001@ledgerly.test",
        password: profilePassword("seller", "run_minted00000001", "secret"),
        name: "Onda Sounds",
      },
    ]);
    expect(calls.roles).toEqual(["u_new"]);
    expect(res.headers.getSetCookie()).toEqual([
      "better-auth.session_token=up.sig; Path=/; HttpOnly",
      `${PROFILE_BINDING_COOKIE}=${profileBinding("u_new", "run_minted00000001", "secret")}; Path=/; SameSite=Lax; HttpOnly`,
      "ledgerly_demo_run=run_minted00000001; Path=/; SameSite=Lax; HttpOnly",
    ]);
  });

  it("sends the operator profile to admin without a stored role write", async () => {
    const { handler, calls } = deps({
      getSession: async () => ({ userId: "u_existing", role: "buyer", demoRunId: "run_A" }),
    });
    const res = await handler(
      new Request("http://x/demo/profile/operator", {
        headers: { cookie: "ledgerly_demo_run=run_A" },
      }),
      params("operator"),
    );
    expect(res.headers.get("location")).toBe("/admin/sellers");
    expect(calls.roles).toEqual([]);
    expect(res.headers.getSetCookie()).not.toContainEqual(
      expect.stringContaining("ledgerly_demo_run"),
    );
  });

  it("refuses off-origin destinations, unknown roles and disabled deployments", async () => {
    const { handler } = deps();
    const off = await handler(
      new Request("http://x/demo/profile/buyer?next=https%3A%2F%2Fevil.test"),
      params("buyer"),
    );
    expect(off.headers.get("location")).toBe("/browse");
    expect(
      (await handler(new Request("http://x/demo/profile/admin"), params("admin"))).status,
    ).toBe(404);
    const { handler: disabled } = deps({ enabled: () => false });
    expect(
      (await disabled(new Request("http://x/demo/profile/buyer"), params("buyer"))).status,
    ).toBe(404);
  });

  it("answers 503 with no cookie when neither sign-in nor sign-up succeeds", async () => {
    const { handler } = deps({
      signUp: async () => new Response('{"code":"USER_ALREADY_EXISTS"}', { status: 422 }),
    });
    const res = await handler(new Request("http://x/demo/profile/buyer"), params("buyer"));
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

it("never signs an unauthenticated caller into a requested foreign run", async () => {
  const { handler, calls } = deps();
  const response = await handler(
    new Request("http://x/demo/profile/operator", {
      headers: { "x-demo-run": "run_foreign", cookie: "ledgerly_demo_run=run_foreign" },
    }),
    params("operator"),
  );
  expect(response.status).toBe(403);
  expect(calls.signIn).toEqual([]);
  expect(calls.signUp).toEqual([]);
});

it.each(["buyer", "seller", "operator"])(
  "refuses foreign %s reissuance for an authenticated profile",
  async (role) => {
    const { handler, calls } = deps({
      getSession: async () => ({ userId: "u_A", role: "demo", demoRunId: "run_A" }),
    });
    for (const headers of [
      { "x-demo-run": "run_B" },
      { cookie: "ledgerly_demo_run=run_B" },
      { "x-demo-run": "run_A", cookie: "ledgerly_demo_run=run_B" },
      { "x-demo-run": "run_B", cookie: "ledgerly_demo_run=run_A" },
      { cookie: "ledgerly_demo_run=run_A; ledgerly_demo_run=run_B" },
      { cookie: "ledgerly_demo_run=%ZZ" },
    ] as Record<string, string>[]) {
      const response = await handler(
        new Request(`http://x/demo/profile/${role}`, { headers }),
        params(role),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(calls.signIn).toEqual([]);
    expect(calls.signUp).toEqual([]);
  },
);

it("mints a fresh run when the authenticated session is gone despite its stale cookie", async () => {
  const { handler, calls } = deps();
  const response = await handler(
    new Request("http://x/demo/profile/operator", {
      headers: { cookie: "ledgerly_demo_run=run_old; ledgerly_demo_profile=oldproof" },
    }),
    params("operator"),
  );
  expect(response.status).toBe(303);
  expect(calls.signIn.map((call) => call.email)).toEqual([
    "demo-operator+run_minted00000001@ledgerly.test",
  ]);
  expect(calls.signUp.map((call) => call.email)).toEqual([
    "demo-operator+run_minted00000001@ledgerly.test",
  ]);
  expect(response.headers.getSetCookie()).toContain(
    "ledgerly_demo_run=run_minted00000001; Path=/; SameSite=Lax; HttpOnly",
  );
});

it.each(["?run=run_foreign", "?run_id=run_foreign", "?run="])(
  "rejects an explicit unbound run request %s",
  async (query) => {
    const { handler, calls } = deps();
    const response = await handler(
      new Request(`http://x/demo/profile/operator${query}`, {
        headers: { cookie: "ledgerly_demo_run=run_old" },
      }),
      params("operator"),
    );
    expect(response.status).toBe(403);
    expect(calls.signIn).toEqual([]);
    expect(calls.signUp).toEqual([]);
  },
);
