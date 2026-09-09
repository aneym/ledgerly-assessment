import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryId, runId, whopPaymentId } from "@ledgerly/core";
import { getLocalRuntime, listInstrumentationEvents } from "@ledgerly/db";
import { expect, it, vi } from "vitest";
import { signStandardWebhook } from "../../../packages/whop/src/webhooks";
import { POST as checkout } from "../src/app/api/local-runtime/checkout/route";
import { GET as readEvent, POST as sendEvent } from "../src/app/api/local-runtime/events/route";
import { GET as profile } from "../src/app/demo/profile/[role]/route";
import { getCommerce } from "../src/lib/commerce";
import { instrumented } from "../src/lib/instrument";
import { getServer } from "../src/lib/server";
import { getSession } from "../src/lib/session";

const context = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => context.headers }));

it("binds signed event replay to real issued buyer proof and exact persisted delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ledgerly-event-binding-"));
  const origin = "http://127.0.0.1:4474";
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "development",
    LEDGERLY_TEST_MODE: "1",
    LEDGERLY_LOCAL_RUNTIME: "1",
    LEDGERLY_LOCAL_DB_DIR: directory,
    WHOP_MODE: "mock",
    DEMO_MODE: "1",
    DEMO_PROFILES_ENABLED: "1",
    APP_BASE_URL: origin,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    WHOP_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
    WHOP_API_VERSION_DATE: "2026-08-21",
    ONBOARDING_RETURN_URL: `${origin}/sell`,
    ONBOARDING_REFRESH_URL: `${origin}/sell`,
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("WHOP_API_KEY", undefined);
  const local = getLocalRuntime(env);
  await local.ready;
  try {
    context.headers = new Headers({ host: "127.0.0.1:4474", origin });
    const signed = await profile(
      new Request(`${origin}/demo/profile/buyer`, { headers: context.headers }),
      { params: Promise.resolve({ role: "buyer" }) },
    );
    expect(signed.status).toBe(303);
    const cookie = signed.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    context.headers = new Headers({ host: "127.0.0.1:4474", origin, cookie });
    const principal = await getSession();
    expect(principal?.role).toBe("buyer");
    const run = runId(principal?.demoRunId ?? "");
    if (!run.ok || !principal) throw new Error("Missing actual profile scope");
    const server = getServer();
    const commerce = getCommerce();
    const onboarded = await server.onboardSeller({
      runId: run.value,
      externalId: "binding-seller",
      email: "binding@ledgerly.test",
      country: "BR",
    });
    if (!onboarded.ok) throw new Error("Onboarding failed");
    const created = await commerce.createOrder({
      runId: run.value,
      sellerId: onboarded.value.seller.id,
      productTitle: "Binding fixture",
      gross: { amountMinor: 2500, currency: "USD" },
      buyerUserId: principal.userId,
    });
    if (!created.ok) throw new Error("Checkout failed");
    const order = created.value;
    const request = (path: string, body?: unknown) =>
      new Request(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: context.headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect(
      (await checkout(request("/api/local-runtime/checkout", { orderId: order.id }))).status,
    ).toBe(200);
    const paid = await commerce.orders.get(order.id);
    const event = {
      orderId: order.id,
      deliveryId: "replay-one",
      resourceId: paid?.paymentId,
      type: "payment.succeeded",
      amountMinor: 2500,
      currency: "USD",
    };
    const replay = await sendEvent(request("/api/local-runtime/events", event));
    expect(replay.status).toBe(200);
    const result = await replay.json();
    expect(result).toMatchObject({
      status: "processed",
      terminal: true,
      order_id: order.id,
      run_id: run.value,
    });
    expect(await commerce.ledger.forSeller(order.sellerId)).toHaveLength(2);
    const persisted = await readEvent(
      request(`/api/local-runtime/events?orderId=${order.id}&deliveryId=${result.delivery_id}`),
    );
    expect(await persisted.json()).toMatchObject({ status: "processed", terminal: true });
    const invalid = await sendEvent(
      request("/api/local-runtime/events", {
        ...event,
        deliveryId: "tamper",
        signatureCase: "tampered",
      }),
    );
    expect(invalid.status).toBe(422);
    const refund = await sendEvent(
      request("/api/local-runtime/events", {
        ...event,
        deliveryId: "refund",
        type: "refund.created",
        resourceId: "refund-one",
      }),
    );
    expect(refund.status).toBe(200);
    expect(await refund.json()).toMatchObject({ status: "processed", terminal: true });
    expect((await commerce.orders.get(order.id))?.status).toBe("refunded");
    const reversed = await commerce.ledger.forSeller(order.sellerId);
    expect(reversed).toHaveLength(4);
    expect(reversed.reduce((sum, row) => sum + row.amount.amountMinor, 0)).toBe(0);
    expect(
      (await checkout(request("/api/local-runtime/checkout", { orderId: order.id }))).status,
    ).toBe(409);
    const paymentId = whopPaymentId(paid?.paymentId ?? "");
    if (!paymentId.ok || !server.simulator) throw new Error("Missing paid simulator fixture");
    const providerBeforeGuard = server.simulator.snapshotState();
    const rejectedMutation = vi.fn(async () => undefined);
    if (!server.localRefundIsolation) throw new Error("Missing refund isolation");
    await expect(
      server.localRefundIsolation.guardRefund(paymentId.value, rejectedMutation),
    ).rejects.toThrow("local_refund_isolated");
    expect(rejectedMutation).not.toHaveBeenCalled();
    // The provider adds telemetry around the same guarded simulator. Verify both
    // entry points preserve the guard, while the provider records the denied call.
    const guarded = await instrumented(async () => {
      const selected = getServer();
      expect(selected).toBe(server);
      expect(
        await selected.provider.refundPayment(paymentId.value, "ordinary-after-isolation"),
      ).toMatchObject({ ok: false, error: { kind: "invalid_request" } });
      return Response.json({ checked: true });
    })(request("/api/guard-check"));
    expect(guarded.status).toBe(200);
    expect(
      await server.simulator.refundPayment(paymentId.value, "alias-after-isolation"),
    ).toMatchObject({ ok: false, error: { kind: "invalid_request" } });
    const guardCorrelation = guarded.headers.get("x-ledgerly-correlation-id");
    if (!guardCorrelation) throw new Error("Missing guarded request correlation");
    await vi.waitFor(async () => {
      const events = await listInstrumentationEvents(server.db, {
        correlationId: guardCorrelation,
      });
      const providerEvents = events.filter((event) => event.source === "whop");
      expect(providerEvents).toHaveLength(2);
      expect(providerEvents.map((event) => event.phase)).toEqual(["start", "end"]);
      expect(providerEvents[1]).toMatchObject({
        provenance: "mock",
        status: "error",
        safeIds: { mock_result: "failed" },
      });
    });
    expect(await commerce.ledger.forSeller(order.sellerId)).toEqual(reversed);
    expect((await commerce.orders.get(order.id))?.status).toBe("refunded");
    expect(server.simulator.snapshotState()).toEqual(providerBeforeGuard);
    expect(existsSync(join(directory, "mock-provider.pending"))).toBe(false);
    const now = new Date();
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const ordinaryId = "ordinary_isolated_refund";
    const rawBody = JSON.stringify({
      id: ordinaryId,
      type: "refund.created",
      api_version: "v1",
      api_version_date: "2026-08-21",
      timestamp: now.toISOString(),
      account_id: "biz_platform_sim",
      data: {
        id: "refund_ordinary",
        payment_id: paymentId.value,
        checkout_configuration_id: order.checkoutConfigurationId,
        amount_minor: "2500",
        currency: "usd",
      },
    });
    const secret = server.webhookSecret();
    const received = await server.receiveWebhook({
      rawBody,
      now,
      secret,
      headers: {
        "webhook-id": ordinaryId,
        "webhook-timestamp": timestamp,
        "webhook-signature": signStandardWebhook({ rawBody, id: ordinaryId, timestamp, secret }),
      },
    });
    expect(received.ok && received.value.row.status).toBe("quarantined");
    await server.processInbox({ limit: 100 });
    await server.processLocalDelivery(ordinaryId);
    expect(await commerce.ledger.forSeller(order.sellerId)).toEqual(reversed);
    const parsedDelivery = deliveryId(ordinaryId);
    if (!parsedDelivery.ok) throw new Error("Invalid delivery fixture");
    expect((await server.uow.run((repos) => repos.inbox.get(parsedDelivery.value))).status).toBe(
      "quarantined",
    );
    const late = await sendEvent(
      request("/api/local-runtime/events", { ...event, deliveryId: "late-payment" }),
    );
    expect(late.status).toBe(200);
    expect((await commerce.orders.get(order.id))?.status).toBe("refunded");
    expect(await commerce.ledger.forSeller(order.sellerId)).toEqual(reversed);
    // A signed ordinary refund already queued before isolation permanently owns its payment.
    const queuedOrder = await commerce.createOrder({
      runId: run.value,
      sellerId: order.sellerId,
      productTitle: "Queued ordinary refund",
      gross: { amountMinor: 2500, currency: "USD" },
      buyerUserId: principal.userId,
    });
    if (!queuedOrder.ok) throw new Error("Queue fixture checkout failed");
    expect(
      (await checkout(request("/api/local-runtime/checkout", { orderId: queuedOrder.value.id })))
        .status,
    ).toBe(200);
    const queuedPaid = await commerce.orders.get(queuedOrder.value.id);
    const queueId = "ordinary_prequeued_refund";
    const queueBody = JSON.stringify({
      ...JSON.parse(rawBody),
      id: queueId,
      data: {
        id: "refund_prequeued",
        payment_id: queuedPaid?.paymentId,
        checkout_configuration_id: queuedOrder.value.checkoutConfigurationId,
        amount_minor: "2500",
        currency: "usd",
      },
    });
    const queued = await server.receiveWebhook({
      rawBody: queueBody,
      now,
      secret,
      headers: {
        "webhook-id": queueId,
        "webhook-timestamp": timestamp,
        "webhook-signature": signStandardWebhook({
          rawBody: queueBody,
          id: queueId,
          timestamp,
          secret,
        }),
      },
    });
    expect(queued.ok && queued.value.row.status).toBe("received");
    const denied = await sendEvent(
      request("/api/local-runtime/events", {
        ...event,
        orderId: queuedOrder.value.id,
        resourceId: "synthetic-on-ordinary",
        deliveryId: "queue-conflict",
        type: "refund.created",
      }),
    );
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: "refund_safety_required" });
    await server.processLocalDelivery(queueId);
    expect((await commerce.orders.get(queuedOrder.value.id))?.status).toBe("refunded");
    // Direct orders retain ordinary provider refunds, but synthetic injection cannot claim them.
    const directSeller = await server.onboardSeller({
      runId: run.value,
      externalId: "direct-negative",
      email: "direct-negative@ledgerly.test",
      country: "US",
    });
    if (!directSeller.ok) throw new Error("Direct fixture failed");
    const directOrder = await commerce.createOrder({
      runId: run.value,
      sellerId: directSeller.value.seller.id,
      productTitle: "Direct negative",
      gross: { amountMinor: 2500, currency: "USD" },
      buyerUserId: principal.userId,
    });
    if (!directOrder.ok) throw new Error("Direct checkout failed");
    expect(
      (await checkout(request("/api/local-runtime/checkout", { orderId: directOrder.value.id })))
        .status,
    ).toBe(200);
    const directRows = await commerce.ledger.forSeller(directSeller.value.seller.id);
    const deniedDirect = await sendEvent(
      request("/api/local-runtime/events", {
        ...event,
        orderId: directOrder.value.id,
        type: "refund.created",
        deliveryId: "direct-negative",
        resourceId: "direct-refund",
      }),
    );
    expect(deniedDirect.status).toBe(409);
    expect(await deniedDirect.json()).toMatchObject({ error: "refund_safety_required" });
    expect((await commerce.orders.get(directOrder.value.id))?.status).toBe("paid");
    expect(await commerce.ledger.forSeller(directSeller.value.seller.id)).toEqual(directRows);
    // The same safeguards survive a database/provider close and reopen.
    await local.close();
    const restarted = getServer();
    await restarted.ready;
    expect(
      (await restarted.provider.refundPayment(paymentId.value, "restart-ordinary-refund")).ok,
    ).toBe(false);
    expect(existsSync(join(directory, "mock-provider.pending"))).toBe(false);
    const persistedAfterRestart = await readEvent(
      request(`/api/local-runtime/events?orderId=${order.id}&deliveryId=${result.delivery_id}`),
    );
    expect(persistedAfterRestart.status).toBe(200);
    expect(await persistedAfterRestart.json()).toMatchObject({
      status: "processed",
      terminal: true,
    });
    context.headers = new Headers({
      host: "127.0.0.1:4474",
      origin,
      cookie: cookie
        .split("; ")
        .filter((v) => !v.startsWith("ledgerly_demo_profile="))
        .join("; "),
    });
    expect((await sendEvent(request("/api/local-runtime/events", event))).status).toBe(401);
  } finally {
    await getLocalRuntime(env).close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
