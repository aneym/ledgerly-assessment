import type { AdminLedgerPage, AdminLedgerRow, Result } from "@ledgerly/core";
import { sellerId, whopAccountId } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import {
  createListAdminLedgerHandler,
  type ListAdminLedgerDeps,
} from "../../../src/app/api/admin/ledger/route";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const SELLER_ID = value(sellerId("seller_1"));
const WHOP_ACCOUNT_ID = value(whopAccountId("biz_1"));

function row(overrides: Partial<AdminLedgerRow> = {}): AdminLedgerRow {
  return {
    id: "entry_1",
    seller: {
      id: SELLER_ID,
      name: "Acme Courses",
      whopAccountId: WHOP_ACCOUNT_ID,
      salePolicy: "direct",
    },
    type: "payment",
    orderId: null,
    providerResourceId: "pay_1",
    status: "settled",
    gross: { amountMinor: 2500, currency: "USD" },
    fee: { amountMinor: 200, currency: "USD" },
    net: { amountMinor: 2500, currency: "USD" },
    currency: "USD",
    createdAt: new Date("2026-09-08T11:00:00.000Z"),
    updatedAt: new Date("2026-09-08T11:00:00.000Z"),
    settledAt: new Date("2026-09-08T11:00:00.000Z"),
    correlationId: "corr_1",
    provenance: "mock",
    ...overrides,
  };
}

function page(overrides: Partial<AdminLedgerPage> = {}): AdminLedgerPage {
  return {
    rows: [row()],
    nextCursor: null,
    summary: { USD: { gross: 2500, fee: 200, net: 2500 } },
    ...overrides,
  };
}

function baseDeps(overrides: Partial<ListAdminLedgerDeps> = {}): ListAdminLedgerDeps {
  return {
    getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
    listLedger: () => Promise.resolve(page()),
    ...overrides,
  };
}

function get(query = "") {
  return new Request(`https://example.invalid/api/admin/ledger${query}`);
}

describe("createListAdminLedgerHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createListAdminLedgerHandler(
      baseDeps({ getSession: () => Promise.resolve(null) }),
    );
    const response = await handler(get());
    expect(response.status).toBe(401);
  });

  it("returns 401 for a seller session, not 403", async () => {
    const handler = createListAdminLedgerHandler(
      baseDeps({ getSession: () => Promise.resolve({ userId: "seller_user", role: "seller" }) }),
    );
    const response = await handler(get());
    expect(response.status).toBe(401);
  });

  it("returns 400 for an invalid type filter", async () => {
    const handler = createListAdminLedgerHandler(baseDeps());
    const response = await handler(get("?type=not_a_type"));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid status filter", async () => {
    const handler = createListAdminLedgerHandler(baseDeps());
    const response = await handler(get("?status=not_a_status"));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid currency filter", async () => {
    const handler = createListAdminLedgerHandler(baseDeps());
    const response = await handler(get("?currency=GBP"));
    expect(response.status).toBe(400);
  });

  it("returns 400 for a malformed seller_id filter", async () => {
    const handler = createListAdminLedgerHandler(baseDeps());
    const response = await handler(get("?seller_id="));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an unparseable from date", async () => {
    const handler = createListAdminLedgerHandler(baseDeps());
    const response = await handler(get("?from=not-a-date"));
    expect(response.status).toBe(400);
  });

  it("does not reject an out-of-range limit (the service clamps it)", async () => {
    let seenLimit: number | undefined;
    const handler = createListAdminLedgerHandler(
      baseDeps({
        listLedger: (query) => {
          seenLimit = query.limit;
          return Promise.resolve(page());
        },
      }),
    );
    const response = await handler(get("?limit=0"));
    expect(response.status).toBe(200);
    expect(seenLimit).toBe(0);
  });

  it("lists ledger rows for an operator with the snake_case wire shape", async () => {
    const handler = createListAdminLedgerHandler(baseDeps());
    const response = await handler(get());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      rows: Array<{
        id: string;
        seller: { id: string; name: string; whop_account_id: string; sale_policy: string };
        order_id: string | null;
        provider_resource_id: string;
        correlation_id: string | null;
      }>;
      next_cursor: string | null;
      summary: Record<string, { gross: number; fee: number; net: number }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.id).toBe("entry_1");
    expect(body.rows[0]?.seller).toEqual({
      id: "seller_1",
      name: "Acme Courses",
      whop_account_id: "biz_1",
      sale_policy: "direct",
    });
    expect(body.rows[0]?.order_id).toBeNull();
    expect(body.rows[0]?.provider_resource_id).toBe("pay_1");
    expect(body.rows[0]?.correlation_id).toBe("corr_1");
    expect(body.next_cursor).toBeNull();
    expect(body.summary).toEqual({ USD: { gross: 2500, fee: 200, net: 2500 } });
  });

  it("keeps the summary per currency, never combined", async () => {
    const handler = createListAdminLedgerHandler(
      baseDeps({
        listLedger: () =>
          Promise.resolve(
            page({
              summary: {
                USD: { gross: 2500, fee: 200, net: 2300 },
                EUR: { gross: 1000, fee: 50, net: 950 },
              },
            }),
          ),
      }),
    );
    const response = await handler(get());
    const body = (await response.json()) as {
      summary: Record<string, { gross: number; fee: number; net: number }>;
    };
    expect(Object.keys(body.summary).sort()).toEqual(["EUR", "USD"]);
    expect(body.summary.USD).toEqual({ gross: 2500, fee: 200, net: 2300 });
    expect(body.summary.EUR).toEqual({ gross: 1000, fee: 50, net: 950 });
  });

  it("forwards the next_cursor the service returns when the page is full", async () => {
    const handler = createListAdminLedgerHandler(
      baseDeps({ listLedger: () => Promise.resolve(page({ nextCursor: "entry_2" })) }),
    );
    const response = await handler(get("?limit=1"));
    const body = (await response.json()) as { next_cursor: string | null };
    expect(body.next_cursor).toBe("entry_2");
  });

  it("passes q, type, status, currency, seller_id, provenance and cursor through to the service", async () => {
    let seenQuery: unknown;
    const handler = createListAdminLedgerHandler(
      baseDeps({
        listLedger: (query) => {
          seenQuery = query;
          return Promise.resolve(page());
        },
      }),
    );
    await handler(
      get(
        `?q=acme&type=refund&status=refunded&currency=USD&seller_id=${SELLER_ID}&provenance=sandbox&cursor=entry_9`,
      ),
    );
    expect(seenQuery).toEqual({
      q: "acme",
      type: "refund",
      status: "refunded",
      sellerId: SELLER_ID,
      provenance: "sandbox",
      currency: "USD",
      cursor: "entry_9",
      limit: undefined,
    });
  });

  it("quotes gross/fee/net as Money objects unchanged, and null when unresolved", async () => {
    const handler = createListAdminLedgerHandler(
      baseDeps({
        listLedger: () =>
          Promise.resolve(
            page({
              rows: [
                row({
                  id: "entry_2",
                  type: "transfer",
                  gross: null,
                  fee: null,
                  net: { amountMinor: 5000, currency: "USD" },
                }),
              ],
            }),
          ),
      }),
    );
    const response = await handler(get());
    const body = (await response.json()) as {
      rows: Array<{
        gross: { amountMinor: number; currency: string } | null;
        fee: { amountMinor: number; currency: string } | null;
        net: { amountMinor: number; currency: string } | null;
      }>;
    };
    expect(body.rows[0]?.gross).toBeNull();
    expect(body.rows[0]?.fee).toBeNull();
    expect(body.rows[0]?.net).toEqual({ amountMinor: 5000, currency: "USD" });
  });
});
