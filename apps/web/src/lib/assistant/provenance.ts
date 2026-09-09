// There is no per-row real-vs-synthetic flag in the database: a ledger entry, seller, or
// order looks the same whether it came from WHOP_MODE=mock's in-memory adapter or a real
// sandbox call. So every tool tags its output records with a provenance derived from the
// system-wide WHOP_MODE at read time: "mock" whenever the platform is running in (or
// defaulting to) mock mode, "sandbox" for both "sandbox" and "hybrid" modes, since both
// talk to Whop's real sandbox for at least part of their reads. Documented as a judgment
// call in docs/lanes/architecture/operator-assistant-contract.md.
export type RecordProvenance = "mock" | "sandbox";

export function recordProvenance(whopMode: string | undefined): RecordProvenance {
  return whopMode === "sandbox" || whopMode === "hybrid" ? "sandbox" : "mock";
}
