import type { DemoEvent, Gate, Source } from "./contract";
import { operationMatches, STEPS, type StepDefinition } from "./steps";

/**
 * The guided tour reduces the shared event log into one state per step. A
 * step advances only on observed outcomes correlated by `x-tour-step`: the
 * request finished, the expected tables were written, the expected provider
 * operations responded. Nothing here can mark a step passed on its own.
 */

export type ProofLevel = "none" | "local-ok" | "mock-ok" | "sandbox-unconfirmed" | "sandbox-ok";

export interface TourProof {
  /** Request id and status of the latest correlated request. */
  request: {
    request_id: string;
    route: string;
    http_status: number | null;
    duration_ms: number | null;
  } | null;
  /** Tables and row ids written, deduplicated. `keys` are the identifier names a transaction reported. */
  db: { table: string; ids: string[]; keys: string[] }[];
  /** Provider operations observed, with their labels. */
  provider: {
    operation: string;
    source: Source;
    http_status: number | null;
    request_id: string | null;
    resource_ids: string[];
    duration_ms: number | null;
    unconfirmed: boolean;
    mock_outcome?: "succeeded" | "failed" | null;
    /** Set when the adapter fell back to mock because of a gate. */
    fallback_gate: Gate | null;
  }[];
  /** Allowlisted facts projected from successful server responses. */
  observed: Record<string, string>;
  level: ProofLevel;
  /** Which expected outcomes are still missing, in words the panel can show. */
  missing: string[];
}

export type TourStatus =
  | "pending"
  | "active"
  | "observing"
  | "passed"
  | "failed"
  | "blocked"
  | "skipped";

export interface TourFailure {
  http_status: number | null;
  route: string | null;
  /** The server's own summary line for the failed request or operation. */
  summary: string;
  correlation_id: string;
  seq: number;
}

export interface TourStepState {
  step: StepDefinition;
  status: TourStatus;
  proof: TourProof;
  gate: Gate | null;
  /** Why the step failed, from the observed event; null unless status is failed. */
  failure: TourFailure | null;
  /** Latest event seq that touched this step. */
  last_seq: number;
}

export interface TourState {
  run_id: string | null;
  steps: TourStepState[];
  /** Index of the step the overlay should show, or -1 when every step is terminal. */
  active_index: number;
  /** How the journey ends: only completed when every step passed. */
  outcome: "in-progress" | "completed" | "partial" | "blocked";
  last_seq: number;
}

function emptyProof(): TourProof {
  return { request: null, db: [], provider: [], observed: {}, level: "none", missing: [] };
}

function levelOf(proof: TourProof): ProofLevel {
  const sandbox = proof.provider.filter((p) => p.source === "sandbox");
  if (sandbox.length && sandbox.every((p) => !p.unconfirmed && p.http_status !== null))
    return "sandbox-ok";
  if (sandbox.length) return "sandbox-unconfirmed";
  if (proof.observed.tour_source === "mock" || proof.provider.some((p) => p.source === "mock")) return "mock-ok";
  if (
    proof.db.length ||
    (proof.request && proof.request.http_status !== null && proof.request.http_status < 400)
  )
    return "local-ok";
  return "none";
}

function missingOf(def: StepDefinition, proof: TourProof, requestDone: boolean): string[] {
  const out: string[] = [];
  if (def.expects.route && !requestDone) out.push(`response from ${def.expects.route}`);
  const durableAccount = def.id === "C01" && proof.observed.tour_durable_account === "true";
  for (const table of def.expects.db) {
    if (durableAccount && table === "sellers") continue;
    if (!proof.db.some((entry) => dbMatches(table, entry))) out.push(`row in ${table}`);
  }
  for (const operation of def.expects.provider) {
    if (durableAccount && operation === "createOrFetchAccount") continue;
    if (!proof.provider.some((entry) => operationMatches(operation, entry.operation) &&
      (entry.source !== "mock" || entry.mock_outcome === "succeeded" ||
        (entry.http_status !== null && entry.http_status >= 200 && entry.http_status < 300))))
      out.push(`provider ${operation}`);
  }
  if (def.expects.terminal && proof.observed.tour_terminal !== "true")
    out.push(`confirmed ${def.expects.terminal}`);
  return out;
}

// Mock methods have settled Results, not HTTP responses. Only the mapper's explicit
// successful mock outcome can satisfy the same operation proof as a real sandbox 2xx.
function providerSucceeded(event: DemoEvent): boolean {
  if (event.kind !== "operation.responded" || !event.provider ||
    event.state === "failed" || event.state === "blocked" || event.payload.unconfirmed === true) return false;
  const status = event.provider.http_status;
  if (status !== null) return status >= 200 && status < 300;
  return event.source === "mock" && event.payload.mock_outcome === "succeeded";
}

/**
 * A table expectation is met by a write to that table, or by a transaction whose reported
 * identifier keys name that record kind (sellers matches seller_id, orders matches order_id).
 */
export function dbMatches(
  expected: string,
  entry: { table: string; ids: string[]; keys: string[] },
): boolean {
  if (entry.table === expected) return true;
  const singular = expected.endsWith("s") ? expected.slice(0, -1) : expected;
  return entry.keys.some((k) => k === singular || k.startsWith(`${singular}_`) || k.startsWith(`${singular}Id`));
}

/** An expected route matches an observed one exactly, or by prefix when it ends in "/". */
export function routeMatches(expected: string | null, method: string, route: string): boolean {
  if (!expected) return true;
  const [expMethod, expPath] = expected.includes(" ") ? expected.split(" ", 2) : [null, expected];
  if (expMethod && expMethod !== method) return false;
  const path = expPath ?? "";
  return path.endsWith("/") ? route.startsWith(path) || route === path.slice(0, -1) : route === path;
}

function responseFacts(event: DemoEvent): Record<string, string> {
  const raw = event.payload.safe_ids;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([key, value]) =>
    key.startsWith("tour_") && key !== "tour_terminal" && typeof value === "string"));
}

/** Recovery must repeat the failed request with the chapter's pinned identities. */
function recoveryResponse(event: DemoEvent, states: Map<string, TourStepState>): boolean {
  if (!event.request || !event.step_id) return false;
  const { method, route } = event.request;
  const facts = responseFacts(event);
  const proof = states.get(event.step_id)?.proof.observed ?? {};
  const seller = states.get("C01")?.proof.observed.tour_seller_id;
  const product = states.get("C02")?.proof.observed.tour_product_id;
  const order = states.get("C03")?.proof.observed;
  switch (event.step_id) {
    case "C01":
      return method === "POST" && route === "/api/sellers" && !!seller && facts.tour_seller_id === seller;
    case "C02":
      return method === "POST" && !!seller && (
        route === `/api/sellers/${seller}/onboarding-link` ||
        (route === "/api/products" && !!product && facts.tour_product_id === product && proof.tour_onboarding_link === "true")
      );
    case "C03":
      return (method === "POST" && route === "/api/checkouts" && !!order?.tour_order_id && facts.tour_order_id === order.tour_order_id) ||
        (method === "GET" && route === `/api/orders/${order?.tour_order_id}` && !!seller && !!product &&
          facts.tour_order_id === order?.tour_order_id && facts.tour_order_paid === "true" && !!facts.tour_payment_id &&
          facts.tour_seller_id === seller && facts.tour_product_id === product);
    case "C04":
      return method === "GET" && !!seller && route === `/api/sellers/${seller}/earnings` &&
        order?.tour_terminal === "true" && !!order.tour_payment_id &&
        !!facts.tour_earnings_payment_ids?.split(",").includes(order.tour_payment_id);
    case "C05":
      return method === "POST" && !!seller && route === `/api/sellers/${seller}/payouts/simulation` &&
        facts.tour_source === "mock" && (facts.tour_sample_started === "true" ||
          (!!facts.tour_sample_payout_id && facts.tour_sample_payout_status === "requested"));
    case "C06":
      return method === "POST" && route === "/api/admin/issues/demo-fault" && !!seller &&
        facts.tour_source === "mock" && facts.tour_seller_id === seller && !!proof.tour_case_id && facts.tour_case_id === proof.tour_case_id;
    case "C07": {
      const injected = states.get("C06")?.proof.observed;
      const id = injected?.tour_terminal === "true" ? injected.tour_case_id : null;
      const action = facts.tour_issue_action;
      return method === "POST" && !!id && route === `/api/admin/issues/${id}/actions/${action}` &&
        facts.tour_case_id === id && facts.tour_action_succeeded === "true" &&
        (action === "refetch" || (action === "import_confirmed" && proof.tour_refetched === id) ||
          (action === "recheck" && proof.tour_imported === id && facts.tour_issue_resolved === "true"));
    }
    default: return false;
  }
}

/** Pure reducer: events in seq order in, tour state out. */
export function reduceTour(
  events: DemoEvent[],
  defs: readonly StepDefinition[] = STEPS,
  opts: {
    skipped?: Set<string>;
    stepOf?: (correlation_id: string) => string | null;
    /** Presentation only: let Retry act while retaining every failed event and proof requirement. */
    retryAfter?: Record<string, number>;
  } = {},
): TourState {
  const byId = new Map<string, TourStepState>();
  for (const step of defs)
    byId.set(step.id, {
      step,
      status: "pending",
      proof: emptyProof(),
      gate: null,
      failure: null,
      last_seq: 0,
    });
  const requestDone = new Map<string, boolean>();
  const failures = new Map<string, { event: DemoEvent; failure: TourFailure }[]>();
  const attempts = new Map<string, DemoEvent[]>();
  const attemptKey = (event: DemoEvent) => JSON.stringify([event.run_id, event.step_id, event.correlation_id]);
  // A provider/DB failure can recover only through the request that owned it.
  const requests = new Map<string, DemoEvent[]>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.kind !== "request.finished" || !event.request) continue;
    const list = requests.get(attemptKey(event)) ?? [];
    list.push(event);
    requests.set(attemptKey(event), list);
  }
  const recordFailure = (state: TourStepState, event: DemoEvent, failure: TourFailure) => {
    state.status = "failed";
    state.failure = failure;
    delete state.proof.observed.tour_terminal;
    delete state.proof.observed.tour_durable_account;
    const history = failures.get(state.step.id) ?? [];
    history.push({ event, failure });
    failures.set(state.step.id, history);
  };
  let run_id: string | null = null;
  let last_seq = 0;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    run_id = e.run_id;
    last_seq = e.seq;
    if (e.kind === "run.reset") {
      for (const s of byId.values())
        Object.assign(s, {
          status: "pending",
          proof: emptyProof(),
          gate: null,
          failure: null,
          last_seq: e.seq,
        });
      requestDone.clear();
      failures.clear();
      attempts.clear();
      continue;
    }
    const step_id =
      e.step_id ??
      (typeof e.payload.tour_step === "string" ? e.payload.tour_step : null) ??
      opts.stepOf?.(e.correlation_id) ??
      null;
    if (!step_id) continue;
    const s = byId.get(step_id);
    if (!s) continue;
    s.last_seq = e.seq;
    const attempt = attempts.get(attemptKey(e)) ?? [];
    attempt.push(e);
    attempts.set(attemptKey(e), attempt);
    if (s.status === "pending") s.status = "observing";
    if (e.kind === "request.finished" && e.request) {
      s.proof.request = {
        request_id: e.request.request_id,
        route: e.request.route,
        http_status: e.request.http_status,
        duration_ms: e.request.duration_ms,
      };
      const matches = routeMatches(s.step.expects.route, e.request.method, e.request.route);
      if (e.request.http_status !== null && e.request.http_status >= 400) {
        recordFailure(s, e, {
          http_status: e.request.http_status,
          route: `${e.request.method} ${e.request.route}`,
          summary: e.summary,
          correlation_id: e.correlation_id,
          seq: e.seq,
        });
        continue;
      }
      const succeeded = e.request.http_status !== null && e.request.http_status >= 200 && e.request.http_status < 300;
      if (matches && succeeded) requestDone.set(step_id, true);
      if (succeeded) {
        const facts = responseFacts(e);
        // Only route-appropriate facts enter the proof. Terminal markers are computed here,
        // never accepted from a request, generic step.finished event or client timer.
        const prior = s.proof.observed;
        const route = e.request.route;
        if (step_id === "C02" && e.request.method === "POST" && route === `/api/sellers/${byId.get("C01")?.proof.observed.tour_seller_id}/onboarding-link`)
          prior.tour_onboarding_link = "true";
        if (step_id === "C02" && e.request.method === "POST" && route === "/api/products" &&
          prior.tour_onboarding_link === "true" && facts.tour_product_id && (!prior.tour_product_id || prior.tour_product_id === facts.tour_product_id)) {
          prior.tour_product_id = facts.tour_product_id;
          prior.tour_terminal = "true";
        }
        if (step_id === "C03" && e.request.method === "POST" && route === "/api/checkouts") {
          if (facts.tour_order_id && !prior.tour_order_id) prior.tour_order_id = facts.tour_order_id;
        }
        if (step_id === "C03" && e.request.method === "GET" &&
          route === `/api/orders/${prior.tour_order_id}` && facts.tour_order_id === prior.tour_order_id &&
          facts.tour_order_paid === "true" && facts.tour_payment_id &&
          facts.tour_seller_id === byId.get("C01")?.proof.observed.tour_seller_id &&
          facts.tour_product_id === byId.get("C02")?.proof.observed.tour_product_id &&
          Boolean(facts.tour_seller_id) && Boolean(facts.tour_product_id)) {
          prior.tour_payment_id = facts.tour_payment_id;
          prior.tour_terminal = "true";
        }
        if (step_id === "C04" && e.request.method === "GET" && route === `/api/sellers/${byId.get("C01")?.proof.observed.tour_seller_id}/earnings`) {
          const order = byId.get("C03")?.proof.observed;
          if (order?.tour_terminal === "true" && order.tour_payment_id &&
            facts.tour_earnings_payment_ids?.split(",").includes(order.tour_payment_id)) prior.tour_terminal = "true";
        }
        if (step_id === "C05" && e.request.method === "POST" && route === `/api/sellers/${byId.get("C01")?.proof.observed.tour_seller_id}/payouts/simulation` &&
          facts.tour_source === "mock") {
          if (facts.tour_sample_started === "true") prior.tour_sample_started = "true";
          if (prior.tour_sample_started === "true" && facts.tour_sample_payout_id && facts.tour_sample_payout_status === "requested") prior.tour_terminal = "true";
        }
        if (step_id === "C06" && e.request.method === "POST" && route === "/api/admin/issues/demo-fault" &&
          facts.tour_case_id && (!prior.tour_case_id || prior.tour_case_id === facts.tour_case_id) && facts.tour_source === "mock" && facts.tour_seller_id === byId.get("C01")?.proof.observed.tour_seller_id && Boolean(facts.tour_seller_id)) {
          prior.tour_case_id = facts.tour_case_id;
          prior.tour_terminal = "true";
        }
        if (step_id === "C07") {
          const injected = byId.get("C06")?.proof.observed;
          const caseId = injected?.tour_terminal === "true" ? injected.tour_case_id : null;
          if (caseId && facts.tour_case_id === caseId && e.request.method === "POST") {
            const action = route.slice(`/api/admin/issues/${caseId}/actions/`.length);
            if (route === `/api/admin/issues/${caseId}/actions/${action}` &&
              facts.tour_issue_action === action && facts.tour_action_succeeded === "true") {
              if (action === "refetch") prior.tour_refetched = caseId;
              if (action === "import_confirmed" && prior.tour_refetched === caseId) prior.tour_imported = caseId;
              if (action === "recheck" && prior.tour_imported === caseId && facts.tour_issue_resolved === "true")
                prior.tour_terminal = "true";
              if (facts.tour_next_action) prior.tour_next_action = facts.tour_next_action;
            }
          }
        }
        if (step_id === "C01" && route === "/api/sellers" && e.request.method === "POST" && facts.tour_seller_id && !prior.tour_seller_id)
          prior.tour_seller_id = facts.tour_seller_id;
        if (step_id === "C01" && facts.tour_seller_id === prior.tour_seller_id && facts.tour_seller_account_readback) {
          const account = facts.tour_seller_account_readback;
          const read = attempt.some((item) => providerSucceeded(item) &&
            item.provider?.operation === `GET /accounts/${account}`);
          const committed = attempt.some((item) => item.kind === "db.written" && item.state !== "failed");
          // The fresh read confirms the persisted account. Account creation remains in history.
          const created = [...attempts.values()].some((items) =>
            items.some((item) => item.correlation_id === e.correlation_id ||
              (failures.get("C01") ?? []).some(({ event }) => event.correlation_id === item.correlation_id) ||
              (item.kind === "request.finished" && responseFacts(item).tour_seller_id === prior.tour_seller_id &&
                responseFacts(item).tour_seller_account_readback === account)) && items.some((item) =>
            item.run_id === e.run_id && item.step_id === "C01" && item.kind === "operation.responded" &&
            item.provider && operationMatches("createOrFetchAccount", item.provider.operation ?? "") &&
            providerSucceeded(item)) && items.some((item) => item.kind === "db.written" && item.state !== "failed"));
          if (read && committed && created) prior.tour_durable_account = "true";
        }
        if (facts.tour_source) prior.tour_source = facts.tour_source;
      }
    }
    if (e.kind === "db.written" && e.db && e.state !== "failed") {
      const keys = Array.isArray(e.payload.safe_id_keys) ? (e.payload.safe_id_keys as string[]) : [];
      const existing = s.proof.db.find((d) => d.table === e.db?.table);
      if (existing) {
        existing.ids = [...new Set([...existing.ids, ...e.db.ids])];
        existing.keys = [...new Set([...existing.keys, ...keys])];
      } else s.proof.db.push({ table: e.db.table, ids: [...e.db.ids], keys });
    }
    if (e.kind === "operation.responded" && e.provider) {
      s.proof.provider.push({
        operation: e.provider.operation ?? String(e.payload.operation ?? "?"),
        source: e.source,
        http_status: e.provider.http_status,
        request_id: e.provider.request_id,
        resource_ids: e.provider.resource_ids,
        duration_ms: e.provider.duration_ms,
        unconfirmed: e.payload.unconfirmed === true,
        mock_outcome: e.payload.mock_outcome === "succeeded" || e.payload.mock_outcome === "failed" ? e.payload.mock_outcome : null,
        fallback_gate: (e.payload.fallback_gate as Gate | undefined) ?? null,
      });
      if (e.state === "failed") {
        recordFailure(s, e, {
          http_status: e.provider.http_status,
          route: e.provider.operation,
          summary: e.summary,
          correlation_id: e.correlation_id,
          seq: e.seq,
        });
      }
    }
    if (e.kind === "db.written" && e.state === "failed") {
      recordFailure(s, e, { http_status: null, route: e.db?.table ?? null, summary: e.summary, correlation_id: e.correlation_id, seq: e.seq });
    }
    if (e.kind === "request.finished" && e.request && e.request.http_status !== null &&
      e.request.http_status >= 200 && e.request.http_status < 300 && recoveryResponse(e, byId)) {
      const remaining = (failures.get(step_id) ?? []).filter(({ event: failed }) => {
        const original = failed.request ? failed : requests.get(attemptKey(failed))?.find((item) => item.seq >= failed.seq);
        if (!original?.request || original.request.method !== e.request?.method ||
          original.request.route !== e.request.route || failed.correlation_id === e.correlation_id ||
          failed.run_id !== e.run_id) return true;
        const fresh = attempt.filter((item) => item.seq > failed.seq);
        // A successful HTTP envelope cannot conceal another failure in its own attempt.
        if (attempt.some((item) => item.state === "failed" || item.state === "blocked")) return true;
        const db = fresh.filter((item) => item.kind === "db.written" && item.db);
        const provider = fresh.filter(providerSucceeded);
        // The C07 chapter requires the resolution write at recheck; refetch/import are intermediate actions.
        const requiresEffects = routeMatches(s.step.expects.route, e.request.method, e.request.route) &&
          (step_id !== "C07" || e.request.route.endsWith("/actions/recheck"));
        const durableAccount = step_id === "C01" && s.proof.observed.tour_durable_account === "true" &&
          responseFacts(e).tour_seller_account_readback && fresh.some((item) => item.kind === "operation.responded" &&
            item.provider?.operation === `GET /accounts/${responseFacts(e).tour_seller_account_readback}` &&
            providerSucceeded(item));
        const expects = requiresEffects && !durableAccount ? s.step.expects : { db: [], provider: [] };
        if (expects.db.some((table) => !db.some((item) => dbMatches(table, {
          table: item.db!.table, ids: item.db!.ids,
          keys: Array.isArray(item.payload.safe_id_keys) ? item.payload.safe_id_keys as string[] : [],
        })))) return true;
        if (expects.provider.some((operation) => !provider.some((item) => operationMatches(operation, item.provider!.operation ?? "")))) return true;
        if (failed.provider && !provider.some((item) => item.provider?.operation === failed.provider?.operation)) return true;
        if (failed.db && !db.some((item) => item.db?.table === failed.db?.table)) return true;
        return false;
      });
      failures.set(step_id, remaining);
      if (remaining.length === 0 && s.status === "failed") {
        s.status = "observing";
        s.failure = null;
      }
    }
    if (e.state === "blocked" && e.gate) {
      s.status = "blocked";
      s.gate = e.gate;
    }
    if (!s.step.expects.terminal && e.kind === "step.finished" && e.state === "passed") requestDone.set(step_id, true);
    if (s.status === "observing" || s.status === "active") {
      s.proof.missing = missingOf(s.step, s.proof, requestDone.get(step_id) === true);
      s.proof.level = levelOf(s.proof);
      if (s.proof.missing.length === 0 && s.proof.level !== "none") s.status = "passed";
    } else {
      s.proof.level = levelOf(s.proof);
      s.proof.missing = missingOf(s.step, s.proof, requestDone.get(step_id) === true);
    }
  }
  // Retry changes the control state, never the evidence used to call a chapter passed.
  for (const state of byId.values()) {
    const pending = failures.get(state.step.id) ?? [];
    const latest = pending.at(-1);
    if (latest) {
      state.status = "failed";
      state.failure = latest.failure;
      if ((opts.retryAfter?.[state.step.id] ?? 0) >= latest.failure.seq) {
        state.status = "active";
        state.failure = null;
      }
      state.proof.missing = missingOf(state.step, state.proof, requestDone.get(state.step.id) === true);
    }
  }
  const steps = [...byId.values()];
  const sellerId = byId.get("C01")?.proof.observed.tour_seller_id;
  const productId = byId.get("C02")?.proof.observed.tour_product_id;
  const caseId = byId.get("C06")?.proof.observed.tour_case_id;
  for (const state of steps) {
    const facts = state.proof.observed;
    const id = state.step.id;
    if (id === "C02" && facts.tour_onboarding_link === "true" && !productId)
      state.step = { ...state.step, path: "/sell/products/new", anchor: "sell.product.demo", action: { kind: "click", label: "Publish the sample product" } };
    if (id === "C03" && productId) state.step = { ...state.step, path: `/p/${encodeURIComponent(productId)}` };
    if (id === "C03" && facts.tour_order_id)
      state.step = { ...state.step, path: `/checkout/${encodeURIComponent(facts.tour_order_id)}`, anchor: "checkout.simulation.complete", action: { kind: "click", label: "Complete the local test payment" } };
    if (id === "C05" && facts.tour_sample_started === "true")
      state.step = { ...state.step, anchor: "sell.payouts.sample.withdraw", action: { kind: "click", label: "Request the sample withdrawal" } };
    if (id === "C06" && sellerId)
      state.step = { ...state.step, path: `/admin/issues?seller_id=${encodeURIComponent(sellerId)}` };
    if (id === "C07" && caseId) {
      const action = facts.tour_imported ? "recheck" : facts.tour_refetched ? "import_confirmed" : "refetch";
      state.step = { ...state.step, path: `/admin/issues?issue=${encodeURIComponent(caseId)}`, anchor: `admin.issues.guided.${action}`, action: { kind: "click", label: action === "recheck" ? "Recheck and resolve" : action === "import_confirmed" ? "Import the confirmed payment" : "Refetch the payment" } };
    }
  }
  for (const s of steps)
    if (opts.skipped?.has(s.step.id) && s.status !== "passed") s.status = "skipped";
  // A failed step holds the tour until it is retried or skipped; nothing advances past a failure on its own.
  const active_index = steps.findIndex(
    (s) =>
      s.status === "pending" ||
      s.status === "observing" ||
      s.status === "active" ||
      s.status === "failed" ||
      s.status === "blocked",
  );
  if (active_index >= 0) {
    const a = steps[active_index];
    if (a && a.status === "pending") a.status = "active";
  }
  const terminal = active_index === -1;
  const outcome: TourState["outcome"] = !terminal
    ? "in-progress"
    : steps.every((s) => s.status === "passed")
      ? "completed"
      : steps.some((s) => s.status === "blocked") && !steps.some((s) => s.status === "skipped")
        ? "blocked"
        : "partial";
  return { run_id, steps, active_index, outcome, last_seq };
}

/** Headers the app's fetch calls send so the server can correlate them to the tour. */
export function tourHeaders(
  step_id: string | null,
  role: string,
  run_id: string | null,
  correlation_id: string | null = null,
): Record<string, string> {
  const h: Record<string, string> = { "x-demo-role": role };
  if (step_id) h["x-tour-step"] = step_id;
  if (run_id) h["x-demo-run"] = run_id;
  if (correlation_id) h["x-ledgerly-correlation-id"] = correlation_id;
  return h;
}
