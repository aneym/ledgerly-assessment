import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Result, runId } from "@ledgerly/core";
import { getLocalRuntime } from "@ledgerly/db";
import { expect, it, vi } from "vitest";
import { signStandardWebhook } from "../../../packages/whop/src/webhooks";
import { POST as completeLocalCheckout } from "../src/app/api/local-runtime/checkout/route";
import { createAdminResolution } from "../src/lib/admin-resolution";
import { buildAuth } from "../src/lib/auth";
import { createCommerce } from "../src/lib/commerce";
import { getServer } from "../src/lib/server";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function present(value: string | undefined): string {
  if (!value) throw new Error("Expected configured local test value");
  return value;
}

it("shares local auth, onboarding, checkout, settlement and operator recovery state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ledgerly-local-flow-"));
  const origin = "http://127.0.0.1:4474";
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "development",
    LEDGERLY_TEST_MODE: "1",
    LEDGERLY_LOCAL_RUNTIME: "1",
    LEDGERLY_LOCAL_DB_DIR: directory,
    WHOP_MODE: "mock",
    DEMO_MODE: "1",
    WHOP_DEMO_FALLBACK: "1",
    APP_BASE_URL: origin,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    WHOP_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
    WHOP_API_VERSION_DATE: "2026-08-21",
    ONBOARDING_RETURN_URL: `${origin}/seller`,
    ONBOARDING_REFRESH_URL: `${origin}/seller`,
  };
  for (const [key, setting] of Object.entries(env)) vi.stubEnv(key, setting);
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("VERCEL", undefined);
  vi.stubEnv("VERCEL_ENV", undefined);
  try {
    const server = getServer(env);
    await server.ready;
    const commerce = createCommerce(env);
    const admin = createAdminResolution(env);
    const auth = buildAuth(env);
    expect(commerce.db).toBe(server.db);
    expect(commerce.provider).toBe(server.provider);
    const password = randomBytes(24).toString("hex");
    const identities = new Map<string, string>();
    const sessionCookies = new Map<string, string>();
    for (const role of ["buyer", "seller", "operator"] as const) {
      const email = `${role}@local-flow.example.invalid`;
      const signUp = await auth.handler(
        new Request(`${origin}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { host: "127.0.0.1:4474", "content-type": "application/json", origin },
          body: JSON.stringify({ name: `Fictional ${role}`, email, password }),
        }),
      );
      expect(signUp.status).toBe(200);
      const created = await signUp.json();
      expect(await commerce.users.getRole(created.user.id)).toBe("buyer");
      if (role !== "buyer") await commerce.users.setRole(created.user.id, role);
      const signIn = await auth.handler(
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { host: "127.0.0.1:4474", "content-type": "application/json", origin },
          body: JSON.stringify({ email, password }),
        }),
      );
      expect(signIn.status).toBe(200);
      const cookies = signIn.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      sessionCookies.set(role, cookies);
      const sessionResponse = await auth.handler(
        new Request(`${origin}/api/auth/get-session`, {
          headers: { host: "127.0.0.1:4474", cookie: cookies },
        }),
      );
      expect(sessionResponse.status).toBe(200);
      const session = await sessionResponse.json();
      expect(session.user).toMatchObject({ id: created.user.id, role });
      identities.set(role, created.user.id);
    }
    const run = value(runId("run_local_flow"));
    const onboarded = await server.onboardSeller({
      runId: run,
      externalId: "fictional-studio",
      email: "seller@local-flow.example.invalid",
      country: "US",
    });
    if (!onboarded.ok) throw new Error(JSON.stringify(onboarded.error));
    const seller = onboarded.value.seller;
    if (!seller.whopAccountId) throw new Error("Expected connected fictional seller");
    await commerce.users.attachSellerOwner(seller.id, present(identities.get("seller")));
    expect(await commerce.users.getSellerIdForUser(present(identities.get("seller")))).toBe(
      seller.id,
    );
    const order = value(
      await commerce.createOrder({
        runId: run,
        sellerId: seller.id,
        productTitle: "Fictional studio guide",
        gross: { amountMinor: 2500, currency: "USD" },
        buyerUserId: present(identities.get("buyer")),
      }),
    );
    expect(order).toMatchObject({
      status: "checkout_created",
      provenance: "mock",
      fee: { amountMinor: 200, currency: "USD" },
    });
    const simulator = server.simulator;
    if (!simulator) throw new Error("Expected explicit local mock simulator");
    const checkoutRequest = (role: string, requestOrigin = origin) =>
      new Request(`${origin}/api/local-runtime/checkout`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:4474",
          "content-type": "application/json",
          origin: requestOrigin,
          cookie: present(sessionCookies.get(role)),
        },
        body: JSON.stringify({ orderId: order.id }),
      });
    expect((await completeLocalCheckout(checkoutRequest("operator"))).status).toBe(404);
    expect(
      (await completeLocalCheckout(checkoutRequest("buyer", "https://outside.example.invalid")))
        .status,
    ).toBe(403);
    expect(await commerce.ledger.forSeller(seller.id)).toHaveLength(0);
    const completed = await completeLocalCheckout(checkoutRequest("buyer"));
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      status: "paid",
      provenance: "mock",
      order_id: order.id,
    });
    const paid = await commerce.orders.get(order.id);
    const payment = { id: present(paid?.paymentId ?? undefined) };
    expect((await completeLocalCheckout(checkoutRequest("buyer"))).status).toBe(200);
    async function deliverPayment(id: string, paymentId: string, checkoutId?: string | null) {
      const now = new Date();
      const timestamp = String(Math.floor(now.getTime() / 1000));
      const rawBody = JSON.stringify({
        id,
        type: "payment.succeeded",
        api_version: "v1",
        api_version_date: "2026-08-21",
        timestamp: now.toISOString(),
        account_id: seller.whopAccountId,
        data: {
          id: paymentId,
          amount_minor: "2500",
          currency: "usd",
          ...(checkoutId ? { checkout_configuration_id: checkoutId } : {}),
        },
      });
      const secret = present(env.WHOP_WEBHOOK_SECRET);
      value(
        await server.receiveWebhook({
          rawBody,
          now,
          secret,
          headers: {
            "webhook-id": id,
            "webhook-timestamp": timestamp,
            "webhook-signature": signStandardWebhook({ rawBody, id, timestamp, secret }),
          },
        }),
      );
      return server.processInbox({ limit: 20 });
    }
    expect(await commerce.orders.get(order.id)).toMatchObject({
      status: "paid",
      paymentId: payment.id,
      buyerUserId: identities.get("buyer"),
      provenance: "mock",
    });
    expect(
      (await commerce.orders.listForBuyer(present(identities.get("buyer")), { limit: 10 })).orders,
    ).toHaveLength(1);
    expect((await commerce.getEarnings(seller.id)).totals).toEqual([
      { currency: "USD", total: { amountMinor: 2300, currency: "USD" } },
    ]);
    expect(await commerce.ledger.forSeller(seller.id)).toHaveLength(2);
    await deliverPayment("local_payment_redelivery", payment.id, order.checkoutConfigurationId);
    expect(await commerce.ledger.forSeller(seller.id)).toHaveLength(2);

    const seeded = simulator.seedPayment(
      { amountMinor: 2500, currency: "USD" },
      seller.whopAccountId,
    );
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const missingPayment = seeded.value;
    const incident = value(
      await admin.injectFault({
        sellerId: seller.id,
        paymentId: missingPayment.id,
        provenance: "mock",
      }),
    );
    expect(incident).toMatchObject({
      kind: "missing_local_payment",
      status: "detected",
      simulated: true,
      provenance: "mock",
    });
    const action = {
      caseId: incident.id,
      action: "import_confirmed" as const,
      idempotencyKey: "local-import",
      actorUserId: present(identities.get("operator")),
    };
    expect(value(await admin.resolution.runAction(admin.provider, action)).case.status).toBe(
      "rechecking",
    );
    value(await admin.resolution.runAction(admin.provider, action));
    expect(await commerce.ledger.forSeller(seller.id)).toHaveLength(4);
    const recovered = value(
      await admin.resolution.runAction(admin.provider, {
        ...action,
        action: "recheck",
        idempotencyKey: "local-recheck",
      }),
    );
    expect(recovered.case.status).toBe("resolved");
    expect(
      (await admin.listActionsForCase(incident.id)).filter(
        (item) => item.actorUserId === identities.get("operator"),
      ),
    ).toHaveLength(2);
    await deliverPayment("local_recovered_late_webhook", missingPayment.id);
    expect(await commerce.ledger.forSeller(seller.id)).toHaveLength(4);
    expect((await commerce.getEarnings(seller.id)).totals).toEqual([
      { currency: "USD", total: { amountMinor: 4600, currency: "USD" } },
    ]);
    // Ordinary direct refunds still call the mock provider and deliver a real signed event.
    const directRefund = await commerce.provider.refundPayment(
      payment.id as Parameters<typeof commerce.provider.refundPayment>[0],
      "direct-full-refund",
    );
    expect(directRefund.ok).toBe(true);
    await server.processInbox({ limit: 100 });
    expect((await commerce.orders.get(order.id))?.status).toBe("refunded");
    const afterRefund = await commerce.ledger.forSeller(seller.id);
    expect(afterRefund).toHaveLength(6);
    expect(
      afterRefund
        .filter((row) => row.resourceType === "refund")
        .map((row) => row.amount.amountMinor)
        .sort((a, b) => a - b),
    ).toEqual([-2300, -200]);
    expect((await completeLocalCheckout(checkoutRequest("buyer"))).status).toBe(409);
    await deliverPayment("local_paid_after_refund", payment.id, order.checkoutConfigurationId);
    expect((await commerce.orders.get(order.id))?.status).toBe("refunded");
    expect(await commerce.ledger.forSeller(seller.id)).toEqual(afterRefund);
  } finally {
    await getLocalRuntime(env).close();
    vi.unstubAllEnvs();
  }
}, 60_000);
