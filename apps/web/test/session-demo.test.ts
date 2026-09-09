import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  headers: new Headers(),
  user: null as { id: string; email: string; role: string } | null,
}));
vi.mock("next/headers", () => ({ headers: async () => auth.headers }));
vi.mock("better-auth", () => ({
  betterAuth: () => ({
    api: {
      getSession: async () => (auth.user ? { user: auth.user } : null),
    },
  }),
}));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: () => ({}) }));

import { profileSessionHandler } from "../src/app/demo/profile/[role]/route";
import { demoHealth, publicHealthHandler } from "../src/lib/demo";
import { PROFILE_BINDING_COOKIE, profileBinding } from "../src/lib/demo-profile-binding";
import { getSession, requireRole } from "../src/lib/session";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://fixture@fixture.invalid.neon.tech/fixture");
  vi.stubEnv("APP_BASE_URL", "http://app.test");
  vi.stubEnv("BETTER_AUTH_SECRET", "fixture-only-not-a-real-secret");
  vi.stubEnv("DEMO_MODE", "1");
  vi.stubEnv("DEMO_PERSONA_EMAIL", "sample@example.invalid");
  auth.headers = new Headers();
  auth.user = { id: "sample", email: "SAMPLE@example.invalid", role: "operator" };
});
afterEach(() => vi.unstubAllEnvs());

describe("runtime demo role", () => {
  it.each(["buyer", "seller", "operator", "unknown"])(
    "overrides stored %s without modifying it",
    async (role) => {
      if (!auth.user) throw new Error("Missing fixture user");
      auth.user.role = role;
      expect(await getSession()).toEqual({ userId: "sample", role: "demo" });
      expect(auth.user.role).toBe(role);
    },
  );
  it("preserves real operators and requires both demo configuration fields", async () => {
    vi.stubEnv("DEMO_MODE", "0");
    expect((await getSession())?.role).toBe("operator");
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("DEMO_PERSONA_EMAIL", "");
    expect((await getSession())?.role).toBe("operator");
    vi.stubEnv("DEMO_PERSONA_EMAIL", "other@example.invalid");
    expect((await getSession())?.role).toBe("operator");
  });
  it("does not grant a session to an anonymous visitor", async () => {
    auth.user = null;
    expect(await getSession()).toBeNull();
  });
  it("allows buyer and seller roles but requires an explicit scoped request for operator", async () => {
    expect((await requireRole("buyer")).ok).toBe(true);
    expect((await requireRole("seller")).ok).toBe(true);
    expect(await requireRole("operator")).toEqual({ ok: false, error: "forbidden" });
    expect((await requireRole("operator", new Request("http://app.test"))).ok).toBe(false);
    expect(
      (
        await requireRole(
          "operator",
          new Request("http://app.test", { headers: { "x-demo-run": "run_A" } }),
        )
      ).ok,
    ).toBe(false);
  });
  it("reports the demo session in public and internal health", async () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", DEMO_MODE: "1", DATABASE_URL: "fixture" };
    const response = await publicHealthHandler(env)(new Request("http://app.test/api/demo/health"));
    expect(await response.json()).toMatchObject({
      operator_session: true,
      scope: "demo",
      sign_in: null,
    });
    expect(await demoHealth(env)).toEqual({ available: true, reason: null });
  });
});

describe("issued profile session identity", () => {
  const secret = "fixture-only-not-a-real-secret";
  it.each(["buyer", "seller", "operator"])(
    "binds the %s profile to its issued user and run",
    async (profile) => {
      auth.user = {
        id: "u_A",
        email: `demo-${profile}+run_A@ledgerly.test`,
        role: profile === "seller" ? "seller" : "buyer",
      };
      auth.headers = new Headers({
        cookie: `${PROFILE_BINDING_COOKIE}=${profileBinding("u_A", "run_A", secret)}`,
      });
      expect(await getSession()).toEqual({
        userId: "u_A",
        role: profile === "operator" ? "demo" : profile,
        demoRunId: "run_A",
      });
      if (profile === "operator") {
        expect(
          (
            await requireRole(
              "operator",
              new Request("http://x", { headers: { "x-demo-run": "run_A" } }),
            )
          ).ok,
        ).toBe(true);
        expect(
          (
            await requireRole(
              "operator",
              new Request("http://x", { headers: { "x-demo-run": "run_B" } }),
            )
          ).ok,
        ).toBe(false);
        expect((await requireRole("operator")).ok).toBe(false);
      }
    },
  );
  it.each(["absent", "foreign-user", "foreign-run", "duplicate", "tampered"])(
    "does not trust reserved profile email with %s proof",
    async (variant) => {
      auth.user = { id: "u_A", email: "demo-operator+run_A@ledgerly.test", role: "buyer" };
      const proof = profileBinding(
        variant === "foreign-user" ? "u_B" : "u_A",
        variant === "foreign-run" ? "run_B" : "run_A",
        secret,
      );
      auth.headers = new Headers({
        cookie:
          variant === "absent"
            ? ""
            : `${PROFILE_BINDING_COOKIE}=${variant === "tampered" ? "0".repeat(64) : proof}${variant === "duplicate" ? `; ${PROFILE_BINDING_COOKIE}=${proof}` : ""}`,
      });
      expect(await getSession()).toBeNull();
      expect(
        (
          await requireRole(
            "operator",
            new Request("http://x", { headers: { "x-demo-run": "run_A" } }),
          )
        ).ok,
      ).toBe(false);
    },
  );
  it("preserves ordinary buyer authorization", async () => {
    auth.user = { id: "ordinary", email: "buyer@example.invalid", role: "buyer" };
    expect(await getSession()).toEqual({ userId: "ordinary", role: "buyer" });
    expect((await requireRole("buyer")).ok).toBe(true);
    expect((await requireRole("operator")).ok).toBe(false);
  });
});

it("uses the profile route's issued cookie to authorize only the signed-in user's run", async () => {
  auth.user = null;
  const handler = profileSessionHandler({
    enabled: () => true,
    getSession,
    secret: () => "fixture-only-not-a-real-secret",
    mintRun: () => "run_issued",
    signIn: async () => new Response(null, { status: 401 }),
    signUp: async ({ email }) => {
      auth.user = { id: "issued_user", email, role: "buyer" };
      return Response.json({ user: auth.user });
    },
    setSellerRole: async () => {
      throw new Error("Operator profile must not write a role");
    },
    ownsSeller: async () => false,
  });
  const response = await handler(new Request("https://app.test/demo/profile/operator"), {
    params: Promise.resolve({ role: "operator" }),
  });
  expect(response.status).toBe(303);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  auth.headers = new Headers({ cookie });
  expect(await getSession()).toEqual({
    userId: "issued_user",
    role: "demo",
    demoRunId: "run_issued",
  });
  expect(
    (await requireRole("operator", new Request("https://app.test", { headers: auth.headers }))).ok,
  ).toBe(true);
  auth.headers.set("x-demo-run", "run_foreign");
  expect(
    (await requireRole("operator", new Request("https://app.test", { headers: auth.headers }))).ok,
  ).toBe(false);
});

it.each(["buyer", "seller"])(
  "rejects an unbound %s demo profile instead of falling through to ordinary account access",
  async (profile) => {
    auth.user = { id: "u_A", email: `demo-${profile}+run_A@ledgerly.test`, role: profile };
    expect(await getSession()).toBeNull();
    expect(await requireRole("buyer")).toEqual({ ok: false, error: "unauthenticated" });
  },
);

it.each(["signed-out", "expired", "unbound-upgrade"])(
  "replaces stale profile cookies after %s without granting the old run",
  async (state) => {
    const secret = "fixture-only-not-a-real-secret";
    auth.user =
      state === "unbound-upgrade"
        ? { id: "old_user", email: "demo-operator+run_old@ledgerly.test", role: "buyer" }
        : null;
    auth.headers = new Headers({ cookie: "ledgerly_demo_run=run_old" });
    expect(await getSession()).toBeNull();
    const calledEmails: string[] = [];
    const handler = profileSessionHandler({
      enabled: () => true,
      getSession,
      secret: () => secret,
      mintRun: () => "run_new",
      signIn: async ({ email }) => {
        calledEmails.push(email);
        return new Response(null, { status: 401 });
      },
      signUp: async ({ email }) => {
        auth.user = { id: "new_user", email, role: "buyer" };
        return Response.json({ user: auth.user });
      },
      setSellerRole: async () => {
        throw new Error("No operator promotion");
      },
      ownsSeller: async () => false,
    });
    const response = await handler(
      new Request("http://app.test/demo/profile/operator", { headers: auth.headers }),
      { params: Promise.resolve({ role: "operator" }) },
    );
    expect(response.status).toBe(303);
    expect(calledEmails).toEqual(["demo-operator+run_new@ledgerly.test"]);
    auth.headers = new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; "),
    });
    expect(await getSession()).toEqual({ userId: "new_user", role: "demo", demoRunId: "run_new" });
    expect(
      (await requireRole("operator", new Request("http://app.test", { headers: auth.headers }))).ok,
    ).toBe(true);
    auth.headers.set("x-demo-run", "run_old");
    expect(
      (await requireRole("operator", new Request("http://app.test", { headers: auth.headers }))).ok,
    ).toBe(false);
  },
);
