import type { DemoEvent } from "../contract";

export interface ReplayState {
  events: DemoEvent[];
  run_id: string | null;
  ready: boolean;
  connected: boolean;
  error: string | null;
}
export const EMPTY_REPLAY: ReplayState = { events: [], run_id: null, ready: false, connected: false, error: null };
export type ReplayStream = Pick<EventSource, "onmessage" | "onopen" | "onerror" | "close">;
export interface ReplayOptions {
  snapshotUrl: string;
  expectedRun: string;
  eventsUrl: string;
  buildUrl: (base: string, after: number, run: string) => string;
  mapReplay: (rows: unknown[], run: string) => DemoEvent[];
}

function rowIdentity(raw: unknown): { seq: number; run: string } {
  if (!raw || typeof raw !== "object") throw new Error("Invalid history row");
  const row = raw as Record<string, unknown>;
  const seq = row.seq;
  const run = row.runId ?? row.run_id;
  if (!Number.isSafeInteger(seq) || Number(seq) <= 0 || typeof run !== "string") throw new Error("Invalid history row");
  return { seq: Number(seq), run };
}

/** Snapshot first, then stream strictly after its watermark. No fallback from denied history. */
export function subscribeTourReplay(
  options: ReplayOptions,
  change: (state: ReplayState) => void,
  io: {
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    stream: (url: string) => ReplayStream;
    retry: (callback: () => void) => () => void;
  },
): () => void {
  const abort = new AbortController();
  let stopped = false;
  let stream: ReplayStream | null = null;
  let cancelRetry: (() => void) | null = null;
  let rows: unknown[] = [];
  let watermark = 0;
  let state = { ...EMPTY_REPLAY };
  const publish = (patch: Partial<ReplayState>) => {
    if (stopped) return;
    state = { ...state, ...patch };
    change(state);
  };
  const fail = (message: string) => {
    stream?.close();
    stream = null;
    cancelRetry?.();
    cancelRetry = null;
    publish({ ready: false, connected: false, error: message });
  };
  const connect = () => {
    if (stopped) return;
    const current = io.stream(options.buildUrl(options.eventsUrl, watermark, options.expectedRun));
    stream = current;
    current.onopen = () => { if (stream === current) publish({ connected: false }); };
    current.onmessage = ({ data }) => {
      if (stopped || stream !== current) return;
      try {
        const raw: unknown = JSON.parse(data);
        if (raw && typeof raw === "object" && "type" in raw && raw.type === "replay.ready") {
          const marker = raw as { run_id?: unknown; last_seq?: unknown };
          if (marker.run_id !== options.expectedRun || marker.last_seq !== watermark)
            throw new Error("Invalid replay boundary");
          publish({ connected: true });
          return;
        }
        const row = rowIdentity(raw);
        if (row.run !== options.expectedRun) throw new Error("Foreign history row");
        if (row.seq <= watermark) return;
        rows.push(raw);
        // Keep raw rows, including provider/DB frames whose request has not ended yet.
        const events = options.mapReplay(rows, options.expectedRun);
        watermark = row.seq;
        publish({ events });
      } catch { fail("The live history could not be read. Reload to restore the tour."); }
    };
    current.onerror = () => {
      if (stopped || stream !== current) return;
      current.close();
      stream = null;
      publish({ connected: false });
      cancelRetry?.();
      cancelRetry = io.retry(connect);
    };
  };
  publish(EMPTY_REPLAY);
  void io.fetch(options.snapshotUrl, { cache: "no-store", signal: abort.signal }).then(async (response) => {
    if (!response.ok) throw new Error(`History request failed (${response.status})`);
    const snapshot: unknown = await response.json();
    if (stopped) return;
    if (!snapshot || typeof snapshot !== "object") throw new Error("Invalid history snapshot");
    const snap = snapshot as Record<string, unknown>;
    if (snap.run_id !== options.expectedRun || !Array.isArray(snap.events) || !Number.isSafeInteger(snap.last_seq) || Number(snap.last_seq) < 0)
      throw new Error("Invalid history snapshot");
    let after = 0;
    for (const raw of snap.events) {
      const row = rowIdentity(raw);
      if (row.run !== options.expectedRun || row.seq <= after || row.seq > Number(snap.last_seq)) throw new Error("Invalid history order");
      after = row.seq;
    }
    if (after !== snap.last_seq) throw new Error("Incomplete history snapshot");
    rows = snap.events;
    const events = options.mapReplay(rows, options.expectedRun);
    watermark = Number(snap.last_seq);
    publish({ events, run_id: options.expectedRun, ready: true, error: null });
    connect();
  }).catch((error: unknown) => {
    if (!stopped) fail(error instanceof Error ? error.message : "The tour history could not be loaded.");
  });
  return () => {
    stopped = true;
    abort.abort();
    cancelRetry?.();
    stream?.close();
  };
}
