import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScenarioStep } from "../../src/app/(storefront)/handoff/scenarios/scenario-explorer";
import { scenarioOutcome } from "../../src/app/(storefront)/handoff/scenarios/scenario-outcome";
import {
  type AssessmentScenarioId,
  runAssessmentScenario,
} from "../../src/lib/assessment-scenarios";

async function run(id: AssessmentScenarioId) {
  const result = await runAssessmentScenario({ scenarioId: id, mode: "mock" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("visible recorded scenario outcomes", () => {
  it("shows premature verification refusal before the JSON disclosure", async () => {
    const step = (await run("onboarding")).steps.find((item) => item.id === "skip-verification");
    if (!step) throw new Error("Missing fixture");
    expect(step.title).toBe("Reject premature verification");
    const visible = renderToStaticMarkup(createElement(ScenarioStep, { step })).split(
      "<details>",
    )[0];
    expect(visible).toContain("Refused");
    expect(visible).not.toContain("invalid_transition");
    expect(visible).toContain("not allowed");
    expect(visible).not.toContain("not_started");
  });
  it("distinguishes the refund, replay and two refusals from their actual results", async () => {
    const steps = (await run("direct-refund")).steps.filter((item) =>
      ["refund", "refund-replay", "refund-conflict", "second-refund"].includes(item.id),
    );
    expect(steps.map((step) => step.title)).toEqual([
      "Refund the charge and reverse the fee",
      "Replay the refund",
      "Reject a changed amount",
      "Reject a second refund",
    ]);
    expect(steps.map((step) => scenarioOutcome(step.result).label)).toEqual([
      "Applied",
      "Replay returned",
      "Refused",
      "Refused",
    ]);
    for (const step of steps) {
      const visible = renderToStaticMarkup(createElement(ScenarioStep, { step })).split(
        "<details>",
      )[0];
      expect(visible).toContain(scenarioOutcome(step.result).label);
      expect(visible).toContain("Buyer refunded");
      expect(visible).not.toContain("buyerRefund");
    }
    expect(scenarioOutcome(steps[2].result).detail).toContain("different input");
    expect(scenarioOutcome(steps[3].result).detail).toContain("rejected the request");
  });
  it("uses readable balance labels for the platform flow", async () => {
    const step = (await run("platform-transfer")).steps.find((item) => item.id === "held-transfer");
    if (!step) throw new Error("Missing fixture");
    const visible = renderToStaticMarkup(createElement(ScenarioStep, { step })).split(
      "<details>",
    )[0];
    for (const label of [
      "Available platform balance",
      "Held platform balance",
      "Seller balance",
      "available balance is too low",
    ])
      expect(visible).toContain(label);
    expect(visible).not.toContain("platformAvailable");
  });
  it("keeps webhook preview details and unknown outcomes honest", async () => {
    const step = (await run("webhook-events")).steps.find((item) => item.id === "semantic-replay");
    if (!step) throw new Error("Missing fixture");
    expect(scenarioOutcome(step.result)).toMatchObject({ label: "Decoded" });
    expect(scenarioOutcome(step.result).detail).toContain("New delivery. Existing effect key.");
    expect(scenarioOutcome(step.result).detail).toContain("No financial effect was applied");
    expect(scenarioOutcome({})).toMatchObject({ label: "Recorded" });
    expect(
      scenarioOutcome({
        adapterResult: { ok: false, error: { kind: "invalid_request" } },
        illustrativeFeeReversal: true,
      }),
    ).toMatchObject({ label: "Refused" });
  });
});
