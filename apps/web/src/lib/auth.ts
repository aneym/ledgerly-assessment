import { account, createDb, getLocalRuntime, session, user, verification } from "@ledgerly/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

// Dev servers run on more than one port (the app's own default, plus the ports the guided
// tour and marketplace lanes bind to locally), so this lists them explicitly rather than
// trusting an env-driven allowlist someone has to remember to extend. APP_BASE_URL, the
// deployed origin, is always included too.
function trustedOrigins(env: NodeJS.ProcessEnv): string[] {
  const origins = new Set<string>([
    "http://localhost:3000",
    "http://localhost:4440",
    "http://localhost:4450",
  ]);
  if (env.APP_BASE_URL) origins.add(env.APP_BASE_URL);
  return [...origins];
}

// Real auth, built on Better Auth's Drizzle adapter over the same Neon
// database the rest of the app uses. New sign-ups are buyers. The `role`
// field is `input: false`, so Better Auth rejects any client-supplied
// value for it; only server code (see users.ts) can promote a user to
// "seller" or "operator".
export function buildAuth(env: NodeJS.ProcessEnv = process.env) {
  const db =
    env.LEDGERLY_LOCAL_RUNTIME !== undefined
      ? getLocalRuntime(env).db
      : createDb(required(env, "DATABASE_URL"));
  // BETTER_AUTH_URL is the historical name, but every other route in this app resolves its
  // base URL from APP_BASE_URL (see commerce.ts), so a deployment that only set that one
  // should not fail auth at startup for a variable it never needed to set.
  const baseURL = env.BETTER_AUTH_URL ?? required(env, "APP_BASE_URL");
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    ...(env.LEDGERLY_LOCAL_RUNTIME !== undefined
      ? { advanced: { disableOriginCheck: false, disableCSRFCheck: false } }
      : {}),
    secret: required(env, "BETTER_AUTH_SECRET"),
    baseURL,
    trustedOrigins: trustedOrigins(env),
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        role: {
          type: "string",
          defaultValue: "buyer",
          input: false,
        },
      },
    },
  });
}

let instance: ReturnType<typeof buildAuth> | undefined;

// Lazy singleton, same pattern as getServer() in server.ts: constructing
// betterAuth() reads env vars and opens a db client, so it must not run at
// module import time (that would run during `next build`).
export function getAuth() {
  if (process.env.LEDGERLY_LOCAL_RUNTIME !== undefined) return buildAuth();
  instance ??= buildAuth();
  return instance;
}

export type ForwardAuthDeps = {
  // Better Auth's own request handler ([...all]/route.ts mounts the same thing). Defaults
  // to the real lazy singleton; tests inject a fake so this stays unit-testable without a
  // database.
  handler: (request: Request) => Promise<Response>;
};

// Thin wrappers at POST /api/auth/sign-up and /api/auth/sign-in re-invoke Better Auth's own
// handler at its real email/password path, so the marketplace pages can call the short
// paths from the JSON-shapes addendum without this lane reimplementing sign-up/sign-in. A
// 2xx response (and its Set-Cookie header) passes through unchanged; an error response is
// reduced to `{ error }` using Better Auth's own error code, so callers get a stable shape
// instead of Better Auth's fuller error body.
export function createForwardEmailAuthHandler(
  target: "sign-up/email" | "sign-in/email",
  deps: ForwardAuthDeps = { handler: (request) => getAuth().handler(request) },
): (request: Request) => Promise<Response> {
  return async function handleForwardEmailAuth(request: Request): Promise<Response> {
    const url = new URL(request.url);
    url.pathname = `/api/auth/${target}`;
    const body = await request.text();
    const forwarded = new Request(url, {
      method: "POST",
      headers: request.headers,
      body,
    });
    const response = await deps.handler(forwarded);
    if (response.ok) return response;
    let code: string | undefined;
    try {
      const parsed = (await response.clone().json()) as { code?: unknown };
      if (typeof parsed.code === "string") code = parsed.code;
    } catch {
      // Non-JSON error body from Better Auth; fall through to the generic error below.
    }
    return Response.json(
      { error: code ? code.toLowerCase() : "auth_failed" },
      { status: response.status },
    );
  };
}
