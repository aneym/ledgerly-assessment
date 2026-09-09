import { createHash } from "node:crypto";
import {
  createInboxService,
  type DeliveryId,
  type Emitter,
  err,
  noopEmitter,
  type UnitOfWork,
  uncorrelated,
} from "@ledgerly/core";
import { assertLocalRuntimeEnvironment, type getLocalRuntime } from "@ledgerly/db";
import type { ReceiveInput } from "../../../../packages/core/src/services/inbox";
import type { InboxRow, Repositories } from "../../../../packages/core/src/services/ports";
import {
  createRepositories,
  type SqlSession,
} from "../../../../packages/db/src/repos/repositories";
import { decodeEnvelope } from "../../../../packages/whop/src/envelope";
import { verifyStandardWebhook } from "../../../../packages/whop/src/webhooks";
import { actualNodeEnvironment } from "./runtime-test-contract/runtime-environment.server";
import type { RefundSafety, RefundScope } from "./runtime-test-contract/test-events";

type Claim = {
  payment_id: string;
  order_id: string | null;
  run_id: string | null;
  mode: "ordinary" | "isolated";
};
type Order = {
  id: string;
  run_id: string;
  payment_id: string;
  checkout_configuration_id: string;
  provenance: string;
  status: string;
  buyer_user_id: string;
  seller_run: string;
  account_id: string;
  flow: string;
};
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function localRefund(scope: RefundScope) {
  return `rf_local_${digest(JSON.stringify([scope.runId, scope.orderId, scope.paymentId]))}`;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function body(raw: string) {
  try {
    return object(JSON.parse(raw));
  } catch {
    return null;
  }
}
const orderSql = `SELECT o.id,o.run_id,o.payment_id,o.checkout_configuration_id,o.provenance,o.status,
  o.buyer_user_id,s.run_id AS seller_run,s.whop_account_id AS account_id,o.flow
  FROM orders o JOIN sellers s ON s.id=o.seller_id`;

/** Local PGlite only. Parent MUST route every provider refund through guardRefund and every
 * ordinary inbox receiver/processor through ordinaryUow. The synthetic receiver is an internal
 * capability: never expose it as an arbitrary raw-body endpoint. Tables persist for DB lifetime. */
export function createLocalRefundIsolation(deps: {
  client: ReturnType<typeof getLocalRuntime>["db"]["$client"];
  env: NodeJS.ProcessEnv;
  baseUow: UnitOfWork;
  databaseReady?: Promise<void>;
  platformAccountId: string;
  now(): Date;
  emitter?: Emitter;
}) {
  assertLocalRuntimeEnvironment(deps.env);
  if (actualNodeEnvironment() === "production")
    throw new Error("Local refund isolation refuses production");
  // Keep these tables local: no production migration or shared schema changes.
  const ready = (deps.databaseReady ?? Promise.resolve()).then(() =>
    deps.client.transaction(async (tx) => {
      await tx.exec(`CREATE TABLE IF NOT EXISTS local_refund_claims (
      payment_id text PRIMARY KEY, order_id text, run_id text, mode text NOT NULL CHECK(mode IN ('ordinary','isolated')),
      CHECK(mode='ordinary' OR (order_id IS NOT NULL AND run_id IS NOT NULL)));
      CREATE TABLE IF NOT EXISTS local_refund_deliveries (
      delivery_id text PRIMARY KEY, payment_id text NOT NULL REFERENCES local_refund_claims(payment_id),
      body_hash text NOT NULL);`);
    }),
  );
  async function transaction<T>(fn: (sql: SqlSession) => Promise<T>): Promise<T> {
    await ready;
    const start = Date.now();
    let status: "ok" | "error" = "error";
    try {
      const result = await deps.client.transaction(fn);
      status = "ok";
      return result;
    } finally {
      (deps.emitter ?? noopEmitter).emit({
        correlationId: uncorrelated,
        source: "db",
        phase: "end",
        path: "run",
        status,
        durationMs: Date.now() - start,
        provenance: "pglite",
        safeIds: {},
        summary: status === "ok" ? "db transaction committed" : "db transaction rolled back",
        at: deps.now(),
      });
    }
  }
  async function claim(sql: SqlSession, payment: string) {
    return (
      await sql.query<Claim>("SELECT * FROM local_refund_claims WHERE payment_id=$1", [payment])
    ).rows[0];
  }
  async function relatedPayments(sql: SqlSession, raw: string): Promise<string[]> {
    const envelope = body(raw);
    const data = object(envelope?.data);
    const metadata = object(data?.metadata);
    if (!data) return [];
    const payment = typeof data.payment_id === "string" ? data.payment_id : null;
    const checkout =
      typeof data.checkout_configuration_id === "string" ? data.checkout_configuration_id : null;
    const order = typeof metadata?.order_id === "string" ? metadata.order_id : null;
    const rows = await sql.query<{ payment_id: string }>(
      `SELECT payment_id FROM orders
      WHERE payment_id IS NOT NULL AND (payment_id=$1 OR checkout_configuration_id=$2 OR id=$3)`,
      [payment, checkout, order],
    );
    return [...new Set([...(payment ? [payment] : []), ...rows.rows.map((r) => r.payment_id)])];
  }
  async function allowed(sql: SqlSession, row: InboxRow): Promise<boolean> {
    if (row.envelope.eventType !== "refund.created") return true;
    const payments = await relatedPayments(sql, row.envelope.rawBody);
    for (const payment of payments) {
      const existing = await claim(sql, payment);
      if (existing?.mode === "isolated") {
        const permission = (
          await sql.query<{ body_hash: string; payment_id: string }>(
            "SELECT body_hash,payment_id FROM local_refund_deliveries WHERE delivery_id=$1",
            [row.deliveryId],
          )
        ).rows[0];
        if (
          !permission ||
          permission.payment_id !== payment ||
          permission.body_hash !== digest(row.envelope.rawBody)
        )
          return false;
      } else {
        // Ordinary receipt/processing wins the race before any effect or provider call.
        await sql.query(
          "INSERT INTO local_refund_claims(payment_id,mode) VALUES($1,'ordinary') ON CONFLICT DO NOTHING",
          [payment],
        );
      }
    }
    return true;
  }
  function repositories(sql: SqlSession): Repositories {
    const repos = createRepositories(sql);
    return {
      ...repos,
      inbox: {
        ...repos.inbox,
        async insert(row, headers) {
          if (!(await allowed(sql, row))) {
            const result = await repos.inbox.insert({ ...row, status: "quarantined" }, headers);
            if (!result.duplicate)
              await repos.inbox.mark(
                row.deliveryId,
                "quarantined",
                deps.now(),
                "local_refund_isolated",
              );
            return result;
          }
          return repos.inbox.insert(row, headers);
        },
        async get(id) {
          const row = await repos.inbox.get(id);
          if (row.status === "received" && !(await allowed(sql, row))) {
            await repos.inbox.mark(id, "quarantined", deps.now(), "local_refund_isolated");
            return { ...row, status: "quarantined" };
          }
          return row;
        },
      },
      effects: {
        async insert(effect, now) {
          if (effect.resourceType === "refund") {
            const row = await repos.inbox.get(effect.deliveryId);
            if (!(await allowed(sql, row))) throw new Error("local_refund_isolated");
          }
          return repos.effects.insert(effect, now);
        },
      },
    };
  }
  const ordinaryUow: UnitOfWork = {
    run: (fn) => transaction((sql) => fn(repositories(sql))),
    exclusive: (key, fn) => deps.baseUow.exclusive(key, () => fn({ run: ordinaryUow.run })),
  };
  const serviceDeps = {
    platformAccountId: deps.platformAccountId,
    clock: { now: deps.now },
    decoder: { decodeEnvelope, verifyStandardWebhook },
    provenance: "mock" as const,
  };
  const ordinaryInbox = createInboxService({ ...serviceDeps, uow: ordinaryUow });
  const refundSafety: RefundSafety = {
    async ensure(scope) {
      return transaction(async (sql) => {
        const matches = (
          await sql.query<Order>(`${orderSql} WHERE o.payment_id=$1`, [scope.paymentId])
        ).rows;
        const order = matches[0];
        if (
          matches.length !== 1 ||
          !order ||
          order.id !== scope.orderId ||
          order.run_id !== scope.runId ||
          order.seller_run !== scope.runId ||
          order.provenance !== "mock" ||
          order.flow !== "platform_transfer" ||
          !order.checkout_configuration_id ||
          !order.buyer_user_id ||
          !["paid", "refunded"].includes(order.status)
        )
          return null;
        const existing = await claim(sql, scope.paymentId);
        if (existing)
          return existing.mode === "isolated" &&
            existing.order_id === scope.orderId &&
            existing.run_id === scope.runId
            ? { ...scope, guarantee: "lifecycle_isolated" as const }
            : null;
        if (order.status !== "paid") return null;
        // Catch ordinary deliveries queued before guards were mounted, regardless of status.
        const queued = await sql.query<{ raw_body: string }>(
          "SELECT raw_body FROM webhook_inbox WHERE event_type='refund.created'",
        );
        for (const row of queued.rows)
          if ((await relatedPayments(sql, row.raw_body)).includes(scope.paymentId)) return null;
        await sql.query(
          "INSERT INTO local_refund_claims(payment_id,order_id,run_id,mode) VALUES($1,$2,$3,'isolated')",
          [scope.paymentId, scope.orderId, scope.runId],
        );
        return { ...scope, guarantee: "lifecycle_isolated" as const };
      });
    },
  };
  return {
    ready,
    ordinaryUow,
    refundSafety,
    async guardRefund<T>(paymentId: string, perform: () => Promise<T>): Promise<T> {
      await transaction(async (sql) => {
        if ((await claim(sql, paymentId))?.mode === "isolated")
          throw new Error("local_refund_isolated");
        // Keep ordinary ownership even on rejection/throw/unknown outcome: never permit later
        // isolation to race an ordinary provider refund whose outcome may still arrive.
        await sql.query(
          "INSERT INTO local_refund_claims(payment_id,mode) VALUES($1,'ordinary') ON CONFLICT DO NOTHING",
          [paymentId],
        );
      });
      return perform();
    },
    syntheticInbox: {
      async receiveWebhook(input: ReceiveInput): ReturnType<typeof ordinaryInbox.receiveWebhook> {
        const verified = verifyStandardWebhook(input);
        if (!verified.ok) return err({ kind: "signature" as const, reason: verified.error.kind });
        const envelope = body(input.rawBody);
        if (envelope?.type !== "refund.created") return ordinaryInbox.receiveWebhook(input);
        return transaction(async (sql) => {
          const data = object(envelope.data);
          const correlation = object(envelope.local_test);
          if (!data || !correlation || typeof data.payment_id !== "string")
            return err({ kind: "decode" as const, reason: "invalid_synthetic_refund" });
          const scope = {
            runId: String(correlation.runId),
            orderId: String(correlation.orderId),
            paymentId: data.payment_id,
          };
          const existing = await claim(sql, scope.paymentId);
          const order = (await sql.query<Order>(`${orderSql} WHERE o.id=$1`, [scope.orderId]))
            .rows[0];
          const id = input.headers["webhook-id"];
          if (
            existing?.mode !== "isolated" ||
            existing.order_id !== scope.orderId ||
            existing.run_id !== scope.runId ||
            !order ||
            order.payment_id !== scope.paymentId ||
            order.run_id !== scope.runId ||
            order.seller_run !== scope.runId ||
            order.provenance !== "mock" ||
            order.flow !== "platform_transfer" ||
            order.buyer_user_id !== correlation.userId ||
            data.id !== localRefund(scope) ||
            data.checkout_configuration_id !== order.checkout_configuration_id ||
            envelope.id !== id ||
            !/^local_test_[a-f0-9]{64}$/.test(id) ||
            envelope.account_id !== deps.platformAccountId
          ) {
            return err({ kind: "decode" as const, reason: "invalid_synthetic_refund" });
          }
          const prior = (
            await sql.query<{ body_hash: string }>(
              "SELECT body_hash FROM local_refund_deliveries WHERE delivery_id=$1",
              [id],
            )
          ).rows[0];
          const persisted = (
            await sql.query<{ raw_body: string }>(
              "SELECT raw_body FROM webhook_inbox WHERE delivery_id=$1",
              [id],
            )
          ).rows[0];
          // Existing authorized replays use persisted bytes, so timestamp regeneration cannot
          // revoke a valid delivery. An ordinary preexisting row is never upgraded to trusted.
          if (persisted && (!prior || digest(persisted.raw_body) !== prior.body_hash))
            return err({ kind: "decode" as const, reason: "delivery_conflict" });
          if (!prior)
            await sql.query(
              "INSERT INTO local_refund_deliveries(delivery_id,payment_id,body_hash) VALUES($1,$2,$3)",
              [id, scope.paymentId, digest(input.rawBody)],
            );
          const repos = repositories(sql);
          const inTransaction: UnitOfWork = {
            run: (fn) => fn(repos),
            exclusive: async (_key, fn) => fn({ run: (fn) => fn(repos) }),
          };
          const service = createInboxService({ ...serviceDeps, uow: inTransaction });
          return service.receiveWebhook(input);
        });
      },
      async processDelivery(id: DeliveryId) {
        const service = createInboxService({
          ...serviceDeps,
          uow: {
            ...ordinaryUow,
            run: (fn) =>
              ordinaryUow.run((repos) =>
                fn({
                  ...repos,
                  inbox: { ...repos.inbox, pending: async () => [await repos.inbox.get(id)] },
                }),
              ),
          },
        });
        return service.processInbox({ limit: 1 });
      },
    },
  };
}
