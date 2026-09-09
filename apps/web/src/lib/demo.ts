// Server-side wiring for the guided demo: one event log per process, the journey and
// snapshot handlers from packages/demo-runtime, and the gate every demo route shares
// (operator session plus DEMO_MODE=1), per docs/lanes/demo-runtime/handoff.md and
// architecture's mount instructions.

import { headers } from "next/headers";
import { createDemoEventStore } from "../../../../packages/db/src/repos/demo-events";
import { FixtureAdapter } from "../../../../packages/demo-runtime/src/adapters";
import {
  commandHandler,
  journeyHandlers,
  snapshotHandler,
} from "../../../../packages/demo-runtime/src/http";
import { EventLog, MemoryStore } from "../../../../packages/demo-runtime/src/log";
import { DemoRunner } from "../../../../packages/demo-runtime/src/runner";
import { STEP_IDS, STEPS } from "../../../../packages/demo-runtime/src/steps";
import { getAuth } from "./auth";
import { demoPersona } from "./demo-persona";
import { demoProfilesEnabled, parseProfileEmail } from "./demo-profiles";
import { getServer } from "./server";
import { getSession } from "./session";

export const isDemoMode = (env: NodeJS.ProcessEnv = process.env): boolean => env.DEMO_MODE === "1";

/** Same-origin paths the deck may hand the demo as a return target. */
export const RETURN_ALLOWLIST = [
  "/deck",
  "/present",
  "/presentation",
  "/docs/presentation",
] as const;

/**
 * Deck origins allowed as absolute return targets, from docs/presentation/journey.json
 * (presentation lane). DEMO_RETURN_ORIGINS (comma separated) overrides at deploy time.
 */
export const DEFAULT_RETURN_ORIGINS = [
  "http://127.0.0.1:4412",
  "http://127.0.0.1:4411",
  "http://127.0.0.1:4400",
  "http://127.0.0.1:4430",
  "http://127.0.0.1:4430",
  "http://localhost:4412",
  "http://localhost:4430",
  "https://ledgerly.example",
] as const;

export function returnOrigins(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env.DEMO_RETURN_ORIGINS;
  return raw
    ? raw
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : DEFAULT_RETURN_ORIGINS;
}

export function returnPolicy(env: NodeJS.ProcessEnv = process.env) {
  return { paths: RETURN_ALLOWLIST, origins: returnOrigins(env) };
}

/** Where the first chapter's control lives; follows the runtime's step table (C01, /sell). */
export const FIRST_STEP_PATH = STEPS[0]?.path ?? "/sell";

/** The explicit demo entry: intro, readiness readback and the per-take operator sign-in. */
export const DEMO_INTRO_PATH = "/demo";

/**
 * Builds the intro URL for a demo page request, keeping `return` and `from` so the intro
 * can hand the presenter straight back into `/demo/start` after sign-in. `why` names the
 * reason the request was turned away (`role`: signed in, but not an operator).
 */
export function demoIntroUrl(req: Request, why: "role" | null): string {
  const url = new URL(req.url);
  const q = new URLSearchParams();
  for (const key of ["return", "from"] as const) {
    const v = url.searchParams.get(key);
    if (v) q.set(key, v);
  }
  if (why) q.set("why", why);
  const search = q.toString();
  return search ? `${DEMO_INTRO_PATH}?${search}` : DEMO_INTRO_PATH;
}

type Demo = {
  log: EventLog;
  runner: DemoRunner;
  journey: ReturnType<typeof journeyHandlers>;
  /**
   * Journey handlers bound to a runner with its own run id: a fresh id per take when none
   * is given. One run per server process (the old default) meant every browser on a
   * serverless instance shared a run and a reset moved them all (QA finding B-1).
   */
  journeyFor: (run_id?: string) => ReturnType<typeof journeyHandlers>;
  snapshot: (req: Request) => Promise<Response>;
  command: (req: Request) => Promise<Response>;
};

const globalKey = "__ledgerly_demo__";
type GlobalWithDemo = typeof globalThis & { [globalKey]?: Demo };

function createStore(env: NodeJS.ProcessEnv) {
  // Durable when a database is configured (Neon in production, PGlite through
  // createTestDb in tests), in memory otherwise, so the routes work in every environment
  // without pretending the memory store is durable.
  if (env.LEDGERLY_LOCAL_RUNTIME !== undefined) return createDemoEventStore(getServer(env).db);
  if (!env.DATABASE_URL) return new MemoryStore();
  return resilient(createDemoEventStore(getServer().db));
}

/**
 * Falls back to memory when the demo_events table is missing (a deployment that has not
 * run migration 0002), logging once, so a demo still runs and the log says it is not durable.
 */
function resilient(primary: ReturnType<typeof createDemoEventStore>) {
  const memory = new MemoryStore();
  let degraded = false;
  const missingTable = (err: unknown) =>
    typeof err === "object" &&
    err !== null &&
    /demo_events|42P01/.test(String((err as { message?: unknown }).message ?? err));
  const guard = <T>(
    name: string,
    viaDb: () => Promise<T>,
    viaMemory: () => Promise<T>,
  ): Promise<T> => {
    if (degraded) return viaMemory();
    return viaDb().catch((err: unknown) => {
      if (!missingTable(err)) throw err;
      if (!degraded)
        console.error(
          `demo_events unavailable (${name}); falling back to memory for this process`,
          err,
        );
      degraded = true;
      return viaMemory();
    });
  };
  return {
    append: (e) =>
      guard(
        "append",
        () => primary.append(e),
        () => memory.append(e),
      ),
    list: (r) =>
      guard(
        "list",
        () => primary.list(r),
        () => memory.list(r),
      ),
    has: (id) =>
      guard(
        "has",
        () => primary.has(id),
        () => memory.has(id),
      ),
    lastSeq: (r) =>
      guard(
        "lastSeq",
        () => primary.lastSeq(r),
        () => memory.lastSeq(r),
      ),
    clearRun: (r) =>
      guard(
        "clearRun",
        () => primary.clearRun(r),
        () => memory.clearRun(r),
      ),
  } satisfies ReturnType<typeof createDemoEventStore>;
}

export async function demoHealth(env: NodeJS.ProcessEnv = process.env) {
  if (!isDemoMode(env)) return { available: false, reason: "DEMO_MODE is not 1" };
  if (!env.DATABASE_URL && env.LEDGERLY_LOCAL_RUNTIME === undefined)
    return { available: false, reason: "no database configured" };
  const session = await getSession();
  if (session?.role !== "operator" && session?.role !== "demo")
    return { available: false, reason: "operator session required" };
  return { available: true, reason: null };
}

/**
 * Readiness for the deck's cross-origin probe: mounted, demo mode, database. It reports
 * whether the current browser holds an operator session but does not require one, so a
 * presenter who is not signed in yet sees "sign in" rather than "not reachable". Answers
 * CORS for the allowed deck origins only. 404 outside demo mode.
 */
export function publicHealthHandler(env: NodeJS.ProcessEnv = process.env) {
  const cors = (req: Request, extra: Record<string, string> = {}) => {
    const origin = req.headers.get("origin");
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      vary: "Origin",
      ...extra,
    };
    if (origin && returnOrigins(env).includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-credentials"] = "true";
      headers["access-control-allow-methods"] = "GET, OPTIONS";
    }
    return headers;
  };
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    if (!isDemoMode(env)) return new Response(null, { status: 404, headers: cors(req) });
    const session = await getSession().catch(() => null);
    const operator = session?.role === "operator" || session?.role === "demo";
    const local = env.LEDGERLY_LOCAL_RUNTIME !== undefined;
    if (local) await getServer(env).ready;
    const database = Boolean(env.DATABASE_URL) || local;
    const persona = demoPersona(env);
    // Per-run sample profiles (dev-profiles lane): which profile this browser holds, so the
    // tour bar can switch to the chapter's role through /demo/profile/<role>.
    const profiles = demoProfilesEnabled(env);
    let profile: string | null = null;
    if (profiles && session) {
      const email = await getAuth()
        .api.getSession({ headers: await headers() })
        .then((r) => r?.user?.email ?? null)
        .catch(() => null);
      profile = email ? (parseProfileEmail(email)?.profile ?? null) : null;
    }
    const body = {
      ...(local ? { database_source: "pglite", provider_source: "mock", local_test: true } : {}),
      mounted: true,
      available: database,
      reason: database ? null : "no database configured",
      operator_session: operator || session?.role === "demo",
      ...(session?.role === "demo" ? { scope: "demo" } : {}),
      // A configured sample persona signs the visitor in server-side at /demo/session; else
      // the intro explains the preflight and carries the operator sign-in. The deck links it.
      sign_in: operator ? null : persona ? "/demo/session" : DEMO_INTRO_PATH,
      persona: persona ? { name: persona.name } : null,
      profiles,
      profile,
      start_url: "/demo/start",
      contract: "packages/demo-runtime/contract/tour-journey.md",
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: cors(req, { "content-type": "application/json" }),
    });
  };
}

function build(env: NodeJS.ProcessEnv): Demo {
  const log = new EventLog(createStore(env));
  // DEMO_RUN_ID keeps one run across serverless cold starts; without it each process
  // starts a fresh run and the durable store still holds the earlier ones.
  const runner = new DemoRunner({
    log,
    adapter: new FixtureAdapter(),
    ...(env.DEMO_RUN_ID ? { run_id: env.DEMO_RUN_ID } : {}),
  });
  const journeyOptions = {
    firstStepPath: FIRST_STEP_PATH,
    allowlist: returnPolicy(env),
    health: () => demoHealth(env),
    // The run id is not a secret; the tour shell reads it from document.cookie.
    cookieAttributes: "Path=/; SameSite=Lax",
  };
  const journey = journeyHandlers(runner, journeyOptions);
  const journeyFor = (run_id?: string) =>
    journeyHandlers(
      new DemoRunner({ log, adapter: new FixtureAdapter(), ...(run_id ? { run_id } : {}) }),
      journeyOptions,
    );
  const snapshotDefault = snapshotHandler(runner);
  return {
    log,
    runner,
    journey,
    journeyFor,
    // `?run=` reads any run in the durable store; without it the current process run.
    snapshot: async (req: Request) => {
      const run = new URL(req.url).searchParams.get("run");
      if (!run) return snapshotDefault(req);
      const snap = await log.snapshot(run, STEP_IDS);
      return Response.json(snap, { headers: { "cache-control": "no-store" } });
    },
    command: commandHandler(runner),
  };
}

export function getDemo(env: NodeJS.ProcessEnv = process.env): Demo {
  const g = globalThis as GlobalWithDemo;
  if (!g[globalKey]) g[globalKey] = build(env);
  return g[globalKey];
}

/**
 * Every demo route answers 404 outside demo mode and 401 without an operator session,
 * matching the SSE route architecture owns. `deps` lets tests inject both checks.
 */
export function gated(
  handler: (req: Request) => Promise<Response> | Response,
  deps: {
    isDemoMode?: () => boolean;
    getSession?: () => Promise<{ role: string } | null>;
    /** Page routes: send an anonymous presenter to sign-in and back, instead of a bare 401. */
    redirectToSignIn?: boolean;
  } = {},
): (req: Request) => Promise<Response> {
  const demoMode = deps.isDemoMode ?? (() => isDemoMode());
  const session = deps.getSession ?? getSession;
  return async (req: Request) => {
    if (!demoMode()) return new Response(null, { status: 404 });
    const s = await session();
    if (deps.redirectToSignIn && s?.role !== "operator" && s?.role !== "demo") {
      // Page routes: an anonymous presenter, or one signed in without the operator role,
      // lands on the demo intro, which explains the preflight and carries the sign-in form
      // with this exact URL as its destination. A bare /signin lost the tour context.
      return new Response(null, {
        status: 303,
        headers: {
          location: demoIntroUrl(req, s ? "role" : null),
          "cache-control": "no-store",
        },
      });
    }
    if (s?.role !== "operator" && s?.role !== "demo")
      return new Response(s ? "This demo needs an operator session." : null, {
        status: s ? 403 : 401,
        headers: { "cache-control": "no-store" },
      });
    return handler(req);
  };
}
