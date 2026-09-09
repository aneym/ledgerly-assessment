/**
 * Demo event/state contract, version 1.
 *
 * Every walkthrough step, provider call, ledger write and reset in the demo
 * emits one DemoEvent. The live log side panel, the saved static run export
 * and the evidence bridge all consume this one shape. Bump CONTRACT_VERSION
 * major when a consumer would misread an older event.
 */

export const CONTRACT_VERSION = "2.0.0" as const;
export const CONTRACT_MAJOR = 2;

/**
 * Where an observation came from. `local` is this app (request, database).
 * `sandbox` and `mock` label provider responses and come from the port result
 * (architecture's hybrid adapter marks every response), never from a caller.
 */
export const SOURCES = ["local", "sandbox", "mock"] as const;
export type Source = (typeof SOURCES)[number];

/**
 * Step state machine. `verified` is a display state: only an evidence record
 * reviewed by a second actor can put a step there. The runtime never emits it.
 */
export const STATES = ["pending", "running", "passed", "failed", "blocked", "verified"] as const;
export type State = (typeof STATES)[number];
export const RUNTIME_TERMINAL_STATES: readonly State[] = ["passed", "failed", "blocked"];

/** Demo presentation roles. Switching one never changes server-side authorization. */
export const ROLES = ["buyer", "creator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const EVENT_KINDS = [
  "run.started",
  "run.reset",
  "role.switched",
  "step.started",
  "step.finished",
  "request.started",
  "request.finished",
  "operation.requested",
  "operation.responded",
  "db.written",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const ENVIRONMENTS = ["local", "sandbox", "hybrid"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Explicit sandbox base. A sandbox-labelled event must carry exactly this. */
export const SANDBOX_API_BASE = "https://sandbox-api.whop.com/api/v1" as const;

export interface ProviderRef {
  /** Base URL the call actually went to. */
  base_url: string;
  /** HTTP status the provider returned, or null when no response arrived. */
  http_status: number | null;
  /** Provider request id header when present. */
  request_id: string | null;
  /** Nonsecret provider resource ids returned by the call, e.g. acc_… */
  resource_ids: string[];
  /** Pinned Api-Version-Date sent with the request. */
  api_version_date: string | null;
  /** Internal operation name, e.g. createOrFetchAccount. */
  operation: string | null;
  duration_ms: number | null;
}

/** One HTTP request into this app, as seen by the route handler wrapper. */
export interface RequestRef {
  request_id: string;
  method: string;
  route: string;
  http_status: number | null;
  duration_ms: number | null;
}

/** Rows this app wrote in its own database. Identifiers only, never row content. */
export interface DbRef {
  table: string;
  ids: string[];
}

export interface Gate {
  /** Owner gate id, e.g. G01 for sandbox payout enablement. */
  id: string;
  reason: string;
}

export interface DemoEvent {
  contract_version: typeof CONTRACT_VERSION;
  /** Unique per event. Consumers dedupe on it. */
  event_id: string;
  /** Assigned by the log at append time. Consumers order by it, never by arrival. */
  seq: number;
  run_id: string;
  /** Groups every event of one step attempt. Equals the step attempt id. */
  correlation_id: string;
  kind: EventKind;
  /** Walkthrough step id, or null for run-level events. */
  step_id: string | null;
  attempt: number;
  at: string;
  role: Role;
  source: Source;
  environment: Environment;
  /** Step state after this event. */
  state: State;
  /** Human-readable, present tense, safe to show in the side panel. */
  summary: string;
  /** Redacted payload. Never carries a key, token or secret. */
  payload: Record<string, unknown>;
  request: RequestRef | null;
  db: DbRef | null;
  provider: ProviderRef | null;
  gate: Gate | null;
  /** Evidence record id once the bridge wrote one, else null. */
  evidence_id: string | null;
}

export interface StepSnapshot {
  step_id: string;
  state: State;
  /** Strongest provider label seen on the step: sandbox beats mock, mock beats local. */
  source: Source | null;
  attempt: number;
  correlation_id: string | null;
  gate: Gate | null;
  last_seq: number;
  evidence_id: string | null;
}

export interface RunSnapshot {
  contract_version: typeof CONTRACT_VERSION;
  run_id: string;
  environment: Environment;
  role: Role;
  started_at: string;
  last_seq: number;
  steps: StepSnapshot[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oneOf<T extends readonly string[]>(list: T, v: unknown): v is T[number] {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

/** Structural validation of one event. Mirrors contract/demo-event.v1.schema.json. */
export function validateEvent(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["event must be an object"] };
  const e = input;
  if (typeof e.contract_version !== "string") errors.push("contract_version missing");
  else if (Number(e.contract_version.split(".")[0]) !== CONTRACT_MAJOR)
    errors.push(`contract_version major must be ${CONTRACT_MAJOR}, got ${e.contract_version}`);
  if (typeof e.event_id !== "string" || e.event_id.length === 0) errors.push("event_id missing");
  if (!Number.isInteger(e.seq) || (e.seq as number) < 1)
    errors.push("seq must be a positive integer");
  if (typeof e.run_id !== "string" || e.run_id.length === 0) errors.push("run_id missing");
  if (typeof e.correlation_id !== "string" || e.correlation_id.length === 0)
    errors.push("correlation_id missing");
  if (!oneOf(EVENT_KINDS, e.kind)) errors.push(`kind invalid: ${String(e.kind)}`);
  if (!(e.step_id === null || typeof e.step_id === "string"))
    errors.push("step_id must be string or null");
  if (!Number.isInteger(e.attempt) || (e.attempt as number) < 0)
    errors.push("attempt must be a non-negative integer");
  if (typeof e.at !== "string" || !ISO.test(e.at)) errors.push("at must be an ISO-8601 timestamp");
  if (!oneOf(ROLES, e.role)) errors.push(`role invalid: ${String(e.role)}`);
  if (!oneOf(SOURCES, e.source)) errors.push(`source invalid: ${String(e.source)}`);
  if (!oneOf(ENVIRONMENTS, e.environment))
    errors.push(`environment invalid: ${String(e.environment)}`);
  if (!oneOf(STATES, e.state)) errors.push(`state invalid: ${String(e.state)}`);
  if (e.state === "verified") errors.push("state verified cannot be emitted by the runtime");
  if (typeof e.summary !== "string" || e.summary.length === 0) errors.push("summary missing");
  if (!isRecord(e.payload)) errors.push("payload must be an object");
  if (!(e.request === null || isRecord(e.request))) errors.push("request must be object or null");
  if (isRecord(e.request)) {
    if (typeof e.request.request_id !== "string" || !e.request.request_id)
      errors.push("request.request_id missing");
    if (typeof e.request.route !== "string") errors.push("request.route missing");
  }
  if (!(e.db === null || isRecord(e.db))) errors.push("db must be object or null");
  if (isRecord(e.db) && (typeof e.db.table !== "string" || !Array.isArray(e.db.ids)))
    errors.push("db needs table and ids");
  if (!(e.provider === null || isRecord(e.provider)))
    errors.push("provider must be object or null");
  if (isRecord(e.provider)) {
    const p = e.provider;
    if (typeof p.base_url !== "string") errors.push("provider.base_url missing");
    if (!(p.http_status === null || Number.isInteger(p.http_status)))
      errors.push("provider.http_status must be int or null");
    if (!Array.isArray(p.resource_ids)) errors.push("provider.resource_ids must be an array");
  }
  if (!(e.gate === null || isRecord(e.gate))) errors.push("gate must be object or null");
  if (!(e.evidence_id === null || typeof e.evidence_id === "string"))
    errors.push("evidence_id must be string or null");

  // Cross-field rules. These are the ones that keep labels honest.
  if (e.source === "sandbox") {
    if (e.environment === "local")
      errors.push("sandbox source cannot occur in a local-only environment");
    const successResponse =
      e.kind === "operation.responded" &&
      e.state === "running" &&
      isRecord(e.payload) &&
      !("error" in e.payload);
    if (successResponse || (e.kind === "step.finished" && e.state === "passed")) {
      if (!isRecord(e.provider)) errors.push("sandbox success requires a provider reference");
      else if (e.provider.base_url !== SANDBOX_API_BASE)
        errors.push(`sandbox provider.base_url must be ${SANDBOX_API_BASE}`);
      else if (
        e.provider.http_status === null &&
        !(e.kind === "operation.responded" && isRecord(e.payload) && e.payload.unconfirmed === true)
      )
        errors.push(
          "sandbox success requires an observed http_status (or payload.unconfirmed true on the response event)",
        );
    }
  }
  if (e.source !== "sandbox" && isRecord(e.provider) && e.provider.base_url === SANDBOX_API_BASE)
    errors.push(`${String(e.source)} event cannot claim the sandbox base url`);
  if ((e.kind === "request.started" || e.kind === "request.finished") && !isRecord(e.request))
    errors.push(`${String(e.kind)} requires a request reference`);
  if (e.kind === "request.finished" && isRecord(e.request) && e.request.http_status === null)
    errors.push("request.finished requires http_status");
  if (e.kind === "db.written" && !isRecord(e.db)) errors.push("db.written requires a db reference");
  if (
    (e.kind === "operation.requested" || e.kind === "operation.responded") &&
    e.source === "local"
  )
    errors.push(`${String(e.kind)} must carry the provider source (sandbox or mock)`);
  if (e.state === "blocked" && !isRecord(e.gate)) errors.push("blocked state requires a gate");
  if (e.kind === "step.finished" && !RUNTIME_TERMINAL_STATES.includes(e.state as State))
    errors.push("step.finished must carry a terminal state");
  if (e.kind === "step.started" && e.state !== "running")
    errors.push("step.started must carry state running");
  if (
    (e.kind === "run.started" || e.kind === "run.reset" || e.kind === "role.switched") &&
    e.step_id !== null
  )
    errors.push(`${String(e.kind)} must not carry a step_id`);
  if (isRecord(e.payload)) {
    const leak = findSecretLeak(e.payload);
    if (leak) errors.push(`payload leaks a secret-shaped value at ${leak}`);
  }
  return { ok: errors.length === 0, errors };
}

export function assertEvent(input: unknown): asserts input is DemoEvent {
  const r = validateEvent(input);
  if (!r.ok) throw new Error(`invalid demo event: ${r.errors.join("; ")}`);
}

const SECRET_KEY =
  /(api[_-]?key|secret|token|authorization|password|bearer|card[_-]?number|iban|account[_-]?number|cvc|ssn)/i;
const SECRET_VALUE = /^(sk_|ws_|whop_|Bearer\s)/;
/** Nonsecret Whop-style ids we allow through untouched. */
const ID_ALLOW =
  /^(biz|acc|usr|pay|ref|trf|po|wd|wh|whd|plan|prod|chk|apik|mem|dsp|ledg|fx|mock|run|step|evt|ev|req|sel|ord|eff|del|usr)_[A-Za-z0-9-]+$/;

/** Returns the dotted path of the first secret-shaped leaf, or null. */
export function findSecretLeak(value: unknown, path = "payload"): string | null {
  if (typeof value === "string") {
    if (ID_ALLOW.test(value)) return null;
    return SECRET_VALUE.test(value) ? path : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecretLeak(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) && typeof v === "string" && v !== "[redacted]" && !ID_ALLOW.test(v))
        return `${path}.${k}`;
      const hit = findSecretLeak(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

export interface Redaction {
  value: Record<string, unknown>;
  /** Field paths whose values were replaced. Goes into evidence redaction_review. */
  removed: string[];
}

/** Replace secret-shaped values before anything is logged or written. Idempotent. */
export function redact(input: Record<string, unknown>): Redaction {
  const removed: string[] = [];
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === "string") {
      if (ID_ALLOW.test(v)) return v;
      if (SECRET_VALUE.test(v)) {
        removed.push(path);
        return "[redacted]";
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    if (isRecord(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) {
        const p = `${path}.${k}`;
        if (
          SECRET_KEY.test(k) &&
          typeof inner === "string" &&
          inner !== "[redacted]" &&
          !ID_ALLOW.test(inner)
        ) {
          removed.push(p);
          out[k] = "[redacted]";
        } else out[k] = walk(inner, p);
      }
      return out;
    }
    return v;
  };
  return { value: walk(input, "payload") as Record<string, unknown>, removed };
}
