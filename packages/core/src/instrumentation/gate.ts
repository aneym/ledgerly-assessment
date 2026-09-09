// Gate ids the guided-tour overlay recognizes on an instrumentation event, per
// docs/lanes/architecture/instrumentation-contract.md and demo-runtime's contract rule 6:
// owner gates use register ids (G01), local gates are CRED (no credential) or WIRE (provider
// client not wired). Only G01 and CRED apply to a whop-adapter Result today.
export type GateId = "G01" | "CRED";
export type Gate = { id: GateId; reason: string };

const GATE_REASONS: Readonly<Record<GateId, string>> = {
  G01: "Whop capability is not active on this account",
  CRED: "No Whop credential is configured",
};

function isGateId(value: unknown): value is GateId {
  return value === "G01" || value === "CRED";
}

// Reads a Gate straight off a whop adapter's failed Result, matching the shape
// packages/whop/src/hybrid-adapter.ts's gateError() produces: { kind: "invalid_request",
// gate: "G01" | "CRED", capability?: string }. The closed WhopError["kind"] union
// (packages/core/src/ports/whop-types.ts) has no dedicated "capability_inactive" or
// "credential_missing" member — widening it would make the hybrid adapter's error type
// incompatible with WhopPort wherever one is expected — so both failure modes reuse the
// existing "invalid_request" kind and carry the gate as a sibling field instead of a new
// kind literal. A gate is therefore only ever recoverable from that field, never from kind
// alone. Takes the whole error as an unknown value (not a typed kind string) so it works
// for any error-shaped object, gated or not; returns null when no gate is present.
export function gateFromError(error: unknown): Gate | null {
  if (typeof error !== "object" || error === null) return null;
  const { gate, capability } = error as { gate?: unknown; capability?: unknown };
  if (!isGateId(gate)) return null;
  const reason = GATE_REASONS[gate];
  return typeof capability === "string"
    ? { id: gate, reason: `${reason} (${capability})` }
    : { id: gate, reason };
}
