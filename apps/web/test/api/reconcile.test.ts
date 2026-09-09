import { describe, expect, it } from "vitest";
import { sellerId } from "../../../../packages/core/src/ids";
import type { Result } from "../../../../packages/core/src/result";
import type { ResolutionCase } from "../../../../packages/core/src/services/resolution";
import {
  createReconcileSellerHandler,
  type ReconcileSellerDeps,
} from "../../src/app/api/reconcile/[sellerId]/route";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const SELLER_ID = value(sellerId("seller_1"));

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
    impact: "Provider shows a paid payment with no matching ledger entry.",
    nextSafeAction: "refetch",
    assignedTo: null,
    provenance: "mock",
    simulated: false,
    openedAt: new Date("2026-09-08T11:00:00.000Z"),
    updatedAt: new Date("2026-09-08T11:00:00.000Z"),
    resolvedAt: null,
    correlationId: null,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<ReconcileSellerDeps> = {}): ReconcileSellerDeps {
  return {
    getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
    detectForSeller: () => Promise.resolve({ ok: true, value: [kase()] }),
    provenance: () => "mock",
    newRunId: () => "run_1",
    now: () => new Date("2026-09-08T12:00:00.000Z"),
    ...overrides,
  };
}

function post() {
  return new Request("https://example.invalid/api/reconcile/seller_1", { method: "POST" });
}

describe("createReconcileSellerHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createReconcileSellerHandler(
      baseDeps({ getSession: () => Promise.resolve(null) }),
    );
    const response = await handler(post(), "seller_1");
    expect(response.status).toBe(401);
  });

  it("returns 403 for a seller session", async () => {
    const handler = createReconcileSellerHandler(
      baseDeps({ getSession: () => Promise.resolve({ userId: "seller_user", role: "seller" }) }),
    );
    const response = await handler(post(), "seller_1");
    expect(response.status).toBe(403);
  });

  it("returns 400 for a malformed seller id", async () => {
    const handler = createReconcileSellerHandler(baseDeps());
    const response = await handler(post(), "");
    expect(response.status).toBe(400);
  });

  it("returns 422 when the seller is not connected", async () => {
    const handler = createReconcileSellerHandler(
      baseDeps({
        detectForSeller: () =>
          Promise.resolve({ ok: false, error: { kind: "seller_not_connected" } }),
      }),
    );
    const response = await handler(post(), "seller_1");
    expect(response.status).toBe(422);
  });

  it("returns 502 for any other detection failure", async () => {
    const handler = createReconcileSellerHandler(
      baseDeps({
        detectForSeller: () =>
          Promise.resolve({ ok: false, error: { kind: "provider_unreachable" } }),
      }),
    );
    const response = await handler(post(), "seller_1");
    expect(response.status).toBe(502);
  });

  it("runs detection scoped to the path param seller and returns a ReconciliationRun", async () => {
    let requestedSeller: string | undefined;
    const handler = createReconcileSellerHandler(
      baseDeps({
        detectForSeller: (id, provenance) => {
          requestedSeller = id;
          expect(provenance).toBe("mock");
          return Promise.resolve({ ok: true, value: [kase(), kase({ id: "case_2" })] });
        },
      }),
    );
    const response = await handler(post(), "seller_1");
    expect(response.status).toBe(200);
    expect(requestedSeller).toBe(SELLER_ID);
    const body = (await response.json()) as {
      id: string;
      seller_id: string;
      recorded_at: string;
      provenance: string;
      issue_ids: string[];
    };
    expect(body).toEqual({
      id: "run_1",
      seller_id: "seller_1",
      recorded_at: "2026-09-08T12:00:00.000Z",
      provenance: "mock",
      issue_ids: ["case_1", "case_2"],
    });
  });
});
