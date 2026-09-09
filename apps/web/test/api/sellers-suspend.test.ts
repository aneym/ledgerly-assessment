import { ok, type Result, runId, type Seller, sellerId, whopAccountId } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import { createGetSellerHandler } from "../../src/app/api/sellers/[id]/route";
import {
  createSuspendSellerHandler,
  type SuspendSellerDeps,
} from "../../src/app/api/sellers/[id]/suspend/route";
import { createListSellersHandler } from "../../src/app/api/sellers/route";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const SELLER_ID = value(sellerId("seller_1"));

function seller(overrides: Partial<Seller> = {}): Seller {
  return {
    id: SELLER_ID,
    runId: value(runId("run_1")),
    externalId: "alice",
    email: "alice@example.invalid",
    country: "US",
    whopAccountId: value(whopAccountId("biz_alice")),
    salePolicy: "direct",
    status: "active",
    ...overrides,
  };
}

function baseDeps(overrides: Partial<SuspendSellerDeps> = {}): SuspendSellerDeps {
  let status: Seller["status"] = "active";
  return {
    getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
    getSeller: () => Promise.resolve(seller({ status })),
    suspend: () => {
      status = "suspended";
      return Promise.resolve();
    },
    getDisplayName: () => Promise.resolve(null),
    ...overrides,
  };
}

function post() {
  return new Request("https://example.invalid/api/sellers/seller_1/suspend", { method: "POST" });
}

describe("createSuspendSellerHandler", () => {
  it("returns stored suspension status after a fresh detail and list read without changing another seller", async () => {
    const otherId = value(sellerId("seller_other"));
    const rows = new Map<string, Seller>([
      [SELLER_ID, seller()],
      [otherId, seller({ id: otherId, runId: value(runId("run_other")) })],
    ]);
    const getSession = async () => ({ userId: "op_1", role: "operator" });
    const getSeller = async (id: string) => rows.get(id) ?? null;
    const getDisplayName = async () => null;
    const response = await createSuspendSellerHandler({
      getSession,
      getSeller,
      getDisplayName,
      suspend: async (id) => {
        const row = rows.get(id);
        if (!row) throw new Error("Missing seller fixture");
        rows.set(id, { ...row, status: "suspended" });
      },
    })(post(), SELLER_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: SELLER_ID,
      status: "suspended",
      provider: { suspended: false },
    });

    const read = createGetSellerHandler({
      getSession,
      getSeller,
      getDisplayName,
      getSellerOwner: async () => "another_user",
      getAccount: async (id) => ok({ id, raw: { status: "active" } }),
    });
    for (const [id, status] of [
      [SELLER_ID, "suspended"],
      [otherId, "active"],
    ] as const) {
      const detail = await read(new Request(`https://example.invalid/api/sellers/${id}`), id);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ id, status });
    }
    const list = await createListSellersHandler({
      getSession,
      getSeller,
      getDisplayName,
      getSellerIdForUser: async () => null,
      listSellers: async () => ({
        sellers: [...rows.values()].map((row) => ({ seller: row, displayName: null })),
        nextCursor: null,
      }),
      env: { WHOP_MODE: "mock" },
    })(new Request("https://example.invalid/api/sellers"));
    expect(list.status).toBe(200);
    expect((await list.json()).sellers).toMatchObject([
      { id: SELLER_ID, status: "suspended" },
      { id: otherId, status: "active" },
    ]);
    expect(rows.get(otherId)?.status).toBe("active");
  });

  it("returns 401 when signed out", async () => {
    const handler = createSuspendSellerHandler(
      baseDeps({ getSession: () => Promise.resolve(null) }),
    );
    const response = await handler(post(), "seller_1");
    expect(response.status).toBe(401);
  });

  it("returns 403 for a seller session", async () => {
    const handler = createSuspendSellerHandler(
      baseDeps({ getSession: () => Promise.resolve({ userId: "user_1", role: "seller" }) }),
    );
    const response = await handler(post(), "seller_1");
    expect(response.status).toBe(403);
  });

  it("returns 404 when the seller does not exist", async () => {
    const handler = createSuspendSellerHandler(
      baseDeps({ getSeller: () => Promise.resolve(null) }),
    );
    const response = await handler(post(), "seller_1");
    expect(response.status).toBe(404);
  });

  it("never calls a provider write; suspension is local only", async () => {
    let suspendCalls = 0;
    const handler = createSuspendSellerHandler(
      baseDeps({
        suspend: (id) => {
          suspendCalls += 1;
          expect(id).toBe("seller_1");
          return Promise.resolve();
        },
      }),
    );
    await handler(post(), "seller_1");
    expect(suspendCalls).toBe(1);
  });

  it("suspends the seller and returns 200 with the local-only provenance and provider fields", async () => {
    const handler = createSuspendSellerHandler(baseDeps());
    const response = await handler(post(), "seller_1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      provenance: string;
      provider: { suspended: boolean; reason: string };
    };
    expect(body.provenance).toBe("app");
    expect(body.provider).toEqual({
      suspended: false,
      reason: "no suspend operation in the provider port",
    });
  });
});
