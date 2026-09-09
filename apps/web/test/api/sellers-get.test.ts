import { ok, type Result, runId, type Seller, sellerId, whopAccountId } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import { createGetSellerHandler, type GetSellerDeps } from "../../src/app/api/sellers/[id]/route";

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

function baseDeps(overrides: Partial<GetSellerDeps> = {}): GetSellerDeps {
  return {
    getSession: () => Promise.resolve({ userId: "user_1", role: "buyer" }),
    getSellerOwner: () => Promise.resolve("user_1"),
    getSeller: () => Promise.resolve(seller()),
    getAccount: () =>
      Promise.resolve(
        ok({
          id: value(whopAccountId("biz_alice")),
          raw: { capabilities: { accept_card_payments: "active", transfer: "active" } },
        }),
      ),
    getDisplayName: () => Promise.resolve(null),
    ...overrides,
  };
}

describe("createGetSellerHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createGetSellerHandler(baseDeps({ getSession: () => Promise.resolve(null) }));
    const response = await handler(
      new Request("https://example.invalid/api/sellers/seller_1"),
      SELLER_ID,
    );
    expect(response.status).toBe(401);
  });

  it("returns 403 for a signed-in user who does not own the seller", async () => {
    const handler = createGetSellerHandler(
      baseDeps({ getSellerOwner: () => Promise.resolve("someone_else") }),
    );
    const response = await handler(
      new Request("https://example.invalid/api/sellers/seller_1"),
      SELLER_ID,
    );
    expect(response.status).toBe(403);
  });

  it("allows an operator regardless of ownership", async () => {
    const handler = createGetSellerHandler(
      baseDeps({
        getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
        getSellerOwner: () => Promise.resolve("someone_else"),
      }),
    );
    const response = await handler(
      new Request("https://example.invalid/api/sellers/seller_1"),
      SELLER_ID,
    );
    expect(response.status).toBe(200);
  });

  it("returns 404 when the seller does not exist", async () => {
    const handler = createGetSellerHandler(baseDeps({ getSeller: () => Promise.resolve(null) }));
    const response = await handler(
      new Request("https://example.invalid/api/sellers/seller_1"),
      SELLER_ID,
    );
    expect(response.status).toBe(404);
  });

  it("returns the seller in the exact JSON shape, with a live capabilities readback", async () => {
    const handler = createGetSellerHandler(baseDeps());
    const response = await handler(
      new Request("https://example.invalid/api/sellers/seller_1"),
      SELLER_ID,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      name: string;
      whop_account_id: string;
      verification: string;
      capabilities: { payments: string; transfers: string; payouts: string };
      provenance: string;
    };
    expect(body.id).toBe("seller_1");
    expect(body.name).toBe("alice");
    expect(body.whop_account_id).toBe("biz_alice");
    expect(body.verification).toBe("verified");
    expect(body.capabilities).toEqual({
      payments: "active",
      transfers: "active",
      payouts: "inactive",
    });
    expect(body.provenance).toBe("mock");
    expect(body).not.toHaveProperty("onboarding_url");
  });

  it("prefers the stored display name over externalId when one is set", async () => {
    const handler = createGetSellerHandler(
      baseDeps({ getDisplayName: () => Promise.resolve("Alice's Shop") }),
    );
    const response = await handler(
      new Request("https://example.invalid/api/sellers/seller_1"),
      SELLER_ID,
    );
    const body = (await response.json()) as { name: string };
    expect(body.name).toBe("Alice's Shop");
  });

  it("reports no capabilities and an unverified status when the seller has never onboarded", async () => {
    const handler = createGetSellerHandler(
      baseDeps({ getSeller: () => Promise.resolve(seller({ whopAccountId: null })) }),
    );
    const response = await handler(
      new Request("https://example.invalid/api/sellers/seller_1"),
      SELLER_ID,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      whop_account_id: string | null;
      verification: string;
      capabilities: { payments: string; transfers: string; payouts: string };
    };
    expect(body.whop_account_id).toBeNull();
    expect(body.verification).toBe("unverified");
    expect(body.capabilities).toEqual({
      payments: "inactive",
      transfers: "inactive",
      payouts: "inactive",
    });
  });
});
