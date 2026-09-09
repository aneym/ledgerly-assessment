import {
  mapTourInstrumentation,
  normalizeInstrumentationEvent,
  type PersistedInstrumentationRow,
} from "../../../../packages/demo-runtime/src/instrumentation";
import {
  endJourney,
  type ReturnPolicy,
  startJourney,
} from "../../../../packages/demo-runtime/src/journey";
import { reduceTour } from "../../../../packages/demo-runtime/src/tour";
import { isValidRunId, parseProfileEmail } from "./demo-profiles";
import { classifyTourRoute } from "./tour-response-proof";

export type TourIdentity = { userId: string; email: string; expiresAt: Date; demoRunId: string };
export type TourHistoryDeps = {
  enabled: () => boolean;
  identity: (request: Request) => Promise<TourIdentity | null>;
  listEvents: (query: {
    runId: string;
    afterSeq: number;
    limit: number;
  }) => Promise<PersistedInstrumentationRow[]>;
  now: () => Date;
};
export type TourFinishDeps = TourHistoryDeps & { allowlist: ReturnPolicy };
const PAGE_SIZE = 500;
const MAX_EVENTS = 10_000;
const failure = (error: string, status: number) =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

async function authorizedTourRun(
  request: Request,
  deps: TourHistoryDeps,
): Promise<string | Response> {
  if (!deps.enabled()) return failure("not_found", 404);
  const identity = await deps.identity(request);
  if (
    !identity ||
    !Number.isFinite(identity.expiresAt.getTime()) ||
    identity.expiresAt <= deps.now()
  )
    return failure("unauthenticated", 401);
  const profile = parseProfileEmail(identity.email);
  if (!profile || !identity.userId) return failure("demo_profile_required", 403);
  if (identity.demoRunId !== profile.run) return failure("demo_scope", 403);
  const url = new URL(request.url);
  const requestedRuns = [...url.searchParams.getAll("run"), ...url.searchParams.getAll("run_id")];
  const headerRun = request.headers.get("x-demo-run");
  if (headerRun !== null) requestedRuns.push(headerRun);
  try {
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
      const [name, ...value] = part.trim().split("=");
      if (name === "ledgerly_demo_run") requestedRuns.push(decodeURIComponent(value.join("=")));
    }
  } catch {
    return failure("demo_scope", 403);
  }
  if (requestedRuns.some((run) => !isValidRunId(run) || run !== profile.run))
    return failure("demo_scope", 403);
  return profile.run;
}

async function readTourHistory(
  runId: string,
  deps: TourHistoryDeps,
): Promise<{ events: PersistedInstrumentationRow[]; lastSeq: number } | Response> {
  const events: PersistedInstrumentationRow[] = [];
  let afterSeq = 0;
  try {
    for (;;) {
      const page = await deps.listEvents({ runId: runId, afterSeq, limit: PAGE_SIZE });
      if (page.length > PAGE_SIZE || events.length + page.length > MAX_EVENTS)
        return failure("tour_history_too_large", 503);
      for (const raw of page) {
        const event = normalizeInstrumentationEvent(raw);
        if (event.run_id !== runId || !Number.isSafeInteger(event.seq) || event.seq <= afterSeq)
          return failure("invalid_tour_history", 503);
        afterSeq = event.seq;
        if (event.source === "app_api" && event.phase === "end") {
          const classified = classifyTourRoute(event.method, event.path);
          const claimed = event.safe_ids.tour_step;
          if (claimed !== undefined && claimed !== classified)
            return failure("invalid_tour_classification", 503);
        }
        events.push(raw);
      }
      if (page.length < PAGE_SIZE) break;
    }
  } catch {
    return failure("tour_history_unavailable", 503);
  }
  return { events, lastSeq: afterSeq };
}

/** Client outcome, skip lists and correlation tables never participate in completion. */
export function createTourFinishHandler(deps: TourFinishDeps, interrupted = false) {
  return async (request: Request): Promise<Response> => {
    const runId = await authorizedTourRun(request, deps);
    if (runId instanceof Response) return runId;
    const record = startJourney(new URL(request.url).searchParams, runId, deps.now, deps.allowlist);
    if (!record) return failure("return_target_not_allowed", 400);
    const history = await readTourHistory(runId, deps);
    if (history instanceof Response) return history;
    const state = reduceTour(mapTourInstrumentation(history.events, runId));
    const ended = endJourney(record, state, interrupted, deps.now);
    return new Response(null, {
      status: 303,
      headers: { location: ended.url, "cache-control": "no-store" },
    });
  };
}

/** Raw server rows and their watermark let the browser resume SSE without discarding in-flight evidence. */
export function createTourSnapshotHandler(deps: TourHistoryDeps) {
  return async (request: Request): Promise<Response> => {
    const runId = await authorizedTourRun(request, deps);
    if (runId instanceof Response) return runId;
    const history = await readTourHistory(runId, deps);
    if (history instanceof Response) return history;
    return Response.json(
      { run_id: runId, events: history.events, last_seq: history.lastSeq },
      { headers: { "cache-control": "no-store, private" } },
    );
  };
}

/** Shared real wiring. No profile email alone can grant a verified run. */
async function persistedTourDeps(): Promise<TourHistoryDeps> {
  const [{ getAuth }, { getSession }, { getServer }, { listInstrumentationEvents }] =
    await Promise.all([
      import("./auth"),
      import("./session"),
      import("./server"),
      import("../../../../packages/db/src/repos/instrumentation"),
    ]);
  return {
    enabled: () => process.env.DEMO_MODE === "1" && process.env.DEMO_PROFILES_ENABLED === "1",
    identity: async (req) => {
      const [session, auth] = await Promise.all([
        getSession(),
        getAuth().api.getSession({ headers: req.headers }),
      ]);
      if (!session || !auth || session.userId !== auth.user.id) return null;
      // A verified profile proof binds the session to the authenticated user and run.
      // Legacy shared personas have no verified run and cannot authorize completion.
      if (
        !("demoRunId" in session) ||
        typeof session.demoRunId !== "string" ||
        session.demoRunId !== parseProfileEmail(auth.user.email)?.run
      )
        return null;
      return {
        userId: auth.user.id,
        email: auth.user.email,
        expiresAt: new Date(auth.session.expiresAt),
        demoRunId: session.demoRunId,
      };
    },
    listEvents: async ({ runId, afterSeq, limit }) =>
      (await listInstrumentationEvents(getServer().db, { runId, afterSeq })).slice(0, limit),
    now: () => new Date(),
  };
}

export async function finishPersistedTour(
  request: Request,
  interrupted = false,
): Promise<Response> {
  if (process.env.DEMO_MODE !== "1" || process.env.DEMO_PROFILES_ENABLED !== "1")
    return failure("not_found", 404);
  const [deps, { returnPolicy }] = await Promise.all([persistedTourDeps(), import("./demo")]);
  return createTourFinishHandler({ ...deps, allowlist: returnPolicy() }, interrupted)(request);
}

export async function snapshotPersistedTour(request: Request): Promise<Response> {
  if (process.env.DEMO_MODE !== "1" || process.env.DEMO_PROFILES_ENABLED !== "1")
    return failure("not_found", 404);
  return createTourSnapshotHandler(await persistedTourDeps())(request);
}
