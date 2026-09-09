import type { InstrumentationEvent } from "./types";

// The seam every source (app_api, whop, db) emits through. Kept synchronous and
// fire-and-forget at this boundary: instrumentation must never make the caller's real
// request wait on, or fail because of, a telemetry write. An implementation that persists
// events is responsible for catching its own errors.
export interface Emitter {
  emit(event: InstrumentationEvent): void;
}

export const noopEmitter: Emitter = {
  emit() {},
};

// Placeholder correlationId for a db event emitted from a context with no real request to
// correlate to (packages/db/src/repos/unit-of-work.ts, which cannot accept one without
// changing the shared UnitOfWork port signature). apps/web/src/lib/instrument.ts wraps the
// persisting emitter it hands to the unit of work and rewrites this sentinel to the ambient
// request's actual correlation id before the event is stored; outside a request the sentinel
// is what gets stored.
export const uncorrelated = "uncorrelated";
