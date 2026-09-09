import { afterEach, expect, it, vi } from "vitest";
import type { Emitter, InstrumentationEvent } from "../../../../packages/core/src/instrumentation";
import { uncorrelated } from "../../../../packages/core/src/instrumentation";
import {
  correlatedEmitter,
  currentCorrelationId,
  instrumented,
  setInstrumentationEmitter,
} from "../../src/lib/instrument";

afterEach(() => {
  // Restore the module's default no-op so later test files aren't affected by whichever
  // emitter the last test in this file installed.
  setInstrumentationEmitter({ emit() {} });
});

it("mints a correlation id, emits app_api start and end events, and sets the response header", async () => {
  const events: InstrumentationEvent[] = [];
  setInstrumentationEmitter({ emit: (event) => events.push(event) });
  const handler = instrumented(async (_request, correlationId) => {
    expect(currentCorrelationId()).toBe(correlationId);
    return Response.json({ ok: true }, { status: 201 });
  });
  const response = await handler(new Request("https://example.invalid/api/thing"));
  expect(response.status).toBe(201);
  const correlationId = response.headers.get("x-ledgerly-correlation-id");
  expect(correlationId).toBeTruthy();
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    source: "app_api",
    phase: "start",
    method: "GET",
    path: "/api/thing",
    correlationId,
    provenance: "app",
  });
  expect(events[1]).toMatchObject({ source: "app_api", phase: "end", status: 201, correlationId });
});

it("reuses the incoming x-ledgerly-correlation-id header instead of minting one", async () => {
  const events: InstrumentationEvent[] = [];
  setInstrumentationEmitter({ emit: (event) => events.push(event) });
  const handler = instrumented(async () => Response.json({}, { status: 200 }));
  const response = await handler(
    new Request("https://example.invalid/api/thing", {
      headers: { "x-ledgerly-correlation-id": "corr_fixed" },
    }),
  );
  expect(response.headers.get("x-ledgerly-correlation-id")).toBe("corr_fixed");
  expect(events.every((event) => event.correlationId === "corr_fixed")).toBe(true);
});

it("turns a thrown handler error into a JSON 500 with an end event carrying status 500", async () => {
  const emit = vi.fn();
  setInstrumentationEmitter({ emit });
  const handler = instrumented(async () => {
    throw new Error("boom");
  });
  const response = await handler(new Request("https://example.invalid/api/thing"));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Error", message: "boom" });
  const emitted = emit.mock.calls.map(([event]) => event as InstrumentationEvent);
  expect(emitted).toHaveLength(2);
  expect(emitted[1]).toMatchObject({ phase: "end", status: 500 });
});

it("correlatedEmitter stamps an uncorrelated db event with the ambient request id", async () => {
  const seen: InstrumentationEvent[] = [];
  const base: Emitter = { emit: (event) => seen.push(event) };
  const wrapped = correlatedEmitter(base);
  setInstrumentationEmitter(wrapped);
  const handler = instrumented(async () => {
    wrapped.emit({
      correlationId: uncorrelated,
      source: "db",
      phase: "end",
      path: "run",
      status: "ok",
      provenance: "neon",
      safeIds: {},
      summary: "db transaction committed",
      at: new Date(),
    });
    return Response.json({}, { status: 200 });
  });
  const response = await handler(new Request("https://example.invalid/api/thing"));
  const correlationId = response.headers.get("x-ledgerly-correlation-id");
  const dbEvent = seen.find((event) => event.source === "db");
  expect(dbEvent?.correlationId).toBe(correlationId);
});

it("leaves an already-correlated event untouched outside any ambient request", () => {
  const seen: InstrumentationEvent[] = [];
  const wrapped = correlatedEmitter({ emit: (event) => seen.push(event) });
  wrapped.emit({
    correlationId: "corr_explicit",
    source: "db",
    phase: "end",
    path: "run",
    status: "ok",
    provenance: "pglite",
    safeIds: {},
    summary: "db transaction committed",
    at: new Date(),
  });
  expect(seen[0]?.correlationId).toBe("corr_explicit");
});
