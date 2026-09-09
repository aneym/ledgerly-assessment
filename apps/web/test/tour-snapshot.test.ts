import { describe, expect, it, vi } from "vitest";
import { createTourSnapshotHandler, type TourHistoryDeps } from "@/lib/tour-finish";
import type { PersistedInstrumentationRow } from "../../../packages/demo-runtime/src/instrumentation";

const identity = {
  userId: "user_1",
  demoRunId: "run_owned",
  email: "demo-seller+run_owned@ledgerly.test",
  expiresAt: new Date("2026-09-10T00:00:00Z"),
};
const req = (query = "run=run_owned", headers: Record<string, string> = {}) =>
  new Request(`https://example.invalid/api/demo/snapshot?${query}`, { headers });
function row(seq: number): PersistedInstrumentationRow {
  return {
    id: `event_${seq}`,
    seq,
    correlationId: `corr_${seq}`,
    runId: "run_owned",
    source: "app_api",
    phase: "end",
    method: "GET",
    path: "/api/unrelated",
    status: 200,
    provenance: "app",
    safeIds: {},
    summary: "Persisted read",
    at: "2026-09-09T00:00:00Z",
  };
}
function deps(over: Partial<TourHistoryDeps> = {}): TourHistoryDeps {
  return {
    enabled: () => true,
    identity: async () => identity,
    listEvents: async () => [],
    now: () => new Date("2026-09-09T00:00:00Z"),
    ...over,
  };
}

describe("authenticated persisted tour snapshot", () => {
  it.each(["seller", "buyer", "operator"])(
    "allows a verified %s profile without a global operator grant",
    async (profile) => {
      const response = await createTourSnapshotHandler(
        deps({
          identity: async () => ({ ...identity, email: `demo-${profile}+run_owned@ledgerly.test` }),
          listEvents: async () => [row(7)],
        }),
      )(req());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ run_id: "run_owned", events: [row(7)], last_seq: 7 });
      expect(response.headers.get("cache-control")).toContain("no-store");
    },
  );
  it("includes the final raw watermark even when no raw events map to tour chapters", async () => {
    const rows = Array.from({ length: 503 }, (_, index) => row(index * 2 + 1));
    const listEvents = vi.fn(async ({ afterSeq, limit }: { afterSeq: number; limit: number }) =>
      rows.filter((event) => event.seq > afterSeq).slice(0, limit),
    );
    const response = await createTourSnapshotHandler(deps({ listEvents }))(req());
    expect(await response.json()).toEqual({ run_id: "run_owned", events: rows, last_seq: 1005 });
    expect(listEvents.mock.calls).toEqual([
      [{ runId: "run_owned", afterSeq: 0, limit: 500 }],
      [{ runId: "run_owned", afterSeq: 999, limit: 500 }],
    ]);
  });
  it("returns an empty authoritative snapshot with watermark zero", async () => {
    expect(await (await createTourSnapshotHandler(deps())(req())).json()).toEqual({
      run_id: "run_owned",
      events: [],
      last_seq: 0,
    });
  });
  it.each([
    null,
    { ...identity, expiresAt: new Date("2026-09-08T00:00:00Z") },
    { ...identity, email: "operator@example.invalid" },
    { ...identity, demoRunId: "run_foreign" },
    { ...identity, email: "demo-seller+run_foreign@ledgerly.test" },
  ])("refuses unverified, foreign or expired identity without reading events", async (session) => {
    const listEvents = vi.fn(async () => []);
    const response = await createTourSnapshotHandler(
      deps({ identity: async () => session, listEvents }),
    )(req());
    expect([401, 403]).toContain(response.status);
    expect(listEvents).not.toHaveBeenCalled();
  });
  it.each([
    req("run=run_foreign"),
    req("run=run_owned&run=run_foreign"),
    req("run=run_owned", { "x-demo-run": "run_foreign" }),
    req("run=run_owned", { cookie: "ledgerly_demo_run=run_foreign" }),
    req("run=run_owned", { cookie: "ledgerly_demo_run=%XX" }),
  ])("refuses conflicting run input without exposing rows", async (request) => {
    const listEvents = vi.fn(async () => [row(1)]);
    const response = await createTourSnapshotHandler(deps({ listEvents }))(request);
    expect(response.status).toBe(403);
    expect(listEvents).not.toHaveBeenCalled();
  });
  it("rejects foreign and malformed persisted pages entirely", async () => {
    for (const rows of [
      [row(1), { ...row(2), runId: "run_foreign" }],
      [row(1), row(1)],
      [{ ...row(1), safeIds: { tour_step: "C01" } }],
    ]) {
      const response = await createTourSnapshotHandler(deps({ listEvents: async () => rows }))(
        req(),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).not.toHaveProperty("events");
    }
  });
  it("does not return partial history on page failure or cap exhaustion", async () => {
    const first = Array.from({ length: 500 }, (_, i) => row(i + 1));
    const failed = await createTourSnapshotHandler(
      deps({
        listEvents: async ({ afterSeq }) => {
          if (afterSeq) throw new Error("offline");
          return first;
        },
      }),
    )(req());
    expect(failed.status).toBe(503);
    expect(await failed.json()).not.toHaveProperty("events");
    const capped = await createTourSnapshotHandler(
      deps({
        listEvents: async ({ afterSeq }) =>
          first.map((event) => ({ ...event, seq: event.seq + afterSeq })),
      }),
    )(req());
    expect(capped.status).toBe(503);
    expect(await capped.json()).not.toHaveProperty("events");
  });
  it("does not expose the route outside enabled demo profiles", async () => {
    expect((await createTourSnapshotHandler(deps({ enabled: () => false }))(req())).status).toBe(
      404,
    );
  });
});
