import type { Currency } from "@ledgerly/core";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { refundRequests } from "../schema";
import type { Database } from "./orders";

export type RefundRequest = {
  id: string;
  orderId: string;
  buyerUserId: string;
  sellerId: string;
  amountMinor: number;
  currency: Currency;
  reason: string | null;
  status: string;
  createdAt: Date;
};

export type NewRefundRequest = {
  orderId: string;
  buyerUserId: string;
  reason: string | null;
};

export interface RefundRequestsRepo {
  create(input: NewRefundRequest): Promise<RefundRequest | null>;
  getForOrder(orderId: string, buyerUserId: string): Promise<RefundRequest | null>;
  listForBuyer(buyerUserId: string): Promise<RefundRequest[]>;
}

function toRefundRequest(row: typeof refundRequests.$inferSelect): RefundRequest {
  return {
    id: row.id,
    orderId: row.orderId,
    buyerUserId: row.buyerUserId,
    sellerId: row.sellerId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export function createRefundRequestsRepo<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
): RefundRequestsRepo {
  async function getForOrder(orderId: string, buyerUserId: string) {
    const rows = await db
      .select()
      .from(refundRequests)
      .where(and(eq(refundRequests.orderId, orderId), eq(refundRequests.buyerUserId, buyerUserId)))
      .orderBy(asc(refundRequests.createdAt), asc(refundRequests.id))
      .limit(1);
    return rows[0] ? toRefundRequest(rows[0]) : null;
  }
  return {
    getForOrder,
    async create(input) {
      // One statement works with Neon HTTP as well as PGlite. Lock the order before
      // checking its latest payment state so a concurrent refund cannot pass a stale read.
      // The deterministic key makes all current writers converge without deleting legacy
      // requests. Existing historical rows retain their original ID, reason and status.
      await db.execute(sql`
        WITH owned_order AS MATERIALIZED (
          SELECT * FROM orders WHERE id = ${input.orderId}
            AND buyer_user_id = ${input.buyerUserId} FOR UPDATE
        )
        INSERT INTO refund_requests (id, order_id, buyer_user_id, seller_id, amount_minor, currency, reason)
        SELECT ${`refreq_order:${input.orderId}`}, id, buyer_user_id, seller_id, gross_minor, currency, ${input.reason}
        FROM owned_order
        WHERE status = 'paid' AND flow = 'platform_transfer'
          AND payment_id IS NOT NULL AND payment_id <> ''
          AND NOT EXISTS (SELECT 1 FROM refund_requests WHERE order_id = ${input.orderId})
        ON CONFLICT (id) DO NOTHING
      `);
      // Separate read observes a concurrent insert after ON CONFLICT waited for it.
      return getForOrder(input.orderId, input.buyerUserId);
    },
    async listForBuyer(buyerUserId) {
      const rows = await db
        .select()
        .from(refundRequests)
        .where(eq(refundRequests.buyerUserId, buyerUserId))
        .orderBy(desc(refundRequests.createdAt), desc(refundRequests.id));
      return rows.map(toRefundRequest);
    },
  };
}
