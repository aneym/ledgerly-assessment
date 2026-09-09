import { type Result, runId, type Seller, sellerId, whopAccountId } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import {
  createSetSellerPolicyHandler,
  type SetSellerPolicyDeps,
} from "../../src/app/api/sellers/[id]/policy/route";

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

function baseDeps(overrides: Partial<SetSellerPolicyDeps> = {}): SetSellerPolicyDeps {
  let policy: Seller["salePolicy"] = "direct";
  return {
    getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
    getSeller: () => Promise.resolve(seller({ salePolicy: policy })),
    setSalePolicy: (_id, salePolicyValue) => {
      policy = salePolicyValue;
      return Promise.resolve();
    },
    getDisplayName: () => Promise.resolve(null),
    ...overrides,
  };
}

function post(body: unknown) {
  return new Request("https://example.invalid/api/sellers/seller_1/policy", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("createSetSellerPolicyHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createSetSellerPolicyHandler(
      baseDeps({ getSession: () => Promise.resolve(null) }),
    );
    const response = await handler(post({ sale_policy: "platform_only" }), "seller_1");
    expect(response.status).toBe(401);
  });

  it("returns 403 for a seller session, even the seller's own owner", async () => {
    const handler = createSetSellerPolicyHandler(
      baseDeps({ getSession: () => Promise.resolve({ userId: "user_1", role: "seller" }) }),
    );
    const response = await handler(post({ sale_policy: "platform_only" }), "seller_1");
    expect(response.status).toBe(403);
  });

  it("rejects an invalid sale_policy value", async () => {
    const handler = createSetSellerPolicyHandler(baseDeps());
    const response = await handler(post({ sale_policy: "whatever" }), "seller_1");
    expect(response.status).toBe(400);
  });

  it("accepts the camelCase salePolicy alias", async () => {
    const handler = createSetSellerPolicyHandler(baseDeps());
    const response = await handler(post({ salePolicy: "platform_only" }), "seller_1");
    expect(response.status).toBe(200);
  });

  it("returns 404 when the seller does not exist", async () => {
    const handler = createSetSellerPolicyHandler(
      baseDeps({ getSeller: () => Promise.resolve(null) }),
    );
    const response = await handler(post({ sale_policy: "platform_only" }), "seller_1");
    expect(response.status).toBe(404);
  });

  it("writes the new policy and returns it in the response", async () => {
    let written: string | undefined;
    const handler = createSetSellerPolicyHandler(
      baseDeps({
        setSalePolicy: (_id, salePolicyValue) => {
          written = salePolicyValue;
          return Promise.resolve();
        },
        getSeller: () =>
          Promise.resolve(
            seller({ salePolicy: (written as "direct" | "platform_only") ?? "direct" }),
          ),
      }),
    );
    const response = await handler(post({ sale_policy: "platform_only" }), "seller_1");
    expect(response.status).toBe(200);
    expect(written).toBe("platform_only");
    const body = (await response.json()) as { sale_policy: string; provenance: string };
    expect(body.sale_policy).toBe("platform_only");
    expect(body.provenance).toBe("app");
  });
});
