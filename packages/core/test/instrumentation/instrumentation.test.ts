import { describe, expect, it, vi } from "vitest";
import {
  correlationFromHeaders,
  type Emitter,
  type InstrumentationEvent,
  redactSafeIds,
  withSpan,
} from "../../src/index";

describe("redactSafeIds", () => {
  it("passes through identifiers with no secret shape", () => {
    const safeIds = { sellerId: "seller_1", paymentId: "pay_abc" };
    expect(redactSafeIds(safeIds)).toBe(safeIds);
  });
  it.each([
    ["apik_live_secret", "apik_"],
    ["ws_something", "ws_"],
    ["Bearer sometoken", "Bearer"],
    ["npg_connectionsecret", "npg_"],
  ])("throws when a value looks like a secret (%s)", (leaked) => {
    expect(() => redactSafeIds({ leaked })).toThrow();
  });
});

describe("correlationFromHeaders", () => {
  it("reads the correlation header when present", () => {
    const headers = {
      get: (name: string) => (name === "x-ledgerly-correlation-id" ? "corr_1" : null),
    };
    expect(correlationFromHeaders(headers)).toBe("corr_1");
  });
  it("mints a fresh id when the header is absent", () => {
    const headers = { get: () => null };
    const first = correlationFromHeaders(headers);
    const second = correlationFromHeaders(headers);
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe("withSpan", () => {
  const context = {
    source: "whop" as const,
    method: "GET",
    path: "/accounts/biz_1",
    correlationId: "corr_1",
    provenance: "sandbox" as const,
  };
  it("emits a start event then an end event carrying duration and status", async () => {
    const events: InstrumentationEvent[] = [];
    const emitter: Emitter = { emit: (event) => events.push(event) };
    const result = await withSpan(
      emitter,
      context,
      async () => "ok" as const,
      (value) => ({ status: 200, safeIds: { sellerId: "seller_1" }, summary: `resolved ${value}` }),
    );
    expect(result).toBe("ok");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ phase: "start", status: null, correlationId: "corr_1" });
    expect(events[1]).toMatchObject({
      phase: "end",
      status: 200,
      safeIds: { sellerId: "seller_1" },
      summary: "resolved ok",
    });
    expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0);
  });
  it("emits an end event with status error and rethrows on failure", async () => {
    const emitter: Emitter = { emit: vi.fn() };
    await expect(
      withSpan(
        emitter,
        context,
        async () => {
          throw new Error("boom");
        },
        () => ({ status: 200, summary: "never reached" }),
      ),
    ).rejects.toThrow("boom");
    const emitted = vi.mocked(emitter.emit).mock.calls.map(([event]) => event);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ phase: "end", status: "error", summary: "boom" });
  });
  it("rejects a leaked secret in the outcome's safe_ids", async () => {
    const emitter: Emitter = { emit: vi.fn() };
    await expect(
      withSpan(
        emitter,
        context,
        async () => "value",
        () => ({ status: 200, safeIds: { token: "apik_leaked" }, summary: "should not persist" }),
      ),
    ).rejects.toThrow();
  });
  it("carries gate through to the end event when the outcome sets one", async () => {
    const events: InstrumentationEvent[] = [];
    const emitter: Emitter = { emit: (event) => events.push(event) };
    await withSpan(
      emitter,
      context,
      async () => "denied" as const,
      () => ({
        status: 403,
        summary: "gated",
        gate: { id: "G01", reason: "Whop capability is not active on this account" },
      }),
    );
    expect(events[0]).not.toHaveProperty("gate");
    expect(events[1]).toMatchObject({
      phase: "end",
      gate: { id: "G01", reason: "Whop capability is not active on this account" },
    });
  });
  it("omits gate from the end event when the outcome does not set one", async () => {
    const events: InstrumentationEvent[] = [];
    const emitter: Emitter = { emit: (event) => events.push(event) };
    await withSpan(
      emitter,
      context,
      async () => "ok" as const,
      () => ({ status: 200, summary: "fine" }),
    );
    expect(events[1]).not.toHaveProperty("gate");
  });
});
