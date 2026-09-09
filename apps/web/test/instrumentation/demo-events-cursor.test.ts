import { describe, expect, it, vi } from "vitest";
import type { EventsRouteDeps } from "../../src/app/api/demo/events/handler";
import { createEventsHandler } from "../../src/app/api/demo/events/handler";

function deps(over: Partial<EventsRouteDeps> = {}): EventsRouteDeps {
  return {
    isDemoMode: () => true,
    getSession: async () => ({ role: "seller", demoRunId: "run_owned" }),
    listEvents: async () => [],
    pollIntervalMs: 1,
    streamDurationMs: 12,
    ...over,
  };
}
function request(query: string, header?: string) {
  return new Request(`http://app.test/api/demo/events?run_id=run_owned${query}`, {
    headers: {
      cookie: "ledgerly_demo_run=run_owned",
      ...(header === undefined ? {} : { "last-event-id": header }),
    },
  });
}
describe("snapshot to live stream cursor", () => {
  it("starts after the snapshot watermark and delivers the next persisted row", async () => {
    const rows = [6, 7, 8].map((seq) => ({
      id: `evt_${seq}`,
      seq,
      correlationId: `corr_${seq}`,
      runId: "run_owned",
      source: "app_api" as const,
      phase: "end" as const,
      method: "GET",
      path: "/api/orders/order_1",
      status: 200,
      provenance: "app" as const,
      safeIds: {},
      summary: `event_${seq}`,
      at: new Date(),
    }));
    const listEvents = vi.fn<EventsRouteDeps["listEvents"]>(async ({ afterSeq }) =>
      rows.filter((row) => row.seq > (afterSeq ?? 0)),
    );
    const response = await createEventsHandler(deps({ listEvents }))(request("&after=7"));
    const body = await response.text();
    expect(listEvents.mock.calls[0]?.[0]).toEqual({ runId: "run_owned", afterSeq: 7 });
    expect(body).toContain("id: 8\n");
    expect(body).not.toContain("id: 7\n");
    expect(body).not.toContain("id: 6\n");
  });
  it("uses native reconnect Last-Event-ID ahead of the original after query", async () => {
    const listEvents = vi.fn<EventsRouteDeps["listEvents"]>(async () => []);
    const response = await createEventsHandler(deps({ listEvents }))(request("&after=7", "12"));
    await response.text();
    expect(listEvents.mock.calls[0]?.[0]).toEqual({ runId: "run_owned", afterSeq: 12 });
  });
  it.each(["", "-1", "1.2", "NaN", "Infinity", "9007199254740992", "1e3", "one"])(
    "rejects malformed cursor %s before reading",
    async (cursor) => {
      for (const req of [request(`&after=${cursor}`), request("&after=7", cursor)]) {
        const listEvents = vi.fn<EventsRouteDeps["listEvents"]>(async () => []);
        const response = await createEventsHandler(deps({ listEvents }))(req);
        expect(response.status).toBe(400);
        expect(listEvents).not.toHaveBeenCalled();
      }
    },
  );
  it("accepts zero as an explicit initial cursor", async () => {
    const listEvents = vi.fn<EventsRouteDeps["listEvents"]>(async () => []);
    const response = await createEventsHandler(deps({ listEvents }))(request("&after=0"));
    await response.text();
    expect(listEvents.mock.calls[0]?.[0]).toEqual({ runId: "run_owned", afterSeq: 0 });
  });
});

it.each(["seller", "buyer", "demo"])(
  "permits %s profile's authenticated run query with or without matching cookie",
  async (role) => {
    const variants: Record<string, string>[] = [{}, { cookie: "ledgerly_demo_run=run_owned" }];
    for (const headers of variants) {
      const response = await createEventsHandler(
        deps({ getSession: async () => ({ role, demoRunId: "run_owned" }) }),
      )(new Request("http://app.test/api/demo/events?run_id=run_owned&after=0", { headers }));
      expect(response.status).toBe(200);
      await response.text();
    }
  },
);

it.each([
  ["run_id=run_owned&run_id=run_foreign", {}],
  ["run_id=run_owned&run=run_foreign", {}],
  ["run_id=run_owned", { "x-demo-run": "run_foreign" }],
  ["run_id=run_owned", { cookie: "ledgerly_demo_run=run_foreign" }],
  ["run_id=run_owned", { cookie: "ledgerly_demo_run=%XX" }],
] as [string, Record<string, string>][])(
  "refuses conflicting run selector %s",
  async (query, headers) => {
    const listEvents = vi.fn<EventsRouteDeps["listEvents"]>(async () => []);
    const response = await createEventsHandler(deps({ listEvents }))(
      new Request(`http://app.test/api/demo/events?${query}`, { headers }),
    );
    expect(response.status).toBe(403);
    expect(listEvents).not.toHaveBeenCalled();
  },
);

it.each(["seller", "buyer", "demo"])(
  "refuses %s without authenticated run binding",
  async (role) => {
    const response = await createEventsHandler(deps({ getSession: async () => ({ role }) }))(
      request("&after=0"),
    );
    expect([401, 403]).toContain(response.status);
  },
);
