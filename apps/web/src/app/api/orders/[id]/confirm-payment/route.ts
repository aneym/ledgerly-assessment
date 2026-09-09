import {
  orderId,
  type PaymentConfirmationInput,
  type PaymentConfirmationResult,
  whopPaymentId,
} from "@ledgerly/core";
import { instrumented } from "@/lib/instrument";
import { confirmOrderPayment } from "@/lib/payment-confirmation";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export function createConfirmPaymentHandler(deps: {
  appBaseUrl: () => string | undefined;
  getSession: () => Promise<{ userId: string; role: string } | null>;
  confirm: (input: PaymentConfirmationInput) => Promise<PaymentConfirmationResult>;
}) {
  return async (request: Request, id: string): Promise<Response> => {
    const reply = (body: unknown, status: number) =>
      Response.json(body, { status, headers: { "cache-control": "no-store" } });
    const session = await deps.getSession();
    if (!session) return reply({ error: "unauthenticated" }, 401);
    if (session.role === "demo") return reply({ error: "forbidden" }, 403);
    const base = deps.appBaseUrl();
    if (!base) return reply({ error: "not_available" }, 503);
    if (
      request.headers.get("origin") !== new URL(base).origin ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return reply({ error: "invalid_origin" }, 403);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
      return reply({ error: "invalid_body" }, 400);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return reply({ error: "invalid_body" }, 400);
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("payment_id" in body) ||
      typeof body.payment_id !== "string" ||
      !/^pay_[A-Za-z0-9]+$/.test(body.payment_id)
    )
      return reply({ error: "invalid_body" }, 400);
    const payment = whopPaymentId(body.payment_id);
    const order = orderId(id);
    if (!payment.ok || !order.ok) return reply({ error: "invalid_body" }, 400);
    const result = await deps.confirm({
      orderId: order.value,
      paymentId: payment.value,
      buyerUserId: session.userId,
    });
    if (!result.ok) {
      const kind = result.error.kind;
      const status =
        kind === "forbidden"
          ? 403
          : kind === "not_found"
            ? 404
            : kind === "not_available"
              ? 503
              : ["provider_read_failed", "invalid_observation", "source_unverified"].includes(kind)
                ? 502
                : 409;
      return reply({ error: kind }, status);
    }
    return reply(
      {
        order_id: result.value.orderId,
        payment_id: result.value.paymentId,
        status: result.value.status,
        provenance: result.value.provenance,
        confirmation_source: "provider_read",
        duplicate: result.value.duplicate,
      },
      200,
    );
  };
}
const handle = createConfirmPaymentHandler({
  appBaseUrl: () => process.env.APP_BASE_URL,
  getSession,
  confirm: confirmOrderPayment,
});
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return instrumented((req) => handle(req, id))(request);
}
