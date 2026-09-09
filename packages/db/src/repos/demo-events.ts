// Durable store for the guided tour's own events (step finished, reset, role switch,
// blocked), per packages/demo-runtime/contract/tour-journey.md section 7. The table lands
// in migration 0002 from architecture with exactly these columns; until then
// DEMO_EVENTS_DDL creates it in tests. Append-only: clearRun deletes one run's rows only.
import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { DemoEvent } from "../../../demo-runtime/src/contract";
import type { EventStore } from "../../../demo-runtime/src/log";

export const demoEvents = pgTable(
  "demo_events",
  {
    eventId: text("event_id").primaryKey(),
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    correlationId: text("correlation_id").notNull(),
    kind: text("kind").notNull(),
    stepId: text("step_id"),
    at: timestamp("at", { withTimezone: true }).notNull(),
    event: jsonb("event").notNull(),
  },
  (table) => [
    uniqueIndex("demo_events_run_seq_idx").on(table.runId, table.seq),
    index("demo_events_correlation_id_idx").on(table.correlationId),
  ],
);

// The same shape as SQL, for tests that run before migration 0002 exists.
export const DEMO_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS "demo_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "seq" integer NOT NULL,
  "correlation_id" text NOT NULL,
  "kind" text NOT NULL,
  "step_id" text,
  "at" timestamp with time zone NOT NULL,
  "event" jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "demo_events_run_seq_idx" ON "demo_events" ("run_id","seq");
CREATE INDEX IF NOT EXISTS "demo_events_correlation_id_idx" ON "demo_events" ("correlation_id");
`;

type Database<TQueryResult extends PgQueryResultHKT> = PgDatabase<
  TQueryResult,
  Record<string, unknown>
>;

/** EventStore over Postgres. Works against Neon in production and PGlite in tests. */
export function createDemoEventStore<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
): EventStore {
  return {
    async append(event: DemoEvent) {
      await db.insert(demoEvents).values({
        eventId: event.event_id,
        runId: event.run_id,
        seq: event.seq,
        correlationId: event.correlation_id,
        kind: event.kind,
        stepId: event.step_id,
        at: new Date(event.at),
        event,
      });
    },
    async list(run_id: string) {
      const rows = await db
        .select({ event: demoEvents.event })
        .from(demoEvents)
        .where(eq(demoEvents.runId, run_id))
        .orderBy(asc(demoEvents.seq));
      return rows.map((r) => r.event as DemoEvent);
    },
    async has(event_id: string) {
      const rows = await db
        .select({ eventId: demoEvents.eventId })
        .from(demoEvents)
        .where(eq(demoEvents.eventId, event_id))
        .limit(1);
      return rows.length > 0;
    },
    async lastSeq(run_id: string) {
      const rows = await db
        .select({ last: max(demoEvents.seq) })
        .from(demoEvents)
        .where(eq(demoEvents.runId, run_id));
      return rows[0]?.last ?? 0;
    },
    async clearRun(run_id: string) {
      await db.delete(demoEvents).where(eq(demoEvents.runId, run_id));
    },
  };
}

/** Events of one run after a seq, for the snapshot route and the evidence export. */
export async function listDemoEventsAfter<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
  run_id: string,
  afterSeq: number,
): Promise<DemoEvent[]> {
  const rows = await db
    .select({ event: demoEvents.event })
    .from(demoEvents)
    .where(and(eq(demoEvents.runId, run_id), gt(demoEvents.seq, afterSeq)))
    .orderBy(asc(demoEvents.seq));
  return rows.map((r) => r.event as DemoEvent);
}

/** Creates the table when the migration has not run yet (tests, local PGlite). */
export async function ensureDemoEventsTable<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
): Promise<void> {
  for (const statement of DEMO_EVENTS_DDL.split(";"))
    if (statement.trim()) await db.execute(sql.raw(statement));
}
