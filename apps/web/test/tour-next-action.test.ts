import { describe, expect, it } from "vitest";
import type { NextActionContext } from "../../../packages/demo-runtime/src/react/tour-overlay";
import { STEPS } from "../../../packages/demo-runtime/src/steps";
import { reduceTour } from "../../../packages/demo-runtime/src/tour";
import { nextAction } from "../src/components/tour/next-action";

const initial = reduceTour([]);
const buyer = initial.steps[0];
const operatorStep = initial.steps.find((s) => s.step.role === "admin");
if (!buyer || !operatorStep) throw new Error("Missing required tour steps");
const operator = { ...operatorStep, status: "active" as const };
const base: Parameters<typeof nextAction>[0] = {
  step: buyer,
  historyReady: true,
  viewing: false,
  done: false,
  busy: false,
  anchorFound: true,
  onThisScreen: true,
  health: { persona: true, operator_session: false },
};

describe("Next decision table", () => {
  it.each([
    ["fills the seller form on the first chapter", {}, "fill"],
    ["clicks other buyer steps", { step: initial.steps[1] }, "act"],
    [
      "revisits without repeating a failed operation",
      { viewing: true, step: { ...buyer, status: "failed" } },
      "navigate",
    ],
    ["finishes only at the end", { step: null, done: true }, "finish"],
    ["waits at startup", { step: null }, "wait"],
    ["waits for an in-flight request", { busy: true }, "wait"],
    ["waits for evidence", { step: { ...buyer, status: "observing" } }, "wait"],
    ["holds a gate", { step: { ...buyer, status: "blocked" } }, "wait"],
    ["offers retry after failure", { step: { ...buyer, status: "failed" } }, "retry"],
    ["navigates to a missing screen", { anchorFound: false, onThisScreen: false }, "navigate"],
    ["does not guess a missing anchor", { anchorFound: false }, "wait"],
    [
      "re-sessions before navigating to admin",
      { step: operator, anchorFound: false, onThisScreen: false },
      "re-session",
    ],
    [
      "re-sessions before retrying an admin rejection",
      { step: { ...operator, status: "failed" } },
      "re-session",
    ],
    ["waits for current health", { step: operator, health: null }, "wait"],
    [
      "keeps legacy account switching without a persona",
      { step: operator, health: { persona: false, operator_session: false } },
      "act",
    ],
    [
      "acts with the operator session",
      { step: operator, health: { persona: true, operator_session: true } },
      "act",
    ],
    ["does not act during sign-in", { signingIn: true }, "wait"],
  ] as const)("%s", (_name, patch, expected) => {
    expect(nextAction({ ...base, ...patch } as Parameters<typeof nextAction>[0])).toBe(expected);
  });
  it.each(["operator", "platform", "admin"])("recognizes %s as an operator step", (role) => {
    const step = { ...operator, step: { ...operator.step, role } } as NextActionContext["step"];
    expect(nextAction({ ...base, step })).toBe("re-session");
  });
  it("covers every actual operator step", () => {
    for (const step of STEPS.slice(7)) {
      expect(nextAction({ ...base, step: { ...operator, step } })).toBe("re-session");
    }
  });
});

it("continues a proven multi-action chapter while observing between requests", () => {
  const step = reduceTour([]).steps[6];
  if (!step) throw new Error("Missing repair step");
  expect(
    nextAction({
      ...base,
      step: {
        ...step,
        status: "observing",
        proof: {
          ...step.proof,
          request: {
            request_id: "r",
            route: "/api/admin/issues/case/actions/refetch",
            http_status: 200,
            duration_ms: 1,
          },
        },
      },
      health: { profiles: true, profile: "operator", persona: true, operator_session: true },
    }),
  ).toBe("act");
});

it("does not navigate stale C01 from onboarding before persisted replay is ready", () => {
  expect(
    nextAction({
      ...base,
      historyReady: false,
      anchorFound: false,
      onThisScreen: false,
    } as Parameters<typeof nextAction>[0]),
  ).toBe("wait");
});
it("does not finish or switch profiles before authenticated history is ready", () => {
  expect(
    nextAction({ ...base, historyReady: false, done: true } as Parameters<typeof nextAction>[0]),
  ).toBe("wait");
});
