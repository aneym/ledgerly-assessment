import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSESSMENT_SCENARIOS,
  type AssessmentScenarioId,
  type AssessmentScenarioRun,
  runAssessmentScenario,
} from "../../src/lib/assessment-scenarios";

async function run(scenarioId: AssessmentScenarioId) {
  const result = await runAssessmentScenario({ scenarioId, mode: "mock" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function step(result: AssessmentScenarioRun, id: string) {
  const selected = result.steps.find((item) => item.id === id);
  if (!selected) throw new Error(`Missing step ${id}`);
  return selected;
}
const USD = (amountMinor: number) => ({ amountMinor, currency: "USD" });
afterEach(() => vi.unstubAllGlobals());

describe("isolated assessment scenarios", () => {
  it("refuses custom targets, amounts, unknown scenarios and non-mock modes", async () => {
    for (const input of [
      null,
      [],
      "onboarding",
      {},
      { scenarioId: "onboarding", mode: "sandbox" },
      { scenarioId: "onboarding", mode: "live" },
      { scenarioId: "onboarding", mode: "mock", accountId: "biz_real" },
      { scenarioId: "direct-refund", mode: "mock", amount: 100 },
      { scenarioId: "onboarding", mode: "mock", token: "arbitrary-input" },
      { scenarioId: "__proto__", mode: "mock" },
      { scenarioId: "unknown", mode: "mock" },
      { scenarioId: "onboarding" },
    ]) {
      expect(await runAssessmentScenario(input)).toMatchObject({
        ok: false,
        error: { kind: "invalid_request" },
      });
    }
  });

  it("executes all four without network and labels every returned trace as isolated mock", async () => {
    const fetch = vi.fn(() => {
      throw new Error("Network forbidden in assessment scenarios");
    });
    vi.stubGlobal("fetch", fetch);
    expect(ASSESSMENT_SCENARIOS.map((item) => item.id)).toEqual([
      "onboarding",
      "direct-refund",
      "platform-transfer",
      "webhook-events",
    ]);
    for (const definition of ASSESSMENT_SCENARIOS) {
      const result = await run(definition.id);
      expect(result).toMatchObject({
        scenarioId: definition.id,
        mode: "mock",
        label: "Demo/Mock",
        isolated: true,
      });
      expect(result.assertions.length).toBeGreaterThanOrEqual(7);
      expect(result.assertions.filter((item) => !item.passed)).toEqual([]);
      expect(result.limitations.join(" ")).toContain(
        "No credentials, network calls, application database writes, or provider evidence",
      );
      expect(new Set(result.steps.map((item) => item.id)).size).toBe(result.steps.length);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("starts fresh for repeated and concurrent invocations", async () => {
    for (const definition of ASSESSMENT_SCENARIOS) {
      const first = await run(definition.id);
      const [second, concurrent] = await Promise.all([run(definition.id), run(definition.id)]);
      expect(second).toEqual(first);
      expect(concurrent).toEqual(first);
      second.finalState.states.injected = "caller mutation";
      expect((await run(definition.id)).finalState.states).not.toHaveProperty("injected");
    }
  });

  it("keeps onboarding verification illustrative and separates the unchanged mock account readback", async () => {
    const result = await run("onboarding");
    expect(step(result, "create").before.states.accountId).toBe("not_created");
    expect(step(result, "create").after.states.accountId).toBe("biz_mock_1");
    expect(step(result, "create-replay").before).toEqual(step(result, "create-replay").after);
    expect(step(result, "create-conflict").result).toEqual({
      ok: false,
      error: { kind: "idempotency_conflict" },
    });
    expect(step(result, "skip-verification").result).toEqual({
      ok: false,
      error: { kind: "invalid_transition" },
    });
    expect(step(result, "skip-verification").after.states.verification).toBe("not_started");
    expect(step(result, "submit").after.states.verification).toBe("pending");
    expect(step(result, "request-information").after.states.verification).toBe(
      "requires_information",
    );
    expect(step(result, "resubmit").after.states.verification).toBe("pending");
    expect(step(result, "illustrative-approval").after.states).toMatchObject({
      verification: "verified",
      capability: "illustrative_active",
    });
    expect(step(result, "approval-replay").result).toMatchObject({
      ok: true,
      value: { duplicate: true },
    });
    expect(step(result, "late-pending").result).toEqual({
      ok: false,
      error: { kind: "invalid_transition" },
    });
    expect(step(result, "readback").result).toMatchObject({
      ok: true,
      value: { id: "biz_mock_1", raw: { status: "active" } },
    });
    expect(JSON.stringify(step(result, "readback").result)).not.toContain("verification");
    expect(result.finalState.balances).toEqual({});
    expect(result.limitations.join(" ")).toContain(
      "No identity document, liveness check, KYC approval",
    );
  });

  it("allocates $25 to $23 seller and $2 platform, then reverses both on one full mock refund", async () => {
    const result = await run("direct-refund");
    expect(step(result, "checkout").input).toMatchObject({
      price: USD(2500),
      applicationFee: USD(200),
    });
    expect(step(result, "settle").before.balances).toEqual({
      seller: USD(0),
      platform: USD(0),
      buyerRefund: USD(0),
    });
    expect(step(result, "settle").after.balances).toEqual({
      seller: USD(2300),
      platform: USD(200),
      buyerRefund: USD(0),
    });
    expect(step(result, "refund").result).toMatchObject({
      adapterResult: { ok: true },
      illustrativeFeeReversal: true,
    });
    expect(step(result, "refund").after).toEqual({
      balances: { seller: USD(0), platform: USD(0), buyerRefund: USD(2500) },
      states: { order: "refunded", book: "illustrative_local_allocation" },
    });
    expect(step(result, "refund-replay").result).toMatchObject({
      adapterResult: { ok: true },
      illustrativeFeeReversal: false,
    });
    expect(step(result, "refund-replay").before).toEqual(step(result, "refund-replay").after);
    expect(step(result, "refund-conflict").result).toMatchObject({
      adapterResult: { ok: false, error: { kind: "idempotency_conflict" } },
      illustrativeFeeReversal: false,
    });
    expect(step(result, "second-refund").result).toMatchObject({
      adapterResult: { ok: false, error: { kind: "invalid_request" } },
      illustrativeFeeReversal: false,
    });
    expect(step(result, "second-refund").before).toEqual(step(result, "second-refund").after);
    expect(step(result, "refund-list").result).toMatchObject({
      ok: true,
      value: { items: [{ amount: USD(2500) }], nextCursor: null },
    });
    expect(result.limitations.join(" ")).toContain(
      "not Whop ledger receipts or the application inbox",
    );
  });

  it("keeps held funds unavailable, then transfers once and credits one mock top-up", async () => {
    const result = await run("platform-transfer");
    expect(step(result, "hold").after.balances).toEqual({
      platformAvailable: USD(0),
      platformHeld: USD(5000),
      sellerAvailable: USD(0),
    });
    expect(step(result, "held-transfer").result).toEqual({
      ok: false,
      error: { kind: "insufficient_balance" },
    });
    expect(step(result, "held-transfer").before).toEqual(step(result, "held-transfer").after);
    expect(step(result, "topup").before.balances).toEqual({
      platformAvailable: USD(0),
      platformHeld: USD(5000),
      sellerAvailable: USD(0),
    });
    expect(step(result, "topup").after.balances).toEqual({
      platformAvailable: USD(1000),
      platformHeld: USD(5000),
      sellerAvailable: USD(0),
    });
    expect(step(result, "topup-not-needed").result).toEqual({
      ok: false,
      error: { kind: "topup_not_needed" },
    });
    expect(step(result, "topup-not-needed").before).toEqual(step(result, "topup-not-needed").after);
    expect(step(result, "topup-held-transfer").result).toEqual({
      ok: false,
      error: { kind: "insufficient_balance" },
    });
    expect(step(result, "topup-held-transfer").before).toEqual(
      step(result, "topup-held-transfer").after,
    );
    expect(step(result, "release").after.balances).toEqual({
      platformAvailable: USD(6000),
      platformHeld: USD(0),
      sellerAvailable: USD(0),
    });
    expect(step(result, "transfer").after.balances).toEqual({
      platformAvailable: USD(1400),
      platformHeld: USD(0),
      sellerAvailable: USD(4600),
    });
    expect(step(result, "transfer-replay").result).toEqual(step(result, "transfer").result);
    expect(step(result, "transfer-replay").before).toEqual(step(result, "transfer-replay").after);
    expect(step(result, "transfer-conflict").result).toEqual({
      ok: false,
      error: { kind: "idempotency_conflict" },
    });
    expect(step(result, "topup-replay").result).toEqual(step(result, "topup").result);
    expect(step(result, "topup-replay").before).toEqual(step(result, "topup-replay").after);
    expect(step(result, "insufficient-transfer").result).toEqual({
      ok: false,
      error: { kind: "insufficient_balance" },
    });
    expect(result.finalState).toEqual({
      balances: { platformAvailable: USD(1400), platformHeld: USD(0), sellerAvailable: USD(4600) },
      states: { settlement: "released" },
    });
  });

  it("decodes the eight required envelope examples without claiming postings", async () => {
    const result = await run("webhook-events");
    const examples = result.steps.filter((item) => item.id.startsWith("example-"));
    expect(examples.map((item) => (item.input as { type: string }).type)).toEqual([
      "payment.succeeded",
      "payment.failed",
      "refund.created",
      "dispute.created",
      "transfer.completed",
      "payout.created",
      "payout.updated",
      "account.updated",
    ]);
    for (const example of examples)
      expect(example.result).toMatchObject({ decoded: true, financialEffectApplied: false });
    for (const id of ["example-2", "example-4", "example-8"])
      expect(step(result, id).result).toMatchObject({ effectKeyPreview: null });
    expect(step(result, "example-6").result).toMatchObject({
      effectKeyPreview: "payout:wdrl_mock_event:pending",
    });
    expect(step(result, "example-7").result).toMatchObject({
      effectKeyPreview: "payout:wdrl_mock_event:completed",
    });
    expect(step(result, "delivery-replay").result).toMatchObject({
      duplicateDelivery: true,
      duplicateEffectPreview: true,
    });
    expect(step(result, "semantic-replay").result).toMatchObject({
      duplicateDelivery: false,
      duplicateEffectPreview: true,
    });
    expect(step(result, "alias-replay").result).toMatchObject({
      canonicalType: "payout.updated",
      duplicateDelivery: false,
      duplicateEffectPreview: true,
      effectKeyPreview: "payout:wdrl_mock_event:completed",
    });
    expect(step(result, "invalid-envelope").result).toMatchObject({
      ok: false,
      error: { kind: "invalid_envelope" },
    });
    expect(result.finalState).toEqual({
      balances: {},
      states: {
        decodedDeliveries: "10",
        uniqueEffectPreviews: "5",
        financialPosting: "none_preview_only",
      },
    });
    expect(result.limitations.join(" ")).toContain(
      "No signature, HTTP delivery, database transaction, financial posting",
    );
  });
});
