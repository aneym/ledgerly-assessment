import { describe, expect, it } from "vitest";
import { sellerId } from "../../../../packages/core/src/ids";
import type { Result } from "../../../../packages/core/src/result";
import type { Seller } from "../../../../packages/core/src/services/ports";
import type {
  ResolutionAction,
  ResolutionCase,
} from "../../../../packages/core/src/services/resolution";
import {
  createGetIssueHandler,
  type GetIssueDeps,
} from "../../src/app/api/admin/issues/[id]/route";

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
    kind: "amount_mismatch",
    status: "detected",
    sellerId: SELLER_ID,
    orderId: null,
    providerResourceType: "payment",
    providerResourceId: "pay_1",
    expected: { amountMinor: 2500, currency: "USD" },
    observed: { amountMinor: 2300, currency: "USD" },
    impact: "Ledger shows 25.00 USD but the provider reports 23.00 USD.",
    nextSafeAction: "recheck",
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

function action(overrides: Partial<ResolutionAction> = {}): ResolutionAction {
  return {
    id: "action_1",
    caseId: "case_1",
    action: "refetch",
    actorUserId: "op_1",
    idempotencyKey: "idem_1",
    outcome: "succeeded",
    detail: {},
    at: new Date("2026-09-08T11:05:00.000Z"),
    ...overrides,
  };
}

function baseDeps(overrides: Partial<GetIssueDeps> = {}): GetIssueDeps {
  return {
    getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
    getCase: () => Promise.resolve(kase()),
    listActionsForCase: () => Promise.resolve([action()]),
    getSeller: () => Promise.resolve(seller()),
    now: () => NOW,
    ...overrides,
  };
}

function get() {
  return new Request("https://example.invalid/api/admin/issues/case_1");
}

type IssueBody = {
  amounts: { local?: unknown; provider?: unknown; difference?: { amountMinor: number } };
  history: Array<{ action: string; outcome: string; provenance: string; evidence_ref?: string }>;
};

describe("createGetIssueHandler", () => {
  it("renders current ledger/provider amounts from the latest recheck without exposing raw details", async () => {
    const historical = kase({
      expected: null,
      observed: { amountMinor: 2400, currency: "USD" },
      status: "resolved",
    });
    const handler = createGetIssueHandler(
      baseDeps({
        getCase: async () => historical,
        listActionsForCase: async () => [
          action({
            action: "resolve",
            detail: {
              currentAmounts: {
                local: { amountMinor: 2500, currency: "USD", private: "omit" },
                provider: { amountMinor: 2500, currency: "USD" },
                matches: true,
              },
              raw: "never expose provider payload",
            },
          }),
        ],
      }),
    );
    const body = await (await handler(get(), "case_1")).json();
    expect(body.amounts).toEqual({
      local: { amountMinor: 2500, currency: "USD" },
      provider: { amountMinor: 2500, currency: "USD" },
      difference: { amountMinor: 0, currency: "USD" },
    });
    expect(historical.expected).toBeNull();
    expect(historical.observed?.amountMinor).toBe(2400);
    expect(JSON.stringify(body)).not.toContain("never expose");
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("does not restore an old matching snapshot after a later inconclusive recheck", async () => {
    const handler = createGetIssueHandler(
      baseDeps({
        getCase: async () => kase({ expected: null, observed: null }),
        listActionsForCase: async () => [
          action({
            action: "resolve",
            detail: {
              currentAmounts: {
                local: { amountMinor: 2500, currency: "USD" },
                provider: { amountMinor: 2500, currency: "USD" },
                matches: true,
              },
            },
          }),
          action({ action: "recheck", outcome: "failed", detail: { reason: "page_limit" } }),
        ],
      }),
    );
    const body = await (await handler(get(), "case_1")).json();
    expect(body.amounts).toEqual({});
  });

  it("shows the injected provider evidence without claiming that amount exists locally", async () => {
    const handler = createGetIssueHandler(
      baseDeps({
        getCase: async () =>
          kase({
            kind: "missing_local_payment",
            expected: { amountMinor: 2500, currency: "USD" },
            observed: null,
          }),
      }),
    );
    const body = await (await handler(get(), "case_1")).json();
    expect(body.amounts).toEqual({ provider: { amountMinor: 2500, currency: "USD" } });
  });

  it("returns 401 when signed out", async () => {
    const handler = createGetIssueHandler(baseDeps({ getSession: () => Promise.resolve(null) }));
    const response = await handler(get(), "case_1");
    expect(response.status).toBe(401);
  });

  it("returns 403 for a seller session", async () => {
    const handler = createGetIssueHandler(
      baseDeps({ getSession: () => Promise.resolve({ userId: "seller_user", role: "seller" }) }),
    );
    const response = await handler(get(), "case_1");
    expect(response.status).toBe(403);
  });

  it("returns 404 when the issue does not exist", async () => {
    const handler = createGetIssueHandler(baseDeps({ getCase: () => Promise.resolve(null) }));
    const response = await handler(get(), "case_1");
    expect(response.status).toBe(404);
  });

  it("computes amounts.difference when both sides share a currency", async () => {
    const handler = createGetIssueHandler(baseDeps());
    const response = await handler(get(), "case_1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as IssueBody;
    expect(body.amounts.difference).toEqual({ amountMinor: -200, currency: "USD" });
  });

  it("omits amounts.difference instead of throwing when currencies differ", async () => {
    const handler = createGetIssueHandler(
      baseDeps({
        getCase: () =>
          Promise.resolve(
            kase({
              expected: { amountMinor: 2500, currency: "USD" },
              observed: { amountMinor: 2300, currency: "EUR" },
            }),
          ),
      }),
    );
    const response = await handler(get(), "case_1");
    const body = (await response.json()) as IssueBody;
    expect(body.amounts.difference).toBeUndefined();
  });

  it("omits amounts.provider and amounts.difference when observed is not yet known", async () => {
    const handler = createGetIssueHandler(
      baseDeps({ getCase: () => Promise.resolve(kase({ observed: null })) }),
    );
    const response = await handler(get(), "case_1");
    const body = (await response.json()) as IssueBody;
    expect(body.amounts.provider).toBeUndefined();
    expect(body.amounts.difference).toBeUndefined();
  });

  it("includes the action history, echoing the case's provenance on each entry", async () => {
    const handler = createGetIssueHandler(baseDeps());
    const response = await handler(get(), "case_1");
    const body = (await response.json()) as IssueBody;
    expect(body.history).toHaveLength(1);
    expect(body.history[0]?.action).toBe("refetch");
    expect(body.history[0]?.outcome).toBe("succeeded");
    expect(body.history[0]?.provenance).toBe("mock");
  });

  it("labels a demo-fault 'note' action's history entry with its detail.note text", async () => {
    const handler = createGetIssueHandler(
      baseDeps({
        listActionsForCase: () =>
          Promise.resolve([
            action({
              action: "note",
              actorUserId: "system:demo-fault",
              detail: { note: "demo fault injected" },
            }),
          ]),
      }),
    );
    const response = await handler(get(), "case_1");
    const body = (await response.json()) as IssueBody;
    expect(body.history[0]?.action).toBe("demo fault injected");
  });

  it("never calls getSeller and returns a null seller when the issue has no sellerId", async () => {
    let called = false;
    const handler = createGetIssueHandler(
      baseDeps({
        getCase: () => Promise.resolve(kase({ sellerId: null })),
        getSeller: () => {
          called = true;
          return Promise.resolve(seller());
        },
      }),
    );
    const response = await handler(get(), "case_1");
    const body = (await response.json()) as { seller: unknown };
    expect(body.seller).toBeNull();
    expect(called).toBe(false);
  });
});
