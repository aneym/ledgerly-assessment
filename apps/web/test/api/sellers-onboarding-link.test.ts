import { err, ok, type Result, runId, type Seller, sellerId, whopAccountId } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import {
  createOnboardingLinkHandler,
  type OnboardingLinkDeps,
} from "../../src/app/api/sellers/[id]/onboarding-link/route";

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

function baseDeps(overrides: Partial<OnboardingLinkDeps> = {}): OnboardingLinkDeps {
  return {
    getSession: () => Promise.resolve({ userId: "user_1", role: "buyer" }),
    getSellerOwner: () => Promise.resolve("user_1"),
    getSeller: () => Promise.resolve(seller()),
    onboardSeller: () =>
      Promise.resolve(
        ok({
          seller: {
            id: SELLER_ID,
            runId: value(runId("run_1")),
            externalId: "alice",
            email: "alice@example.invalid",
            country: "US" as const,
            whopAccountId: value(whopAccountId("biz_alice")),
          },
          operationKey: "op_1",
          onboardingUrl: "https://onboard.example.invalid/refresh",
        }),
      ),
    env: { WHOP_MODE: "mock" as const },
    ...overrides,
  };
}

function post() {
  return new Request("https://example.invalid/api/sellers/seller_1/onboarding-link", {
    method: "POST",
  });
}

describe("createOnboardingLinkHandler", () => {
  it("returns 403 for a caller who does not own the seller", async () => {
    const handler = createOnboardingLinkHandler(
      baseDeps({ getSellerOwner: () => Promise.resolve("someone_else") }),
    );
    const response = await handler(post(), SELLER_ID);
    expect(response.status).toBe(403);
  });

  it("returns 404 when the seller does not exist", async () => {
    const handler = createOnboardingLinkHandler(
      baseDeps({ getSeller: () => Promise.resolve(null) }),
    );
    const response = await handler(post(), SELLER_ID);
    expect(response.status).toBe(404);
  });

  it("returns a fresh onboarding url in the exact JSON shape", async () => {
    const handler = createOnboardingLinkHandler(baseDeps());
    const response = await handler(post(), SELLER_ID);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      url: string;
      expires_at: string | null;
      provenance: string;
    };
    expect(body).toEqual({
      url: "https://onboard.example.invalid/refresh",
      expires_at: null,
      provenance: "mock",
    });
  });

  it("maps a provider error to 502", async () => {
    const handler = createOnboardingLinkHandler(
      baseDeps({ onboardSeller: () => Promise.resolve(err({ kind: "network" as const })) }),
    );
    const response = await handler(post(), SELLER_ID);
    expect(response.status).toBe(502);
  });
});
