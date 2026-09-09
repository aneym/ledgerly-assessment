import { type InstrumentationEvent, whopAccountId } from "@ledgerly/core";
import { describe, expect, it, vi } from "vitest";
import { createMockAdapter, createWhopAdapter } from "../src/index";

const seller = {
  externalId: "run1:seller1",
  runId: "run1",
  email: "private@example.invalid",
  country: "US" as const,
  title: "Private seller",
};

describe("actual mock provider telemetry", () => {
  it("observes actual account creation and read without inventing HTTP status", async () => {
    const events: InstrumentationEvent[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network allowed"));
    try {
      const mock = createMockAdapter();
      const adapter = createWhopAdapter(
        { WHOP_MODE: "mock" },
        { mock, onEvent: (event) => events.push(event) },
      );
      const result = await adapter.createOrFetchAccount(seller, "secret-operation-key");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Account not created");
      const read = await adapter.getAccount(result.value.id, "read");
      expect(read.ok).toBe(true);
      expect(events).toHaveLength(4);
      expect(
        events.map(({ phase, status, provenance }) => ({ phase, status, provenance })),
      ).toEqual([
        { phase: "start", status: null, provenance: "mock" },
        { phase: "end", status: "ok", provenance: "mock" },
        { phase: "start", status: null, provenance: "mock" },
        { phase: "end", status: "ok", provenance: "mock" },
      ]);
      expect(events[1]).toMatchObject({
        method: "POST",
        path: "/accounts",
        safeIds: { mock_result: "succeeded", account_id: result.value.id },
      });
      expect(events[3]).toMatchObject({
        method: "GET",
        path: `/accounts/${result.value.id}`,
        safeIds: { mock_result: "succeeded", account_id: result.value.id },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.stringify(events)).not.toContain(seller.email);
      expect(JSON.stringify(events)).not.toContain("secret-operation-key");
    } finally {
      fetch.mockRestore();
    }
  });
  it("reports a failed Result unchanged without emitting its error body", async () => {
    const events: InstrumentationEvent[] = [];
    const adapter = createWhopAdapter(
      { WHOP_MODE: "mock" },
      {
        mock: createMockAdapter({ accountKind: "connected" }),
        onEvent: (event) => events.push(event),
      },
    );
    expect(await adapter.createOrFetchAccount(seller, "a")).toEqual({
      ok: false,
      error: { kind: "nested_account" },
    });
    expect(events.at(-1)).toMatchObject({
      phase: "end",
      status: "error",
      provenance: "mock",
      safeIds: { mock_result: "failed" },
    });
  });
});

import { instrumentMockAdapter } from "../src/mock-instrumentation";

it("records end only after the actual pending call settles and preserves this and result identity", async () => {
  const events: InstrumentationEvent[] = [];
  const account = whopAccountId("biz_settled");
  if (!account.ok) throw new Error("Invalid fixture ID");
  const result = { ok: true as const, value: { id: account.value, raw: { token: "apik_secret" } } };
  let settle: (() => void) | undefined;
  const pending = new Promise<typeof result>((resolve) => {
    settle = () => resolve(result);
  });
  const mock = {
    ...createMockAdapter(),
    marker: "bound",
    async getAccount() {
      expect(this.marker).toBe("bound");
      return pending;
    },
    helper() {
      return this.marker;
    },
  };
  const wrapped = instrumentMockAdapter(mock, (event) => events.push(event));
  const call = wrapped.getAccount();
  expect(events).toHaveLength(1);
  expect(events[0]?.phase).toBe("start");
  expect(wrapped.helper()).toBe("bound");
  expect(events).toHaveLength(1);
  if (!settle) throw new Error("Missing deferred settlement");
  settle();
  expect(await call).toBe(result);
  expect(events).toHaveLength(2);
  expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0);
  expect(events[1]?.at.getTime()).toBeGreaterThanOrEqual(events[0]?.at.getTime() ?? Infinity);
  expect(events[1]?.correlationId).toBe(events[0]?.correlationId);
  expect(JSON.stringify(events)).not.toContain("apik_secret");
});

it("rethrows the exact exception while retaining a secret-free failed event", async () => {
  const events: InstrumentationEvent[] = [];
  const error = new Error("apik_secret private@example.invalid");
  const mock = {
    ...createMockAdapter(),
    async getAccount() {
      throw error;
    },
  };
  const wrapped = instrumentMockAdapter(mock, (event) => events.push(event));
  await expect(wrapped.getAccount()).rejects.toBe(error);
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    phase: "end",
    status: "error",
    provenance: "mock",
    safeIds: { mock_result: "threw" },
    summary: "mock getAccount threw",
  });
  expect(JSON.stringify(events)).not.toContain(error.message);
});

it("preserves optional mock seeding helpers and leaves adapters unchanged without a subscriber", async () => {
  const events: InstrumentationEvent[] = [];
  const original = createMockAdapter();
  expect(instrumentMockAdapter(original)).toBe(original);
  const wrapped = instrumentMockAdapter(original, (event) => events.push(event));
  expect(wrapped.seedBalance).toBe(wrapped.seedBalance);
  expect(wrapped.seedDemoPayment).toBeTypeOf("function");
  expect(wrapped.emitWebhook).toBeTypeOf("function");
  const created = await wrapped.createOrFetchAccount(seller, "seed");
  if (!created.ok) throw new Error("Missing fixture account");
  wrapped.seedBalance(created.value.id, { amountMinor: 1000, currency: "USD" });
  const seeded = wrapped.seedDemoPayment(created.value.id, "run_seed");
  expect(seeded.ok).toBe(true);
  expect(events).toHaveLength(2);
});

it("never projects an unsafe account argument or result into event paths or IDs", async () => {
  const events: InstrumentationEvent[] = [];
  const mock = {
    ...createMockAdapter(),
    async getAccount(_id: string) {
      return { ok: true as const, value: { id: "apik_secret", raw: {} } };
    },
  };
  // Runtime decoder regression for a malformed custom mock implementation.
  const wrapped = instrumentMockAdapter(
    mock as unknown as ReturnType<typeof createMockAdapter>,
    (event) => events.push(event),
  );
  await wrapped.getAccount("apik_secret" as never, "read");
  expect(events[1]).toMatchObject({
    path: "/accounts/:accountId",
    safeIds: { mock_result: "succeeded" },
  });
  expect(events[1]?.safeIds).not.toHaveProperty("account_id");
  expect(JSON.stringify(events)).not.toContain("apik_secret");
});

it("does not add a second mock event pair to hybrid fallback", async () => {
  const events: InstrumentationEvent[] = [];
  const adapter = createWhopAdapter(
    {
      WHOP_MODE: "hybrid",
      WHOP_API_VERSION_DATE: "2026-08-21",
      WHOP_PLATFORM_ACCOUNT_ID: "biz_platform",
    },
    { mock: createMockAdapter(), onEvent: (event) => events.push(event) },
  );
  const account = whopAccountId("biz_platform");
  if (!account.ok) throw new Error("Invalid fixture ID");
  await adapter.getPayout({ payoutId: "payout_missing", accountId: account.value }, "key");
  const payoutEvents = events.filter((event) => event.path === "/payouts/:payoutId");
  expect(payoutEvents).toHaveLength(2);
  expect(payoutEvents.every((event) => event.safeIds.mock_result === undefined)).toBe(true);
});
