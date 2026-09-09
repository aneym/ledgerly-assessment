import { describe, expect, it } from "vitest";
import { sellerId } from "../../../../packages/core/src/ids";
import type { Result } from "../../../../packages/core/src/result";
import type { Seller } from "../../../../packages/core/src/services/ports";
import type {
  ResolutionAction,
  ResolutionActionRequest,
  ResolutionCase,
} from "../../../../packages/core/src/services/resolution";
import {
  createRunIssueActionHandler,
  type RunIssueActionDeps,
} from "../../src/app/api/admin/issues/[id]/actions/[action]/route";

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

function baseDeps(overrides: Partial<RunIssueActionDeps> = {}): RunIssueActionDeps {
  return {
    getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
    runAction: () => Promise.resolve({ ok: true, value: { action: action(), case: kase() } }),
    listActionsForCase: () => Promise.resolve([action()]),
    getSeller: () => Promise.resolve(seller()),
    now: () => NOW,
    ...overrides,
  };
}

function post(body: unknown = { idempotency_key: "k1" }, headers: Record<string, string> = {}) {
  return new Request("https://example.invalid/api/admin/issues/case_1/actions/refetch", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
}

describe("createRunIssueActionHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createRunIssueActionHandler(
      baseDeps({ getSession: () => Promise.resolve(null) }),
    );
    const response = await handler(post(), "case_1", "refetch");
    expect(response.status).toBe(401);
  });

  it("returns 403 for a seller session", async () => {
    const handler = createRunIssueActionHandler(
      baseDeps({ getSession: () => Promise.resolve({ userId: "seller_user", role: "seller" }) }),
    );
    const response = await handler(post(), "case_1", "refetch");
    expect(response.status).toBe(403);
  });

  it("returns 404 for an action id not in the URL's own path (unrecognized action)", async () => {
    const handler = createRunIssueActionHandler(baseDeps());
    const response = await handler(post(), "case_1", "resend_transfer");
    expect(response.status).toBe(404);
  });

  it("returns 400 when no idempotency key is given, header or body", async () => {
    const handler = createRunIssueActionHandler(baseDeps());
    const response = await handler(post({}), "case_1", "refetch");
    expect(response.status).toBe(400);
  });

  it("reads the idempotency key from the Idempotency-Key header", async () => {
    let received: string | null = null;
    const handler = createRunIssueActionHandler(
      baseDeps({
        runAction: (input) => {
          received = input.idempotencyKey;
          return Promise.resolve({ ok: true, value: { action: action(), case: kase() } });
        },
      }),
    );
    const response = await handler(
      post({}, { "Idempotency-Key": "header_key" }),
      "case_1",
      "refetch",
    );
    expect(response.status).toBe(200);
    expect(received).toBe("header_key");
  });

  it("falls back to the body idempotency_key when the header is absent", async () => {
    let received: string | null = null;
    const handler = createRunIssueActionHandler(
      baseDeps({
        runAction: (input) => {
          received = input.idempotencyKey;
          return Promise.resolve({ ok: true, value: { action: action(), case: kase() } });
        },
      }),
    );
    await handler(post({ idempotency_key: "body_key" }), "case_1", "refetch");
    expect(received).toBe("body_key");
  });

  it("returns 404 when the case does not exist", async () => {
    const handler = createRunIssueActionHandler(
      baseDeps({
        runAction: () => Promise.resolve({ ok: false, error: { kind: "case_not_found" } }),
      }),
    );
    const response = await handler(post(), "case_1", "refetch");
    expect(response.status).toBe(404);
  });

  it("returns 409 when the action is not allowed for the case kind", async () => {
    const handler = createRunIssueActionHandler(
      baseDeps({
        runAction: () =>
          Promise.resolve({
            ok: false,
            error: {
              kind: "action_not_allowed",
              action: "import_confirmed",
              caseKind: "amount_mismatch",
            },
          }),
      }),
    );
    const response = await handler(post(), "case_1", "import_confirmed");
    expect(response.status).toBe(409);
  });

  it("returns 422 when the seller is not connected", async () => {
    const handler = createRunIssueActionHandler(
      baseDeps({
        runAction: () => Promise.resolve({ ok: false, error: { kind: "seller_not_connected" } }),
      }),
    );
    const response = await handler(post(), "case_1", "refetch");
    expect(response.status).toBe(422);
  });

  it("passes the operator's userId as actorUserId", async () => {
    let actor: string | null = null;
    const handler = createRunIssueActionHandler(
      baseDeps({
        getSession: () => Promise.resolve({ userId: "op_42", role: "operator" }),
        runAction: (input) => {
          actor = input.actorUserId;
          return Promise.resolve({ ok: true, value: { action: action(), case: kase() } });
        },
      }),
    );
    await handler(post(), "case_1", "escalate");
    expect(actor).toBe("op_42");
  });

  it("forwards an optional note", async () => {
    let received: string | undefined;
    const handler = createRunIssueActionHandler(
      baseDeps({
        runAction: (input) => {
          received = input.note;
          return Promise.resolve({ ok: true, value: { action: action(), case: kase() } });
        },
      }),
    );
    await handler(post({ idempotency_key: "k1", note: "checked with support" }), "case_1", "note");
    expect(received).toBe("checked with support");
  });

  it.each<ResolutionActionRequest>(["refetch", "import_confirmed", "recheck", "escalate", "note"])(
    "accepts the %s action id from the URL path and returns 200",
    async (actionId) => {
      const handler = createRunIssueActionHandler(baseDeps());
      const response = await handler(post(), "case_1", actionId);
      expect(response.status).toBe(200);
    },
  );

  it("returns the updated issue, not a {action, case} wrapper, and reflects a resolved recheck", async () => {
    const resolvedAt = new Date("2026-09-08T12:00:00.000Z");
    const handler = createRunIssueActionHandler(
      baseDeps({
        runAction: () =>
          Promise.resolve({
            ok: true,
            value: {
              action: action({ action: "resolve", outcome: "succeeded" }),
              case: kase({ status: "resolved", resolvedAt }),
            },
          }),
        listActionsForCase: () =>
          Promise.resolve([action({ action: "resolve", outcome: "succeeded" })]),
      }),
    );
    const response = await handler(post(), "case_1", "recheck");
    const body = (await response.json()) as {
      id: string;
      status: string;
      history: Array<{ action: string }>;
    };
    expect(body.id).toBe("case_1");
    expect(body.status).toBe("resolved");
    expect(body.history[0]?.action).toBe("resolve");
  });
});
