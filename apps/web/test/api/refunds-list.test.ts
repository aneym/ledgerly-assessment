import { describe, expect, it } from "vitest";
import { createListRefundsHandler, type ListRefundsDeps } from "../../src/app/api/refunds/route";

type RefundRequestRow = {
  id: string;
  orderId: string;
  sellerId: string;
  amountMinor: number;
  currency: string;
  reason: string | null;
  status: string;
  createdAt: Date;
};

function row(overrides: Partial<RefundRequestRow> = {}): RefundRequestRow {
  return {
    id: "refreq_1",
    orderId: "order_1",
    sellerId: "seller_1",
    amountMinor: 2500,
    currency: "USD",
    reason: null,
    status: "requested",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function baseDeps(overrides: Partial<ListRefundsDeps> = {}): ListRefundsDeps {
  return {
    getSession: () => Promise.resolve({ userId: "buyer_1", role: "buyer" }),
    listForBuyer: () => Promise.resolve([row()]),
    ...overrides,
  };
}

function get(query = "") {
  return new Request(`https://example.invalid/api/refunds${query}`);
}

describe("createListRefundsHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createListRefundsHandler(baseDeps({ getSession: () => Promise.resolve(null) }));
    const response = await handler(get());
    expect(response.status).toBe(401);
  });

  it("rejects a buyer query param other than 'me'", async () => {
    const handler = createListRefundsHandler(baseDeps());
    const response = await handler(get("?buyer=someone_else"));
    expect(response.status).toBe(400);
  });

  it("accepts no buyer param at all", async () => {
    const handler = createListRefundsHandler(baseDeps());
    const response = await handler(get());
    expect(response.status).toBe(200);
  });

  it("scopes the query to the signed-in caller's own userId", async () => {
    let requestedBuyer: string | undefined;
    const handler = createListRefundsHandler(
      baseDeps({
        listForBuyer: (buyerUserId) => {
          requestedBuyer = buyerUserId;
          return Promise.resolve([row()]);
        },
      }),
    );
    await handler(get("?buyer=me"));
    expect(requestedBuyer).toBe("buyer_1");
  });

  it("returns refund requests newest first, in the exact JSON shape", async () => {
    const handler = createListRefundsHandler(
      baseDeps({
        listForBuyer: () =>
          Promise.resolve([
            row({ id: "refreq_2", createdAt: new Date("2026-01-03T00:00:00.000Z") }),
            row({ id: "refreq_1", createdAt: new Date("2026-01-02T00:00:00.000Z") }),
          ]),
      }),
    );
    const response = await handler(get("?buyer=me"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      refund_requests: Array<{
        id: string;
        order_id: string;
        seller_id: string;
        amount: { amount_minor: number; currency: string };
        reason: string | null;
        status: string;
        created_at: string;
      }>;
    };
    expect(body.refund_requests).toEqual([
      {
        id: "refreq_2",
        order_id: "order_1",
        seller_id: "seller_1",
        amount: { amount_minor: 2500, currency: "USD" },
        reason: null,
        status: "requested",
        created_at: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "refreq_1",
        order_id: "order_1",
        seller_id: "seller_1",
        amount: { amount_minor: 2500, currency: "USD" },
        reason: null,
        status: "requested",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("returns an empty list when the caller has no refund requests", async () => {
    const handler = createListRefundsHandler(baseDeps({ listForBuyer: () => Promise.resolve([]) }));
    const response = await handler(get());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { refund_requests: unknown[] };
    expect(body.refund_requests).toEqual([]);
  });
});
