import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsersRepo, getLocalRuntime } from "@ledgerly/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGetAccountHandler } from "../src/app/api/account/route";
import { profileSessionHandler } from "../src/app/demo/profile/[role]/route";
import { buildAuth } from "../src/lib/auth";
import { demoProfilesEnabled, profileRoleFor } from "../src/lib/demo-profiles";

import { getSession } from "../src/lib/session";

const requestContext = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => requestContext.headers }));
const baseURL = "http://127.0.0.1:4474";

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

describe("isolated local runtime with real Better Auth", () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;
  let runtime: ReturnType<typeof getLocalRuntime>;
  let auth: ReturnType<typeof buildAuth>;
  let buyerCookie: string;
  let buyerId: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "ledgerly-local-auth-"));
    env = {
      NODE_ENV: "test",
      LEDGERLY_LOCAL_RUNTIME: "1",
      LEDGERLY_TEST_MODE: "1",
      LEDGERLY_LOCAL_DB_DIR: join(directory, "db"),
      WHOP_MODE: "mock",
      APP_BASE_URL: baseURL,
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      DEMO_MODE: "1",
      DEMO_PROFILES_ENABLED: "1",
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("WHOP_API_KEY", undefined);
    runtime = getLocalRuntime(env);
    await runtime.ready;
    auth = buildAuth(env);
  }, 30_000);

  afterAll(async () => {
    await runtime?.close();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("signs all demo profiles in through Better Auth and preserves their stored roles", async () => {
    const users = createUsersRepo(runtime.db);
    const profiles = profileSessionHandler({
      enabled: () => demoProfilesEnabled(env),
      getSession,
      mintRun: () => "run_authproof",
      secret: () => env.BETTER_AUTH_SECRET as string,
      signIn: ({ email, password, headers }) =>
        auth.api.signInEmail({ body: { email, password }, headers, asResponse: true }),
      signUp: ({ email, password, name, headers }) =>
        auth.api.signUpEmail({ body: { email, password, name }, headers, asResponse: true }),
      setSellerRole: (userId) => users.setRole(userId, "seller"),
      ownsSeller: async (userId) => (await users.getSellerIdForUser(userId)) !== null,
    });
    const ids = new Set<string>();
    const jar = new Map<string, string>();
    function receive(response: Response) {
      for (const cookie of response.headers.getSetCookie()) {
        const [name, ...value] = (cookie.split(";", 1)[0] ?? "").split("=");
        jar.set(name ?? "", value.join("="));
      }
      return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    for (const profile of ["buyer", "seller", "operator"] as const) {
      const request = new Request(`${baseURL}/demo/profile/${profile}`, {
        headers: {
          origin: baseURL,
          cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
        },
      });
      requestContext.headers = request.headers;
      const response = await profiles(request, { params: Promise.resolve({ role: profile }) });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        profile === "buyer" ? "/browse" : profile === "seller" ? "/sell" : "/admin/sellers",
      );
      const cookie = receive(response);
      expect(cookie).toContain("ledgerly_demo_profile=");
      requestContext.headers = new Headers({ cookie });
      expect((await getSession())?.demoRunId).toBe("run_authproof");
      expect(cookie).toContain("better-auth.session_token=");
      const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
      expect(session?.user.email).toBe(`demo-${profile}+run_authproof@ledgerly.test`);
      expect(session?.user.role).toBe(profile === "seller" ? "seller" : "buyer");
      if (!session) throw new Error("Profile did not produce an authenticated session");
      ids.add(session.user.id);
      // Operator profiles use the existing restricted demo role, never a stored operator grant.
      expect(profileRoleFor(session.user.email)).toBe(profile === "operator" ? "demo" : null);
      const account = createGetAccountHandler({
        getSession: async () => {
          const signed = await auth.api.getSession({ headers: new Headers({ cookie }) });
          return signed ? { userId: signed.user.id, role: signed.user.role } : null;
        },
        getUser: (userId) => users.getUser(userId),
        getSellerIdForUser: (userId) => users.getSellerIdForUser(userId),
      });
      const accountResponse = await account(new Request(`${baseURL}/api/account`));
      expect(accountResponse.status).toBe(200);
      expect(await accountResponse.json()).toMatchObject({
        user: { id: session.user.id, role: profile === "seller" ? "seller" : "buyer" },
        seller: null,
      });
      const repeatRequest = new Request(request.url, { headers: { origin: baseURL, cookie } });
      requestContext.headers = repeatRequest.headers;
      const repeated = await profiles(repeatRequest, {
        params: Promise.resolve({ role: profile }),
      });
      receive(repeated);
      expect(repeated.status).toBe(303);
      const repeatedSession = await auth.api.getSession({
        headers: new Headers({ cookie: cookieHeader(repeated) }),
      });
      expect(repeatedSession?.user.id).toBe(session.user.id);
      if (profile === "buyer") {
        buyerCookie = cookie;
        buyerId = session.user.id;
      }
    }
    expect(ids.size).toBe(3);
  }, 30_000);

  it("keeps public signup a buyer and rejects invalid passwords, cookies and origins", async () => {
    const password = randomBytes(24).toString("base64url");
    const signUp = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({
          name: "Local Role Test",
          email: "role-test@ledgerly.test",
          password,
          role: "operator",
        }),
      }),
    );
    expect(signUp.status).toBe(200);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader(signUp) }),
    });
    expect(session?.user.role).toBe("buyer");
    const wrongPassword = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({ email: "role-test@ledgerly.test", password: "incorrect-password" }),
      }),
    );
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.headers.get("set-cookie")).toBeNull();
    expect(
      await auth.api.getSession({
        headers: new Headers({ cookie: "better-auth.session_token=forged.invalid" }),
      }),
    ).toBeNull();
    const foreignOrigin = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://untrusted.invalid",
          cookie: buyerCookie,
        },
        body: JSON.stringify({ email: "role-test@ledgerly.test", password }),
      }),
    );
    expect(foreignOrigin.status).toBe(403);
  }, 30_000);

  it("retains a real authenticated session when the disposable database is reopened", async () => {
    await runtime.close();
    runtime = getLocalRuntime(env);
    await runtime.ready;
    auth = buildAuth(env);
    const persisted = await auth.api.getSession({ headers: new Headers({ cookie: buyerCookie }) });
    expect(persisted?.user.id).toBe(buyerId);
    expect(persisted?.user.email).toBe("demo-buyer+run_authproof@ledgerly.test");
    expect(persisted?.user.role).toBe("buyer");
  }, 30_000);
});
