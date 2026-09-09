import type { DemoEvent, Environment, Role, Source } from "./contract";
import { redact } from "./contract";
import type { EventDraft } from "./log";

/**
 * Architecture's server-side trace stream, as fixed in
 * docs/lanes/architecture/instrumentation-contract.md. The app emits these
 * from its route wrapper, its unit of work and the Whop client hook. This
 * module maps them onto the demo event contract so the overlay, the panel and
 * the evidence bridge read one shape. Nothing here invents a status, a label
 * or a step: each comes from the instrumentation event or from the tour's own
 * correlation table.
 */

export const CORRELATION_HEADER = "x-ledgerly-correlation-id";

export interface InstrumentationEvent {
  id: string;
  seq: number;
  correlation_id: string;
  run_id: string | null;
  source: "app_api" | "db" | "whop";
  phase: "start" | "end";
  method: string;
  path: string;
  status: number | "ok" | "error" | null;
  duration_ms: number | null;
  provenance: "sandbox" | "mock" | "neon" | "pglite" | "app";
  safe_ids: Record<string, string>;
  summary: string;
  at: string;
  /** Proposed addition: owner or local gate when the adapter refused the operation. */
  gate?: { id: string; reason: string } | null;
}

/** The persisted row as the SSE route serialises it (camelCase, Date as ISO string). */
export interface PersistedInstrumentationRow {
  id: string;
  seq: number;
  correlationId: string;
  runId?: string | null;
  source: InstrumentationEvent["source"];
  phase: InstrumentationEvent["phase"];
  method?: string | null;
  path: string;
  status: InstrumentationEvent["status"];
  durationMs?: number | null;
  provenance: InstrumentationEvent["provenance"];
  safeIds?: Record<string, string> | null;
  summary: string;
  at: string | Date;
  gate?: { id: string; reason: string } | null;
}

/** Accepts either the contract's snake_case shape or the persisted camelCase row. */
export function normalizeInstrumentationEvent(
  raw: InstrumentationEvent | PersistedInstrumentationRow,
): InstrumentationEvent {
  const r = raw as Partial<InstrumentationEvent> & Partial<PersistedInstrumentationRow>;
  const rawAt: unknown = r.at;
  const at =
    typeof rawAt === "object" && rawAt !== null && "toISOString" in rawAt
      ? (rawAt as Date).toISOString()
      : String(rawAt ?? "");
  return {
    id: String(r.id ?? ""),
    seq: Number(r.seq ?? 0),
    correlation_id: r.correlation_id ?? r.correlationId ?? "",
    run_id: r.run_id ?? r.runId ?? null,
    source: r.source as InstrumentationEvent["source"],
    phase: r.phase as InstrumentationEvent["phase"],
    method: r.method ?? "",
    path: r.path ?? "",
    status: (r.status ?? null) as InstrumentationEvent["status"],
    duration_ms: r.duration_ms ?? r.durationMs ?? null,
    provenance: r.provenance as InstrumentationEvent["provenance"],
    safe_ids: r.safe_ids ?? r.safeIds ?? {},
    summary: r.summary ?? "",
    at,
    gate: r.gate ?? null,
  };
}

export interface MapOptions {
  /** The tour's correlation table: which step minted this correlation id. */
  stepOf: (correlation_id: string) => string | null;
  run_id: string;
  role?: Role;
  environment?: Environment;
}

const SANDBOX_BASE = "https://sandbox-api.whop.com/api/v1";

function providerSource(provenance: InstrumentationEvent["provenance"]): Source {
  return provenance === "sandbox" ? "sandbox" : "mock";
}

/**
 * One instrumentation event becomes at most one demo event. Returns null for
 * shapes the tour does not consume (a db start, an unknown source).
 */
export function fromInstrumentationEvent(
  raw: InstrumentationEvent | PersistedInstrumentationRow,
  opts: MapOptions,
): EventDraft | null {
  const ev = normalizeInstrumentationEvent(raw);
  const step_id = (typeof ev.safe_ids.tour_step === "string" && /^C0[1-7]$/.test(ev.safe_ids.tour_step) ? ev.safe_ids.tour_step : null) ?? opts.stepOf(ev.correlation_id);
  const ids = Object.values(ev.safe_ids ?? {}).filter((v) => typeof v === "string");
  const base = (
    kind: DemoEvent["kind"],
    source: Source,
    state: DemoEvent["state"],
    payload: Record<string, unknown>,
  ): EventDraft => {
    const { value, removed } = redact({ ...payload, safe_ids: ev.safe_ids ?? {} });
    if (removed.length) value.redacted_fields = removed;
    return {
      event_id: `evt_${ev.id}`,
      run_id: opts.run_id,
      correlation_id: ev.correlation_id,
      kind,
      step_id,
      attempt: 0,
      at: ev.at,
      role: opts.role ?? "buyer",
      source,
      environment: opts.environment ?? "hybrid",
      state,
      summary: ev.summary,
      payload: { ...value, instrumentation_id: ev.id, instrumentation_seq: ev.seq },
      request: null,
      db: null,
      provider: null,
      gate: null,
      evidence_id: null,
    };
  };

  if (ev.source === "app_api") {
    const status = typeof ev.status === "number" ? ev.status : null;
    const d = base(
      ev.phase === "start" ? "request.started" : "request.finished",
      "local",
      ev.phase === "end" && status !== null && status >= 400 ? "failed" : "running",
      { method: ev.method, path: ev.path },
    );
    d.request = {
      request_id: ev.correlation_id,
      method: ev.method,
      route: ev.path,
      http_status: ev.phase === "end" ? (status ?? 0) : null,
      duration_ms: ev.phase === "end" ? ev.duration_ms : null,
    };
    return d;
  }

  if (ev.source === "db") {
    if (ev.phase !== "end") return null;
    const d = base("db.written", "local", ev.status === "error" ? "failed" : "running", {
      transaction: ev.path,
      provenance: ev.provenance,
      // The unit of work reports a transaction, not a table; the keys of safe_ids say
      // which records it touched (seller_id, order_id), and the tour matches on those.
      safe_id_keys: Object.keys(ev.safe_ids ?? {}),
    });
    d.db = { table: ev.path, ids };
    return d;
  }

  if (ev.source === "whop") {
    const source = providerSource(ev.provenance);
    const operation = `${ev.method} ${ev.path}`;
    if (ev.phase === "start")
      return base("operation.requested", source, "running", { operation, input: {} });
    const status = typeof ev.status === "number" ? ev.status : null;
    const gate = ev.gate ?? null;
    const mockOutcome = source === "mock" && ev.status === "ok" && ev.safe_ids.mock_result === "succeeded"
      ? "succeeded"
      : source === "mock" && ev.status === "error" ? "failed" : null;
    const failed = !gate && ((status !== null && status >= 400) || ev.status === "error");
    const d = base(
      "operation.responded",
      source,
      gate ? "blocked" : failed ? "failed" : "running",
      failed || gate
        ? { operation, error: gate ? gate.reason : mockOutcome === "failed" ? "mock operation failed" : `http ${status}`, ...(mockOutcome ? { mock_outcome: mockOutcome } : {}) }
        : {
            operation,
            output: {},
            ...(mockOutcome ? { mock_outcome: mockOutcome } : {}),
            ...(source === "sandbox" && status === null ? { unconfirmed: true } : {}),
          },
    );
    d.provider = {
      base_url: source === "sandbox" ? SANDBOX_BASE : "mock://local",
      http_status: status,
      request_id: null,
      resource_ids: ids,
      api_version_date: null,
      operation,
      duration_ms: ev.duration_ms,
    };
    d.gate = gate;
    return d;
  }
  return null;
}

/** The tour's correlation table, kept client-side: one id per step attempt. */
export class CorrelationTable {
  private readonly byCorrelation = new Map<string, string>();
  private readonly mint: () => string;
  constructor(mint: () => string = () => crypto.randomUUID()) {
    this.mint = mint;
  }
  /** Mint a fresh correlation id for a step attempt. */
  begin(step_id: string): string {
    const id = this.mint();
    this.byCorrelation.set(id, step_id);
    return id;
  }
  stepOf(correlation_id: string): string | null {
    return this.byCorrelation.get(correlation_id) ?? null;
  }
  /** Restore after a refresh. */
  load(entries: Record<string, string>): void {
    for (const [c, s] of Object.entries(entries)) this.byCorrelation.set(c, s);
  }
  dump(): Record<string, string> {
    return Object.fromEntries(this.byCorrelation);
  }
}

/** Replays only the requested run and binds provider/DB rows through server-classified requests. */
export function mapTourInstrumentation(rows: (InstrumentationEvent | PersistedInstrumentationRow)[], runId: string): DemoEvent[] {
  const normalized = rows.map(normalizeInstrumentationEvent).filter((row) => row.run_id === runId);
  const bindings = new Map<string, Set<string>>();
  for (const row of normalized) {
    const step = row.safe_ids.tour_step;
    if (row.source !== "app_api" || row.phase !== "end" || !/^C0[1-7]$/.test(step ?? "")) continue;
    const values = bindings.get(row.correlation_id) ?? new Set<string>();
    values.add(step as string);
    bindings.set(row.correlation_id, values);
  }
  return normalized.flatMap((row) => {
    const values = bindings.get(row.correlation_id);
    // Reusing a correlation for different chapters cannot attribute supporting evidence.
    if (!values || values.size !== 1) return [];
    const step = [...values][0] ?? null;
    const draft = fromInstrumentationEvent(row, { run_id: runId, stepOf: () => step });
    return draft ? [{ ...draft, contract_version: "2.0.0" as const, seq: row.seq }] : [];
  });
}
