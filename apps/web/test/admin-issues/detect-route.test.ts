import { describe, expect, it } from "vitest";
import { sellerId } from "../../../../packages/core/src/ids";
import type { Result } from "../../../../packages/core/src/result";
import type { ResolutionCase } from "../../../../packages/core/src/services/resolution";
import {
  createDetectIssuesHandler,
  type DetectIssuesDeps,
} from "../../src/app/api/admin/issues/detect/route";

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

function baseDeps(overrides: Partial<DetectIssuesDeps> = {}): DetectIssuesDeps {
  return {
    getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
    detectForSeller: () => Promise.resolve({ ok: true, value: [kase()] }),
    detectBounded: () => Promise.resolve({ sellers: 10, failed: 0, casesDetected: 3 }),
    provenance: () => "mock",
    ...overrides,
  };
}

function post(body: unknown = {}) {
  return new Request("https://example.invalid/api/admin/issues/detect", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function postEmpty() {
  return new Request("https://example.invalid/api/admin/issues/detect", {
    method: "POST",
    headers: { "content-length": "0" },
  });
}

describe("createDetectIssuesHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createDetectIssuesHandler(
      baseDeps({ getSession: () => Promise.resolve(null) }),
    );
    const response = await handler(post());
    expect(response.status).toBe(401);
  });

  it("returns 403 for a seller session", async () => {
    const handler = createDetectIssuesHandler(
      baseDeps({ getSession: () => Promise.resolve({ userId: "seller_user", role: "seller" }) }),
    );
    const response = await handler(post());
    expect(response.status).toBe(403);
  });

  it("runs the bounded all-sellers batch when no seller_id is given", async () => {
    let called = false;
    const handler = createDetectIssuesHandler(
      baseDeps({
        detectBounded: () => {
          called = true;
          return Promise.resolve({ sellers: 10, failed: 1, casesDetected: 4 });
        },
      }),
    );
    const response = await handler(post());
    expect(called).toBe(true);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      mode: string;
      sellers: number;
      failed: number;
      casesDetected: number;
    };
    expect(body).toEqual({ mode: "all_sellers", sellers: 10, failed: 1, casesDetected: 4 });
  });

  it("runs the bounded batch for an empty body (content-length 0)", async () => {
    const handler = createDetectIssuesHandler(baseDeps());
    const response = await handler(postEmpty());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mode: string };
    expect(body.mode).toBe("all_sellers");
  });

  it("returns 400 for an invalid seller_id", async () => {
    const handler = createDetectIssuesHandler(baseDeps());
    const response = await handler(post({ seller_id: "" }));
    expect(response.status).toBe(400);
  });

  it("detects for a single seller when seller_id is given", async () => {
    let requested: string | null = null;
    const handler = createDetectIssuesHandler(
      baseDeps({
        detectForSeller: (id, provenance) => {
          requested = id;
          expect(provenance).toBe("mock");
          return Promise.resolve({ ok: true, value: [kase()] });
        },
      }),
    );
    const response = await handler(post({ seller_id: "seller_1" }));
    expect(response.status).toBe(200);
    expect(requested).toBe(SELLER_ID);
    const body = (await response.json()) as { mode: string; cases: Array<{ id: string }> };
    expect(body.mode).toBe("single_seller");
    expect(body.cases).toHaveLength(1);
  });

  it("returns 422 when the seller is not connected", async () => {
    const handler = createDetectIssuesHandler(
      baseDeps({
        detectForSeller: () =>
          Promise.resolve({ ok: false, error: { kind: "seller_not_connected" } }),
      }),
    );
    const response = await handler(post({ seller_id: "seller_1" }));
    expect(response.status).toBe(422);
  });

  it("returns 502 for any other detection failure", async () => {
    const handler = createDetectIssuesHandler(
      baseDeps({
        detectForSeller: () =>
          Promise.resolve({ ok: false, error: { kind: "provider_unreachable" } }),
      }),
    );
    const response = await handler(post({ seller_id: "seller_1" }));
    expect(response.status).toBe(502);
  });
});
