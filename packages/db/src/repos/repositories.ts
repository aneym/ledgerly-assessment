import {
  deliveryId,
  orderId,
  parseEffectKey,
  runId,
  sellerId,
  whopAccountId,
} from "../../../core/src/ids";
import { add, money } from "../../../core/src/money";
import type { Result } from "../../../core/src/result";
import type {
  Envelope,
  InboxOrder,
  InboxRow,
  LedgerEntry,
  LedgerRepo,
  Operation,
  Repositories,
  Seller,
} from "../../../core/src/services/ports";
import type { ledgerEntries, operations, orders, sellers, webhookInbox } from "../schema";

export interface SqlSession {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
function valid<T>(value: Result<T, unknown>): T {
  if (!value.ok) throw new Error("Invalid persisted domain value");
  return value.value;
}
function first<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error("Expected a persisted row");
  return row;
}
// SQL aliases keep the schema's camel-case types at this boundary.
const sellerColumns =
  'id, run_id AS "runId", external_id AS "externalId", email, country, whop_account_id AS "whopAccountId"';
const operationColumns =
  'idempotency_key AS key, request, api_version_date AS "apiVersionDate", status, provider_resource_id AS "providerResourceId"';
const inboxColumns =
  'delivery_id AS "deliveryId", event_type AS "eventType", api_version_date AS "apiVersionDate", account_field AS "accountField", account_id AS "accountId", raw_body AS "rawBody", received_at AS "receivedAt", status';
type SellerRow = Pick<
  typeof sellers.$inferSelect,
  "id" | "runId" | "externalId" | "email" | "country" | "whopAccountId"
>;
function seller(row: SellerRow): Seller {
  return {
    ...row,
    id: valid(sellerId(row.id)),
    runId: valid(runId(row.runId)),
    whopAccountId: row.whopAccountId ? valid(whopAccountId(row.whopAccountId)) : null,
  };
}
type OperationRow = Pick<
  typeof operations.$inferSelect,
  "request" | "apiVersionDate" | "status" | "providerResourceId"
> & { key: string };
function operation(row: OperationRow): Operation {
  return {
    ...row,
    request: row.request as Operation["request"],
    providerResourceId: row.providerResourceId
      ? valid(whopAccountId(row.providerResourceId))
      : null,
  };
}
type InboxRecord = Pick<
  typeof webhookInbox.$inferSelect,
  | "deliveryId"
  | "eventType"
  | "apiVersionDate"
  | "accountField"
  | "accountId"
  | "rawBody"
  | "receivedAt"
  | "status"
>;
function inbox(row: InboxRecord): InboxRow {
  return {
    deliveryId: valid(deliveryId(row.deliveryId)),
    receivedAt: new Date(row.receivedAt),
    status: row.status,
    envelope: {
      accountId: row.accountId,
      eventType: row.eventType,
      apiVersionDate: row.apiVersionDate,
      originalAccountField: row.accountField,
      rawBody: row.rawBody,
      raw: parseRaw(row.rawBody, row.eventType),
    },
  };
}
// A validly signed delivery whose body is not JSON is stored as a "failed" row (see
// packages/core/src/services/inbox.ts's undecodableEnvelope). Reading it back must not throw:
// the placeholder mirrors what the inbox service stored for it, so the RETURNING row of that
// insert, and any later listing, maps cleanly (QA-F20).
function parseRaw(rawBody: string, eventType: string): Envelope["raw"] {
  try {
    return JSON.parse(rawBody) as Envelope["raw"];
  } catch {
    return { type: eventType, timestamp: 0 } as Envelope["raw"];
  }
}
export function createRepositories(sql: SqlSession): Repositories {
  // Keep the mapping stable until the inbox transaction accepts or rejects the delivery.
  async function findInboxOrders(
    column: "payment_id" | "checkout_configuration_id" | "id",
    id: string,
  ): Promise<InboxOrder[]> {
    const result = await sql.query<
      Pick<
        typeof orders.$inferSelect,
        "id" | "sellerId" | "runId" | "flow" | "paymentId" | "checkoutConfigurationId"
      >
    >(
      `SELECT id,seller_id AS "sellerId",run_id AS "runId",flow,payment_id AS "paymentId",
       checkout_configuration_id AS "checkoutConfigurationId" FROM orders WHERE ${column}=$1 LIMIT 2 FOR UPDATE`,
      [id],
    );
    return result.rows.map((row) => ({
      ...row,
      sellerId: valid(sellerId(row.sellerId)),
      runId: valid(runId(row.runId)),
    }));
  }
  const resolveOrder: LedgerRepo["resolveOrder"] = async (owner, input, options) => {
    const result = await sql.query<
      Pick<typeof orders.$inferSelect, "grossMinor" | "feeMinor" | "currency">
    >(
      `SELECT gross_minor AS "grossMinor",fee_minor AS "feeMinor",currency FROM orders
       WHERE run_id=$1 AND seller_id=$2 AND (payment_id=$3 OR checkout_configuration_id=$4 OR id=$5)
       FOR UPDATE`,
      [
        owner.runId,
        owner.id,
        input.paymentId ?? null,
        input.checkoutId ?? null,
        input.orderId ?? null,
      ],
    );
    if (result.rows.length > 1) throw new Error("Payment maps to multiple orders");
    const row = result.rows[0];
    if (row && !options?.requirePostedPayment)
      return {
        matched: true,
        allocation: {
          gross: valid(money(Number(row.grossMinor), row.currency)),
          fee: valid(money(Number(row.feeMinor), row.currency)),
        },
      };
    if (!input.paymentId) return { matched: Boolean(row), allocation: null };
    const posted = await sql.query<{
      side: "seller" | "platform";
      amount: string;
      currency: "USD" | "EUR" | "BRL";
    }>(
      "SELECT account_side AS side,amount_minor AS amount,currency FROM ledger_entries WHERE run_id=$1 AND seller_id=$2 AND provider_resource_type='payment' AND provider_resource_id=$3",
      [owner.runId, owner.id, input.paymentId],
    );
    if (!posted.rows.length) return { matched: Boolean(row), allocation: null };
    const sellerShare = posted.rows.find((entry) => entry.side === "seller");
    const platform = posted.rows.find((entry) => entry.side === "platform");
    if (posted.rows.length !== 2 || !sellerShare || !platform)
      throw new Error("Incomplete payment allocation");
    const share = valid(money(Number(sellerShare.amount), sellerShare.currency));
    const fee = valid(money(Number(platform.amount), platform.currency));
    return { matched: Boolean(row), allocation: { gross: valid(add(share, fee)), fee } };
  };
  return {
    async lock(key) {
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    },
    orders: {
      async forPaymentConfirmation(id) {
        const row = (
          await sql.query<typeof orders.$inferSelect>(
            `SELECT id,run_id AS "runId",seller_id AS "sellerId",product_title AS "productTitle",
           product_external_id AS "productExternalId",gross_minor AS "grossMinor",fee_minor AS "feeMinor",
           currency,flow,checkout_configuration_id AS "checkoutConfigurationId",purchase_url AS "purchaseUrl",
           status,created_at AS "createdAt",provenance,buyer_user_id AS "buyerUserId",payment_id AS "paymentId"
           FROM orders WHERE id=$1 FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!row) return null;
        // Keep the seller's provider account binding stable through local validation and commit.
        await sql.query("SELECT id FROM sellers WHERE id=$1 FOR UPDATE", [row.sellerId]);
        if (
          !["pending", "checkout_created", "failed", "paid", "refunded"].includes(row.status) ||
          (row.provenance !== "sandbox" && row.provenance !== "mock")
        )
          throw new Error("Invalid confirmation order state");
        return {
          id: valid(orderId(row.id)),
          runId: valid(runId(row.runId)),
          sellerId: valid(sellerId(row.sellerId)),
          productTitle: row.productTitle,
          productExternalId: row.productExternalId,
          gross: valid(money(Number(row.grossMinor), row.currency)),
          fee: valid(money(Number(row.feeMinor), row.currency)),
          flow: row.flow,
          checkoutConfigurationId: row.checkoutConfigurationId,
          purchaseUrl: row.purchaseUrl,
          status: row.status as import("../../../core/src/services/orders").OrderStatus,
          createdAt: new Date(row.createdAt),
          provenance: row.provenance,
          buyerUserId: row.buyerUserId,
          paymentId: row.paymentId,
        };
      },
      async byCheckoutConfigurationId(id) {
        const rows = await findInboxOrders("checkout_configuration_id", id);
        return rows.length === 1 ? (rows[0] ?? null) : null;
      },
      async byId(id) {
        const rows = await findInboxOrders("id", id);
        return rows[0] ?? null;
      },
      async byPaymentId(id) {
        const rows = await findInboxOrders("payment_id", id);
        return rows.length > 1 ? { kind: "ambiguous" } : (rows[0] ?? null);
      },
    },
    sellers: {
      async createOrFetch(input, id) {
        const inserted = await sql.query<SellerRow>(
          `INSERT INTO sellers (id,run_id,external_id,email,country,sale_policy) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id,external_id) DO NOTHING RETURNING ${sellerColumns}`,
          [
            id,
            input.runId,
            input.externalId,
            input.email,
            input.country,
            input.country === "BR" ? "platform_only" : "direct",
          ],
        );
        if (inserted.rows.length) return seller(first(inserted.rows));
        const result = await sql.query<SellerRow>(
          `SELECT ${sellerColumns} FROM sellers WHERE run_id=$1 AND external_id=$2`,
          [input.runId, input.externalId],
        );
        return seller(first(result.rows));
      },
      async get(id) {
        const result = await sql.query<SellerRow>(
          `SELECT ${sellerColumns} FROM sellers WHERE id=$1`,
          [id],
        );
        return result.rows[0] ? seller(result.rows[0]) : null;
      },
      async byAccount(id) {
        const result = await sql.query<SellerRow>(
          `SELECT ${sellerColumns} FROM sellers WHERE whop_account_id=$1`,
          [id],
        );
        return result.rows[0] ? seller(result.rows[0]) : null;
      },
      async attach(id, accountId) {
        await sql.query("UPDATE sellers SET whop_account_id=$2 WHERE id=$1", [id, accountId]);
      },
      async count() {
        const result = await sql.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM sellers WHERE whop_account_id IS NOT NULL",
        );
        return first(result.rows).count;
      },
      async list(limit, offset) {
        const result = await sql.query<SellerRow>(
          `SELECT ${sellerColumns} FROM sellers WHERE whop_account_id IS NOT NULL ORDER BY id LIMIT $1 OFFSET $2`,
          [limit, offset ?? 0],
        );
        return result.rows.map(seller);
      },
    },
    operations: {
      async createOrFetch(input) {
        const inserted = await sql.query<OperationRow>(
          `INSERT INTO operations (idempotency_key,kind,request,api_version_date,status) VALUES ($1,'onboard',$2::jsonb,$3,$4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${operationColumns}`,
          [input.key, JSON.stringify(input.request), input.apiVersionDate, input.status],
        );
        if (inserted.rows.length)
          return { operation: operation(first(inserted.rows)), created: true };
        const result = await sql.query<OperationRow>(
          `SELECT ${operationColumns} FROM operations WHERE idempotency_key=$1`,
          [input.key],
        );
        return { operation: operation(first(result.rows)), created: false };
      },
      async get(key) {
        return operation(
          first(
            (
              await sql.query<OperationRow>(
                `SELECT ${operationColumns} FROM operations WHERE idempotency_key=$1`,
                [key],
              )
            ).rows,
          ),
        );
      },
      async finish(key, status, accountId, now) {
        await sql.query(
          "UPDATE operations SET status=$2,provider_resource_id=$3,response=$4::jsonb,updated_at=$5 WHERE idempotency_key=$1",
          [key, status, accountId, JSON.stringify({ status, accountId }), now],
        );
      },
    },
    inbox: {
      async insert(row, headers) {
        const envelope = row.envelope;
        const result = await sql.query<InboxRecord>(
          `INSERT INTO webhook_inbox (delivery_id,event_type,api_version_date,account_field,account_id,raw_body,headers,received_at,status) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT (delivery_id) DO NOTHING RETURNING ${inboxColumns}`,
          [
            row.deliveryId,
            envelope.eventType,
            envelope.apiVersionDate,
            envelope.originalAccountField,
            envelope.accountId,
            envelope.rawBody,
            JSON.stringify(headers),
            row.receivedAt,
            row.status,
          ],
        );
        if (result.rows.length) return { row: inbox(first(result.rows)), duplicate: false };
        return {
          row: inbox(
            first(
              (
                await sql.query<InboxRecord>(
                  `SELECT ${inboxColumns} FROM webhook_inbox WHERE delivery_id=$1`,
                  [row.deliveryId],
                )
              ).rows,
            ),
          ),
          duplicate: true,
        };
      },
      async pending(limit) {
        return (
          await sql.query<InboxRecord>(
            `SELECT ${inboxColumns} FROM webhook_inbox WHERE status IN ('received','failed') ORDER BY received_at,delivery_id LIMIT $1`,
            [limit],
          )
        ).rows.map(inbox);
      },
      async get(id) {
        return inbox(
          first(
            (
              await sql.query<InboxRecord>(
                `SELECT ${inboxColumns} FROM webhook_inbox WHERE delivery_id=$1`,
                [id],
              )
            ).rows,
          ),
        );
      },
      async mark(id, status, now, error) {
        await sql.query(
          "UPDATE webhook_inbox SET status=$2,processed_at=$3,error=$4 WHERE delivery_id=$1",
          [id, status, status === "processed" ? now : null, error ?? null],
        );
      },
    },
    effects: {
      async insert(effect, now) {
        return (
          (
            await sql.query(
              "INSERT INTO business_effects (effect_key,delivery_id,resource_type,resource_id,transition,detail,applied_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (effect_key) DO NOTHING RETURNING effect_key",
              [
                effect.key,
                effect.deliveryId,
                effect.resourceType,
                effect.resourceId,
                effect.transition,
                effect.detail ? JSON.stringify(effect.detail) : null,
                now,
              ],
            )
          ).rows.length === 1
        );
      },
    },
    ledger: {
      async forPaymentConfirmation(paymentId) {
        const result = await sql.query<typeof ledgerEntries.$inferSelect>(
          `SELECT run_id AS "runId",seller_id AS "sellerId",account_side AS "accountSide",currency,
           amount_minor AS "amountMinor",kind,provider_resource_type AS "providerResourceType",
           provider_resource_id AS "providerResourceId",effect_key AS "effectKey",occurred_at AS "occurredAt",provenance
           FROM ledger_entries WHERE provider_resource_type='payment' AND provider_resource_id=$1 ORDER BY id`,
          [paymentId],
        );
        return result.rows.map((row): LedgerEntry => {
          if (row.provenance !== "sandbox" && row.provenance !== "mock")
            throw new Error("Invalid payment ledger provenance");
          return {
            runId: valid(runId(row.runId)),
            sellerId: valid(sellerId(row.sellerId ?? "")),
            accountSide: row.accountSide,
            amount: valid(money(Number(row.amountMinor), row.currency)),
            kind: row.kind,
            resourceType: row.providerResourceType,
            resourceId: row.providerResourceId,
            effectKey: valid(parseEffectKey(row.effectKey)),
            occurredAt: new Date(row.occurredAt),
            provenance: row.provenance,
          };
        });
      },
      async append(entries) {
        for (const entry of entries) {
          valid(money(entry.amount.amountMinor, entry.amount.currency));
          await sql.query(
            "INSERT INTO ledger_entries (run_id,seller_id,account_side,currency,amount_minor,kind,provider_resource_type,provider_resource_id,effect_key,occurred_at,provenance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'mock'))",
            [
              entry.runId,
              entry.sellerId,
              entry.accountSide,
              entry.amount.currency,
              entry.amount.amountMinor,
              entry.kind,
              entry.resourceType,
              entry.resourceId,
              entry.effectKey,
              entry.occurredAt,
              entry.provenance ?? null,
            ],
          );
        }
      },
      async forSeller(id) {
        const result = await sql.query<typeof ledgerEntries.$inferSelect>(
          'SELECT run_id AS "runId",seller_id AS "sellerId",account_side AS "accountSide",currency,amount_minor AS "amountMinor",kind,provider_resource_type AS "providerResourceType",provider_resource_id AS "providerResourceId",effect_key AS "effectKey",occurred_at AS "occurredAt" FROM ledger_entries WHERE seller_id=$1 ORDER BY id',
          [id],
        );
        return result.rows.map(
          (row): LedgerEntry => ({
            runId: valid(runId(row.runId)),
            sellerId: valid(sellerId(row.sellerId ?? "")),
            accountSide: row.accountSide,
            amount: valid(money(Number(row.amountMinor), row.currency)),
            kind: row.kind,
            resourceType: row.providerResourceType,
            resourceId: row.providerResourceId,
            effectKey: valid(parseEffectKey(row.effectKey)),
            occurredAt: new Date(row.occurredAt),
          }),
        );
      },
      resolveOrder,
      async settleOrder(owner, input, update) {
        const settlement = await resolveOrder(owner, input);
        if (settlement.matched) {
          // Preserve the complete refunded state, including payment identity and provenance,
          // when an older paid observation arrives through any caller.
          await sql.query(
            `UPDATE orders SET payment_id=COALESCE($6,payment_id),status=$7,provenance=$8
             WHERE run_id=$1 AND seller_id=$2 AND (payment_id=$3 OR checkout_configuration_id=$4 OR id=$5)
             AND NOT (status='refunded' AND $7='paid')`,
            [
              owner.runId,
              owner.id,
              input.paymentId ?? null,
              input.checkoutId ?? null,
              input.orderId ?? null,
              update.paymentId ?? null,
              update.status,
              update.provenance,
            ],
          );
        }
        return settlement;
      },
    },
  };
}
