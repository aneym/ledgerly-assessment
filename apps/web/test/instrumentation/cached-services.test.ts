import { afterEach, expect, it, vi } from "vitest";
import type { InstrumentationEvent } from "../../../../packages/core/src/instrumentation";
import {
  bindInstrumentationEmitter,
  correlatedEmitter,
  instrumented,
} from "../../src/lib/instrument";

const backend = vi.hoisted(() => ({ getServer: vi.fn() }));
vi.mock("../../src/lib/server", () => backend);
vi.mock("../../../../packages/db/src/repos/resolution", () => ({
  createNeonResolutionUnitOfWork: vi.fn(() => ({})),
}));
vi.mock("../../../../packages/db/src/repos/unit-of-work", () => ({
  createNeonUnitOfWork: vi.fn(() => ({})),
}));
vi.mock("../../../../packages/whop/src/index", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createWhopAdapter: vi.fn(() => ({})),
}));
vi.mock("@ledgerly/db", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const fake = Object.fromEntries(
    [
      "createNeonUnitOfWork",
      "createNeonResolutionUnitOfWork",
      "createOrdersRepo",
      "createSellerLookup",
      "createSellerIdentityLookup",
      "createSellerDisplayNameRepo",
      "createSellerAdminWritesRepo",
      "createSellerListRepo",
      "createUsersRepo",
      "createLedgerReader",
      "createProductsRepo",
      "createRefundRequestsRepo",
    ].map((name) => [name, vi.fn(() => ({}))]),
  );
  return { ...actual, ...fake };
});
vi.mock("@ledgerly/whop", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createWhopAdapter: vi.fn(() => ({})),
}));
vi.mock("@ledgerly/core", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createOrderService: vi.fn(() => ({})),
  createEarningsService: vi.fn(() => ({})),
  createReconciliationProvider: vi.fn(() => ({})),
  createReconciliationService: vi.fn(() => ({})),
  createResolutionService: vi.fn(() => ({})),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  backend.getServer.mockReset();
});

it.each(["commerce", "admin"])(
  "binds the original cached %s server on each nonlocal request",
  async (service) => {
    vi.stubEnv("LEDGERLY_LOCAL_RUNTIME", undefined);
    vi.stubEnv("DATABASE_URL", "postgres://fixture.invalid/offline");
    vi.stubEnv("APP_BASE_URL", "https://fixture.invalid");
    const events: InstrumentationEvent[] = [];
    const emitter = correlatedEmitter({ emit: (event) => events.push(event) });
    backend.getServer.mockImplementation(() => {
      bindInstrumentationEmitter(emitter);
      return { db: {}, instrumentationEmitter: emitter };
    });
    const getter =
      service === "commerce"
        ? (await import("../../src/lib/commerce")).getCommerce
        : (await import("../../src/lib/admin-resolution")).getAdminResolution;
    const cached = getter();
    const providerFactory =
      service === "commerce"
        ? (await import("@ledgerly/whop")).createWhopAdapter
        : (await import("../../../../packages/whop/src/index")).createWhopAdapter;
    expect(providerFactory).toHaveBeenLastCalledWith(expect.any(Object), { onEvent: emitter.emit });
    expect(backend.getServer).toHaveBeenCalledTimes(1);
    backend.getServer.mockImplementation(() => {
      throw new Error("Must use original cached backend");
    });
    for (const run of ["first", "second"]) {
      const response = await instrumented(async () => {
        expect(getter()).toBe(cached);
        return Response.json({ ok: true });
      })(new Request("https://fixture.invalid/api/thing", { headers: { "x-demo-run": run } }));
      expect(response.status).toBe(200);
    }
    expect(backend.getServer).toHaveBeenCalledTimes(1);
    expect(events.map((event) => `${event.runId}:${event.phase}`)).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  },
);
