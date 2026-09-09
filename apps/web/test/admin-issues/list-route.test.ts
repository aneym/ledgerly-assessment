import { describe, expect, it } from "vitest";
import { sellerId } from "../../../../packages/core/src/ids";
import type { Result } from "../../../../packages/core/src/result";
import type { Seller } from "../../../../packages/core/src/services/ports";
import type {
  ResolutionAction,
  ResolutionCase,
} from "../../../../packages/core/src/services/resolution";
import { createListIssuesHandler, type ListIssuesDeps } from "../../src/app/api/admin/issues/route";

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

function baseDeps(overrides: Partial<ListIssuesDeps> = {}): ListIssuesDeps {
  return {
    getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
    listCases: () => Promise.resolve([kase()]),
    getSeller: () => Promise.resolve(seller()),
    listActionsForCase: () => Promise.resolve([] as ResolutionAction[]),
    now: () => NOW,
    ...overrides,
  };
}

function get(query = "") {
  return new Request(`https://example.invalid/api/admin/issues${query}`);
}

type IssueBody = {
  id: string;
  seller: { id: string; name: string; whop_account_id: string | null } | null;
  subject: { provider_resource_id: string };
  age_seconds: number;
  status: string;
  next_safe_action: { id: string | null; available: boolean };
};

describe("createListIssuesHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createListIssuesHandler(baseDeps({ getSession: () => Promise.resolve(null) }));
    const response = await handler(get());
    expect(response.status).toBe(401);
  });

  it("returns 403 for a seller session", async () => {
    const handler = createListIssuesHandler(
      baseDeps({ getSession: () => Promise.resolve({ userId: "seller_user", role: "seller" }) }),
    );
    const response = await handler(get());
    expect(response.status).toBe(403);
  });

  it("returns 400 for an invalid kind filter", async () => {
    const handler = createListIssuesHandler(baseDeps());
    const response = await handler(get("?kind=not_a_kind"));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid status filter using the old 'open' spelling", async () => {
    const handler = createListIssuesHandler(baseDeps());
    const response = await handler(get("?status=open"));
    expect(response.status).toBe(400);
  });

  it("accepts the 'detected' status spelling", async () => {
    const handler = createListIssuesHandler(baseDeps());
    const response = await handler(get("?status=detected"));
    expect(response.status).toBe(200);
  });

  it("returns 400 for an out-of-range limit", async () => {
    const handler = createListIssuesHandler(baseDeps());
    const response = await handler(get("?limit=0"));
    expect(response.status).toBe(400);
  });

  it("lists issues for an operator, attaching seller, subject, and age_seconds", async () => {
    const handler = createListIssuesHandler(baseDeps());
    const response = await handler(get());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { issues: IssueBody[]; next_cursor: string | null };
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]?.id).toBe("case_1");
    expect(body.issues[0]?.seller?.name).toBe("ext_1");
    expect(body.issues[0]?.seller?.whop_account_id).toBe("biz_1");
    expect(body.issues[0]?.subject.provider_resource_id).toBe("pay_1");
    expect(body.issues[0]?.age_seconds).toBe(3600);
    expect(body.issues[0]?.status).toBe("detected");
    expect(body.issues[0]?.next_safe_action.id).toBe("refetch");
    expect(body.next_cursor).toBeNull();
  });

  it("sets next_cursor to the last case id when the page is full", async () => {
    const handler = createListIssuesHandler(
      baseDeps({
        listCases: () => Promise.resolve([kase({ id: "case_1" }), kase({ id: "case_2" })]),
      }),
    );
    const response = await handler(get("?limit=2"));
    const body = (await response.json()) as { next_cursor: string | null };
    expect(body.next_cursor).toBe("case_2");
  });

  it("omits seller when the case has no sellerId", async () => {
    const handler = createListIssuesHandler(
      baseDeps({ listCases: () => Promise.resolve([kase({ sellerId: null })]) }),
    );
    const response = await handler(get());
    const body = (await response.json()) as { issues: Array<{ seller: unknown }> };
    expect(body.issues[0]?.seller).toBeNull();
  });

  it("reports next_safe_action.available: false for a resolved issue", async () => {
    const handler = createListIssuesHandler(
      baseDeps({
        listCases: () =>
          Promise.resolve([kase({ status: "resolved", resolvedAt: NOW, nextSafeAction: null })]),
      }),
    );
    const response = await handler(get());
    const body = (await response.json()) as { issues: IssueBody[] };
    expect(body.issues[0]?.next_safe_action).toEqual({
      id: null,
      label: "No safe action available",
      reason: "This issue is already resolved.",
      available: false,
      provenance: "mock",
    });
  });
});
