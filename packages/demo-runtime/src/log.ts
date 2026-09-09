import {
  assertEvent,
  CONTRACT_VERSION,
  type DemoEvent,
  type RunSnapshot,
  type StepSnapshot,
} from "./contract";

/** Storage seam. Architecture may supply a durable implementation; the contract stays the same. */
export interface EventStore {
  append(event: DemoEvent): Promise<void>;
  /** Events for a run in seq order. */
  list(run_id: string): Promise<DemoEvent[]>;
  has(event_id: string): Promise<boolean>;
  lastSeq(run_id: string): Promise<number>;
  /** Remove every event of one LOCAL run. Never touches anything remote. */
  clearRun(run_id: string): Promise<void>;
}

export class MemoryStore implements EventStore {
  private runs = new Map<string, DemoEvent[]>();
  private ids = new Set<string>();
  async append(event: DemoEvent) {
    const list = this.runs.get(event.run_id) ?? [];
    list.push(event);
    this.runs.set(event.run_id, list);
    this.ids.add(event.event_id);
  }
  async list(run_id: string) {
    return [...(this.runs.get(run_id) ?? [])].sort((a, b) => a.seq - b.seq);
  }
  async has(event_id: string) {
    return this.ids.has(event_id);
  }
  async lastSeq(run_id: string) {
    const list = this.runs.get(run_id);
    return list?.length ? Math.max(...list.map((e) => e.seq)) : 0;
  }
  async clearRun(run_id: string) {
    for (const e of this.runs.get(run_id) ?? []) this.ids.delete(e.event_id);
    this.runs.delete(run_id);
  }
}

export type Listener = (event: DemoEvent) => void;

/** Draft of an event before the log assigns seq. */
export type EventDraft = Omit<DemoEvent, "seq" | "contract_version">;

/**
 * Append-only, sequenced, deduplicated log. seq is assigned here, so a producer
 * that retries or delivers out of order cannot reorder what consumers see.
 */
export class EventLog {
  private listeners = new Set<Listener>();
  private chain: Promise<void> = Promise.resolve();
  private readonly store: EventStore;
  constructor(store: EventStore) {
    this.store = store;
  }

  /** Appends one event. A duplicate event_id is ignored and the stored copy returned. */
  append(draft: EventDraft): Promise<DemoEvent> {
    const run = this.chain.then(async () => {
      if (await this.store.has(draft.event_id)) {
        const existing = (await this.store.list(draft.run_id)).find(
          (e) => e.event_id === draft.event_id,
        );
        if (existing) return existing;
      }
      const seq = (await this.store.lastSeq(draft.run_id)) + 1;
      const event: DemoEvent = { ...draft, seq, contract_version: CONTRACT_VERSION };
      assertEvent(event);
      await this.store.append(event);
      for (const l of this.listeners) l(event);
      return event;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  list(run_id: string) {
    return this.store.list(run_id);
  }

  /** Events after a seq, for reconnecting panels that send Last-Event-ID. */
  async since(run_id: string, seq: number) {
    return (await this.store.list(run_id)).filter((e) => e.seq > seq);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Live async iterator: replays from `afterSeq`, then streams new events. */
  async *stream(run_id: string, afterSeq = 0, signal?: AbortSignal): AsyncGenerator<DemoEvent> {
    const queue: DemoEvent[] = [];
    let wake: (() => void) | null = null;
    const unsub = this.subscribe((e) => {
      if (e.run_id !== run_id) return;
      queue.push(e);
      wake?.();
    });
    try {
      let last = afterSeq;
      for (const e of await this.since(run_id, afterSeq)) {
        yield e;
        last = e.seq;
      }
      while (!signal?.aborted) {
        const next = queue.shift();
        if (next) {
          if (next.seq <= last) continue;
          last = next.seq;
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        wake = null;
      }
    } finally {
      unsub();
    }
  }

  clearRun(run_id: string) {
    return this.store.clearRun(run_id);
  }

  /** Current per-step state derived from the log. Consumers never keep their own counter. */
  async snapshot(run_id: string, step_ids: readonly string[]): Promise<RunSnapshot> {
    const events = await this.list(run_id);
    const started = events.find((e) => e.kind === "run.started" || e.kind === "run.reset");
    const byStep = new Map<string, StepSnapshot>();
    for (const id of step_ids)
      byStep.set(id, {
        step_id: id,
        state: "pending",
        source: null,
        attempt: 0,
        correlation_id: null,
        gate: null,
        last_seq: 0,
        evidence_id: null,
      });
    let role = started?.role ?? "buyer";
    for (const e of events) {
      if (e.kind === "role.switched") role = e.role;
      if (!e.step_id) continue;
      const s = byStep.get(e.step_id);
      if (!s) continue;
      s.state = e.state;
      if (
        e.source === "sandbox" ||
        (e.source === "mock" && s.source !== "sandbox") ||
        s.source === null
      )
        s.source = e.source;
      s.attempt = e.attempt;
      s.correlation_id = e.correlation_id;
      s.gate = e.gate;
      s.last_seq = e.seq;
      if (e.evidence_id) s.evidence_id = e.evidence_id;
    }
    return {
      contract_version: CONTRACT_VERSION,
      run_id,
      environment: started?.environment ?? "local",
      role,
      started_at: started?.at ?? "",
      last_seq: events.length ? (events[events.length - 1] as DemoEvent).seq : 0,
      steps: [...byStep.values()],
    };
  }
}
