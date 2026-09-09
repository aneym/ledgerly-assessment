import { describe, expect, it } from "vitest";
import { sellerId } from "../../../../packages/core/src/ids";
import type { Result } from "../../../../packages/core/src/result";
import type { Seller } from "../../../../packages/core/src/services/ports";
import type {
  ResolutionAction,
  ResolutionCase,
} from "../../../../packages/core/src/services/resolution";
import {
  createDemoFaultHandler,
  type DemoFaultDeps,
} from "../../src/app/api/admin/issues/demo-fault/route";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const SELLER_ID = value(sellerId("seller_1"));
const NOW = new Date("2026-09-08T12:00:00.000Z");

function seller(overrides: Partial<Seller> = {}): Seller {
  return {
    id: SELLER_ID,
    runId: "run_1" as Seller["runId"],
    externalId: "ext_1",
    email: "seller@example.invalid",
    country: "US",
    whopAccountId: "biz_1" as Seller["whopAccountId"],
    ...overrides,
  };
}

function kase(overrides: Partial<ResolutionCase> = {}): ResolutionCase {
  return {
    id: "case_1",
    kind: "missing_local_payment",
    status: "detected",
    sellerId: SELLER_ID,
    orderId: null,
    providerResourceType: "payment",
    providerResourceId: "pay_1",
    expected: { amountMinor: 2500, currency: "USD" },
    observed: null,
    impact:
      "Demo fault: the provider confirms payment pay_1 as paid, but its ledger effect was deliberately withheld.",
    nextSafeAction: "refetch",
    assignedTo: null,
    provenance: "mock",
    simulated: true,
    openedAt: new Date("2026-09-08T11:00:00.000Z"),
    updatedAt: new Date("2026-09-08T11:00:00.000Z"),
    resolvedAt: null,
    correlationId: null,
    ...overrides,
  };
}

function demoFaultAction(overrides: Partial<ResolutionAction> = {}): ResolutionAction {
  return {
    id: "action_1",
    caseId: "case_1",
    action: "note",
    actorUserId: "system:demo-fault",
    idempotencyKey: "demo_fault:case_1",
    outcome: "succeeded",
    detail: { note: "demo fault injected" },
    at: new Date("2026-09-08T11:00:00.000Z"),
    ...overrides,
  };
}

function baseDeps(overrides: Partial<DemoFaultDeps> = {}): DemoFaultDeps {
  return {
    getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
    isDemoMode: () => true,
    injectFault: () => Promise.resolve({ ok: true, value: kase() }),
    listActionsForCase: () => Promise.resolve([demoFaultAction()]),
    getSeller: () => Promise.resolve(seller()),
    now: () => NOW,
    ...overrides,
  };
}

function post(body: unknown = { seller_id: "seller_1", payment_id: "pay_1" }, query = "") {
  return new Request(`https://example.invalid/api/admin/issues/demo-fault${query}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("createDemoFaultHandler", () => {
  const readFaultRequest = (body: object = {}, run = "run_readfault") =>
    new Request("https://example.invalid/api/admin/issues/demo-fault?kind=missing_local_payment", {
      method: "POST",
      headers: { "x-demo-run": run },
      body: JSON.stringify({
        seller_id: "seller_1",
        fresh: true,
        provider_outcome: "uncertain",
        ...body,
      }),
    });

  it.each([
    { name: "non-demo", isDemoMode: () => false, status: 404 },
    { name: "signed out", getSession: async () => null, status: 401 },
    { name: "seller", getSession: async () => ({ userId: "seller", role: "seller" }), status: 403 },
    {
      name: "demo persona",
      getSession: async () => ({ userId: "demo", role: "demo", demoRunId: "run_readfault" }),
      status: 403,
    },
    { name: "fallback disabled", isDemoReadFaultEnabled: () => false, status: 400 },
  ])(
    "rejects unknown-read fixture for $name before injection",
    async ({ name: _name, status, ...overrides }) => {
      let injected = false;
      const handler = createDemoFaultHandler(
        baseDeps({
          isDemoReadFaultEnabled: () => true,
          getSeller: async () => seller({ runId: "run_readfault" as Seller["runId"] }),
          ...overrides,
          injectFault: async () => {
            injected = true;
            return { ok: true, value: kase() };
          },
        }),
      );
      expect((await handler(readFaultRequest())).status).toBe(status);
      expect(injected).toBe(false);
    },
  );

  it.each([
    { body: { fresh: false }, run: "run_readfault" },
    { body: { payment_id: "pay_existing" }, run: "run_readfault" },
    { body: {}, run: "malformed" },
    { body: {}, run: "run_" },
    { body: {}, run: "run_has_separator" },
  ])("rejects nonfresh or malformed unknown-read fixture %j", async ({ body, run }) => {
    let injected = false;
    const handler = createDemoFaultHandler(
      baseDeps({
        isDemoReadFaultEnabled: () => true,
        injectFault: async () => {
          injected = true;
          return { ok: true, value: kase() };
        },
      }),
    );
    expect((await handler(readFaultRequest(body, run))).status).toBe(400);
    expect(injected).toBe(false);
  });

  it("passes only the explicit fresh mock read fixture through the operator gate", async () => {
    let received: unknown;
    const handler = createDemoFaultHandler(
      baseDeps({
        isDemoReadFaultEnabled: () => true,
        injectFault: async (input) => {
          received = input;
          return { ok: true, value: kase() };
        },
      }),
    );
    expect((await handler(readFaultRequest())).status).toBe(201);
    expect(received).toEqual({
      sellerId: SELLER_ID,
      paymentId: "",
      fresh: true,
      runId: "run_readfault",
      providerOutcome: "uncertain",
      provenance: "mock",
    });
  });

  it.each(["ledgerly_demo_run=run_other", "ledgerly_demo_run=%invalid"])(
    "refuses conflicting or malformed run cookies %s",
    async (cookie) => {
      let injected = false;
      const request = readFaultRequest();
      request.headers.set("cookie", cookie);
      const handler = createDemoFaultHandler(
        baseDeps({
          isDemoReadFaultEnabled: () => true,
          injectFault: async () => {
            injected = true;
            return { ok: true, value: kase() };
          },
        }),
      );
      expect((await handler(request)).status).toBe(400);
      expect(injected).toBe(false);
    },
  );

  it("returns 404 when DEMO_MODE is off, before even checking the session", async () => {
    let sessionChecked = false;
    const handler = createDemoFaultHandler(
      baseDeps({
        isDemoMode: () => false,
        getSession: () => {
          sessionChecked = true;
          return Promise.resolve({ userId: "op_1", role: "operator" });
        },
      }),
    );
    const response = await handler(post());
    expect(response.status).toBe(404);
    expect(sessionChecked).toBe(false);
  });

  it("returns 401 when signed out", async () => {
    const handler = createDemoFaultHandler(baseDeps({ getSession: () => Promise.resolve(null) }));
    const response = await handler(post());
    expect(response.status).toBe(401);
  });

  it("returns 403 for a seller session", async () => {
    const handler = createDemoFaultHandler(
      baseDeps({ getSession: () => Promise.resolve({ userId: "seller_user", role: "seller" }) }),
    );
    const response = await handler(post());
    expect(response.status).toBe(403);
  });

  it("returns 400 for an unsupported kind query param", async () => {
    const handler = createDemoFaultHandler(baseDeps());
    const response = await handler(post(undefined, "?kind=unconfirmed_transfer"));
    expect(response.status).toBe(400);
  });

  it("accepts kind=missing_local_payment", async () => {
    const handler = createDemoFaultHandler(baseDeps());
    const response = await handler(post(undefined, "?kind=missing_local_payment"));
    expect(response.status).toBe(201);
  });

  it("accepts an omitted kind query param", async () => {
    const handler = createDemoFaultHandler(baseDeps());
    const response = await handler(post());
    expect(response.status).toBe(201);
  });

  it("returns 400 for a missing payment_id", async () => {
    const handler = createDemoFaultHandler(baseDeps());
    const response = await handler(post({ seller_id: "seller_1" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid seller_id", async () => {
    const handler = createDemoFaultHandler(baseDeps());
    const response = await handler(post({ seller_id: "", payment_id: "pay_1" }));
    expect(response.status).toBe(400);
  });

  it("returns 422 when the seller is not connected", async () => {
    const handler = createDemoFaultHandler(
      baseDeps({
        injectFault: () => Promise.resolve({ ok: false, error: { kind: "seller_not_connected" } }),
      }),
    );
    const response = await handler(post());
    expect(response.status).toBe(422);
  });

  it("returns 422 when the payment is not confirmed at the provider", async () => {
    const handler = createDemoFaultHandler(
      baseDeps({
        injectFault: () => Promise.resolve({ ok: false, error: { kind: "payment_not_confirmed" } }),
      }),
    );
    const response = await handler(post());
    expect(response.status).toBe(422);
  });

  it("returns 404 when the service itself reports demo_mode_required", async () => {
    const handler = createDemoFaultHandler(
      baseDeps({
        injectFault: () => Promise.resolve({ ok: false, error: { kind: "demo_mode_required" } }),
      }),
    );
    const response = await handler(post());
    expect(response.status).toBe(404);
  });

  it("always passes provenance 'mock', never the configured WHOP_MODE", async () => {
    let received: { sellerId: string; paymentId: string; provenance: string } | null = null;
    const handler = createDemoFaultHandler(
      baseDeps({
        injectFault: (input) => {
          received = input;
          return Promise.resolve({ ok: true, value: kase() });
        },
      }),
    );
    await handler(post());
    expect(received).toEqual({ sellerId: SELLER_ID, paymentId: "pay_1", provenance: "mock" });
  });

  it("returns 201 with the created issue's Issue JSON, simulated:true, and a 'demo fault injected' history entry", async () => {
    const handler = createDemoFaultHandler(baseDeps());
    const response = await handler(post());
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      id: string;
      simulated: boolean;
      provenance: string;
      history: Array<{ action: string }>;
    };
    expect(body.id).toBe("case_1");
    expect(body.simulated).toBe(true);
    expect(body.provenance).toBe("mock");
    expect(body.history[0]?.action).toBe("demo fault injected");
  });
});
