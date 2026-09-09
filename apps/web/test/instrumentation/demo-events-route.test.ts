import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createTestDb } from "../../../../packages/db/src/client";
import {
  insertInstrumentationEvent,
  listInstrumentationEvents,
} from "../../../../packages/db/src/repos/instrumentation";
import { createEventsHandler } from "../../src/app/api/demo/events/handler";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});
beforeEach(async () => {
  await db.$client.exec("TRUNCATE instrumentation_events");
});

function operatorSession() {
  return Promise.resolve({ role: "operator" });
}

it("returns 404 when DEMO_MODE is off, before even checking the session", async () => {
  const handler = createEventsHandler({
    isDemoMode: () => false,
    getSession: operatorSession,
    listEvents: (query) => listInstrumentationEvents(db, query),
  });
  const response = await handler(
    new Request("https://example.invalid/api/demo/events?correlation_id=corr_1"),
  );
  expect(response.status).toBe(404);
});

it("returns 401 without an operator session", async () => {
  const handler = createEventsHandler({
    isDemoMode: () => true,
    getSession: () => Promise.resolve(null),
    listEvents: (query) => listInstrumentationEvents(db, query),
  });
  const response = await handler(
    new Request("https://example.invalid/api/demo/events?correlation_id=corr_1"),
  );
  expect(response.status).toBe(401);
});

it("returns 401 for a non-operator session", async () => {
  const handler = createEventsHandler({
    isDemoMode: () => true,
    getSession: () => Promise.resolve({ role: "buyer" }),
    listEvents: (query) => listInstrumentationEvents(db, query),
  });
  const response = await handler(
    new Request("https://example.invalid/api/demo/events?correlation_id=corr_1"),
  );
  expect(response.status).toBe(401);
});

it("streams the events already stored for the requested correlation id, then stops on disconnect", async () => {
  await insertInstrumentationEvent(db, {
    correlationId: "corr_stream",
    source: "app_api",
    phase: "start",
    path: "/api/thing",
    status: null,
    provenance: "app",
    safeIds: {},
    summary: "first",
    at: new Date(),
  });
  await insertInstrumentationEvent(db, {
    correlationId: "corr_stream",
    source: "app_api",
    phase: "end",
    path: "/api/thing",
    status: 200,
    provenance: "app",
    safeIds: {},
    summary: "second",
    at: new Date(),
  });

  const controller = new AbortController();
  const handler = createEventsHandler({
    isDemoMode: () => true,
    getSession: operatorSession,
    listEvents: (query) => listInstrumentationEvents(db, query),
    pollIntervalMs: 20,
  });
  const response = await handler(
    new Request("https://example.invalid/api/demo/events?correlation_id=corr_stream", {
      signal: controller.signal,
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Expected a readable stream body");
  const decoder = new TextDecoder();
  let buffer = "";
  // The stream opens with a ": connected" comment frame, then one frame per row.
  while ((buffer.match(/\n\n/g)?.length ?? 0) < 3) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  controller.abort();
  await reader.cancel().catch(() => {});

  const allFrames = buffer.trim().split("\n\n").filter(Boolean);
  expect(allFrames[0]).toBe(": connected");
  const frames = allFrames.filter((frame) => !frame.startsWith(":"));
  expect(frames).toHaveLength(2);
  expect(frames[0]).toMatch(/^id: \d+\ndata: /);
  expect(frames[0]).toContain('"summary":"first"');
  expect(frames[1]).toContain('"summary":"second"');
});

it("streams only the demo run's events even when a correlation id crosses runs", async () => {
  for (const runId of ["run_A", "run_B"]) {
    await insertInstrumentationEvent(db, {
      correlationId: "corr_shared",
      runId,
      source: "app_api",
      phase: "end",
      path: "/api/test",
      status: 200,
      provenance: "app",
      safeIds: {},
      summary: runId,
      at: new Date(),
    });
  }
  const handler = createEventsHandler({
    isDemoMode: () => true,
    getSession: async () => ({ role: "demo", demoRunId: "run_A" }),
    listEvents: (query) => listInstrumentationEvents(db, query),
    pollIntervalMs: 1,
    streamDurationMs: 20,
  });
  const response = await handler(
    new Request("http://app.test/api/demo/events?correlation_id=corr_shared", {
      headers: { cookie: "ledgerly_demo_run=run_A" },
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("run_A");
  expect(body).not.toContain("run_B");
});

it("refuses demo event requests without a run or selecting another run", async () => {
  const handler = createEventsHandler({
    isDemoMode: () => true,
    getSession: async () => ({ role: "demo", demoRunId: "run_A" }),
    listEvents: async () => {
      throw new Error("Must not read events");
    },
  });
  for (const headers of [{}, { "x-demo-run": "run_A" }] as Record<string, string>[]) {
    const response = await handler(
      new Request("http://app.test/api/demo/events?run_id=run_B", { headers }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "demo_scope" });
  }
});

it.each(["demo", "buyer", "seller"])(
  "denies foreign event selection for the %s profile",
  async (role) => {
    const handler = createEventsHandler({
      isDemoMode: () => true,
      getSession: async () => ({ role, demoRunId: "run_A" }),
      listEvents: async () => {
        throw new Error("Must not read");
      },
    });
    const response = await handler(
      new Request("http://x/api/demo/events?run_id=run_B", {
        headers: { "x-demo-run": "run_B" },
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  },
);
