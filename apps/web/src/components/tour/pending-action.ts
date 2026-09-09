import type { DemoEvent } from "../../../../../packages/demo-runtime/src/contract";
import type { TourState } from "../../../../../packages/demo-runtime/src/tour";

export type PendingTourAction = {
  run: string;
  step: string;
  anchor: string;
  correlation: string;
  afterSeq: number;
  networkUnknown?: boolean;
};

/** A URL change or a client HTTP response alone cannot release a chapter action. */
export function hasPendingTourProof(
  pending: PendingTourAction,
  events: DemoEvent[],
  state: TourState,
): boolean {
  const step = state.steps.find((item) => item.step.id === pending.step);
  if (!step) return false;
  const response = events.some(
    (event) =>
      event.run_id === pending.run &&
      event.step_id === pending.step &&
      event.correlation_id === pending.correlation &&
      event.seq > pending.afterSeq &&
      event.kind === "request.finished" &&
      event.request?.http_status !== null,
  );
  if (!response) return false;
  return (
    ["passed", "failed", "blocked"].includes(step.status) || step.step.anchor !== pending.anchor
  );
}

/** Only seller setup has a durable create-or-fetch identity stable across this UI retry. */
export function canRetryUnknownAction(pending: PendingTourAction, replayReady: boolean): boolean {
  return replayReady && pending.networkUnknown === true && pending.step === "C01";
}
