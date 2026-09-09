import { describe, expect, it, vi } from "vitest";
import { mapTourInstrumentation, type PersistedInstrumentationRow } from "../src/instrumentation";
import { subscribeTourReplay, type ReplayState, type ReplayStream } from "../src/react/tour-replay";
import { reduceTour } from "../src/tour";

const run = "run_replay";
function row(seq: number, patch: Partial<PersistedInstrumentationRow> = {}): PersistedInstrumentationRow {
  return { id: `row-${seq}`, seq, runId: run, correlationId: "create", source: "app_api", phase: "end", method: "POST", path: "/api/sellers", status: 201, provenance: "app", at: "2026-09-09T00:00:00Z", summary: "Observed", safeIds: { tour_step: "C01", tour_seller_id: "seller_1" }, ...patch };
}
const created = [
  row(1, { source: "db", method: "", path: "sellers", status: "ok", provenance: "pglite", safeIds: { seller_id: "seller_1" } }),
  row(2, { source: "whop", path: "/accounts", status: 200, provenance: "mock", safeIds: { account_id: "biz_1" } }),
  row(3),
];
async function flush() { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
function harness(fetcher: () => Promise<Response>) {
  const states: ReplayState[] = [];
  const streams: { url: string; stream: ReplayStream }[] = [];
  const retries: (() => void)[] = [];
  const stop = subscribeTourReplay({ snapshotUrl: "/snapshot", expectedRun: run, eventsUrl: "/events", buildUrl: (base, after, id) => `${base}?run_id=${id}&after=${after}`, mapReplay: (rows, id) => mapTourInstrumentation(rows as PersistedInstrumentationRow[], id) },
    (state) => states.push(state), {
      fetch: fetcher,
      stream: (url) => { const stream: ReplayStream = { onmessage: null, onopen: null, onerror: null, close: vi.fn() }; streams.push({ url, stream }); return stream; },
      retry: (callback) => { retries.push(callback); return vi.fn(); },
    });
  return { states, streams, retries, stop, latest: () => states.at(-1) as ReplayState };
}
function emit(stream: ReplayStream, data: unknown) {
  stream.onmessage?.call(stream as EventSource, new MessageEvent("message", { data: JSON.stringify(data) }));
}

describe("authenticated replay before live controls", () => {
  it("holds readiness until the complete seller history is restored, then starts after its watermark", async () => {
    let answer: (response: Response) => void = () => {};
    const h = harness(() => new Promise((resolve) => { answer = resolve; }));
    expect(h.latest().ready).toBe(false);
    expect(h.streams).toHaveLength(0);
    answer(Response.json({ run_id: run, events: created, last_seq: 3 }));
    await flush();
    expect(h.latest().ready).toBe(true);
    expect(reduceTour(h.latest().events).active_index).toBe(1);
    expect(h.latest().connected).toBe(false);
    expect(h.streams[0]?.url).toBe("/events?run_id=run_replay&after=3");
    h.stop();
  });
  it.each([401, 403, 503])("never substitutes an empty live stream for denied history %s", async (status) => {
    const h = harness(async () => Response.json({ error: "denied" }, { status }));
    await flush();
    expect(h.latest().ready).toBe(false);
    expect(h.latest().error).toContain(String(status));
    expect(h.streams).toHaveLength(0);
    h.stop();
  });
  it.each([
    { run_id: "run_foreign", events: created, last_seq: 3 },
    { run_id: run, events: created, last_seq: 4 },
    { run_id: run, events: [created[2], created[0]], last_seq: 3 },
    { run_id: run, events: [row(1, { runId: "run_foreign" })], last_seq: 1 },
  ])("rejects a malformed or foreign snapshot", async (snapshot) => {
    const h = harness(async () => Response.json(snapshot));
    await flush();
    expect(h.latest().ready).toBe(false);
    expect(h.streams).toHaveLength(0);
    h.stop();
  });
  it("retains provider/DB rows across a snapshot taken before the request completes", async () => {
    const h = harness(async () => Response.json({ run_id: run, events: created.slice(0, 2), last_seq: 2 }));
    await flush();
    expect(reduceTour(h.latest().events).active_index).toBe(0);
    const stream = h.streams[0]?.stream;
    if (!stream) throw new Error("missing stream");
    emit(stream, created[2]);
    expect(reduceTour(h.latest().events).active_index).toBe(1);
    emit(stream, created[2]);
    expect(h.latest().events).toHaveLength(3);
    stream.onerror?.call(stream as EventSource, new Event("error"));
    expect(h.latest().connected).toBe(false);
    h.retries[0]?.();
    expect(h.streams[1]?.url).toContain("after=3");
    h.stop();
  });
  it("does not publish an old fetch after cleanup or open a replacement stream", async () => {
    let answer: (response: Response) => void = () => {};
    const h = harness(() => new Promise((resolve) => { answer = resolve; }));
    h.stop();
    answer(Response.json({ run_id: run, events: created, last_seq: 3 }));
    await flush();
    expect(h.latest().ready).toBe(false);
    expect(h.streams).toHaveLength(0);
  });
});

it("does not open controls at transport open before post-snapshot backlog is consumed", async () => {
  const h = harness(async () => Response.json({ run_id: run, events: created.slice(0, 2), last_seq: 2 }));
  await flush();
  const stream = h.streams[0]?.stream;
  if (!stream) throw new Error("missing stream");
  stream.onopen?.call(stream as EventSource, new Event("open"));
  expect(h.latest().ready && h.latest().connected).toBe(false);
  emit(stream, created[2]);
  expect(h.latest().connected).toBe(false);
  emit(stream, { type: "replay.ready", run_id: run, last_seq: 3 });
  expect(h.latest().ready && h.latest().connected).toBe(true);
  expect(reduceTour(h.latest().events).active_index).toBe(1);
  stream.onerror?.call(stream as EventSource, new Event("error"));
  h.retries[0]?.();
  const reconnect = h.streams[1]?.stream;
  if (!reconnect) throw new Error("missing reconnect");
  reconnect.onopen?.call(reconnect as EventSource, new Event("open"));
  expect(h.latest().connected).toBe(false);
  emit(reconnect, { type: "replay.ready", run_id: run, last_seq: 3 });
  expect(h.latest().connected).toBe(true);
  h.stop();
});

it("invalid replay terminates the current stream and ignores its late callbacks", async () => {
  const h = harness(async () => Response.json({ run_id: run, events: [], last_seq: 0 }));
  await flush();
  const stream = h.streams[0]?.stream;
  if (!stream) throw new Error("missing stream");
  emit(stream, { type: "replay.ready", run_id: "run_foreign", last_seq: 0 });
  expect(h.latest().ready).toBe(false);
  emit(stream, row(1));
  stream.onopen?.call(stream as EventSource, new Event("open"));
  stream.onerror?.call(stream as EventSource, new Event("error"));
  expect(h.latest().events).toHaveLength(0);
  expect(h.latest().connected).toBe(false);
  expect(h.retries).toHaveLength(0);
  h.stop();
});
