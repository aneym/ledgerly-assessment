import { getStep } from "../src/steps";
import { CONTRACT_VERSION, type DemoEvent } from "../src/contract";

export function fixedClock(start = "2026-09-08T18:00:00.000Z") {
  let t = new Date(start).getTime();
  return () => {
    t += 1000;
    return new Date(t);
  };
}

export function sampleEvent(over: Partial<DemoEvent> = {}): DemoEvent {
  return {
    contract_version: CONTRACT_VERSION,
    event_id: "evt_a1",
    seq: 1,
    run_id: "run_a1",
    correlation_id: "step_a1",
    kind: "step.started",
    step_id: "C01",
    attempt: 1,
    at: "2026-09-08T18:00:00.000Z",
    role: "admin",
    source: "local",
    environment: "local",
    state: "running",
    summary: "Platform key starts",
    payload: {},
    request: null,
    db: null,
    provider: null,
    gate: null,
    evidence_id: null,
    ...over,
  };
}

/** Exercise owner-gate behavior without making the payout token step block the story. */
export async function withOwnerGate<T>(stepId: string, run: () => Promise<T>): Promise<T> {
  const step = getStep(stepId);
  const previous = step.gates;
  step.gates = [{ id: "G01", reason: "test-only owner gate" }];
  try {
    return await run();
  } finally {
    step.gates = previous;
  }
}
