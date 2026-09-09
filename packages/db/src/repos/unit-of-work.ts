import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@neondatabase/serverless";
import { type Emitter, noopEmitter, uncorrelated } from "../../../core/src/instrumentation";
import type { UnitOfWork } from "../../../core/src/services/ports";
import { createRepositories } from "./repositories";

// A db instrumentation event for one finished transaction. There is no transaction name to
// carry as `path` without changing UnitOfWork's signature (out of scope here), so every
// commit or rollback reports as "run". `correlationId` is a placeholder: the app layer
// (apps/web/src/lib/instrument.ts) wraps this emitter to stamp the ambient request's real
// correlation id before the event is persisted; outside a request (a bare script, a test
// with no wrapping emitter) it stays as this placeholder.
function dbEvent(provenance: "neon" | "pglite", status: "ok" | "error", durationMs: number) {
  return {
    correlationId: uncorrelated,
    source: "db" as const,
    phase: "end" as const,
    path: "run",
    status,
    durationMs,
    provenance,
    safeIds: {},
    summary: status === "ok" ? "db transaction committed" : "db transaction rolled back",
    at: new Date(),
  };
}
// PGlite has one database session. Share its onboarding queue across repository instances.
const queues = new WeakMap<PGlite, Map<string, Promise<void>>>();
export function createPgliteUnitOfWork(client: PGlite, emitter: Emitter = noopEmitter): UnitOfWork {
  let locks = queues.get(client);
  if (!locks) {
    locks = new Map();
    queues.set(client, locks);
  }
  const queue = locks;
  const run: UnitOfWork["run"] = async (fn) => {
    const startedAt = Date.now();
    try {
      const result = await client.transaction((tx) => fn(createRepositories(tx)));
      emitter.emit(dbEvent("pglite", "ok", Date.now() - startedAt));
      return result;
    } catch (error) {
      emitter.emit(dbEvent("pglite", "error", Date.now() - startedAt));
      throw error;
    }
  };
  return {
    run,
    async exclusive(key, fn) {
      const previous = queue.get(key) ?? Promise.resolve();
      let release = () => {};
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      queue.set(key, current);
      await previous;
      try {
        return await fn({ run });
      } finally {
        release();
        if (queue.get(key) === current) queue.delete(key);
      }
    },
  };
}
function scoped(connection: Client, emitter: Emitter): Pick<UnitOfWork, "run"> {
  return {
    async run(fn) {
      const startedAt = Date.now();
      await connection.query("BEGIN");
      try {
        const result = await fn(
          createRepositories({
            async query<T>(sql: string, params?: unknown[]) {
              const result = await connection.query(sql, params);
              return { rows: result.rows as T[] };
            },
          }),
        );
        await connection.query("COMMIT");
        emitter.emit(dbEvent("neon", "ok", Date.now() - startedAt));
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        emitter.emit(dbEvent("neon", "error", Date.now() - startedAt));
        throw error;
      }
    },
  };
}
// A session lock spans the durable operation commit and the provider call.
// Transaction locks alone leave a race between those two steps.
export function createNeonUnitOfWork(
  url: string,
  emitter: Emitter = noopEmitter,
): UnitOfWork & { close(): Promise<void> } {
  const parsed = new URL(url);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !(parsed.hostname === "neon.tech" || parsed.hostname.endsWith(".neon.tech"))
  )
    throw new Error("Transactional services require a Neon Postgres URL");
  if (parsed.hostname.includes("-pooler."))
    throw new Error(
      "Onboarding session locks require a direct Neon URL, not the transaction pooler",
    );
  // One WebSocket connection per unit of work, opened on demand and closed in finally. A
  // Pool held idle connections open across serverless invocations (the function freezes
  // after the response, so the pool's idle timer never fires), and on 2026-09-08 every
  // function instance's idle pool added up to 101 of the compute's 112 connection slots,
  // at which point Postgres answered "remaining connection slots are reserved". The
  // per-call connect costs one round trip and leaves nothing behind.
  async function connect(): Promise<Client> {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
    await client.connect();
    return client;
  }
  return {
    async run(fn) {
      const connection = await connect();
      try {
        return await scoped(connection, emitter).run(fn);
      } finally {
        await connection.end().catch(() => {});
      }
    },
    async exclusive(key, fn) {
      const connection = await connect();
      try {
        await connection.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
        return await fn(scoped(connection, emitter));
      } finally {
        // Ending the session releases the advisory lock; an explicit unlock is not needed
        // and would only matter if the connection were reused.
        await connection.end().catch(() => {});
      }
    },
    close: async () => {},
  };
}
