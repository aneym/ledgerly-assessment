import { runId, type Seller, sellerId, whopAccountId } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import { createListSellersHandler, type ListSellersDeps } from "../../src/app/api/sellers/route";

function value<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}
function seller(id: string, account: string | null): Seller {
  return {
    id: value(sellerId(id)),
    runId: value(runId("run_1")),
    externalId: `${id}-ext`,
    email: `${id}@example.invalid`,
    country: "US",
    whopAccountId: account ? value(whopAccountId(account)) : null,
    salePolicy: "direct",
    status: "active",
  };
}
const rows = [
  { seller: seller("seller_a", "biz_a"), displayName: "Alice" },
  { seller: seller("seller_b", null), displayName: null },
];
function deps(role: string | null, overrides: Partial<ListSellersDeps> = {}): ListSellersDeps {
  return {
    getSession: async () => (role ? { userId: "user_1", role } : null),
    listSellers: async ({ limit }) => ({ sellers: rows.slice(0, limit), nextCursor: null }),
    getSellerIdForUser: async () => "seller_b",
    getSeller: async (id) => rows.find((row) => row.seller.id === id)?.seller ?? null,
    getDisplayName: async (id) => rows.find((row) => row.seller.id === id)?.displayName ?? null,
    env: { WHOP_MODE: "hybrid" },
    ...overrides,
  };
}
const get = (query = "") => new Request(`http://app.test/api/sellers${query}`);

describe("GET /api/sellers", () => {
  it("returns 401 signed out and 403 for a buyer", async () => {
    expect((await createListSellersHandler(deps(null))(get())).status).toBe(401);
    expect((await createListSellersHandler(deps("buyer"))(get())).status).toBe(403);
  });
  it("lists every seller for an operator with the contract fields", async () => {
    const response = await createListSellersHandler(deps("operator"))(get("?limit=10"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sellers: Record<string, unknown>[];
      next_cursor: null;
    };
    expect(body.next_cursor).toBeNull();
    expect(body.sellers.map((row) => row.id)).toEqual(["seller_a", "seller_b"]);
    expect(body.sellers[0]).toMatchObject({
      id: "seller_a",
      name: "Alice",
      country: "US",
      sale_policy: "direct",
      whop_account_id: "biz_a",
      capabilities: { payments: "inactive", transfers: "inactive", payouts: "inactive" },
      provenance: "sandbox", // hybrid reads the real sandbox; only WHOP_MODE=mock is mock
    });
    expect(body.sellers[1]).toMatchObject({ name: "seller_b-ext", whop_account_id: null });
  });
  it("returns only the owned seller for a seller session", async () => {
    const response = await createListSellersHandler(deps("seller"))(get());
    const body = (await response.json()) as { sellers: { id: string }[] };
    expect(body.sellers.map((row) => row.id)).toEqual(["seller_b"]);
  });
  it("passes limit and cursor through", async () => {
    const seen: unknown[] = [];
    const handler = createListSellersHandler(
      deps("operator", {
        listSellers: async (opts) => {
          seen.push(opts);
          return { sellers: [], nextCursor: "abc" };
        },
      }),
    );
    const body = (await (await handler(get("?limit=1&cursor=xyz"))).json()) as {
      next_cursor: string;
    };
    expect(seen).toEqual([{ limit: 1, cursor: "xyz" }]);
    expect(body.next_cursor).toBe("abc");
  });
});
