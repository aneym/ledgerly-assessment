import { orderId, whopAccountId } from "@ledgerly/core";
import { signStandardWebhook } from "../../../../../../../packages/whop/src/webhooks";
import { getAuth } from "../../../../lib/auth";
import { getCommerce } from "../../../../lib/commerce";
import { requireLocalRequest } from "../../../../lib/local-identities";
import { getServer } from "../../../../lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Keep an interrupted local attempt on the same simulated payment while this runtime lives.
const pending = new WeakMap<object, Map<string, string>>();

export async function POST(request: Request) {
  if (process.env.LEDGERLY_LOCAL_RUNTIME === undefined) return new Response(null, { status: 404 });
  const server = getServer(); // Validates the local/test/loopback/production guards.
  await server.ready;
  const origin = process.env.APP_BASE_URL;
  if (!requireLocalRequest(request) || request.headers.get("origin") !== origin)
    return Response.json({ error: "forbidden_origin" }, { status: 403 });
  const auth = await getAuth().api.getSession({ headers: request.headers });
  if (!auth) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  const parsed = orderId(
    typeof body === "object" &&
      body !== null &&
      "orderId" in body &&
      typeof body.orderId === "string"
      ? body.orderId
      : "",
  );
  if (!parsed.ok) return Response.json({ error: "invalid_order" }, { status: 400 });
  const commerce = getCommerce();
  return server.uow.exclusive(`local-checkout:${parsed.value}`, async () => {
    const order = await commerce.orders.get(parsed.value);
    if (!order || order.buyerUserId !== auth.user.id)
      return Response.json({ error: "not_found" }, { status: 404 });
    if (order.provenance !== "mock" || !order.checkoutConfigurationId)
      return Response.json({ error: "mock_checkout_required" }, { status: 409 });
    if (order.paymentId) {
      if ((order.status as string) !== "paid")
        return Response.json({ error: "terminal_order", status: order.status }, { status: 409 });
      return Response.json({ status: "paid", provenance: "mock", order_id: order.id });
    }
    const seller = await commerce.sellers.get(order.sellerId);
    const simulator = server.simulator;
    if (!seller?.whopAccountId || !simulator)
      return Response.json({ error: "local_provider_unavailable" }, { status: 409 });
    let payments = pending.get(server);
    if (!payments) {
      payments = new Map();
      pending.set(server, payments);
    }
    let paymentId = payments.get(order.id);
    if (!paymentId) {
      const account = whopAccountId(
        order.flow === "direct"
          ? seller.whopAccountId
          : (process.env.WHOP_PLATFORM_ACCOUNT_ID ?? "biz_platform_sim"),
      );
      if (!account.ok) throw new Error("Invalid local account");
      const payment = simulator.seedPayment(order.gross, account.value, `checkout:${order.id}`);
      if (!payment.ok) return Response.json({ error: "simulation_failed" }, { status: 409 });
      paymentId = payment.value.id;
      payments.set(order.id, payment.value.id);
    }
    const now = new Date();
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const id = `local_checkout_${order.id}`;
    const rawBody = JSON.stringify({
      id,
      type: "payment.succeeded",
      api_version: "v1",
      api_version_date: "2026-08-21",
      timestamp: now.toISOString(),
      account_id:
        order.flow === "direct"
          ? seller.whopAccountId
          : (process.env.WHOP_PLATFORM_ACCOUNT_ID ?? "biz_platform_sim"),
      data: {
        id: paymentId,
        amount_minor: String(order.gross.amountMinor),
        currency: order.gross.currency.toLowerCase(),
        checkout_configuration_id: order.checkoutConfigurationId,
      },
    });
    const secret = server.webhookSecret();
    const received = await server.receiveWebhook({
      rawBody,
      now,
      secret,
      headers: {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": signStandardWebhook({ rawBody, id, timestamp, secret }),
      },
    });
    if (!received.ok)
      return Response.json({ error: "simulation_delivery_failed" }, { status: 409 });
    await server.processLocalDelivery(id);
    const settled = await commerce.orders.get(order.id);
    if (settled?.paymentId !== paymentId || (settled.status as string) !== "paid")
      return Response.json({ error: "payment_confirmation_pending" }, { status: 409 });
    payments.delete(order.id);
    return Response.json({ status: "paid", provenance: "mock", order_id: order.id });
  });
}
