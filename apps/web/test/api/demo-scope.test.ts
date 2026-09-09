import { type AdminLedgerRow, runId, type Seller, sellerId, whopAccountId } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import type { ResolutionCase } from "../../../../packages/core/src/services/resolution";
import { createAssistantHealthHandler } from "../../src/app/api/admin/assistant/health/route";
import { createRunIssueActionHandler } from "../../src/app/api/admin/issues/[id]/actions/[action]/route";
import { createGetIssueHandler } from "../../src/app/api/admin/issues/[id]/route";
import { createDemoFaultHandler } from "../../src/app/api/admin/issues/demo-fault/route";
import { createDetectIssuesHandler } from "../../src/app/api/admin/issues/detect/route";
import { createListIssuesHandler } from "../../src/app/api/admin/issues/route";
import { createGetAdminLedgerEntryHandler } from "../../src/app/api/admin/ledger/[id]/route";
import { createListAdminLedgerHandler } from "../../src/app/api/admin/ledger/route";
import { createListSellersHandler, type ListSellersDeps } from "../../src/app/api/sellers/route";

function value<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error("Invalid fixture");
  return result.value;
}
const now = new Date("2026-09-08T12:00:00Z");
const sellers: Seller[] = ["A", "B"].map((suffix) => ({
  id: value(sellerId(`seller_${suffix}`)),
  runId: value(runId(`run_${suffix}`)),
  externalId: suffix,
  email: `${suffix}@example.invalid`,
  country: "US",
  whopAccountId: value(whopAccountId(`biz_${suffix}`)),
  salePolicy: "direct",
  status: "active",
}));
const cases: ResolutionCase[] = sellers.map((seller) => ({
  id: `case_${seller.externalId}`,
  sellerId: seller.id,
  orderId: null,
  kind: "missing_local_payment",
  status: "detected",
  providerResourceType: "payment",
  providerResourceId: `pay_${seller.externalId}`,
  expected: null,
  observed: null,
  impact: "Fixture",
  nextSafeAction: "refetch",
  assignedTo: null,
  provenance: "mock",
  simulated: true,
  openedAt: now,
  updatedAt: now,
  resolvedAt: null,
  correlationId: null,
}));
const session =
  (role = "demo") =>
  async () => ({ userId: "sample", role, demoRunId: "run_A" });
const request = (path: string, run: string | null = "run_A", body?: unknown) =>
  new Request(`http://app.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(run ? { "x-demo-run": run } : {}), "Idempotency-Key": "fixture-action" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const getSeller = async (id: string) => sellers.find((seller) => seller.id === id) ?? null;
const issueDeps = (role = "demo") => ({
  getSession: session(role),
  getSeller,
  now: () => now,
  listCases: async () => cases,
  getCase: async (id: string) => cases.find((kase) => kase.id === id) ?? null,
  listActionsForCase: async () => [],
});
const sellerDeps = (role = "demo"): ListSellersDeps => ({
  getSession: session(role),
  getSeller,
  listSellers: async () => ({
    sellers: sellers.map((seller) => ({ seller, displayName: null })),
    nextCursor: null,
  }),
  getSellerIdForUser: async () => null,
  getDisplayName: async () => null,
  env: {},
});
const ledgerRows: AdminLedgerRow[] = sellers.map((seller, index) => ({
  id: String(index + 1),
  seller: {
    id: seller.id,
    name: seller.externalId,
    whopAccountId: seller.whopAccountId,
    salePolicy: "direct",
  },
  type: "payment",
  orderId: null,
  providerResourceId: `pay_${index}`,
  status: "settled",
  gross: { amountMinor: 100, currency: "USD" },
  fee: { amountMinor: 8, currency: "USD" },
  net: { amountMinor: 92, currency: "USD" },
  currency: "USD",
  createdAt: now,
  updatedAt: now,
  settledAt: now,
  correlationId: null,
  provenance: "mock",
}));
const ledgerDeps = (role = "demo") => ({
  getSession: session(role),
  listLedger: async () => ({
    rows: ledgerRows,
    nextCursor: null,
    summary: { USD: { gross: 200, fee: 16, net: 184 } },
  }),
  getRowScope: async (row: AdminLedgerRow) => ({
    runId: row.id === "1" ? "run_A" : "run_B",
    sellerRunId: row.id === "1" ? "run_A" : "run_B",
    orderRunId: null,
  }),
});

describe("demo admin boundaries", () => {
  it("lists only sellers and issues from the request run", async () => {
    const sellerResponse = await createListSellersHandler(sellerDeps())(request("/api/sellers"));
    expect((await sellerResponse.json()).sellers.map((row: { id: string }) => row.id)).toEqual([
      "seller_A",
    ]);
    const issueResponse = await createListIssuesHandler(issueDeps())(request("/api/admin/issues"));
    expect((await issueResponse.json()).issues.map((row: { id: string }) => row.id)).toEqual([
      "case_A",
    ]);
  });
  it("leaves real operator seller, issue and ledger results unchanged", async () => {
    const a = await createListSellersHandler(sellerDeps("operator"))(request("/api/sellers", null));
    expect((await a.json()).sellers).toHaveLength(2);
    const b = await createListIssuesHandler(issueDeps("operator"))(
      request("/api/admin/issues", null),
    );
    expect((await b.json()).issues).toHaveLength(2);
    const c = await createListAdminLedgerHandler(ledgerDeps("operator"))(
      request("/api/admin/ledger", null),
    );
    expect(await c.json()).toMatchObject({
      rows: [{ id: "1" }, { id: "2" }],
      summary: { USD: { gross: 200, fee: 16, net: 184 } },
    });
  });
  it("refuses foreign demo-fault writes before invoking the injector", async () => {
    let writes = 0;
    const handler = createDemoFaultHandler({
      ...issueDeps(),
      isDemoMode: () => true,
      injectFault: async () => {
        writes++;
        return { ok: true, value: cases[0] as ResolutionCase };
      },
    });
    const response = await handler(
      request("/api/admin/issues/demo-fault", "run_A", {
        seller_id: "seller_B",
        payment_id: "pay_B",
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "demo_scope" });
    expect(writes).toBe(0);
    expect(
      (
        await handler(
          request("/api/admin/issues/demo-fault", "run_A", {
            seller_id: "seller_A",
            payment_id: "pay_A",
          }),
        )
      ).status,
    ).toBe(201);
    expect(writes).toBe(1);
  });
  it.each(["refetch", "import_confirmed", "recheck", "escalate", "note"])(
    "refuses a foreign %s action before any write",
    async (action) => {
      let writes = 0;
      const handler = createRunIssueActionHandler({
        ...issueDeps(),
        runAction: async () => {
          writes++;
          return { ok: false, error: { kind: "case_not_found" } };
        },
      });
      const response = await handler(
        request("/api/admin/issues/case_B/actions", "run_A", {}),
        "case_B",
        action,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "demo_scope" });
      expect(writes).toBe(0);
    },
  );
  it("refuses a foreign issue detail", async () => {
    const response = await createGetIssueHandler(issueDeps())(
      request("/api/admin/issues/case_B"),
      "case_B",
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "demo_scope" });
  });
  it("detects only in-scope sellers and never invokes global detection", async () => {
    const seen: string[] = [];
    const handler = createDetectIssuesHandler({
      ...issueDeps(),
      listDemoSellers: async () => sellers,
      detectForSeller: async (id) => {
        seen.push(id);
        return { ok: true, value: [] };
      },
      detectBounded: async () => {
        throw new Error("Global detection must not run");
      },
      provenance: () => "mock",
    });
    expect((await handler(request("/api/admin/issues/detect", "run_A", {}))).status).toBe(200);
    expect(seen).toEqual(["seller_A"]);
    const response = await handler(
      request("/api/admin/issues/detect", "run_A", { seller_id: "seller_B" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "demo_scope" });
    expect(seen).toEqual(["seller_A"]);
  });
  it("filters ledger rows and totals, including mismatched ledger and order run ids", async () => {
    const handler = createListAdminLedgerHandler(ledgerDeps());
    const body = await (await handler(request("/api/admin/ledger"))).json();
    expect(body.rows.map((row: { id: string }) => row.id)).toEqual(["1"]);
    expect(body.summary).toEqual({ USD: { gross: 100, fee: 8, net: 92 } });
    for (const record of [
      { runId: "run_B", sellerRunId: "run_A", orderRunId: "run_A" },
      { runId: "run_A", sellerRunId: "run_B", orderRunId: "run_A" },
      { runId: "run_A", sellerRunId: "run_A", orderRunId: "run_B" },
    ]) {
      const first = ledgerRows[0] as AdminLedgerRow;
      const response = await createGetAdminLedgerEntryHandler({
        getSession: session(),
        getRowScope: async () => record,
        getEntry: async () => ({
          row: { ...first, orderId: "order_1" as NonNullable<AdminLedgerRow["orderId"]> },
          order: null,
          siblings: [],
          instrumentationEvents: [],
        }),
      })(request("/api/admin/ledger/1"), "1");
      expect(response.status).toBe(403);
    }
  });
  it("refuses every admin handler without a demo run", async () => {
    const req = request("/api/admin/test", null, {});
    const base = issueDeps();
    const responses = await Promise.all([
      createListSellersHandler(sellerDeps())(req),
      createListIssuesHandler(base)(req),
      createGetIssueHandler(base)(req, "case_A"),
      createDemoFaultHandler({
        ...base,
        isDemoMode: () => true,
        injectFault: async () => {
          throw new Error("Must not write");
        },
      })(req),
      createRunIssueActionHandler({
        ...base,
        runAction: async () => {
          throw new Error("Must not write");
        },
      })(req, "case_A", "recheck"),
      createDetectIssuesHandler({
        ...base,
        detectBounded: async () => {
          throw new Error("Must not write");
        },
        detectForSeller: async () => {
          throw new Error("Must not write");
        },
        provenance: () => "mock",
      })(req),
      createListAdminLedgerHandler(ledgerDeps())(req),
      createGetAdminLedgerEntryHandler({
        getSession: session(),
        getEntry: async () => {
          throw new Error("Must not read");
        },
      })(req, "1"),
      createAssistantHealthHandler({
        getSession: session(),
        getModel: () => "fixture",
        isGatewayConfigured: () => true,
      })(req),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "demo_scope" });
    }
  });
});

describe("demo fault responses", () => {
  it("returns 409 with the resolved case ID", async () => {
    const handler = createDemoFaultHandler({
      ...issueDeps("operator"),
      isDemoMode: () => true,
      injectFault: async () => ({
        ok: false,
        error: { kind: "case_resolved", caseId: "case_closed" },
      }),
    });
    const response = await handler(
      request("/api/admin/issues/demo-fault", "run_A", {
        seller_id: "seller_A",
        payment_id: "pay_A",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "case_resolved", case_id: "case_closed" });
  });

  it("returns 400 with a plain message when seeding is unavailable", async () => {
    const handler = createDemoFaultHandler({
      ...issueDeps("operator"),
      isDemoMode: () => true,
      injectFault: async (input) => {
        expect(input.paymentId).toBe("");
        return {
          ok: false,
          error: {
            kind: "payment_required",
            message: "Provide a payment ID. Demo payment seeding is unavailable.",
          },
        };
      },
    });
    const response = await handler(
      request("/api/admin/issues/demo-fault", "run_A", { seller_id: "seller_A" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "payment_required",
      message: "Provide a payment ID. Demo payment seeding is unavailable.",
    });
  });

  it.each(["header", "cookie"])(
    "passes fresh input and the %s run ID to the service",
    async (source) => {
      const handler = createDemoFaultHandler({
        ...issueDeps("operator"),
        isDemoMode: () => true,
        injectFault: async (input) => {
          expect(input).toEqual({
            sellerId: "seller_A",
            paymentId: source === "header" ? "pay_old" : "",
            fresh: source === "header" ? true : undefined,
            runId: "run_A",
            provenance: "mock",
          });
          return { ok: true, value: cases[0] as ResolutionCase };
        },
      });
      const response = await handler(
        new Request("http://app.test/api/admin/issues/demo-fault", {
          method: "POST",
          headers:
            source === "header"
              ? { "x-demo-run": "run_A", cookie: "ledgerly_demo_run=run_other" }
              : { cookie: "ledgerly_demo_run=run_A" },
          body: JSON.stringify({
            seller_id: "seller_A",
            ...(source === "header" ? { paymentId: "pay_old", fresh: true } : {}),
          }),
        }),
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ id: cases[0]?.id });
    },
  );
});

describe("caller-selected foreign scope", () => {
  it.each([
    { "x-demo-run": "run_B" },
    { cookie: "ledgerly_demo_run=run_B" },
    { "x-demo-run": "run_A", cookie: "ledgerly_demo_run=run_B" },
    { "x-demo-run": "run_B", cookie: "ledgerly_demo_run=run_A" },
    { cookie: "ledgerly_demo_run=run_A; ledgerly_demo_run=run_B" },
  ] as Record<string, string>[])(
    "denies read, note and fault before accessing foreign records for %j",
    async (headers) => {
      const base = issueDeps();
      let accessed = 0;
      const forbidden = async (): Promise<never> => {
        accessed++;
        throw new Error("Must not access foreign records");
      };
      const req = () =>
        new Request("http://x/api/admin/issues", {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": "isolation" },
          body: JSON.stringify({ seller_id: "seller_B", note: "foreign", fresh: true }),
        });
      const responses = await Promise.all([
        createGetIssueHandler({ ...base, getCase: forbidden })(req(), "case_B"),
        createRunIssueActionHandler({ ...base, runAction: forbidden })(req(), "case_B", "note"),
        createDemoFaultHandler({ ...base, isDemoMode: () => true, injectFault: forbidden })(req()),
      ]);
      for (const response of responses) expect(response.status).toBe(403);
      expect(accessed).toBe(0);
    },
  );
});
