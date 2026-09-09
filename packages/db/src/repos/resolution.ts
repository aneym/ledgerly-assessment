// Postgres-backed repos and unit-of-work for the admin issue resolution service
// (packages/core/src/services/resolution.ts). Follows the same raw-SQL-over-SqlSession
// style as packages/db/src/repos/repositories.ts (ON CONFLICT ... DO NOTHING RETURNING,
// falling back to a plain SELECT on the loser side of a race) rather than the Drizzle
// query-builder style used by packages/db/src/repos/orders.ts. Both patterns coexist in
// this codebase; raw SQL was chosen here so the new tables' repos can run inside the exact
// same transaction as createRepositories(sql)'s ledger/effects/sellers repos, which is
// exactly what import_confirmed_payment needs for atomicity. Surfaced to the team as an
// open question rather than a silent decision — see the final report.
import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@neondatabase/serverless";
import { orderId, sellerId } from "../../../core/src/ids";
import { type Emitter, noopEmitter, uncorrelated } from "../../../core/src/instrumentation";
import type { Money } from "../../../core/src/money";
import type { Result } from "../../../core/src/result";
import type {
  NewResolutionAction,
  NewResolutionCase,
  ResolutionAction,
  ResolutionActionRepo,
  ResolutionCase,
  ResolutionCaseFilter,
  ResolutionCasePatch,
  ResolutionCaseRepo,
  ResolutionRepositories,
  ResolutionUnitOfWork,
} from "../../../core/src/services/resolution";
import { createRepositories, type SqlSession } from "./repositories";

function valid<T>(value: Result<T, unknown>): T {
  if (!value.ok) throw new Error("Invalid persisted domain value");
  return value.value;
}
function first<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error("Expected a persisted row");
  return row;
}

const caseColumns =
  'id, kind, status, seller_id AS "sellerId", order_id AS "orderId", provider_resource_type AS "providerResourceType", provider_resource_id AS "providerResourceId", expected, observed, impact, next_safe_action AS "nextSafeAction", assigned_to AS "assignedTo", provenance, simulated, opened_at AS "openedAt", updated_at AS "updatedAt", resolved_at AS "resolvedAt", correlation_id AS "correlationId"';
const actionColumns =
  'id, case_id AS "caseId", action, actor_user_id AS "actorUserId", idempotency_key AS "idempotencyKey", outcome, detail, at';

type CaseRow = {
  id: string;
  kind: ResolutionCase["kind"];
  status: ResolutionCase["status"];
  sellerId: string | null;
  orderId: string | null;
  providerResourceType: "payment" | "transfer";
  providerResourceId: string;
  expected: Money | null;
  observed: Money | null;
  impact: string;
  nextSafeAction: string | null;
  assignedTo: string | null;
  provenance: string;
  simulated: boolean;
  openedAt: string | Date;
  updatedAt: string | Date;
  resolvedAt: string | Date | null;
  correlationId: string | null;
};
function toCase(row: CaseRow): ResolutionCase {
  return {
    ...row,
    sellerId: row.sellerId ? valid(sellerId(row.sellerId)) : null,
    orderId: row.orderId ? valid(orderId(row.orderId)) : null,
    openedAt: new Date(row.openedAt),
    updatedAt: new Date(row.updatedAt),
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : null,
  };
}
type ActionRow = {
  id: string;
  caseId: string;
  action: ResolutionAction["action"];
  actorUserId: string;
  idempotencyKey: string;
  outcome: ResolutionAction["outcome"];
  detail: unknown;
  at: string | Date;
};
function toAction(row: ActionRow): ResolutionAction {
  return { ...row, at: new Date(row.at) };
}

function createCaseRepo(sql: SqlSession): ResolutionCaseRepo {
  return {
    async upsert(input: NewResolutionCase) {
      const inserted = await sql.query<CaseRow>(
        `INSERT INTO resolution_cases (id,kind,status,seller_id,order_id,provider_resource_type,provider_resource_id,expected,observed,impact,next_safe_action,provenance,simulated,opened_at,updated_at,correlation_id) VALUES ($1,$2,'detected',$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$13,$14) ON CONFLICT (kind, provider_resource_id) DO NOTHING RETURNING ${caseColumns}`,
        [
          input.id,
          input.kind,
          input.sellerId,
          input.orderId ?? null,
          input.providerResourceType,
          input.providerResourceId,
          input.expected === null ? null : JSON.stringify(input.expected),
          input.observed === null ? null : JSON.stringify(input.observed),
          input.impact,
          input.nextSafeAction,
          input.provenance,
          input.simulated,
          input.now,
          input.correlationId ?? null,
        ],
      );
      if (inserted.rows.length) return { case: toCase(first(inserted.rows)), created: true };
      const existing = await sql.query<CaseRow>(
        `SELECT ${caseColumns} FROM resolution_cases WHERE kind=$1 AND provider_resource_id=$2`,
        [input.kind, input.providerResourceId],
      );
      return { case: toCase(first(existing.rows)), created: false };
    },
    async get(id: string) {
      const result = await sql.query<CaseRow>(
        `SELECT ${caseColumns} FROM resolution_cases WHERE id=$1`,
        [id],
      );
      return result.rows[0] ? toCase(result.rows[0]) : null;
    },
    async findOpenByResource(kind, providerResourceId) {
      const result = await sql.query<CaseRow>(
        `SELECT ${caseColumns} FROM resolution_cases WHERE kind=$1 AND provider_resource_id=$2 AND status <> 'resolved'`,
        [kind, providerResourceId],
      );
      return result.rows[0] ? toCase(result.rows[0]) : null;
    },
    async update(id: string, patch: ResolutionCasePatch, now: Date) {
      const sets: string[] = ["updated_at=$2"];
      const params: unknown[] = [id, now];
      let position = 3;
      if (patch.status !== undefined) {
        sets.push(`status=$${position++}`);
        params.push(patch.status);
      }
      if (patch.observed !== undefined) {
        sets.push(`observed=$${position++}::jsonb`);
        params.push(patch.observed === null ? null : JSON.stringify(patch.observed));
      }
      if (patch.impact !== undefined) {
        sets.push(`impact=$${position++}`);
        params.push(patch.impact);
      }
      if (patch.nextSafeAction !== undefined) {
        sets.push(`next_safe_action=$${position++}`);
        params.push(patch.nextSafeAction);
      }
      if (patch.assignedTo !== undefined) {
        sets.push(`assigned_to=$${position++}`);
        params.push(patch.assignedTo);
      }
      if (patch.resolvedAt !== undefined) {
        sets.push(`resolved_at=$${position++}`);
        params.push(patch.resolvedAt);
      }
      const result = await sql.query<CaseRow>(
        `UPDATE resolution_cases SET ${sets.join(",")} WHERE id=$1 RETURNING ${caseColumns}`,
        params,
      );
      return toCase(first(result.rows));
    },
    async list(filter: ResolutionCaseFilter) {
      const result = await sql.query<CaseRow>(
        `SELECT ${caseColumns} FROM resolution_cases
         WHERE ($1::text IS NULL OR kind = $1::resolution_case_kind)
           AND ($2::text IS NULL OR status = $2::resolution_case_status)
           AND ($3::text IS NULL OR seller_id = $3)
           AND ($4::text IS NULL OR provenance = $4)
           AND ($5::text IS NULL OR (opened_at, id) < (SELECT opened_at, id FROM resolution_cases WHERE id = $5))
         ORDER BY opened_at DESC, id DESC
         LIMIT $6`,
        [
          filter.kind ?? null,
          filter.status ?? null,
          filter.sellerId ?? null,
          filter.provenance ?? null,
          filter.cursor ?? null,
          filter.limit,
        ],
      );
      return result.rows.map(toCase);
    },
  };
}

function createActionRepo(sql: SqlSession): ResolutionActionRepo {
  return {
    async insert(input: NewResolutionAction) {
      const inserted = await sql.query<ActionRow>(
        `INSERT INTO resolution_actions (id,case_id,action,actor_user_id,idempotency_key,outcome,detail,at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${actionColumns}`,
        [
          input.id,
          input.caseId,
          input.action,
          input.actorUserId,
          input.idempotencyKey,
          input.outcome,
          JSON.stringify(input.detail ?? {}),
          input.at,
        ],
      );
      if (inserted.rows.length) return { action: toAction(first(inserted.rows)), created: true };
      const existing = await sql.query<ActionRow>(
        `SELECT ${actionColumns} FROM resolution_actions WHERE idempotency_key=$1`,
        [input.idempotencyKey],
      );
      return { action: toAction(first(existing.rows)), created: false };
    },
    async get(idempotencyKey: string) {
      const result = await sql.query<ActionRow>(
        `SELECT ${actionColumns} FROM resolution_actions WHERE idempotency_key=$1`,
        [idempotencyKey],
      );
      return result.rows[0] ? toAction(result.rows[0]) : null;
    },
    async listForCase(caseId: string) {
      const result = await sql.query<ActionRow>(
        `SELECT ${actionColumns} FROM resolution_actions WHERE case_id=$1 ORDER BY at, id`,
        [caseId],
      );
      return result.rows.map(toAction);
    },
  };
}

export function createResolutionRepositories(sql: SqlSession): ResolutionRepositories {
  const base = createRepositories(sql);
  return {
    cases: createCaseRepo(sql),
    actions: createActionRepo(sql),
    sellers: base.sellers,
    ledger: base.ledger,
    effects: base.effects,
  };
}

function dbEvent(provenance: "neon" | "pglite", status: "ok" | "error", durationMs: number) {
  return {
    correlationId: uncorrelated,
    source: "db" as const,
    phase: "end" as const,
    path: "resolution_run",
    status,
    durationMs,
    provenance,
    safeIds: {},
    summary: status === "ok" ? "db transaction committed" : "db transaction rolled back",
    at: new Date(),
  };
}

export function createPgliteResolutionUnitOfWork(
  client: PGlite,
  emitter: Emitter = noopEmitter,
): ResolutionUnitOfWork {
  return {
    async run(fn) {
      const startedAt = Date.now();
      try {
        const result = await client.transaction((tx) => fn(createResolutionRepositories(tx)));
        emitter.emit(dbEvent("pglite", "ok", Date.now() - startedAt));
        return result;
      } catch (error) {
        emitter.emit(dbEvent("pglite", "error", Date.now() - startedAt));
        throw error;
      }
    },
  };
}

function scoped(connection: Client, emitter: Emitter): ResolutionUnitOfWork {
  return {
    async run(fn) {
      const startedAt = Date.now();
      await connection.query("BEGIN");
      try {
        const result = await fn(
          createResolutionRepositories({
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

export function createNeonResolutionUnitOfWork(
  url: string,
  emitter: Emitter = noopEmitter,
): ResolutionUnitOfWork & { close(): Promise<void> } {
  const parsed = new URL(url);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !(parsed.hostname === "neon.tech" || parsed.hostname.endsWith(".neon.tech"))
  )
    throw new Error("Transactional services require a Neon Postgres URL");
  // One connection per unit of work, closed in finally: same reason as
  // packages/db/src/repos/unit-of-work.ts (idle pool connections exhausted the compute's
  // connection slots on 2026-09-08).
  return {
    async run(fn) {
      const connection = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
      await connection.connect();
      try {
        return await scoped(connection, emitter).run(fn);
      } finally {
        await connection.end().catch(() => {});
      }
    },
    close: async () => {},
  };
}
