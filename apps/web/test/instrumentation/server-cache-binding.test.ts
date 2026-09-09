import { afterEach, expect, it, vi } from "vitest";
import type { InstrumentationEvent } from "../../../../packages/core/src/instrumentation";

const fixture = vi.hoisted(() => ({ local: {}, getLocalRuntime: vi.fn() }));
vi.mock("@ledgerly/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getLocalRuntime: fixture.getLocalRuntime,
}));

const cacheSlot = globalThis as typeof globalThis & {
  __ledgerlyLocalServersV2?: WeakMap<object, unknown>;
};
const previousCache = cacheSlot.__ledgerlyLocalServersV2;
afterEach(() => {
  cacheSlot.__ledgerlyLocalServersV2 = previousCache;
  fixture.getLocalRuntime.mockReset();
  vi.resetModules();
});

it("binds the exact cached local server after the instrument and server modules reload", async () => {
  const first = await import("../../src/lib/instrument");
  const events: InstrumentationEvent[] = [];
  const cached = {
    instrumentationEmitter: first.correlatedEmitter({ emit: (event) => events.push(event) }),
  };
  cacheSlot.__ledgerlyLocalServersV2 = new WeakMap([[fixture.local, cached]]);
  fixture.getLocalRuntime.mockReturnValue(fixture.local);
  vi.resetModules();
  const fresh = await import("../../src/lib/instrument");
  const { getServer } = await import("../../src/lib/server");
  await fresh.instrumented(async () => {
    expect(getServer({ NODE_ENV: "test", LEDGERLY_LOCAL_RUNTIME: "fixture" })).toBe(cached);
    expect(getServer({ NODE_ENV: "test", LEDGERLY_LOCAL_RUNTIME: "fixture" })).toBe(cached);
    return Response.json({ ok: true });
  })(new Request("https://fixture.invalid/api/thing", { headers: { "x-demo-run": "cached_run" } }));
  expect(events).toHaveLength(2);
  expect(events.every((event) => event.runId === "cached_run")).toBe(true);
});

it("requires an owner restart for an old cached backend without the emitter field", async () => {
  const cached = {};
  cacheSlot.__ledgerlyLocalServersV2 = new WeakMap([[fixture.local, cached]]);
  fixture.getLocalRuntime.mockReturnValue(fixture.local);
  const { instrumented } = await import("../../src/lib/instrument");
  const { getServer } = await import("../../src/lib/server");
  const operation = vi.fn();
  const response = await instrumented(async () => {
    getServer({ NODE_ENV: "test", LEDGERLY_LOCAL_RUNTIME: "fixture" });
    operation();
    return Response.json({ ok: true });
  })(new Request("https://fixture.invalid/api/thing"));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    message: "Cached backend lacks instrumentation binding; restart the server",
  });
  expect(operation).not.toHaveBeenCalled();
  expect(cacheSlot.__ledgerlyLocalServersV2?.get(fixture.local)).toBe(cached);
});
