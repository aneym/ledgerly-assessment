// POST /api/orders/{id}/refund-request: the signed-in buyer who owns the order asks for a
// refund (apps/web/src/components/buyer/RefundRequest.tsx, which always posts an empty
// body - no `reason` field exists in the client today, though the stored row and repo
// accept one for a future UI). Buyer-only authz, no seller/operator fallback: unlike
// GET /api/orders/{id}'s receipt read, only the buyer who paid may open a refund ask on
// their own order.
import { type Order, orderId as parseOrderId } from "@ledgerly/core";
import { getCommerce } from "../../../../../lib/commerce";
import { instrumented } from "../../../../../lib/instrument";
import { getSession } from "../../../../../lib/session";

export const runtime = "nodejs";

function parseReason(value: unknown): string | null | undefined {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (body.reason === undefined) return null;
  if (typeof body.reason !== "string") return undefined;
  return body.reason.trim() || null;
}

type RefundRequestView = {
  id: string;
  orderId: string;
  status: string;
  amountMinor: number;
  currency: string;
  reason: string | null;
  createdAt: Date;
};

export type CreateRefundRequestDeps = {
  getSession: () => Promise<{ userId: string; role: string } | null>;
  getOrder: (id: string) => Promise<Order | null>;
  getRefundRequest: (orderId: string, buyerUserId: string) => Promise<RefundRequestView | null>;
  createRefundRequest: (input: {
    orderId: string;
    buyerUserId: string;
    reason: string | null;
  }) => Promise<RefundRequestView | null>;
};

export function createCreateRefundRequestHandler(
  deps: CreateRefundRequestDeps,
): (request: Request, id: string) => Promise<Response> {
  return async function handleCreateRefundRequest(request: Request, id: string) {
    const session = await deps.getSession();
    if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });

    let json: unknown;
    try {
      json = request.headers.get("content-length") === "0" ? {} : await request.json();
    } catch {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const reason = parseReason(json);
    if (reason === undefined) return Response.json({ error: "invalid_body" }, { status: 400 });

    const order = await deps.getOrder(id);
    if (!order) return Response.json({ error: "not_found" }, { status: 404 });
    if (order.buyerUserId !== session.userId)
      return Response.json({ error: "forbidden" }, { status: 403 });

    // Return the original request even after the payment has subsequently been refunded.
    let created = await deps.getRefundRequest(order.id, session.userId);
    if (!created) {
      if (order.status !== "paid" || order.flow !== "platform_transfer" || !order.paymentId)
        return Response.json({ error: "refund_not_available" }, { status: 409 });
      created = await deps.createRefundRequest({
        orderId: order.id,
        buyerUserId: session.userId,
        reason,
      });
      // The repository rechecks ownership and eligibility atomically with insertion.
      if (!created) return Response.json({ error: "refund_not_available" }, { status: 409 });
    }

    return Response.json(
      {
        id: created.id,
        order_id: created.orderId,
        status: created.status,
        amount: { amount_minor: created.amountMinor, currency: created.currency },
        reason: created.reason,
        created_at: created.createdAt.toISOString(),
      },
      { status: 201 },
    );
  };
}

const handleCreateRefundRequest = createCreateRefundRequestHandler({
  getSession,
  async getOrder(id) {
    const parsed = parseOrderId(id);
    if (!parsed.ok) return null;
    return getCommerce().orders.get(parsed.value);
  },
  createRefundRequest: (input) => getCommerce().refundRequests.create(input),
  getRefundRequest: (id, buyer) => getCommerce().refundRequests.getForOrder(id, buyer),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return instrumented((req) => handleCreateRefundRequest(req, id))(request);
}
