"use client";
import { useEffect, useMemo, useState } from "react";
import type { DemoEvent } from "../contract";
import type { StepDefinition } from "../steps";
import { reduceTour, type TourState } from "../tour";
import { EMPTY_REPLAY, type ReplayState, subscribeTourReplay } from "./tour-replay";

export interface UseTourOptions {
  eventsUrl: string;
  snapshotUrl: string;
  /** Authenticated snapshot must name this run before any controls become available. */
  runId: string | null;
  steps?: readonly StepDefinition[];
  skipped?: Set<string>;
  mapReplay: (rows: unknown[], run: string) => DemoEvent[];
  retryAfter?: Record<string, number>;
  buildUrl: (base: string, after: number, run: string) => string;
}

/** Restores the same persisted history used by Finish before subscribing to newer rows. */
export function useTour(opts: UseTourOptions): ReplayState & { state: TourState } {
  const [loaded, setLoaded] = useState<{ key: string; replay: ReplayState }>({ key: "", replay: EMPTY_REPLAY });
  const key = `${opts.runId ?? ""}:${opts.snapshotUrl}`;
  const replay = loaded.key === key ? loaded.replay : EMPTY_REPLAY;
  useEffect(() => {
    if (!opts.runId) return;
    return subscribeTourReplay({ ...opts, expectedRun: opts.runId }, (next) => setLoaded({ key, replay: next }), {
      fetch: (url, init) => fetch(url, init),
      stream: (url) => new EventSource(url),
      retry: (callback) => {
        const timeout = setTimeout(callback, 1000);
        return () => clearTimeout(timeout);
      },
    });
  }, [key, opts.eventsUrl, opts.snapshotUrl, opts.runId, opts.mapReplay, opts.buildUrl]);
  const state = useMemo(() => reduceTour(replay.events, opts.steps, {
    ...(opts.skipped ? { skipped: opts.skipped } : {}),
    ...(opts.retryAfter ? { retryAfter: opts.retryAfter } : {}),
  }), [replay.events, opts.steps, opts.skipped, opts.retryAfter]);
  return { ...replay, state };
}
