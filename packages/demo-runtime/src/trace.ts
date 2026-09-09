import type {
  DbRef,
  DemoEvent,
  Environment,
  Gate,
  ProviderRef,
  RequestRef,
  Role,
  Source,
} from "./contract";
import { ROLES, redact } from "./contract";
import { type Clock, newId, systemClock } from "./ids";
import { CORRELATION_HEADER } from "./instrumentation";
import type { EventDraft, EventLog } from "./log";

/**
 * Instrumentation for the real app. A route handler wrapped with `withTrace`
 * emits request.started and request.finished; inside it, `trace.db` records
 * rows written and `tracePort` records every provider call with the label the
 * port result carries. Everything lands in the shared log the tour reads.
 */

export const TOUR_STEP_HEADER = "x-tour-step";
export const TOUR_ROLE_HEADER = "x-demo-role";
export const REQUEST_ID_HEADER = "x-request-id";
export const RUN_HEADER = "x-demo-run";

export interface TraceContext {
  request_id: string;
  method: string;
  route: string;
  /** Tour step the client said it was on, or null for untraced traffic. */
  tour_step: string | null;
  role: Role;
  started_at: number;
}

export interface TracerOptions {
  log: EventLog;
  run_id: string;
  environment: Environment;
  clock?: Clock;
  /** Monotonic timer for durations; defaults to performance.now. */
  now?: () => number;
}

/** What `tracePort` reads off a port result to label it. All optional; missing fields degrade honestly. */
export interface PortResultMeta {
  source?: Source;
  status?: number | null;
  requestId?: string | null;
  apiVersionDate?: string | null;
  baseUrl?: string | null;
  /** Gate the adapter reports on a mock fallback (e.g. G01) or a refusal. */
  gate?: Gate | null;
}

/**
 * Default reader for architecture's port results: successful values carry
 * `meta: { source, status, requestId, gate }`; errors carry `status`,
 * `requestId` and a `kind`. Anything missing stays null and is reported as such.
 */
export function metaFromResult(result: Result): PortResultMeta {
  if (result.ok) {
    const v = result.value as { meta?: PortResultMeta & { gate?: Gate | null } } | null | undefined;
    const m = v && typeof v === "object" ? v.meta : undefined;
    return m ? { ...m } : {};
  }
  const e = result.error as
    | { status?: number; requestId?: string; source?: Source }
    | null
    | undefined;
  return e && typeof e === "object"
    ? {
        ...(e.status !== undefined ? { status: e.status } : {}),
        ...(e.requestId ? { requestId: e.requestId } : {}),
        ...(e.source ? { source: e.source } : {}),
      }
    : {};
}

export type Result<T = unknown, E = unknown> = { ok: true; value: T } | { ok: false; error: E };

export class Tracer {
  readonly log: EventLog;
  readonly run_id: string;
  readonly environment: Environment;
  private readonly clock: Clock;
  private readonly now: () => number;
  constructor(opts: TracerOptions) {
    this.log = opts.log;
    this.run_id = opts.run_id;
    this.environment = opts.environment;
    this.clock = opts.clock ?? systemClock;
    this.now = opts.now ?? (() => performance.now());
  }

  private draft(
    ctx: TraceContext,
    kind: DemoEvent["kind"],
    source: Source,
    summary: string,
    payload: Record<string, unknown> = {},
  ): EventDraft {
    const { value, removed } = redact(payload);
    if (removed.length) value.redacted_fields = removed;
    return {
      event_id: newId("evt"),
      run_id: this.run_id,
      correlation_id: ctx.request_id,
      kind,
      step_id: ctx.tour_step,
      attempt: 0,
      at: this.clock().toISOString(),
      role: ctx.role,
      source,
      environment: this.environment,
      state: "running",
      summary,
      payload: { ...value, tour_step: ctx.tour_step },
      request: null,
      db: null,
      provider: null,
      gate: null,
      evidence_id: null,
    };
  }

  begin(method: string, route: string, headers: Headers): TraceContext {
    const roleHeader = headers.get(TOUR_ROLE_HEADER);
    const role = (ROLES as readonly string[]).includes(roleHeader ?? "")
      ? (roleHeader as Role)
      : "buyer";
    return {
      request_id:
        headers.get(CORRELATION_HEADER)?.trim() ||
        headers.get(REQUEST_ID_HEADER)?.trim() ||
        newId("req"),
      method,
      route,
      tour_step: headers.get(TOUR_STEP_HEADER)?.trim() || null,
      role,
      started_at: this.now(),
    };
  }

  async requestStarted(ctx: TraceContext): Promise<DemoEvent> {
    const d = this.draft(ctx, "request.started", "local", `${ctx.method} ${ctx.route} received`);
    d.request = {
      request_id: ctx.request_id,
      method: ctx.method,
      route: ctx.route,
      http_status: null,
      duration_ms: null,
    };
    return this.log.append(d);
  }

  async requestFinished(
    ctx: TraceContext,
    http_status: number,
    extra: Record<string, unknown> = {},
  ): Promise<DemoEvent> {
    const duration_ms = Math.round(this.now() - ctx.started_at);
    const failed = http_status >= 400;
    const d = this.draft(
      ctx,
      "request.finished",
      "local",
      `${ctx.method} ${ctx.route} ${http_status} in ${duration_ms} ms`,
      extra,
    );
    d.state = failed ? "failed" : "running";
    d.request = {
      request_id: ctx.request_id,
      method: ctx.method,
      route: ctx.route,
      http_status,
      duration_ms,
    };
    return this.log.append(d);
  }

  /** Rows this app wrote. Pass identifiers only. */
  async db(ctx: TraceContext, table: string, ids: string[], summary?: string): Promise<DemoEvent> {
    const d = this.draft(
      ctx,
      "db.written",
      "local",
      summary ?? `${table}: ${ids.length} row${ids.length === 1 ? "" : "s"} written`,
    );
    d.db = { table, ids };
    return this.log.append(d);
  }

  /** A step cannot proceed because of an owner or local gate. */
  async blocked(ctx: TraceContext, gate: Gate, summary?: string): Promise<DemoEvent> {
    const d = this.draft(
      ctx,
      "step.finished",
      "local",
      summary ?? `${ctx.tour_step ?? ctx.route} blocked by ${gate.id}: ${gate.reason}`,
    );
    d.state = "blocked";
    d.gate = gate;
    return this.log.append(d);
  }

  async providerCalled(
    ctx: TraceContext,
    operation: string,
    source: Source,
    input: Record<string, unknown>,
  ): Promise<DemoEvent> {
    return this.log.append(
      this.draft(ctx, "operation.requested", source, `${operation} requested (${source})`, {
        operation,
        input,
      }),
    );
  }

  async providerResponded(
    ctx: TraceContext,
    operation: string,
    result: Result,
    meta: PortResultMeta,
    duration_ms: number,
  ): Promise<DemoEvent> {
    const source = meta.source ?? "mock";
    const provider: ProviderRef = {
      base_url:
        meta.baseUrl ??
        (source === "sandbox" ? "https://sandbox-api.whop.com/api/v1" : "mock://local"),
      http_status: meta.status ?? null,
      request_id: meta.requestId ?? null,
      resource_ids: resourceIds(result),
      api_version_date: meta.apiVersionDate ?? null,
      operation,
      duration_ms,
    };
    const unconfirmed = result.ok && source === "sandbox" && provider.http_status === null;
    const gate = !result.ok ? gateFromError(result.error) : null;
    const fallbackGate = result.ok ? (meta.gate ?? null) : null;
    const payload: Record<string, unknown> = result.ok
      ? {
          operation,
          output: summarize(result.value),
          ...(unconfirmed ? { unconfirmed: true } : {}),
          ...(fallbackGate ? { fallback_gate: fallbackGate } : {}),
        }
      : { operation, error: summarize(result.error) };
    const d = this.draft(
      ctx,
      "operation.responded",
      source,
      result.ok
        ? `${operation} ${source} ok${provider.http_status != null ? ` ${provider.http_status}` : unconfirmed ? " (status unconfirmed)" : ""} in ${duration_ms} ms${fallbackGate ? ` (mock because ${fallbackGate.id})` : ""}`
        : gate
          ? `${operation} blocked by ${gate.id}: ${gate.reason}`
          : `${operation} ${source} failed${provider.http_status != null ? ` ${provider.http_status}` : ""}`,
      payload,
    );
    d.provider = provider;
    if (gate) {
      d.state = "blocked";
      d.gate = gate;
    } else if (!result.ok) d.state = "failed";
    return this.log.append(d);
  }
}

/** Provider errors that mean "cannot do this yet" rather than "went wrong". */
export function gateFromError(error: unknown): Gate | null {
  if (typeof error !== "object" || error === null) return null;
  const given = (error as { gate?: unknown }).gate;
  if (given && typeof given === "object" && typeof (given as Gate).id === "string")
    return given as Gate;
  const kind = (error as { kind?: unknown }).kind;
  if (kind === "capability_inactive" || kind === "insufficient_balance")
    return { id: "G01", reason: `provider reports ${String(kind)}; enablement pending` };
  if (kind === "not_configured" || kind === "credential_missing")
    return { id: "CRED", reason: "provider credential not configured in this environment" };
  return null;
}

const ID_SHAPE = /^[a-z]{2,6}_[A-Za-z0-9-]{4,}$/;
function resourceIds(result: Result): string[] {
  if (!result.ok) return [];
  const v = result.value as { id?: unknown; url?: unknown } | null;
  const out: string[] = [];
  if (v && typeof v.id === "string" && ID_SHAPE.test(v.id)) out.push(v.id);
  return out;
}

/** Keep only identifier-shaped and scalar summary fields; never the raw body. */
function summarize(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null)
    return { value: typeof value === "string" ? value.slice(0, 200) : value };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "raw" || k === "body" || k === "token") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null)
      out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}

/**
 * Wraps a Web-standard route handler. Reads the correlation headers the tour
 * client sends, emits request.started and request.finished, and echoes the
 * request id on the response so the panel can match it.
 */
export function withTrace<H extends (req: Request, trace: TraceContext) => Promise<Response>>(
  tracer: Tracer,
  route: string,
  handler: H,
) {
  return async (req: Request): Promise<Response> => {
    const ctx = tracer.begin(req.method, route, req.headers);
    await tracer.requestStarted(ctx);
    let res: Response;
    try {
      res = await handler(req, ctx);
    } catch (err) {
      await tracer.requestFinished(ctx, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    await tracer.requestFinished(ctx, res.status);
    const headers = new Headers(res.headers);
    headers.set(REQUEST_ID_HEADER, ctx.request_id);
    headers.set(CORRELATION_HEADER, ctx.request_id);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

type AsyncMethod = (...args: never[]) => Promise<Result>;

/**
 * Decorates a provider port so every call is traced. The label comes from the
 * result (`meta(value)`), which architecture's hybrid adapter marks as sandbox
 * or mock. Without a status on a sandbox success the event says so instead of
 * guessing; the tour then shows the step as sandbox-unconfirmed, not sandbox-ok.
 */
export function tracePort<P extends object>(
  port: P,
  tracer: Tracer,
  ctxOf: () => TraceContext,
  meta: (result: Result, operation: string) => PortResultMeta = metaFromResult,
  now: () => number = () => performance.now(),
): P {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(port)) {
    const fn = (port as Record<string, unknown>)[key];
    if (typeof fn !== "function") {
      out[key] = fn;
      continue;
    }
    out[key] = async (...args: unknown[]) => {
      const ctx = ctxOf();
      const input =
        typeof args[0] === "object" && args[0] !== null
          ? (args[0] as Record<string, unknown>)
          : { arg: args[0] };
      const m0 = meta({ ok: true, value: undefined }, key);
      await tracer.providerCalled(ctx, key, m0.source ?? "mock", input);
      const t0 = now();
      const result = (await (fn as AsyncMethod).apply(port, args as never[])) as Result;
      await tracer.providerResponded(ctx, key, result, meta(result, key), Math.round(now() - t0));
      return result;
    };
  }
  return Object.setPrototypeOf(out, Object.getPrototypeOf(port)) as P;
}

export type { DbRef, RequestRef };
