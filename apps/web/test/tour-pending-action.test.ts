import { describe, expect, it } from "vitest";
import { reduceTour } from "../../../packages/demo-runtime/src/tour";
import { sampleEvent } from "../../../packages/demo-runtime/test/helpers";
import { hasPendingTourProof, type PendingTourAction } from "../src/components/tour/pending-action";

const pending: PendingTourAction = {
  run: "run_a1",
  step: "C01",
  anchor: "sell.start.submit",
  correlation: "create",
  afterSeq: 1,
};
const response = sampleEvent({
  seq: 2,
  correlation_id: "create",
  kind: "request.finished",
  request: {
    request_id: "create",
    method: "POST",
    route: "/api/sellers",
    http_status: 201,
    duration_ms: 1,
  },
});

describe("pending action proof across navigation", () => {
  it("does not release when HTTP ended but persisted chapter proof is incomplete", () => {
    expect(hasPendingTourProof(pending, [], reduceTour([]))).toBe(false);
    expect(hasPendingTourProof(pending, [response], reduceTour([response]))).toBe(false);
  });
  it("requires this attempt's persisted response before releasing on completion", () => {
    const state = reduceTour([]);
    const step = state.steps[0];
    if (!step) throw new Error("missing step");
    step.status = "passed";
    for (const event of [
      sampleEvent({ ...response, correlation_id: "foreign" }),
      sampleEvent({ ...response, run_id: "run_foreign" }),
      sampleEvent({ ...response, seq: 1 }),
    ])
      expect(hasPendingTourProof(pending, [event], state)).toBe(false);
    expect(hasPendingTourProof(pending, [response], state)).toBe(true);
  });
  it("releases a persisted failure for Retry without advancing", () => {
    if (!response.request) throw new Error("missing request");
    const failed = sampleEvent({ ...response, request: { ...response.request, http_status: 409 } });
    const state = reduceTour([failed]);
    expect(state.steps[0]?.status).toBe("failed");
    expect(hasPendingTourProof(pending, [failed], state)).toBe(true);
  });
  it("releases a multi-action chapter when proof changes its next control", () => {
    const state = reduceTour([]);
    const step = state.steps[1];
    if (!step) throw new Error("missing step");
    step.step = { ...step.step, anchor: "sell.product.demo" };
    expect(
      hasPendingTourProof(
        { ...pending, step: "C02", anchor: "sell.onboarding.link" },
        [sampleEvent({ ...response, step_id: "C02" })],
        state,
      ),
    ).toBe(true);
  });
});

it("offers unknown-outcome retry only for idempotent seller identity after history replay", async () => {
  const { canRetryUnknownAction } = await import("../src/components/tour/pending-action");
  expect(canRetryUnknownAction({ ...pending, networkUnknown: true }, false)).toBe(false);
  expect(canRetryUnknownAction({ ...pending, networkUnknown: true }, true)).toBe(true);
  expect(canRetryUnknownAction({ ...pending, step: "C03", networkUnknown: true }, true)).toBe(
    false,
  );
  expect(canRetryUnknownAction({ ...pending, step: "C07", networkUnknown: true }, true)).toBe(
    false,
  );
});
