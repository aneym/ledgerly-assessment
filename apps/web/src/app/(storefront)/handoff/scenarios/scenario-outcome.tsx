function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const reasons: Record<string, string> = {
  invalid_transition: "The requested verification transition is not allowed.",
  idempotency_conflict: "This idempotency key was already used with different input.",
  invalid_request: "The mock adapter rejected the request.",
  insufficient_balance: "The available balance is too low for this transfer.",
  topup_not_needed: "The available balance is nonzero, so another top-up is refused.",
  invalid_envelope: "The envelope does not match the selected API version.",
};

// Read the recorded decision only. A step title or unchanged balance cannot prove success.
export function scenarioOutcome(result: unknown): { label: string; detail: string } {
  const outer = record(result);
  if (!outer) return { label: "Recorded", detail: "No structured outcome was returned." };
  const decision = record(outer.adapterResult) ?? outer;
  if (decision.ok === false) {
    const error = record(decision.error);
    const kind = typeof error?.kind === "string" ? error.kind : "unknown_reason";
    return {
      label: "Refused",
      detail:
        reasons[kind] ?? "The operation was refused. Inspect the result for its recorded reason.",
    };
  }
  if (decision.ok === true) {
    if (outer.illustrativeFeeReversal === false)
      return {
        label: "Replay returned",
        detail: "The existing refund was returned. No additional fee reversal was applied.",
      };
    if (outer.illustrativeFeeReversal === true)
      return {
        label: "Applied",
        detail: "The mock refund succeeded and the illustrative fee reversal was applied.",
      };
    const value = record(decision.value);
    if (value?.duplicate === true)
      return {
        label: "Duplicate",
        detail: "The model recognized this transition as already applied.",
      };
    if (typeof value?.verification === "string")
      return {
        label: "Applied",
        detail: `The model returned verification state: ${value.verification}.`,
      };
    return { label: "Accepted", detail: "The mock operation returned a successful result." };
  }
  if (outer.decoded === true) {
    const replay = outer.duplicateDelivery === true ? "Duplicate delivery." : "New delivery.";
    const effect =
      outer.duplicateEffectPreview === true
        ? "Existing effect key."
        : outer.effectKeyPreview === null
          ? "Observation only."
          : "New effect key preview.";
    return {
      label: "Decoded",
      detail: `${replay} ${effect} ${typeof outer.effectPreview === "string" ? outer.effectPreview : ""} No financial effect was applied.`,
    };
  }
  if (outer.illustrative === true)
    return {
      label: "Fixture applied",
      detail: "The local model returned an illustrative fixture result.",
    };
  return {
    label: "Recorded",
    detail: "Inspect the returned result for details; no success decision was supplied.",
  };
}

export function ScenarioOutcome({ result }: { result: unknown }) {
  const outcome = scenarioOutcome(result);
  return (
    <div className="asc-outcome" data-outcome={outcome.label}>
      <strong>{outcome.label}</strong>
      <p>{outcome.detail}</p>
    </div>
  );
}
