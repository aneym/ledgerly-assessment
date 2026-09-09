import { afterEach, expect, it, vi } from "vitest";
import type { Emitter, InstrumentationEvent } from "../../../../packages/core/src/instrumentation";
import { uncorrelated } from "../../../../packages/core/src/instrumentation";
import { mapTourInstrumentation } from "../../../../packages/demo-runtime/src/instrumentation";

const backend = vi.hoisted(() => ({ getServer: vi.fn() }));
vi.mock("../../src/lib/server", () => backend);

afterEach(() => {
  vi.resetModules();
  backend.getServer.mockReset();
});

function request(run: string) {
  return new Request("https://example.invalid/api/sellers", {
    method: "POST",
    headers: { "x-demo-run": run, "x-ledgerly-correlation-id": `corr_${run}` },
  });
}

function dependencyEvents(emitter: Emitter) {
  for (const source of ["db", "whop"] as const) {
    emitter.emit({
      source,
      phase: "end",
      correlationId: uncorrelated,
      path: "run",
      status: "ok",
      provenance: "mock",
      safeIds: {},
      summary: "completed",
      at: new Date(),
    });
  }
}

function assertProof(events: InstrumentationEvent[], run: string) {
  expect(events.map((event) => `${event.source}:${event.phase}`)).toEqual([
    "app_api:start",
    "db:end",
    "whop:end",
    "app_api:end",
  ]);
  expect(
    events.every((event) => event.runId === run && event.correlationId === `corr_${run}`),
  ).toBe(true);
  expect(events.at(-1)).toMatchObject({
    safeIds: { tour_step: "C01", tour_seller_id: `seller_${run}` },
  });
  const rows = events.map((event, index) => ({ ...event, id: `event_${index}`, seq: index + 1 }));
  expect(mapTourInstrumentation(rows, run).length).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toContain("secret_sentinel");
}

it("flushes the original cold span start once when the handler first selects its server", async () => {
  const module = await import("../../src/lib/instrument");
  const events: InstrumentationEvent[] = [];
  const cached = {
    instrumentationEmitter: module.correlatedEmitter({ emit: (event) => events.push(event) }),
  };
  backend.getServer.mockImplementation(() => {
    module.bindInstrumentationEmitter(cached.instrumentationEmitter);
    return cached;
  });
  const response = await module.instrumented(async () => {
    const beforeBinding = new Date();
    expect(events).toHaveLength(0);
    backend.getServer();
    backend.getServer();
    expect(events).toHaveLength(1);
    expect(events[0]?.at.getTime()).toBeLessThanOrEqual(beforeBinding.getTime());
    dependencyEvents(cached.instrumentationEmitter);
    return Response.json(
      { id: "seller_cold", provenance: "mock", token: "secret_sentinel" },
      { status: 201 },
    );
  })(request("cold"));
  expect(response.status).toBe(201);
  assertProof(events, "cold");
});

it("keeps the cached server emitter correlated after the route module reloads", async () => {
  const first = await import("../../src/lib/instrument");
  const events: InstrumentationEvent[] = [];
  const cached = {
    instrumentationEmitter: first.correlatedEmitter({ emit: (event) => events.push(event) }),
  };
  backend.getServer.mockImplementation(() => {
    first.bindInstrumentationEmitter(cached.instrumentationEmitter);
    return cached;
  });
  vi.resetModules();
  const reloaded = await import("../../src/lib/instrument");
  await reloaded.instrumented(async () => {
    backend.getServer();
    dependencyEvents(cached.instrumentationEmitter);
    return Response.json({ id: "seller_reload", provenance: "mock" }, { status: 201 });
  })(request("reload"));
  assertProof(events, "reload");
});

it("holds each selected server sink across overlapping requests", async () => {
  const module = await import("../../src/lib/instrument");
  const eventsA: InstrumentationEvent[] = [];
  const eventsB: InstrumentationEvent[] = [];
  const serverA = {
    instrumentationEmitter: module.correlatedEmitter({ emit: (event) => eventsA.push(event) }),
  };
  const serverB = {
    instrumentationEmitter: module.correlatedEmitter({ emit: (event) => eventsB.push(event) }),
  };
  backend.getServer
    .mockImplementationOnce(() => {
      module.bindInstrumentationEmitter(serverA.instrumentationEmitter);
      return serverA;
    })
    .mockImplementationOnce(() => {
      module.bindInstrumentationEmitter(serverB.instrumentationEmitter);
      return serverB;
    });
  let releaseA!: () => void;
  let enteredA!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredA = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const first = module.instrumented(async () => {
    backend.getServer();
    enteredA();
    await wait;
    dependencyEvents(serverA.instrumentationEmitter);
    return Response.json({ id: "seller_a", provenance: "mock" }, { status: 201 });
  })(request("a"));
  await entered;
  await module.instrumented(async () => {
    backend.getServer();
    dependencyEvents(serverB.instrumentationEmitter);
    return Response.json({ id: "seller_b", provenance: "mock" }, { status: 201 });
  })(request("b"));
  releaseA();
  await first;
  assertProof(eventsA, "a");
  assertProof(eventsB, "b");
});

it("rejects a second backend before its operation runs", async () => {
  const module = await import("../../src/lib/instrument");
  const eventsA: InstrumentationEvent[] = [];
  const emitB = vi.fn();
  const operationB = vi.fn();
  const response = await module.instrumented(async () => {
    module.bindInstrumentationEmitter({ emit: (event) => eventsA.push(event) });
    module.bindInstrumentationEmitter({ emit: emitB });
    operationB();
    return Response.json({ ok: true });
  })(request("mismatch"));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    message: "Request instrumentation cannot switch backend",
  });
  expect(operationB).not.toHaveBeenCalled();
  expect(emitB).not.toHaveBeenCalled();
  expect(eventsA.map((event) => event.phase)).toEqual(["start", "end"]);
});

it.each([401, 404])(
  "preserves a %i gate without initializing an unavailable backend",
  async (status) => {
    const module = await import("../../src/lib/instrument");
    backend.getServer.mockImplementation(() => {
      throw new Error("Missing DATABASE_URL");
    });
    const response = await module.instrumented(async () =>
      Response.json({ error: "denied" }, { status }),
    )(request("denied"));
    expect(response.status).toBe(status);
    expect(backend.getServer).not.toHaveBeenCalled();
    const events: InstrumentationEvent[] = [];
    await module.instrumented(async () => {
      module.bindInstrumentationEmitter(
        module.correlatedEmitter({ emit: (event) => events.push(event) }),
      );
      return Response.json({ ok: true });
    })(request("next"));
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.runId === "next")).toBe(true);
  },
);
