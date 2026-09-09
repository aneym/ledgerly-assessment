import type { InstrumentationEvent } from "@ledgerly/core";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createWhopClient } from "../src/index";

const options = {
  baseUrl: "https://sandbox.invalid/api/v1",
  apiKey: "test-key",
  apiVersionDate: "2026-08-21",
};
it("emits a whop start and end event around a successful request", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('{"id":"biz_test"}'));
  const events: InstrumentationEvent[] = [];
  const client = createWhopClient({ ...options, fetch, onEvent: (event) => events.push(event) });
  const result = await client.request("GET", "/accounts/biz_test", {
    schema: z.object({ id: z.string() }),
    correlationId: "corr_1",
    safeIds: { sellerId: "seller_1" },
  });
  expect(result).toEqual({ ok: true, value: { id: "biz_test" } });
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    source: "whop",
    phase: "start",
    method: "GET",
    path: "/accounts/biz_test",
    correlationId: "corr_1",
    provenance: "sandbox",
    status: null,
  });
  expect(events[1]).toMatchObject({
    source: "whop",
    phase: "end",
    method: "GET",
    path: "/accounts/biz_test",
    correlationId: "corr_1",
    provenance: "sandbox",
    status: 200,
    safeIds: { sellerId: "seller_1" },
  });
  expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0);
});
it("emits an end event carrying the HTTP status on a rejected request", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('{"error":"rejected"}', { status: 422 }));
  const events: InstrumentationEvent[] = [];
  const client = createWhopClient({ ...options, fetch, onEvent: (event) => events.push(event) });
  await client.request("POST", "/accounts", { schema: z.unknown(), correlationId: "corr_2" });
  expect(events[1]).toMatchObject({ phase: "end", status: 422 });
  // An ordinary HTTP failure (kind "http") is not a gate: the overlay must see this as a
  // plain failed call, not a gated one.
  expect(events[1]).not.toHaveProperty("gate");
});
it("strips the query string from the instrumented path but keeps ids", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}"));
  const events: InstrumentationEvent[] = [];
  const client = createWhopClient({ ...options, fetch, onEvent: (event) => events.push(event) });
  await client.request("GET", "/payments?account_id=biz_test&after=cursor", {
    schema: z.unknown(),
  });
  expect(events[0]?.path).toBe("/payments");
});
it("mints a correlation id when the caller does not supply one", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}"));
  const events: InstrumentationEvent[] = [];
  const client = createWhopClient({ ...options, fetch, onEvent: (event) => events.push(event) });
  await client.request("GET", "/accounts", { schema: z.unknown() });
  expect(events[0]?.correlationId.length).toBeGreaterThan(0);
});
it("stays a no-op without onEvent, matching prior behavior", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('{"id":"biz_test"}'));
  const client = createWhopClient({ ...options, fetch });
  await expect(
    client.request("GET", "/accounts/biz_test", { schema: z.object({ id: z.string() }) }),
  ).resolves.toEqual({ ok: true, value: { id: "biz_test" } });
});
