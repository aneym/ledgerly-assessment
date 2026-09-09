import { ok, type Result, runId, type Seller, sellerId, whopAccountId } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import {
  createGetOwnSellerHandler,
  type GetOwnSellerDeps,
} from "../../src/app/api/sellers/me/route";

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

function baseDeps(overrides: Partial<GetOwnSellerDeps> = {}): GetOwnSellerDeps {
  return {
    getSession: () => Promise.resolve({ userId: "user_1", role: "buyer" }),
    getSellerOwner: () => Promise.resolve("user_1"),
    getSellerIdForUser: () => Promise.resolve(SELLER_ID),
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

function get() {
  return new Request("https://example.invalid/api/sellers/me");
}

describe("createGetOwnSellerHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createGetOwnSellerHandler(
      baseDeps({ getSession: () => Promise.resolve(null) }),
    );
    const response = await handler(get());
    expect(response.status).toBe(401);
  });

  it("returns 404 when the signed-in user owns no seller yet", async () => {
    const handler = createGetOwnSellerHandler(
      baseDeps({ getSellerIdForUser: () => Promise.resolve(null) }),
    );
    const response = await handler(get());
    expect(response.status).toBe(404);
  });

  it("resolves the caller's own seller id and returns it in the exact JSON shape", async () => {
    const handler = createGetOwnSellerHandler(baseDeps());
    const response = await handler(get());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; name: string };
    expect(body.id).toBe("seller_1");
    expect(body.name).toBe("alice");
  });

  it("still 404s if the resolved seller id has no seller record", async () => {
    const handler = createGetOwnSellerHandler(baseDeps({ getSeller: () => Promise.resolve(null) }));
    const response = await handler(get());
    expect(response.status).toBe(404);
  });
});
