// Storage for the guided-tour instrumentation stream, per
// docs/lanes/architecture/instrumentation-contract.md. Unlike the transactional repos in
// repositories.ts, this is not part of the UnitOfWork flow: instrumentation writes are
// fire-and-forget telemetry, called directly against whichever `db` handle the caller has
// (Neon in production, PGlite in tests), so it is typed generically over both rather than
// going through a SqlSession.
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type {
  Gate,
  InstrumentationEvent,
  InstrumentationPhase,
  InstrumentationSource,
} from "../../../core/src/instrumentation";
import type * as schema from "../schema";
import { instrumentationEvents } from "../schema";

type Database<TQueryResult extends PgQueryResultHKT> = PgDatabase<TQueryResult, typeof schema>;

// `id` and `seq` are assigned by the insert; every other field is exactly what the caller's
// Emitter constructed.
export type PersistedInstrumentationEvent = InstrumentationEvent & { id: string; seq: number };

// `status` is stored as text because it holds either an HTTP status number (app_api, whop)
// or "ok" / "error" (db); null on a start event either way.
function encodeStatus(status: InstrumentationEvent["status"]): string | null {
  return status === null ? null : String(status);
}
function decodeStatus(value: string | null): InstrumentationEvent["status"] {
  if (value === null) return null;
  if (value === "ok" || value === "error") return value;
  const parsed = Number(value);
  if (Number.isNaN(parsed))
    throw new Error(`Persisted instrumentation event has an unrecognized status: ${value}`);
  return parsed;
}
// Architecture's schema.ts had no dedicated `gate jsonb null` column when this was
// written (app-routes-auth was adding one separately), so a gated event's `gate` is
// nested inside the `safe_ids` jsonb blob under the "gate" key on write and split back
// out on read, per the addendum's documented fallback. This keeps the decoded event's own
// `safeIds` holding only string ids, matching its declared type — `gate` never leaks into
// it. If a real `gate` column lands later, insertInstrumentationEvent/decodeRow are the
// only two places that need to change.
function isGate(value: unknown): value is Gate {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; reason?: unknown };
  return (
    (candidate.id === "G01" || candidate.id === "CRED") && typeof candidate.reason === "string"
  );
}
function splitStoredSafeIds(value: unknown): {
  safeIds: InstrumentationEvent["safeIds"];
  gate: Gate | null;
} {
  const raw = (value ?? {}) as Record<string, unknown>;
  const { gate: rawGate, ...rest } = raw;
  return {
    safeIds: rest as InstrumentationEvent["safeIds"],
    gate: isGate(rawGate) ? rawGate : null,
  };
}
// The `safe_ids` column is untyped jsonb, so the on-the-wire shape (safeIds plus an
// optional nested gate) does not need to lie about matching the app-level SafeIds type.
function encodeSafeIds(event: InstrumentationEvent): Record<string, unknown> {
  if (!event.gate) return event.safeIds;
  return { ...event.safeIds, gate: event.gate };
}
function decodeRow(row: typeof instrumentationEvents.$inferSelect): PersistedInstrumentationEvent {
  const { safeIds, gate } = splitStoredSafeIds(row.safeIds);
  return {
    id: row.id,
    seq: row.seq,
    correlationId: row.correlationId,
    ...(row.runId === null ? {} : { runId: row.runId }),
    // The enum columns are narrower than `text` at the database level; the app_api/db/whop
    // and start/end shapes are exactly InstrumentationSource and InstrumentationPhase.
    source: row.source as InstrumentationSource,
    phase: row.phase as InstrumentationPhase,
    ...(row.method === null ? {} : { method: row.method }),
    path: row.path,
    status: decodeStatus(row.status),
    ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
    provenance: row.provenance as InstrumentationEvent["provenance"],
    safeIds,
    ...(gate === null ? {} : { gate }),
    summary: row.summary,
    at: row.at,
  };
}

export async function insertInstrumentationEvent<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
  event: InstrumentationEvent,
): Promise<PersistedInstrumentationEvent> {
  const rows = await db
    .insert(instrumentationEvents)
    .values({
      id: randomUUID(),
      correlationId: event.correlationId,
      runId: event.runId ?? null,
      source: event.source,
      phase: event.phase,
      method: event.method ?? null,
      path: event.path,
      status: encodeStatus(event.status),
      durationMs: event.durationMs ?? null,
      provenance: event.provenance,
      safeIds: encodeSafeIds(event),
      summary: event.summary,
      at: event.at,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Expected the inserted instrumentation event row back");
  return decodeRow(row);
}

export type ListInstrumentationEventsQuery = { afterSeq?: number } & (
  | { correlationId: string; runId?: undefined }
  | { runId: string; correlationId?: undefined }
);

// Ordered by seq so a caller (the SSE route) can resume from the last seq it saw via
// `afterSeq` and never miss or repeat an event.
export async function listInstrumentationEvents<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
  query: ListInstrumentationEventsQuery,
): Promise<PersistedInstrumentationEvent[]> {
  const scope =
    query.correlationId !== undefined
      ? eq(instrumentationEvents.correlationId, query.correlationId)
      : eq(instrumentationEvents.runId, query.runId);
  const condition =
    query.afterSeq === undefined
      ? scope
      : and(scope, gt(instrumentationEvents.seq, query.afterSeq));
  const rows = await db
    .select()
    .from(instrumentationEvents)
    .where(condition)
    .orderBy(asc(instrumentationEvents.seq));
  return rows.map(decodeRow);
}
