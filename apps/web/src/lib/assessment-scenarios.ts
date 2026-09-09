import {
  add,
  canonicalEventType,
  computePlatformFee,
  effectKey,
  err,
  type Money,
  money,
  ok,
  type Result,
  subtract,
  type WhopAccount,
  whopAccountId,
} from "@ledgerly/core";
import { createMockAdapter, decodeEnvelope } from "@ledgerly/whop";

export type AssessmentScenarioId =
  | "onboarding"
  | "direct-refund"
  | "platform-transfer"
  | "webhook-events";
export type AssessmentScenarioDefinition = {
  id: AssessmentScenarioId;
  title: string;
  description: string;
  limitations: readonly string[];
};
const ISOLATION =
  "Fresh in-memory Demo/Mock fixtures on every run. No credentials, network calls, application database writes, or provider evidence.";
export const ASSESSMENT_SCENARIOS: readonly AssessmentScenarioDefinition[] = [
  {
    id: "onboarding",
    title: "Onboarding verification transitions",
    description:
      "Create a fictional account and link, then inspect an illustrative verification timeline and refusals.",
    limitations: [
      ISOLATION,
      "Verification states are illustrative local transitions. No identity document, liveness check, KYC approval, or provider capability change occurs.",
    ],
  },
  {
    id: "direct-refund",
    title: "Direct charge and fee reversal",
    description:
      "Allocate a $25.00 fixture payment, refund it once, and reverse the $2.00 application fee in an isolated book.",
    limitations: [
      ISOLATION,
      "Checkout and refund operations use the existing mock adapter. Payment settlement and the application-fee reversal are an illustrative book using core fee arithmetic, not Whop ledger receipts or the application inbox.",
      "Only a full refund is modeled. Processing fees, partial refunds, chargebacks, and external settlement are excluded.",
    ],
  },
  {
    id: "platform-transfer",
    title: "Platform charge, hold, transfer and top-up",
    description:
      "Hold a $50.00 fixture charge, top up the empty available balance by $10.00, then release the hold and transfer $46.00.",
    limitations: [
      ISOLATION,
      "The settlement hold and payment credit are illustrative fixture mechanics; the mock adapter has no settlement clock. Transfers and top-ups use its actual balance and idempotency rules.",
      "All amounts are USD; the fictional Brazilian seller receives USD. No FX, bank settlement, payout, or real funding occurs.",
    ],
  },
  {
    id: "webhook-events",
    title: "Eight webhook examples and replay",
    description:
      "Decode eight representative event envelopes and compare delivery deduplication with business-effect keys.",
    limitations: [
      ISOLATION,
      "Examples exercise the existing envelope decoder and core effect-key alias rules. Payloads and effect previews are illustrative, not captured Whop deliveries or application inbox processing.",
      "Envelope decoding does not validate every event payload. No signature, HTTP delivery, database transaction, financial posting, or provider acceptance is claimed.",
    ],
  },
];
export type ScenarioState = { balances: Record<string, Money>; states: Record<string, string> };
export type AssessmentScenarioRun = {
  scenarioId: AssessmentScenarioId;
  mode: "mock";
  label: "Demo/Mock";
  isolated: true;
  summary: string;
  limitations: readonly string[];
  steps: {
    id: string;
    title: string;
    input: unknown;
    result: unknown;
    before: ScenarioState;
    after: ScenarioState;
  }[];
  assertions: { id: string; description: string; passed: boolean }[];
  finalState: ScenarioState;
};
type ScenarioError = { kind: "invalid_request"; message: string };
function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Invalid assessment fixture or invariant");
  return result.value;
}
const usd = (amount: number): Money => value(money(amount, "USD"));
const platformId = value(whopAccountId("biz_mock_assessment_platform"));
const sellerId = value(whopAccountId("biz_mock_assessment_seller"));
const now = () => new Date("2026-09-09T00:00:00.000Z");
function mock() {
  const accounts: WhopAccount[] = [
    { id: platformId, country: "US", raw: { id: platformId, title: "Fictional platform" } },
    { id: sellerId, country: "BR", raw: { id: sellerId, title: "Fictional seller" } },
  ];
  return createMockAdapter({ accounts, parentAccountId: platformId, now });
}
function trace(definition: AssessmentScenarioDefinition, snapshot: () => ScenarioState) {
  const run: AssessmentScenarioRun = {
    scenarioId: definition.id,
    mode: "mock",
    label: "Demo/Mock",
    isolated: true,
    summary: definition.description,
    limitations: [...definition.limitations],
    steps: [],
    assertions: [],
    finalState: snapshot(),
  };
  return {
    async step<T>(
      id: string,
      title: string,
      input: unknown,
      action: () => T | Promise<T>,
    ): Promise<T> {
      const before = structuredClone(snapshot());
      const result = await action();
      run.steps.push({
        id,
        title,
        input: structuredClone(input),
        result: structuredClone(result),
        before,
        after: structuredClone(snapshot()),
      });
      return result;
    },
    check(id: string, description: string, passed: boolean) {
      run.assertions.push({ id, description, passed });
    },
    finish() {
      run.finalState = structuredClone(snapshot());
      return run;
    },
  };
}
async function onboarding(definition: AssessmentScenarioDefinition) {
  const adapter = mock();
  type Verification = "not_started" | "pending" | "requires_information" | "verified";
  let verification: Verification = "not_started",
    accountId = "not_created";
  const seen = new Map<string, { next: Verification }>();
  const t = trace(definition, () => ({
    balances: {},
    states: {
      accountId,
      verification,
      capability: verification === "verified" ? "illustrative_active" : "illustrative_blocked",
    },
  }));
  const input = {
    externalId: "assessment-fictional-seller",
    email: "assessment@example.invalid",
    country: "US" as const,
    title: "Fictional assessment seller",
  };
  const created = await t.step("create", "Create a mock connected account", input, async () => {
    const result = await adapter.createOrFetchAccount(input, "account:create");
    if (result.ok) accountId = result.value.id;
    return result;
  });
  const duplicate = await t.step("create-replay", "Replay account creation", input, () =>
    adapter.createOrFetchAccount(input, "account:create"),
  );
  t.check(
    "one-account",
    "Repeated creation resolves to the same mock account",
    created.ok && duplicate.ok && created.value.id === duplicate.value.id,
  );
  const conflict = await t.step(
    "create-conflict",
    "Refuse changed identity on the same key",
    { ...input, email: "different@example.invalid" },
    () =>
      adapter.createOrFetchAccount(
        { ...input, email: "different@example.invalid" },
        "account:create",
      ),
  );
  t.check(
    "identity-conflict",
    "Changed creation input returns idempotency_conflict",
    !conflict.ok && conflict.error.kind === "idempotency_conflict",
  );
  const id = value(whopAccountId(accountId));
  const link = await t.step("link", "Create a mock onboarding link", { accountId: id }, () =>
    adapter.createOnboardingLink(
      {
        accountId: id,
        returnUrl: "https://mock.invalid/return",
        refreshUrl: "https://mock.invalid/refresh",
      },
      "account:link",
    ),
  );
  t.check(
    "mock-link",
    "Onboarding stays on mock.invalid",
    link.ok && new URL(link.value.url).hostname === "mock.invalid",
  );
  async function transition(stepId: string, title: string, key: string, next: Verification) {
    return t.step(stepId, title, { transitionId: key, next }, () => {
      const prior = seen.get(key);
      if (prior)
        return prior.next === next
          ? ok({ duplicate: true, verification })
          : err({ kind: "idempotency_conflict" });
      const allowed: Record<Verification, readonly Verification[]> = {
        not_started: ["pending"],
        pending: ["requires_information", "verified"],
        requires_information: ["pending"],
        verified: [],
      };
      if (!allowed[verification].includes(next)) return err({ kind: "invalid_transition" });
      verification = next;
      seen.set(key, { next });
      return ok({ duplicate: false, verification, illustrative: true });
    });
  }
  const refused = await transition(
    "skip-verification",
    "Reject premature verification",
    "skip",
    "verified",
  );
  t.check(
    "cannot-skip",
    "Verification cannot skip directly to verified",
    !refused.ok && refused.error.kind === "invalid_transition",
  );
  await transition("submit", "Submit verification", "submit", "pending");
  await transition(
    "request-information",
    "Request more information",
    "request-information",
    "requires_information",
  );
  await transition("resubmit", "Resubmit verification", "resubmit", "pending");
  await transition("illustrative-approval", "Approve verification", "approval", "verified");
  const replay = await transition("approval-replay", "Replay the approval", "approval", "verified");
  t.check(
    "verification-replay",
    "Replayed approval does not advance the timeline again",
    replay.ok && replay.value.duplicate,
  );
  const regression = await transition(
    "late-pending",
    "Reject a late pending state",
    "late-pending",
    "pending",
  );
  t.check(
    "no-regression",
    "Late pending cannot regress the illustrative verified state",
    !regression.ok && regression.error.kind === "invalid_transition",
  );
  const read = await t.step(
    "readback",
    "Read the actual mock account separately",
    { accountId: id },
    () => adapter.getAccount(id, "account:read"),
  );
  t.check(
    "no-kyc-write",
    "The timeline never writes verification into the mock account",
    read.ok && !("verification" in (read.value.raw as Record<string, unknown>)),
  );
  return t.finish();
}
async function directRefund(definition: AssessmentScenarioDefinition) {
  const adapter = mock(),
    gross = usd(2500),
    allocation = value(computePlatformFee(gross));
  let seller = usd(0),
    platform = usd(0),
    returned = usd(0),
    order = "unpaid";
  const postedRefunds = new Set<string>();
  const t = trace(definition, () => ({
    balances: { seller, platform, buyerRefund: returned },
    states: { order, book: "illustrative_local_allocation" },
  }));
  const checkoutInput = {
    accountId: sellerId,
    productTitle: "Fictional $25 direct sale",
    price: gross,
    applicationFee: allocation.fee,
    redirectUrl: "https://mock.invalid/receipt",
  };
  const checkout = await t.step(
    "checkout",
    "Create a mock direct checkout with the core 8% fee",
    checkoutInput,
    () => adapter.createCheckoutConfiguration(checkoutInput, "direct:checkout"),
  );
  t.check(
    "checkout-fee",
    "The mock checkout accepts a $2.00 fee on $25.00",
    checkout.ok &&
      allocation.fee.amountMinor === 200 &&
      allocation.sellerShare.amountMinor === 2300,
  );
  const paymentId = await t.step(
    "settle",
    "Allocate a fixture payment in the illustrative book",
    { gross },
    () => {
      const payment = value(adapter.seedPayment(gross, sellerId, "direct:payment"));
      seller = allocation.sellerShare;
      platform = allocation.fee;
      order = "paid";
      return { paymentId: payment.id, source: "mock", illustrative: true, allocation };
    },
  );
  t.check(
    "allocation-conserved",
    "Seller $23.00 plus platform $2.00 equals $25.00",
    value(add(seller, platform)).amountMinor === 2500,
  );
  async function refund(stepId: string, title: string, key: string, amount: Money) {
    return t.step(
      stepId,
      title,
      { paymentId: paymentId.paymentId, amount, idempotencyKey: key },
      async () => {
        const result = await adapter.refundPayment(paymentId.paymentId, key, amount);
        let applied = false;
        if (result.ok && !postedRefunds.has(result.value.id)) {
          // Only the fixed full refund is exposed; the adapter checks the remaining refundable amount.
          seller = value(subtract(seller, allocation.sellerShare));
          platform = value(subtract(platform, allocation.fee));
          returned = value(add(returned, gross));
          order = "refunded";
          postedRefunds.add(result.value.id);
          applied = true;
        }
        return {
          adapterResult: result,
          illustrativeFeeReversal: applied,
          effectKey: result.ok ? effectKey("refund", result.value.id, "created") : null,
        };
      },
    );
  }
  await refund("refund", "Refund the charge and reverse the fee", "direct:refund", gross);
  const afterRefund = structuredClone(t.finish().finalState);
  await refund("refund-replay", "Replay the refund", "direct:refund", gross);
  t.check(
    "refund-replay",
    "Replaying the key does not reverse balances twice",
    JSON.stringify(afterRefund) === JSON.stringify(t.finish().finalState),
  );
  const conflict = await refund(
    "refund-conflict",
    "Reject a changed amount",
    "direct:refund",
    usd(100),
  );
  t.check(
    "refund-key-conflict",
    "Changed refund amount on the same key is refused",
    !conflict.adapterResult.ok && conflict.adapterResult.error.kind === "idempotency_conflict",
  );
  const excess = await refund(
    "second-refund",
    "Reject a second refund",
    "direct:second-refund",
    gross,
  );
  t.check(
    "no-over-refund",
    "A fresh key cannot refund more than the original payment",
    !excess.adapterResult.ok && excess.adapterResult.error.kind === "invalid_request",
  );
  t.check(
    "full-reversal",
    "Refund returns $25.00 and clears share and fee",
    seller.amountMinor === 0 && platform.amountMinor === 0 && returned.amountMinor === 2500,
  );
  const refunds = await t.step(
    "refund-list",
    "Read the mock refund collection",
    { paymentId: paymentId.paymentId },
    () => adapter.listRefunds({ paymentId: paymentId.paymentId }),
  );
  t.check(
    "one-refund-record",
    "Exactly one $25.00 mock refund exists",
    refunds.ok &&
      refunds.value.items.length === 1 &&
      refunds.value.items[0]?.amount?.amountMinor === 2500,
  );
  return t.finish();
}
async function platformTransfer(definition: AssessmentScenarioDefinition) {
  const adapter = mock(),
    gross = usd(5000),
    topup = usd(1000),
    allocation = value(computePlatformFee(gross));
  let held = usd(0),
    settlement = "not_started";
  const t = trace(definition, () => ({
    balances: {
      platformAvailable: adapter.getBalance(platformId, "USD"),
      platformHeld: held,
      sellerAvailable: adapter.getBalance(sellerId, "USD"),
    },
    states: { settlement },
  }));
  const checkoutInput = {
    accountId: platformId,
    productTitle: "Fictional platform sale",
    price: gross,
    applicationFee: null,
    redirectUrl: "https://mock.invalid/receipt",
  };
  const checkout = await t.step("checkout", "Create a mock platform checkout", checkoutInput, () =>
    adapter.createCheckoutConfiguration(checkoutInput, "platform:checkout"),
  );
  t.check("platform-checkout", "Platform checkout accepts no application fee", checkout.ok);
  await t.step(
    "hold",
    "Place a fixture payment in an illustrative settlement hold",
    { gross },
    () => {
      const payment = value(adapter.seedPayment(gross, platformId, "platform:payment"));
      held = gross;
      settlement = "held";
      return { payment, illustrative: true, availableCredit: usd(0) };
    },
  );
  const transferInput = {
    originId: platformId,
    destinationId: sellerId,
    amount: allocation.sellerShare,
    metadata: { scenario: "assessment_mock" },
  };
  const refused = await t.step(
    "held-transfer",
    "Attempt transfer before release",
    transferInput,
    () => adapter.createTransfer(transferInput, "platform:transfer"),
  );
  t.check(
    "hold-refusal",
    "Held money is unavailable for transfer",
    !refused.ok &&
      refused.error.kind === "insufficient_balance" &&
      held.amountMinor === 5000 &&
      adapter.getBalance(sellerId, "USD").amountMinor === 0,
  );
  const topupInput = {
    accountId: platformId,
    amount: topup,
    paymentMethodId: "pm_mock_assessment_only",
  };
  async function topupIfEmpty(key: string) {
    return adapter.getBalance(platformId, "USD").amountMinor === 0
      ? adapter.createTopup(topupInput, key)
      : err({ kind: "topup_not_needed" as const });
  }
  const topped = await t.step(
    "topup",
    "Top up $10.00 only while available balance is zero",
    topupInput,
    () => topupIfEmpty("platform:topup"),
  );
  await t.step("topup-replay", "Replay the mock top-up", topupInput, () =>
    adapter.createTopup(topupInput, "platform:topup"),
  );
  const notNeeded = await t.step(
    "topup-not-needed",
    "Skip new funding when available balance is nonzero",
    topupInput,
    () => topupIfEmpty("platform:another-topup"),
  );
  t.check(
    "conditional-topup",
    "A nonzero available balance refuses another conditional top-up",
    !notNeeded.ok && notNeeded.error.kind === "topup_not_needed",
  );
  t.check(
    "topup-once",
    "Top-up replay and the nonzero-balance check credit only $10.00",
    topped.ok && adapter.getBalance(platformId, "USD").amountMinor === 1000,
  );
  const stillHeld = await t.step(
    "topup-held-transfer",
    "Top-up cannot make the held $50.00 available",
    transferInput,
    () => adapter.createTransfer(transferInput, "platform:transfer"),
  );
  t.check(
    "topup-preserves-hold",
    "$10.00 available is still insufficient for $46.00 while $50.00 remains held",
    !stillHeld.ok &&
      stillHeld.error.kind === "insufficient_balance" &&
      held.amountMinor === 5000 &&
      adapter.getBalance(platformId, "USD").amountMinor === 1000,
  );
  await t.step(
    "release",
    "Release the illustrative hold into mock available balance",
    { held },
    () => {
      value(
        adapter.seedBalance(platformId, value(add(adapter.getBalance(platformId, "USD"), held))),
      );
      held = usd(0);
      settlement = "released";
      return { illustrative: true, released: gross };
    },
  );
  const transferred = await t.step(
    "transfer",
    "Retry the same transfer key after local release",
    transferInput,
    () => adapter.createTransfer(transferInput, "platform:transfer"),
  );
  t.check(
    "transfer-balances",
    "Transfer leaves platform $14.00 and seller $46.00",
    transferred.ok &&
      adapter.getBalance(platformId, "USD").amountMinor === 1400 &&
      adapter.getBalance(sellerId, "USD").amountMinor === 4600,
  );
  const afterTransfer = structuredClone(t.finish().finalState);
  await t.step("transfer-replay", "Replay the successful transfer", transferInput, () =>
    adapter.createTransfer(transferInput, "platform:transfer"),
  );
  t.check(
    "transfer-replay",
    "Replaying transfer changes neither balance",
    JSON.stringify(afterTransfer) === JSON.stringify(t.finish().finalState),
  );
  const conflict = await t.step(
    "transfer-conflict",
    "Refuse changed amount with the same key",
    { ...transferInput, amount: usd(100) },
    () => adapter.createTransfer({ ...transferInput, amount: usd(100) }, "platform:transfer"),
  );
  t.check(
    "transfer-conflict",
    "Changed transfer returns idempotency_conflict",
    !conflict.ok && conflict.error.kind === "idempotency_conflict",
  );
  const denied = await t.step(
    "insufficient-transfer",
    "Refuse transfer above the remaining balance",
    transferInput,
    () => adapter.createTransfer(transferInput, "platform:too-large"),
  );
  t.check(
    "insufficient-after-topup",
    "Refuse $46.00 from a $14.00 available balance",
    !denied.ok && denied.error.kind === "insufficient_balance",
  );
  t.check(
    "funds-conserved",
    "Platform $14.00 plus seller $46.00 equals $50.00 charge plus $10.00 top-up",
    value(add(adapter.getBalance(platformId, "USD"), adapter.getBalance(sellerId, "USD")))
      .amountMinor === 6000 && held.amountMinor === 0,
  );
  return t.finish();
}

type EventExample = {
  type: string;
  data: Record<string, unknown>;
  effect: string;
  key: string | null;
};
async function webhookEvents(definition: AssessmentScenarioDefinition) {
  const deliveries = new Set<string>(),
    previews = new Set<string>();
  const t = trace(definition, () => ({
    balances: {},
    states: {
      decodedDeliveries: String(deliveries.size),
      uniqueEffectPreviews: String(previews.size),
      financialPosting: "none_preview_only",
    },
  }));
  const amount = { amount_minor: "2500", currency: "USD" };
  const examples: EventExample[] = [
    {
      type: "payment.succeeded",
      data: { id: "pay_mock_event", ...amount },
      effect:
        "Allocation preview: seller $23.00, platform $2.00. Actual inbox may resolve the stored order allocation.",
      key: effectKey("payment", "pay_mock_event", "succeeded"),
    },
    {
      type: "payment.failed",
      data: { id: "pay_mock_failed", ...amount },
      effect: "Observation only. Existing inbox does not post a financial effect.",
      key: null,
    },
    {
      type: "refund.created",
      data: { id: "rf_mock_event", payment_id: "pay_mock_event", ...amount },
      effect:
        "Full refund preview reverses the matched order share and fee. Actual inbox defers without the payment and rejects partial refunds.",
      key: effectKey("refund", "rf_mock_event", "created"),
    },
    {
      type: "dispute.created",
      data: { id: "dp_mock_event", payment_id: "pay_mock_event", ...amount },
      effect: "Observation only. Existing inbox does not debit funds for dispute.created.",
      key: null,
    },
    {
      type: "transfer.completed",
      data: { id: "tsf_mock_event", destination_id: sellerId, ...amount },
      effect:
        "Transfer preview: platform debit and seller credit. Actual inbox checks the destination seller.",
      key: effectKey("transfer", "tsf_mock_event", "completed"),
    },
    {
      type: "payout.created",
      data: { id: "wdrl_mock_event", status: "pending", ...amount },
      effect: "Pending status preview has a zero-value observation, no completed-payout debit.",
      key: effectKey("payout", "wdrl_mock_event", "pending"),
    },
    {
      type: "payout.updated",
      data: { id: "wdrl_mock_event", status: "completed", ...amount },
      effect: "Completed payout preview debits seller once per resource and transition.",
      key: effectKey("payout", "wdrl_mock_event", "completed"),
    },
    {
      type: "account.updated",
      data: { id: sellerId, status: "active" },
      effect:
        "Observation only. Existing inbox does not approve verification or post money for account.updated.",
      key: null,
    },
  ];
  async function inspect(example: EventExample, stepId: string, deliveryId: string, title: string) {
    const envelope = {
      id: deliveryId,
      type: example.type,
      api_version: "v1",
      api_version_date: "2026-08-21",
      timestamp: now().toISOString(),
      account_id: sellerId,
      data: example.data,
    };
    return t.step(stepId, title, envelope, () => {
      const decoded = decodeEnvelope(JSON.stringify(envelope));
      if (!decoded.ok) throw new Error("Invalid example envelope");
      const duplicateDelivery = deliveries.has(deliveryId),
        duplicateEffect = example.key !== null && previews.has(example.key);
      deliveries.add(deliveryId);
      if (example.key) previews.add(example.key);
      return {
        decoded: true,
        canonicalType: decoded.value.eventType,
        mockEnvelope: envelope,
        duplicateDelivery,
        duplicateEffectPreview: duplicateEffect,
        effectKeyPreview: example.key,
        effectPreview: example.effect,
        financialEffectApplied: false,
      };
    });
  }
  for (const [index, example] of examples.entries())
    await inspect(
      example,
      `example-${index + 1}`,
      `msg_mock_example_${index + 1}`,
      `Decode ${example.type}`,
    );
  t.check("eight-decode", "All eight illustrative envelopes decode", deliveries.size === 8);
  t.check(
    "five-effect-previews",
    "Five have effect-key previews; three are observation-only",
    previews.size === 5,
  );
  const completed = examples[6];
  if (!completed) throw new Error("Missing payout fixture");
  const duplicate = await inspect(
    completed,
    "delivery-replay",
    "msg_mock_example_7",
    "Replay the same delivery ID",
  );
  t.check(
    "delivery-replay",
    "Same delivery is duplicate at both preview layers",
    duplicate.duplicateDelivery && duplicate.duplicateEffectPreview && deliveries.size === 8,
  );
  const regenerated = await inspect(
    completed,
    "semantic-replay",
    "msg_mock_regenerated",
    "Replay with a new delivery ID",
  );
  t.check(
    "semantic-replay",
    "Regenerated ID is new delivery, same effect preview",
    !regenerated.duplicateDelivery && regenerated.duplicateEffectPreview && previews.size === 5,
  );
  const alias = {
    ...completed,
    type: "withdrawal.updated",
    key: effectKey(
      canonicalEventType("withdrawal.updated").split(".")[0] ?? "",
      "wdrl_mock_event",
      "completed",
    ),
  };
  const aliased = await inspect(
    alias,
    "alias-replay",
    "msg_mock_alias",
    "Decode withdrawal.updated alias",
  );
  t.check(
    "alias-dedupe",
    "Withdrawal and payout completion share a core effect key",
    aliased.canonicalType === "payout.updated" &&
      aliased.duplicateEffectPreview &&
      previews.size === 5,
  );
  const malformed = await t.step(
    "invalid-envelope",
    "Refuse a current-version envelope with only company_id",
    { api_version_date: "2026-08-21", company_id: sellerId },
    () =>
      decodeEnvelope(
        JSON.stringify({
          id: "msg_mock_invalid",
          type: "payout.updated",
          api_version_date: "2026-08-21",
          timestamp: now().toISOString(),
          company_id: sellerId,
          data: completed.data,
        }),
      ),
  );
  t.check(
    "version-refusal",
    "Current-version envelopes require account_id",
    !malformed.ok && malformed.error.kind === "invalid_envelope",
  );
  t.check(
    "no-financial-postings",
    "Envelope examples never alter balances",
    Object.keys(t.finish().finalState.balances).length === 0,
  );
  return t.finish();
}

/** Fixed inputs keep this public mock operation independent of accounts, credentials and application state. */
export async function runAssessmentScenario(
  input: unknown,
): Promise<Result<AssessmentScenarioRun, ScenarioError>> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return err({ kind: "invalid_request", message: "Choose a scenario with mode mock." });
  const body = input as Record<string, unknown>,
    keys = Object.keys(body);
  const definition = ASSESSMENT_SCENARIOS.find((item) => item.id === body.scenarioId);
  if (
    keys.length !== 2 ||
    !keys.includes("scenarioId") ||
    !keys.includes("mode") ||
    body.mode !== "mock" ||
    !definition
  )
    return err({
      kind: "invalid_request",
      message:
        "Only scenarioId and mode mock are accepted. Custom accounts, amounts and provider environments are not supported.",
    });
  const runners = {
    onboarding,
    "direct-refund": directRefund,
    "platform-transfer": platformTransfer,
    "webhook-events": webhookEvents,
  };
  return ok(await runners[definition.id](definition));
}
