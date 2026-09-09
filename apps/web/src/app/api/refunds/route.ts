// GET /api/refunds?buyer=me: the signed-in buyer's own refund requests, newest first. No
// client reads this yet (RefundRequest.tsx only ever POSTs and discards the body), but it
// is named explicitly in the brief's contract, so it exists ahead of a caller - mirrors
// GET /api/orders's own `?buyer=me` alias for the same "only your own" query shape.
import { getCommerce } from "../../../lib/commerce";
import { instrumented } from "../../../lib/instrument";
import { getSession } from "../../../lib/session";

export const runtime = "nodejs";

type RefundRequestRow = {
  id: string;
  orderId: string;
  sellerId: string;
  amountMinor: number;
  currency: string;
  reason: string | null;
  status: string;
  createdAt: Date;
};

export type ListRefundsDeps = {
  getSession: () => Promise<{ userId: string; role: string } | null>;
  listForBuyer: (buyerUserId: string) => Promise<RefundRequestRow[]>;
};

function serializeRefundRequest(row: RefundRequestRow) {
  return {
    id: row.id,
    order_id: row.orderId,
    seller_id: row.sellerId,
    amount: { amount_minor: row.amountMinor, currency: row.currency },
    reason: row.reason,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  };
}

export function createListRefundsHandler(
  deps: ListRefundsDeps,
): (request: Request) => Promise<Response> {
  return async function handleListRefunds(request: Request) {
    const session = await deps.getSession();
    if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });

    const url = new URL(request.url);
    const buyer = url.searchParams.get("buyer");
    if (buyer !== null && buyer !== "me")
      return Response.json({ error: "invalid_query" }, { status: 400 });

    const rows = await deps.listForBuyer(session.userId);
    return Response.json({ refund_requests: rows.map(serializeRefundRequest) });
  };
}

export const GET = instrumented(
  createListRefundsHandler({
    getSession,
    listForBuyer: (buyerUserId) => getCommerce().refundRequests.listForBuyer(buyerUserId),
  }),
);
