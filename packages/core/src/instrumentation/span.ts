import type { Emitter } from "./emitter";
import type { Gate } from "./gate";
import { redactSafeIds } from "./redact";
import type {
  InstrumentationEvent,
  InstrumentationProvenance,
  InstrumentationSource,
  SafeIds,
} from "./types";

export type SpanContext = {
  source: InstrumentationSource;
  method?: string;
  path: string;
  correlationId: string;
  runId?: string;
  provenance: InstrumentationProvenance;
};

// What a span's `fn` reports about its own outcome, decoupled from whatever value it
// actually returns to its caller. `gate` is only meaningful on an end frame whose result
// failed on an owner-gated capability or a missing credential (see gate.ts); a caller that
// doesn't set it leaves the event ungated.
export type SpanOutcome = {
  status: InstrumentationEvent["status"];
  safeIds?: SafeIds;
  summary: string;
  gate?: Gate | null;
};

function toEvent(
  context: SpanContext,
  phase: InstrumentationEvent["phase"],
  outcome: {
    status: InstrumentationEvent["status"];
    safeIds: SafeIds;
    summary: string;
    gate?: Gate | null;
  },
  durationMs: number | undefined,
): InstrumentationEvent {
  return {
    correlationId: context.correlationId,
    ...(context.runId === undefined ? {} : { runId: context.runId }),
    source: context.source,
    phase,
    ...(context.method === undefined ? {} : { method: context.method }),
    path: context.path,
    status: outcome.status,
    ...(durationMs === undefined ? {} : { durationMs }),
    provenance: context.provenance,
    safeIds: outcome.safeIds,
    ...(outcome.gate ? { gate: outcome.gate } : {}),
    summary: outcome.summary,
    at: new Date(),
  };
}

// Emits a `start` event, runs `fn`, then emits an `end` event derived from its outcome via
// `describe`. On a thrown error, emits `end` with status "error" and rethrows — the error
// itself is not swallowed or converted into a Result here, only observed.
export async function withSpan<T>(
  emitter: Emitter,
  context: SpanContext,
  fn: () => Promise<T>,
  describe: (value: T) => SpanOutcome,
): Promise<T> {
  const startedAt = Date.now();
  emitter.emit(
    toEvent(
      context,
      "start",
      { status: null, safeIds: {}, summary: `${context.source} started` },
      undefined,
    ),
  );
  try {
    const value = await fn();
    const outcome = describe(value);
    emitter.emit(
      toEvent(
        context,
        "end",
        {
          status: outcome.status,
          safeIds: redactSafeIds(outcome.safeIds ?? {}),
          summary: outcome.summary,
          ...(outcome.gate === undefined ? {} : { gate: outcome.gate }),
        },
        Date.now() - startedAt,
      ),
    );
    return value;
  } catch (cause) {
    emitter.emit(
      toEvent(
        context,
        "end",
        {
          status: "error",
          safeIds: {},
          summary: cause instanceof Error ? cause.message : "unknown error",
        },
        Date.now() - startedAt,
      ),
    );
    throw cause;
  }
}
