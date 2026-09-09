import type { Adapter } from "./adapters";
import {
  type DemoEvent,
  type Environment,
  type Gate,
  type Role,
  redact,
  type Source,
  type State,
} from "./contract";
import { type Clock, newId, systemClock } from "./ids";
import type { EventDraft, EventLog } from "./log";
import { getStep, STEPS, type StepDefinition } from "./steps";

export interface RunnerOptions {
  log: EventLog;
  adapter: Adapter;
  clock?: Clock;
  /** Initial presentation role. */
  role?: Role;
  /** Resume an existing run id after a restart; attempts seed the per-step counters. */
  run_id?: string;
  attempts?: Record<string, number>;
}

export interface StepOutcome {
  step_id: string;
  correlation_id: string;
  attempt: number;
  state: State;
  source: Source;
  gate: Gate | null;
  events: DemoEvent[];
}

/**
 * Role-aware demo orchestrator. One runner owns one local run id. It emits
 * every event through the shared log, labels source from the adapter it was
 * given, and blocks instead of pretending when a gate is in the way.
 */
export class DemoRunner {
  readonly log: EventLog;
  private adapter: Adapter;
  private readonly clock: Clock;
  private role: Role;
  private runId: string;
  private attempts = new Map<string, number>();
  private inFlight = new Set<Promise<unknown>>();
  private readonly defs: readonly StepDefinition[];

  constructor(opts: RunnerOptions, defs: readonly StepDefinition[] = STEPS) {
    this.log = opts.log;
    this.adapter = opts.adapter;
    this.clock = opts.clock ?? systemClock;
    this.role = opts.role ?? "buyer";
    this.runId = opts.run_id ?? newId("run");
    for (const [k, v] of Object.entries(opts.attempts ?? {})) this.attempts.set(k, v);
    this.defs = defs;
  }

  get run_id() {
    return this.runId;
  }
  get source(): Source {
    return this.adapter.kind;
  }
  get environment(): Environment {
    return this.adapter.kind === "sandbox" ? "sandbox" : "local";
  }
  /** Run-level and step events are this app's own; provider events carry the adapter label. */
  private sourceFor(kind: DemoEvent["kind"]): Source {
    return kind === "operation.requested" || kind === "operation.responded"
      ? this.adapter.kind
      : "local";
  }
  get currentRole() {
    return this.role;
  }

  private base(
    kind: DemoEvent["kind"],
    step_id: string | null,
    correlation_id: string,
    attempt: number,
    state: State,
    summary: string,
    payload: Record<string, unknown> = {},
  ): EventDraft {
    const { value, removed } = redact(payload);
    if (removed.length) value.redacted_fields = removed;
    return {
      event_id: newId("evt"),
      run_id: this.runId,
      correlation_id,
      kind,
      step_id,
      attempt,
      at: this.clock().toISOString(),
      role: this.role,
      source: this.sourceFor(kind),
      environment: this.environment,
      state,
      summary,
      payload: value,
      request: null,
      db: null,
      provider: null,
      gate: null,
      evidence_id: null,
    };
  }

  /** Opens the run. Call once per run id; reset calls it again with a new id. */
  async start(): Promise<DemoEvent> {
    return this.log.append(
      this.base(
        "run.started",
        null,
        this.runId,
        0,
        "pending",
        `Run ${this.runId} starts against ${this.source}`,
        { step_ids: this.defs.map((d) => d.id) },
      ),
    );
  }

  /**
   * Presentation-only role switch. It changes which screens the walkthrough
   * animates. It does not touch any server principal; see roles.ts.
   */
  async switchRole(role: Role): Promise<DemoEvent> {
    const from = this.role;
    this.role = role;
    return this.log.append(
      this.base(
        "role.switched",
        null,
        this.runId,
        0,
        "pending",
        `Demo view switches from ${from} to ${role}; server authorization unchanged`,
        { from, to: role, scope: "presentation" },
      ),
    );
  }

  /** Swap the provider seam, e.g. after a credential becomes available. Source labelling follows automatically. */
  useAdapter(adapter: Adapter) {
    this.adapter = adapter;
  }

  runStep(step_id: string, input: Record<string, unknown> = {}): Promise<StepOutcome> {
    const p = this.runStepInner(step_id, input);
    this.inFlight.add(p);
    p.finally(() => this.inFlight.delete(p)).catch(() => undefined);
    return p;
  }

  private async runStepInner(
    step_id: string,
    input: Record<string, unknown>,
  ): Promise<StepOutcome> {
    const def = getStep(step_id);
    const attempt = (this.attempts.get(step_id) ?? 0) + 1;
    this.attempts.set(step_id, attempt);
    const correlation_id = newId("step");
    const events: DemoEvent[] = [];
    const push = async (d: EventDraft) => {
      const e = await this.log.append(d);
      events.push(e);
      return e;
    };
    const finish = async (
      state: State,
      summary: string,
      gate: Gate | null,
      payload: Record<string, unknown> = {},
    ) => {
      const d = this.base(
        "step.finished",
        step_id,
        correlation_id,
        attempt,
        state,
        summary,
        payload,
      );
      d.gate = gate;
      await push(d);
      return {
        step_id,
        correlation_id,
        attempt,
        state,
        source: this.source,
        gate,
        events,
      } satisfies StepOutcome;
    };

    if (def.role !== this.role) await this.switchRole(def.role);
    await push(
      this.base(
        "step.started",
        step_id,
        correlation_id,
        attempt,
        "running",
        `${def.title} starts as ${this.role} (attempt ${attempt})`,
        {
          requirement_ids: def.requirement_ids,
          scenario_id: def.scenario_id,
          operations: def.operations,
        },
      ),
    );

    // Sandbox path honours owner gates before any call goes out.
    if (this.source === "sandbox" && def.gates.length) {
      return finish(
        "blocked",
        `${def.title} is blocked by ${def.gates.map((g) => g.id).join(", ")}`,
        def.gates[0] ?? null,
        { gates: def.gates },
      );
    }

    for (const operation of def.operations) {
      const reqPayload = { operation, input: redact(input).value };
      await push(
        this.base(
          "operation.requested",
          step_id,
          correlation_id,
          attempt,
          "running",
          `${operation} requested`,
          reqPayload,
        ),
      );
      let result: Awaited<ReturnType<Adapter["call"]>>;
      try {
        result = await this.adapter.call({ operation, step_id, run_id: this.runId, input });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await push(
          this.base(
            "operation.responded",
            step_id,
            correlation_id,
            attempt,
            "running",
            `${operation} threw: ${message}`,
            { operation, error: message },
          ),
        );
        return finish("failed", `${def.title} failed at ${operation}: ${message}`, null, {
          operation,
          error: message,
        });
      }
      if (result.outcome === "blocked") {
        const gate = result.gate ?? {
          id: "UNKNOWN",
          reason: "adapter blocked without naming a gate",
        };
        const d = this.base(
          "operation.responded",
          step_id,
          correlation_id,
          attempt,
          "blocked",
          `${operation} blocked by ${gate.id}: ${gate.reason}`,
          { operation },
        );
        d.gate = gate;
        await push(d);
        return finish("blocked", `${def.title} is blocked by ${gate.id}`, gate, {
          operation,
          gate,
        });
      }
      const responded = this.base(
        "operation.responded",
        step_id,
        correlation_id,
        attempt,
        "running",
        `${operation} responded ${result.outcome}${result.provider?.http_status != null ? ` (${result.provider.http_status})` : ""}`,
        { operation, output: result.output },
      );
      responded.provider = result.provider;
      await push(responded);
      for (const row of [...(result.ledger_rows ?? []), ...(result.inbox_rows ?? [])]) {
        const table = result.inbox_rows?.includes(row) ? "webhook_inbox" : "ledger_entries";
        const d = this.base(
          "db.written",
          step_id,
          correlation_id,
          attempt,
          "running",
          `${table} row written for ${operation}`,
          { row },
        );
        d.db = { table, ids: [String(row.ref ?? "")] };
        await push(d);
      }
      if (result.outcome === "error")
        return finish("failed", `${def.title} failed at ${operation}`, null, {
          operation,
          output: result.output,
        });
    }

    const finished = this.base(
      "step.finished",
      step_id,
      correlation_id,
      attempt,
      "passed",
      `${def.title} passed on ${this.source}${def.human_gate ? "; hosted human step recorded as hand-off, not completed" : ""}`,
      { human_gate: def.human_gate },
    );
    // Carry the last provider ref so a sandbox pass proves an observed response.
    const lastProvider = [...events].reverse().find((e) => e.provider)?.provider ?? null;
    finished.provider = lastProvider;
    if (lastProvider) finished.source = this.adapter.kind;
    await push(finished);
    return {
      step_id,
      correlation_id,
      attempt,
      state: "passed",
      source: this.source,
      gate: null,
      events,
    };
  }

  /** Runs every step in walkthrough order and stops at nothing: a blocked step is recorded and the next one runs. */
  async runAll(inputs: Record<string, Record<string, unknown>> = {}): Promise<StepOutcome[]> {
    const out: StepOutcome[] = [];
    for (const d of this.defs) out.push(await this.runStep(d.id, inputs[d.id] ?? {}));
    return out;
  }

  /**
   * Clean slate. Clears this run's LOCAL events, mints a new run id and records
   * what was and was not touched. Provider resources are left in place; the
   * adapter has no destructive member, so this cannot reach them.
   */
  async reset(reason = "operator reset"): Promise<DemoEvent> {
    // Drain in-flight steps so every event of the old run is appended before it is cleared.
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
    const previous = this.runId;
    const previousCount = (await this.log.list(previous)).length;
    await this.log.clearRun(previous);
    this.runId = newId("run");
    this.attempts.clear();
    return this.log.append(
      this.base(
        "run.reset",
        null,
        this.runId,
        0,
        "pending",
        `Local state reset; new run ${this.runId}. Remote resources untouched.`,
        {
          previous_run_id: previous,
          previous_event_count: previousCount,
          reason,
          remote_untouched: true,
          local_only: true,
        },
      ),
    );
  }

  snapshot() {
    return this.log.snapshot(
      this.runId,
      this.defs.map((d) => d.id),
    );
  }
}
