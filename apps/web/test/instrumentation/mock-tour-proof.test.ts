import type { NewOrder, OrderId } from "@ledgerly/core";
import { afterEach, expect, it } from "vitest";
import { runId } from "../../../../packages/core/src/ids";
import { createOrdersRepo } from "../../../../packages/db/src/repos/orders";
import {
  mapTourInstrumentation,
  type PersistedInstrumentationRow,
} from "../../../../packages/demo-runtime/src/instrumentation";
import { reduceTour } from "../../../../packages/demo-runtime/src/tour";
import { createWhopAdapter } from "../../../../packages/whop/src/index";
import { createMockAdapter } from "../../../../packages/whop/src/mock-adapter";
import {
  bindInstrumentationEmitter,
  correlatedEmitter,
  instrumented,
  setInstrumentationEmitter,
} from "../../src/lib/instrument";

afterEach(() => setInstrumentationEmitter());

async function observedOnboarding() {
  const rows: PersistedInstrumentationRow[] = [];
  const emitter = correlatedEmitter({
    emit(event) {
      rows.push({ ...event, id: `event_${rows.length}`, seq: rows.length + 1 });
    },
  });
  const provider = createWhopAdapter(
    { WHOP_MODE: "mock" },
    { mock: createMockAdapter(), onEvent: emitter.emit },
  );
  const run = runId("run_mockproof");
  if (!run.ok) throw new Error("Invalid fixture run");
  const response = await instrumented(async () => {
    bindInstrumentationEmitter(emitter);
    const account = await provider.createOrFetchAccount(
      {
        externalId: "proof_seller",
        title: "Fixture seller",
        email: "private@example.invalid",
        country: "US",
        runId: run.value,
      },
      "fixture_account",
    );
    if (!account.ok) throw new Error("Fixture account failed");
    // Explicit committed-transaction fixture, matching the existing UoW event shape.
    // This test proves mapper/reducer integration, not database persistence.
    emitter.emit({
      source: "db",
      phase: "end",
      path: "run",
      status: "ok",
      safeIds: {},
      correlationId: "uncorrelated",
      provenance: "pglite",
      summary: "db transaction committed",
      at: new Date(),
    });
    const read = await provider.getAccount(account.value.id, "fixture_read");
    if (!read.ok) throw new Error("Fixture read failed");
    return Response.json(
      {
        id: "seller_proof",
        whop_account_id: account.value.id,
        account: read.value,
        provenance: "mock",
      },
      { status: 201 },
    );
  })(
    new Request("https://fixture.invalid/api/sellers", {
      method: "POST",
      headers: { "x-demo-run": run.value, "x-ledgerly-correlation-id": "corr_mockproof" },
    }),
  );
  expect(response.status).toBe(201);
  return {
    rows,
    emitter,
    provider,
    account: rows.find((row) => row.safeIds?.account_id)?.safeIds?.account_id,
  };
}

it("accepts actual successful mock calls plus matching committed-account readback without invented HTTP", async () => {
  const { rows } = await observedOnboarding();
  const events = mapTourInstrumentation(rows, "run_mockproof");
  const step = reduceTour(events).steps[0];
  expect(step?.status).toBe("passed");
  expect(step?.proof.level).toBe("mock-ok");
  expect(step?.proof.observed.tour_durable_account).toBe("true");
  const calls = events.filter((event) => event.kind === "operation.responded");
  expect(calls).toHaveLength(2);
  expect(
    calls.every(
      (event) =>
        event.source === "mock" &&
        event.provider?.http_status === null &&
        event.payload.mock_outcome === "succeeded",
    ),
  ).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("private@example.invalid");
});

it.each([
  "absent",
  "unknown",
  "failed",
  "wrong-operation",
  "wrong-run",
  "wrong-correlation",
  "wrong-account",
  "rollback",
  "sandbox-without-http",
])("rejects %s evidence for the durable-account alternative", async (variant) => {
  let { rows } = await observedOnboarding();
  rows = rows.flatMap((row) => {
    if (variant === "rollback" && row.source === "db")
      return [{ ...row, status: "error" as const }];
    if (row.source !== "whop" || row.phase !== "end") return [row];
    if (variant === "absent") return [];
    if (variant === "unknown") return [{ ...row, status: null, safeIds: {} }];
    if (variant === "failed")
      return [{ ...row, status: "error" as const, safeIds: { mock_result: "failed" } }];
    if (variant === "wrong-operation") return [{ ...row, path: "/unrelated" }];
    if (variant === "wrong-run") return [{ ...row, runId: "run_foreign" }];
    if (variant === "wrong-correlation") return [{ ...row, correlationId: "corr_foreign" }];
    if (variant === "wrong-account" && row.method === "GET")
      return [{ ...row, path: "/accounts/biz_foreign" }];
    if (variant === "sandbox-without-http") return [{ ...row, provenance: "sandbox" as const }];
    return [row];
  });
  const state = reduceTour(mapTourInstrumentation(rows, "run_mockproof"));
  expect(state.steps[0]?.status).not.toBe("passed");
});

it("maps actual mock onboarding and checkout operations with autocommit order events through C03", async () => {
  const { rows, emitter, provider } = await observedOnboarding();
  const account = await provider.createOrFetchAccount(
    {
      externalId: "proof_seller",
      title: "Fixture seller",
      email: "private@example.invalid",
      country: "US",
      runId: "run_mockproof" as Parameters<typeof provider.createOrFetchAccount>[0]["runId"],
    },
    "fixture_account",
  );
  if (!account.ok) throw new Error("Fixture account failed");
  const invoke = (path: string, method: string, handler: () => Promise<Response>) =>
    instrumented(async () => {
      bindInstrumentationEmitter(emitter);
      return handler();
    })(
      new Request(`https://fixture.invalid${path}`, {
        method,
        headers: {
          "x-demo-run": "run_mockproof",
          "x-ledgerly-correlation-id": `corr_${rows.length}`,
        },
      }),
    );
  await invoke("/api/sellers/seller_proof/onboarding-link", "POST", async () => {
    const link = await provider.createOnboardingLink(
      {
        accountId: account.value.id,
        returnUrl: "https://fixture.invalid/return",
        refreshUrl: "https://fixture.invalid/refresh",
      },
      "fixture_link",
    );
    if (!link.ok) throw new Error("Fixture onboarding failed");
    return Response.json({ url: link.value.url });
  });
  await invoke("/api/products", "POST", async () =>
    Response.json({ id: "product_proof" }, { status: 201 }),
  );
  const row = {
    id: "order_proof",
    runId: "run_mockproof",
    sellerId: "seller_proof",
    productTitle: "Fixture",
    productExternalId: "product_proof",
    grossMinor: 1000,
    feeMinor: 100,
    currency: "USD",
    flow: "direct",
    checkoutConfigurationId: null,
    purchaseUrl: null,
    status: "pending",
    createdAt: new Date(),
    provenance: "mock",
    buyerUserId: null,
    paymentId: null,
  };
  // A resolved autocommit RETURNING fixture exercises the production repository emitter.
  // Actual database and paid-order persistence remain runtime/QA verification.
  const db = {
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: async () => [row] }) }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: async () => [{ ...row, status: "checkout_created" }] }),
      }),
    }),
  };
  const orders = createOrdersRepo(db as unknown as Parameters<typeof createOrdersRepo>[0], {
    emitter,
    provenance: "pglite",
  });
  await invoke("/api/checkouts", "POST", async () => {
    await orders.createOrFetch(
      {
        runId: row.runId,
        sellerId: row.sellerId,
        productTitle: row.productTitle,
        gross: { amountMinor: 1000, currency: "USD" },
        fee: { amountMinor: 100, currency: "USD" },
        flow: "direct",
      } as NewOrder,
      row.id as OrderId,
    );
    const checkout = await provider.createCheckoutConfiguration(
      {
        accountId: account.value.id,
        productTitle: "Fixture",
        price: { amountMinor: 1000, currency: "USD" } as Parameters<
          typeof provider.createCheckoutConfiguration
        >[0]["price"],
        applicationFee: null,
        redirectUrl: "https://fixture.invalid/receipt",
      },
      "fixture_checkout",
    );
    if (!checkout.ok) throw new Error("Fixture checkout failed");
    await orders.setCheckout(row.id as OrderId, {
      checkoutConfigurationId: checkout.value.id,
      purchaseUrl: checkout.value.purchaseUrl ?? null,
      status: "checkout_created",
      provenance: "mock",
    });
    return Response.json({ order_id: row.id }, { status: 201 });
  });
  expect(reduceTour(mapTourInstrumentation(rows, "run_mockproof")).steps[2]?.status).not.toBe(
    "passed",
  );
  await invoke("/api/orders/order_proof", "GET", async () =>
    Response.json({
      id: "order_proof",
      payment_id: "pay_proof",
      status: "paid",
      seller: { id: "seller_proof" },
      product: { id: "product_proof" },
    }),
  );
  const state = reduceTour(mapTourInstrumentation(rows, "run_mockproof"));
  expect(state.steps.slice(0, 3).map((step) => step.status)).toEqual([
    "passed",
    "passed",
    "passed",
  ]);
  const withoutOrderWrites = rows.filter((row) => row.source !== "db" || row.path !== "orders");
  expect(
    reduceTour(mapTourInstrumentation(withoutOrderWrites, "run_mockproof")).steps[2]?.status,
  ).not.toBe("passed");
  const withoutMockOutcomes = rows.map((row) =>
    row.source === "whop" ? { ...row, status: null, safeIds: {} } : row,
  );
  const missing = reduceTour(mapTourInstrumentation(withoutMockOutcomes, "run_mockproof"));
  expect(missing.steps[1]?.status).not.toBe("passed");
  expect(missing.steps[2]?.status).not.toBe("passed");
});
