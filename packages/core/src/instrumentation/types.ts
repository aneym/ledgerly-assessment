import type { Gate } from "./gate";

// Shared shape for the guided-tour instrumentation event, per
// docs/lanes/architecture/instrumentation-contract.md. `id` and `seq` are assigned by the
// storage layer on insert and are not part of what an emitter constructs.
export type InstrumentationSource = "app_api" | "db" | "whop";
export type InstrumentationPhase = "start" | "end";
// "sandbox" | "mock" come from the whop adapter, "neon" | "pglite" from the db adapter,
// "app" from the app_api wrapper. Never set by the calling code.
export type InstrumentationProvenance = "sandbox" | "mock" | "neon" | "pglite" | "app";
// Non-secret identifiers touched by the operation (seller id, whop account id, payment id,
// order id, delivery id, effect key). Never a request or response body, header, email, or token.
export type SafeIds = Record<string, string>;

export type InstrumentationEvent = {
  correlationId: string;
  runId?: string;
  source: InstrumentationSource;
  phase: InstrumentationPhase;
  method?: string;
  path: string;
  // HTTP status for app_api and whop; "ok" or "error" for db; null on start.
  status: number | "ok" | "error" | null;
  durationMs?: number;
  provenance: InstrumentationProvenance;
  safeIds: SafeIds;
  summary: string;
  at: Date;
  // Set only on a whop end frame whose adapter Result failed with an owner-gated
  // capability (G01) or a missing credential (CRED) — see gate.ts's gateForErrorKind.
  // Omitted (not present) on every other event; never set to null by an emitter, though
  // the type allows it for a caller that wants to say "checked, not gated" explicitly.
  gate?: Gate | null;
};
