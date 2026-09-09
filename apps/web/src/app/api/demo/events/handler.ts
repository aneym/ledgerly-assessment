// Live instrumentation stream for the guided-tour overlay, per
// docs/lanes/architecture/instrumentation-contract.md's "Stream" section: events are
// streamed as-is (no mapping to the demo-runtime v2 event shape — that mapping is the
// overlay's job on the consuming side).
import type { ListInstrumentationEventsQuery, PersistedInstrumentationEvent } from "@ledgerly/db";
import { type DemoScope, type DemoScopedSession, requestedDemoRuns } from "@/lib/demo-scope";

type Selector = { correlationId: string } | { runId: string };

function selectorFor(correlationId: string | null, runId: string | null): Selector | null {
  if (correlationId !== null) return { correlationId };
  if (runId !== null) return { runId };
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type EventsRouteDeps = {
  isDemoMode: () => boolean;
  getSession: () => Promise<DemoScopedSession | null>;
  listEvents: (query: ListInstrumentationEventsQuery) => Promise<PersistedInstrumentationEvent[]>;
  pollIntervalMs?: number;
  keepaliveMs?: number;
  streamDurationMs?: number;
};

// Factored out from the exported GET so a test can supply a stubbed session and a
// PGlite-backed listEvents without going through getServer() (which needs production env
// vars) or Better Auth. The real GET below wires production dependencies.
export function createEventsHandler(
  deps: EventsRouteDeps,
): (request: Request) => Promise<Response> {
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  const keepaliveMs = deps.keepaliveMs ?? 15000;
  const streamDurationMs = deps.streamDurationMs ?? 5 * 60 * 1000;
  return async function handleEvents(request: Request): Promise<Response> {
    if (!deps.isDemoMode()) return new Response(null, { status: 404 });
    const session = await deps.getSession();
    // Only a verified session attribute binds a sample profile to a run. Query selectors
    // may carry that same identity after snapshot, without requiring a duplicate cookie.
    const url = new URL(request.url);
    let scope: DemoScope | null = session?.role === "operator" ? { kind: "operator" } : null;
    if (session && ["demo", "buyer", "seller"].includes(session.role)) {
      const authenticatedRun = session.demoRunId;
      const supplied = requestedDemoRuns(request);
      const requested =
        supplied === null
          ? null
          : [...supplied, ...url.searchParams.getAll("run"), ...url.searchParams.getAll("run_id")];
      if (
        authenticatedRun &&
        /^run_[A-Za-z0-9]{1,32}$/.test(authenticatedRun) &&
        requested &&
        requested.length > 0 &&
        requested.every((value) => value === authenticatedRun)
      )
        scope = { kind: "demo", runId: authenticatedRun };
    }
    if (!scope) {
      const scoped = session?.role === "demo" || Boolean(session?.demoRunId);
      return Response.json(
        { error: scoped ? "demo_scope" : "unauthorized" },
        { status: scoped ? 403 : 401 },
      );
    }

    const selector = selectorFor(
      url.searchParams.get("correlation_id"),
      url.searchParams.get("run_id"),
    );
    if (selector === null) return new Response(null, { status: 400 });

    if (scope.kind === "demo" && "runId" in selector && selector.runId !== scope.runId)
      return Response.json({ error: "demo_scope" }, { status: 403 });

    const lastEventId = request.headers.get("last-event-id");
    const cursor = lastEventId ?? url.searchParams.get("after");
    if (cursor !== null && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))
      return Response.json({ error: "invalid_cursor" }, { status: 400 });
    let afterSeq = cursor === null ? undefined : Number(cursor);
    const deadline = Date.now() + streamDurationMs;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Flush headers at once so EventSource fires onopen before the first row,
        // then keep the connection alive through proxies with a comment frame
        // whenever a poll finds nothing new.
        controller.enqueue(encoder.encode(": connected\n\n"));
        let idleSince = Date.now();
        try {
          while (!request.signal.aborted && Date.now() < deadline) {
            const query: ListInstrumentationEventsQuery =
              afterSeq === undefined ? selector : { ...selector, afterSeq };
            const rows = await deps.listEvents(query);
            for (const row of rows) {
              afterSeq = row.seq;
              if (scope.kind === "demo" && row.runId !== scope.runId) continue;
              controller.enqueue(
                encoder.encode(`id: ${row.seq}\ndata: ${JSON.stringify(row)}\n\n`),
              );
              afterSeq = row.seq;
            }
            // A transport-open comment is not a replay boundary. Emit this only after
            // the persisted rows read for this poll have been sent in sequence.
            if ("runId" in selector)
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "replay.ready", run_id: selector.runId, last_seq: afterSeq ?? 0 })}\n\n`,
                ),
              );
            if (rows.length > 0) idleSince = Date.now();
            else if (Date.now() - idleSince >= keepaliveMs) {
              controller.enqueue(encoder.encode(": ping\n\n"));
              idleSince = Date.now();
            }
            if (request.signal.aborted) break;
            await sleep(pollIntervalMs);
          }
        } catch (error) {
          controller.error(error);
          return;
        }
        try {
          controller.close();
        } catch {
          // The client already disconnected; there is nothing left to close for.
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  };
}
