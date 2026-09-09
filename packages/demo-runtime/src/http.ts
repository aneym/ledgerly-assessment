import type { DemoEvent, Role } from "./contract";
import { ROLES } from "./contract";
import {
  DEMO_RUN_COOKIE,
  endJourney,
  type JourneyRecord,
  parseReturnTarget,
  type ReturnPolicy,
  startJourney,
} from "./journey";
import type { DemoRunner } from "./runner";
import { STEP_IDS, STEPS } from "./steps";
import { reduceTour } from "./tour";

/** One SSE frame. `id` is the seq so a reconnecting panel can resume with Last-Event-ID. */
export function toSSE(event: DemoEvent): string {
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Web-standard handlers so the host framework mounts them in one line each.
 * They hold no framework import. Architecture decides the route paths.
 */
export function eventsHandler(runner: DemoRunner) {
  return (req: Request): Response => {
    const url = new URL(req.url);
    const followed = req.headers.get("x-demo-run") ?? url.searchParams.get("run");
    const sameRun = !followed || followed === runner.run_id;
    const last = sameRun
      ? Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0) || 0
      : 0;
    const controller = new AbortController();
    req.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const enc = new TextEncoder();
        try {
          for await (const e of runner.log.stream(runner.run_id, last, controller.signal))
            ctrl.enqueue(enc.encode(toSSE(e)));
        } finally {
          ctrl.close();
        }
      },
      cancel() {
        controller.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  };
}

export function snapshotHandler(runner: DemoRunner) {
  return async (_req: Request): Promise<Response> => json(await runner.snapshot());
}

export interface CommandBody {
  action: "run-step" | "run-all" | "reset" | "switch-role";
  step_id?: string;
  role?: Role;
  input?: Record<string, unknown>;
}

/**
 * Dev-mode commands. The host must gate this route behind its own dev-mode
 * check; the handler itself only validates shape. Reset is local-only by
 * construction (see DemoRunner.reset).
 */
export function commandHandler(runner: DemoRunner) {
  return async (req: Request): Promise<Response> => {
    let body: CommandBody;
    try {
      body = (await req.json()) as CommandBody;
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    switch (body.action) {
      case "run-step":
        if (!body.step_id || !STEP_IDS.includes(body.step_id))
          return json({ error: "unknown step_id" }, 400);
        return json(await runner.runStep(body.step_id, body.input ?? {}));
      case "run-all":
        return json(await runner.runAll());
      case "reset":
        return json(
          await runner.reset(
            typeof body.input?.reason === "string" ? body.input.reason : undefined,
          ),
        );
      case "switch-role":
        if (!body.role || !ROLES.includes(body.role)) return json({ error: "unknown role" }, 400);
        return json(await runner.switchRole(body.role));
      default:
        return json({ error: "unknown action" }, 400);
    }
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ---- Presentation journey: demo start, finish, return, health -----------------------------

export interface JourneyHandlerOptions {
  /** Where the first step's control lives, e.g. /signup. Marketplace owns the screen. */
  firstStepPath: string;
  /** Return-target policy: same-origin path prefixes and absolute deck origins. */
  allowlist?: readonly string[] | ReturnPolicy;
  /** Reports whether the real demo can run right now: auth, database and provider wiring. */
  health?: () => Promise<{ available: boolean; reason: string | null }>;
  /** Cookie attributes appended to the run cookie. */
  cookieAttributes?: string;
}

function cookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * Journey routes. Start validates the return target before anything else and
 * answers 400 to a bad one. Finish and return compute the outcome from the log,
 * so a run that did not complete cannot arrive at the completed slide.
 */
export function journeyHandlers(runner: DemoRunner, opts: JourneyHandlerOptions) {
  const attrs = opts.cookieAttributes ?? "Path=/; SameSite=Lax; HttpOnly";
  // Skips live in the presenter's browser, not in the log; the client sends them along so the
  // outcome and the reported step reflect what the viewer saw.
  const stateFor = async (run_id: string, skipped: Set<string>) =>
    reduceTour(await runner.log.list(run_id), STEPS, { skipped });
  const finishWith = async (req: Request, interrupted: boolean): Promise<Response> => {
    const url = new URL(req.url);
    const run_id =
      url.searchParams.get("run") ?? cookieValue(req, DEMO_RUN_COOKIE) ?? runner.run_id;
    const return_to = parseReturnTarget(url.searchParams.get("return"), opts.allowlist);
    if (!return_to) return json({ error: "return target not allowed" }, 400);
    const record: JourneyRecord = {
      run_id,
      return_to,
      from_slide: url.searchParams.get("from"),
      started_at: "",
      outcome: null,
      ended_at: null,
    };
    const skipped = new Set(
      (url.searchParams.get("skipped") ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter((x) => /^[A-Z]\d{2}$/.test(x)),
    );
    const state = await stateFor(run_id, skipped);
        const ended = endJourney(record, state, interrupted);
    return new Response(null, {
      status: 303,
      headers: { location: ended.url, "cache-control": "no-store" },
    });
  };
  return {
    start: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const record = startJourney(url.searchParams, runner.run_id, undefined, opts.allowlist);
      // The run exists in the log from the moment the deck deep-links in, so finish and
      // return can read it even when no step has run yet.
      if (record && (await runner.log.list(runner.run_id)).length === 0) await runner.start();
      if (!record) return json({ error: "return target not allowed" }, 400);
      const h = opts.health ? await opts.health() : { available: true, reason: null };
      if (!h.available) {
        const ended = endJourney(record, null, false);
        return new Response(null, {
          status: 303,
          headers: { location: ended.url, "cache-control": "no-store" },
        });
      }
      const next = new URL(opts.firstStepPath, url.origin);
      next.searchParams.set("tour", STEPS[0]?.id ?? "W01");
      next.searchParams.set("return", record.return_to);
      next.searchParams.set("run", runner.run_id);
      if (record.from_slide) next.searchParams.set("from", record.from_slide);
      return new Response(null, {
        status: 303,
        headers: {
          location: `${next.pathname}${next.search}`,
          "set-cookie": `${DEMO_RUN_COOKIE}=${encodeURIComponent(runner.run_id)}; ${attrs}`,
          "cache-control": "no-store",
        },
      });
    },
    finish: (req: Request) => finishWith(req, false),
    return: (req: Request) => finishWith(req, true),
    health: async (_req: Request): Promise<Response> =>
      json(opts.health ? await opts.health() : { available: true, reason: null }),
  };
}
