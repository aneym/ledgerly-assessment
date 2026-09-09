// Wraps a Next.js route handler so every request emits app_api instrumentation events and
// carries a stable correlation id, per docs/lanes/architecture/instrumentation-contract.md.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  correlationFromHeaders,
  type Emitter,
  type InstrumentationEvent,
  uncorrelated,
  withSpan,
} from "@ledgerly/core";
import { classifyTourRoute, projectTourResponse } from "./tour-response-proof";

type RequestInstrumentation = {
  correlationId: string;
  runId: string | undefined;
  emitter: Emitter | undefined;
  pending: InstrumentationEvent[];
};

// Next can reload a route module while retaining its cached backend. Both copies must
// read the same async context. Sinks belong to requests, never to this process-global slot.
const processContext = globalThis as typeof globalThis & {
  __ledgerlyRequestInstrumentationV1?: AsyncLocalStorage<RequestInstrumentation>;
};
processContext.__ledgerlyRequestInstrumentationV1 ??=
  new AsyncLocalStorage<RequestInstrumentation>();
const requestStore = processContext.__ledgerlyRequestInstrumentationV1;

// Explicit injection for isolated instrumentation tests. Server construction must use
// bindInstrumentationEmitter so one request cannot change another request's destination.
let testEmitter: Emitter | undefined;
export function setInstrumentationEmitter(next?: Emitter): void {
  testEmitter = next;
}

// getServer binds its validated cached instance before returning it to an operation.
// The span may already have started before the handler passed its auth/config gates.
// Flush that original event once, keeping its timestamp and correlation unchanged.
export function bindInstrumentationEmitter(next: Emitter): void {
  const context = requestStore.getStore();
  if (!context) return;
  if (!next || typeof next.emit !== "function") {
    throw new Error("Cached backend lacks instrumentation binding; restart the server");
  }
  if (context.emitter && context.emitter !== next) {
    throw new Error("Request instrumentation cannot switch backend");
  }
  context.emitter = next;
  const pending = context.pending.splice(0);
  for (const event of pending) next.emit(event);
}

// Exposed for tests and for anything else that wants to know whether it is running inside
// an instrumented request.
export function currentCorrelationId(): string | undefined {
  return requestStore.getStore()?.correlationId;
}

// Wraps a base emitter so a db event carrying the unit-of-work's placeholder correlation id
// picks up whatever request is ambient when it fires. Events that already carry a real
// correlation id (app_api, and whop when the caller supplied one) pass through untouched.
export function correlatedEmitter(base: Emitter): Emitter {
  return {
    emit(event) {
      const context = requestStore.getStore();
      const ambient = context?.correlationId;
      // A whop event minted its own correlation id inside the provider client (the client
      // has no access to the request); inside an instrumented request the request's id is
      // the one the trace panel joins on, so it wins there too.
      const rewrite =
        ambient !== undefined && (event.correlationId === uncorrelated || event.source === "whop");
      const runId = context?.runId;
      base.emit({
        ...event,
        ...(rewrite ? { correlationId: ambient } : {}),
        ...(runId ? { runId } : {}),
      });
    },
  };
}

export type InstrumentedHandler = (request: Request, correlationId: string) => Promise<Response>;

const correlationHeader = "x-ledgerly-correlation-id";

const runHeader = "x-demo-run";
const runCookie = "ledgerly_demo_run";

// The tour stamps its run id on requests with a header; browser navigations
// carry it in the cookie /demo/start sets. Either way the run-scoped stream can
// join every frame of a run.
export function runIdFromRequest(request: Request): string | undefined {
  const fromHeader = request.headers.get(runHeader)?.trim();
  if (fromHeader) return fromHeader;
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === runCookie && rest.length > 0) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function instrumented(
  handler: InstrumentedHandler,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const correlationId = correlationFromHeaders(request.headers);
    const runId = runIdFromRequest(request);
    const path = new URL(request.url).pathname;
    let tourProof: Record<string, string> = {};
    const context: RequestInstrumentation = {
      correlationId,
      runId,
      emitter: testEmitter,
      pending: [],
    };
    const requestEmitter: Emitter = {
      emit(event) {
        if (context.emitter) context.emitter.emit(event);
        else context.pending.push(event);
      },
    };
    const response = await requestStore.run(context, () =>
      withSpan(
        requestEmitter,
        {
          source: "app_api",
          method: request.method,
          path,
          correlationId,
          ...(runId === undefined ? {} : { runId }),
          provenance: "app",
        },
        async () => {
          try {
            const result = await handler(request, correlationId);
            tourProof = await projectTourResponse(request.method, path, result);
            return result;
          } catch (cause) {
            // A thrown error becomes a JSON 500 with the error name and message
            // (never a stack, never a secret) so the trace panel and provider
            // delivery logs show why a request failed instead of an empty body.
            const error = cause instanceof Error ? cause : new Error(String(cause));
            console.error("route failed", path, error.name, error.message);
            return Response.json({ error: error.name, message: error.message }, { status: 500 });
          }
        },
        (result) => ({
          status: result.status,
          safeIds: {
            ...tourProof,
            ...(classifyTourRoute(request.method, path)
              ? { tour_step: classifyTourRoute(request.method, path) as string }
              : {}),
          },
          summary: `app_api ${request.method} ${path} -> ${result.status}`,
        }),
      ),
    );
    // A denied/disabled handler need not select a backend. Its unpersisted span is
    // discarded with the request; it must never become proof for a later request.
    context.pending.length = 0;
    response.headers.set(correlationHeader, correlationId);
    return response;
  };
}
