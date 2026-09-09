import type { AdminLedgerEntryDetail, AdminLedgerRow, Result } from "@ledgerly/core";
import { orderId, sellerId, whopAccountId } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import {
  createGetAdminLedgerEntryHandler,
  type GetAdminLedgerEntryDeps,
} from "../../../src/app/api/admin/ledger/[id]/route";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const SELLER_ID = value(sellerId("seller_1"));
const WHOP_ACCOUNT_ID = value(whopAccountId("biz_1"));
const ORDER_ID = value(orderId("order_1"));

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
    orderId: ORDER_ID,
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

function detail(overrides: Partial<AdminLedgerEntryDetail> = {}): AdminLedgerEntryDetail {
  return {
    row: row(),
    order: {
      id: ORDER_ID,
      productTitle: "Course",
      gross: { amountMinor: 2500, currency: "USD" },
      fee: { amountMinor: 200, currency: "USD" },
      status: "checkout_created",
    },
    siblings: [row({ id: "entry_2", type: "fee", net: { amountMinor: -200, currency: "USD" } })],
    instrumentationEvents: [
      {
        correlationId: "corr_1",
        source: "app_api",
        phase: "end",
        method: "GET",
        path: "/api/admin/ledger/entry_1",
        status: 200,
        durationMs: 12,
        provenance: "app",
        safeIds: { sellerId: SELLER_ID },
        summary: "Fetched admin ledger entry",
        at: new Date("2026-09-08T11:00:01.000Z"),
      },
    ],
    ...overrides,
  };
}

function baseDeps(overrides: Partial<GetAdminLedgerEntryDeps> = {}): GetAdminLedgerEntryDeps {
  return {
    getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
    getEntry: () => Promise.resolve(detail()),
    ...overrides,
  };
}

function get() {
  return new Request("https://example.invalid/api/admin/ledger/entry_1");
}

describe("createGetAdminLedgerEntryHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createGetAdminLedgerEntryHandler(
      baseDeps({ getSession: () => Promise.resolve(null) }),
    );
    const response = await handler(get(), "entry_1");
    expect(response.status).toBe(401);
  });

  it("returns 401 for a seller session, not 403", async () => {
    const handler = createGetAdminLedgerEntryHandler(
      baseDeps({ getSession: () => Promise.resolve({ userId: "seller_user", role: "seller" }) }),
    );
    const response = await handler(get(), "entry_1");
    expect(response.status).toBe(401);
  });

  it("returns 404 when the entry does not exist", async () => {
    const handler = createGetAdminLedgerEntryHandler(
      baseDeps({ getEntry: () => Promise.resolve(null) }),
    );
    const response = await handler(get(), "entry_1");
    expect(response.status).toBe(404);
  });

  it("passes the route id through to getEntry", async () => {
    let requestedId: string | null = null;
    const handler = createGetAdminLedgerEntryHandler(
      baseDeps({
        getEntry: (id) => {
          requestedId = id;
          return Promise.resolve(detail());
        },
      }),
    );
    await handler(get(), "entry_1");
    expect(requestedId).toBe("entry_1");
  });

  it("returns the row, order, siblings and instrumentation events with the snake_case wire shape", async () => {
    const handler = createGetAdminLedgerEntryHandler(baseDeps());
    const response = await handler(get(), "entry_1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      row: { id: string; order_id: string | null; correlation_id: string | null };
      order: { id: string; product_title: string; status: string } | null;
      siblings: Array<{ id: string }>;
      instrumentation_events: Array<{
        correlation_id: string;
        run_id?: string;
        method?: string;
        duration_ms?: number;
        safe_ids: Record<string, string>;
      }>;
    };
    expect(body.row.id).toBe("entry_1");
    expect(body.row.order_id).toBe("order_1");
    expect(body.row.correlation_id).toBe("corr_1");
    expect(body.order).toEqual({
      id: "order_1",
      product_title: "Course",
      gross: { amountMinor: 2500, currency: "USD" },
      fee: { amountMinor: 200, currency: "USD" },
      status: "checkout_created",
    });
    expect(body.siblings).toHaveLength(1);
    expect(body.siblings[0]?.id).toBe("entry_2");
    expect(body.instrumentation_events).toHaveLength(1);
    expect(body.instrumentation_events[0]?.correlation_id).toBe("corr_1");
    expect(body.instrumentation_events[0]?.method).toBe("GET");
    expect(body.instrumentation_events[0]?.duration_ms).toBe(12);
    expect(body.instrumentation_events[0]?.safe_ids).toEqual({ sellerId: SELLER_ID });
    expect(body.instrumentation_events[0]?.run_id).toBeUndefined();
  });

  it("returns a null order when nothing resolved", async () => {
    const handler = createGetAdminLedgerEntryHandler(
      baseDeps({ getEntry: () => Promise.resolve(detail({ order: null })) }),
    );
    const response = await handler(get(), "entry_1");
    const body = (await response.json()) as { order: unknown };
    expect(body.order).toBeNull();
  });

  it("returns an empty siblings array and instrumentation_events array when there are none", async () => {
    const handler = createGetAdminLedgerEntryHandler(
      baseDeps({
        getEntry: () => Promise.resolve(detail({ siblings: [], instrumentationEvents: [] })),
      }),
    );
    const response = await handler(get(), "entry_1");
    const body = (await response.json()) as {
      siblings: unknown[];
      instrumentation_events: unknown[];
    };
    expect(body.siblings).toEqual([]);
    expect(body.instrumentation_events).toEqual([]);
  });
});
