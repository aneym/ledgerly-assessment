import { runId, type Seller, sellerId, whopAccountId } from "@ledgerly/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sellerApi } from "../src/lib/seller/api";
import { serializeSeller } from "../src/lib/seller-view";

afterEach(() => vi.unstubAllGlobals());

async function readResponse(body: unknown) {
  const fetch = vi.fn().mockResolvedValue(Response.json(body));
  vi.stubGlobal("fetch", fetch);
  const result = await sellerApi.read("seller_readback", "onboarding-readback-test");
  expect(fetch).toHaveBeenCalledWith(
    "/api/sellers/seller_readback",
    expect.objectContaining({ method: "GET", cache: "no-store" }),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected a seller readback");
  return result.data;
}

function serializedSeller(country: Seller["country"], salePolicy: Seller["salePolicy"]) {
  const id = sellerId("seller_readback");
  const run = runId("run_readback");
  const account = whopAccountId("biz_readback");
  if (!id.ok || !run.ok || !account.ok) throw new Error("Invalid fixture IDs");
  return serializeSeller(
    {
      id: id.value,
      runId: run.value,
      externalId: "readback-shop",
      email: "readback@example.invalid",
      country,
      salePolicy,
      status: "suspended",
      whopAccountId: account.value,
    },
    { id: account.value },
    "mock",
    { displayName: "Readback Shop", onboardingUrl: "https://example.invalid/onboard" },
  );
}

describe("sellerApi.read onboarding contract", () => {
  for (const [country, policy] of [
    ["DE", "direct"],
    ["BR", "platform_only"],
  ] as const) {
    for (const shape of ["flat", "compatibility envelope"] as const) {
      it(`preserves ${country} ${policy} and suspended status from the ${shape}`, async () => {
        const serialized = serializedSeller(country, policy);
        const { seller: legacy, ...flat } = serialized;
        const result = await readResponse(shape === "flat" ? flat : serialized);
        expect(result).toMatchObject({
          id: "seller_readback",
          name: "Readback Shop",
          country,
          status: "suspended",
          sale_policy: policy,
          whop_account_id: "biz_readback",
          verification: "verified",
          capabilities: { payments: "inactive", transfers: "inactive", payouts: "inactive" },
          required_actions: [],
          provenance: "mock",
          onboarding_url: "https://example.invalid/onboard",
          accountId: "biz_readback",
        });
        // OnboardingStatus checks camelCase first. A stale alias must not mask this policy.
        expect(result.salePolicy ?? result.sale_policy).toBe(policy);
        if (shape === "compatibility envelope") {
          expect(result.externalId).toBe(legacy.externalId);
        }
      });
    }
  }

  it("prefers canonical top-level fields over stale compatibility aliases", async () => {
    const result = await readResponse({
      id: "seller_readback",
      name: "Current name",
      country: "BR",
      sale_policy: "platform_only",
      salePolicy: "direct",
      status: "suspended",
      whop_account_id: null,
      whopAccountId: "biz_stale",
      verification: null,
      capabilities: { payments: "inactive" },
      required_actions: ["verify_identity"],
      provenance: "mock",
      account: null,
      accountError: "not_found",
      seller: {
        id: "seller_stale",
        name: "Old name",
        email: "legacy@example.invalid",
        country: "DE",
        salePolicy: "direct",
        status: "active",
        whopAccountId: "biz_stale",
        verification: "verified",
        capabilities: { payments: "active" },
      },
    });
    expect(result).toMatchObject({
      id: "seller_readback",
      name: "Current name",
      email: "legacy@example.invalid",
      country: "BR",
      salePolicy: "platform_only",
      sale_policy: "platform_only",
      status: "suspended",
      whopAccountId: null,
      whop_account_id: null,
      verification: null,
      capabilities: { payments: "inactive" },
      required_actions: ["verify_identity"],
      provenance: "mock",
      accountId: null,
      accountError: "not_found",
    });
  });

  it("accepts top-level camelCase fields ahead of nested snake_case", async () => {
    const result = await readResponse({
      salePolicy: "platform_only",
      status: "suspended",
      whopAccountId: "biz_current",
      seller: {
        id: "seller_readback",
        sale_policy: "direct",
        status: "active",
        whop_account_id: "biz_stale",
      },
    });
    expect(result).toMatchObject({
      salePolicy: "platform_only",
      sale_policy: "platform_only",
      status: "suspended",
      whopAccountId: "biz_current",
      whop_account_id: "biz_current",
    });
    expect(result.verification).toBeUndefined();
  });

  for (const [legacyPolicy, policy] of [
    ["direct", "direct"],
    ["platform_only", "platform_only"],
    ["direct_charge", "direct"],
    ["platform_charge_transfer", "platform_only"],
  ]) {
    it(`retains nested-only ${legacyPolicy} compatibility`, async () => {
      const result = await readResponse({
        seller: {
          id: "seller_readback",
          salePolicy: legacyPolicy,
          status: "active",
          country: "DE",
          whopAccountId: "biz_readback",
          requiredActions: ["verify_identity"],
        },
        account: { id: "biz_readback", private_provider_field: "not for the UI" },
      });
      expect(result).toMatchObject({
        sale_policy: policy,
        salePolicy: policy,
        status: "active",
        country: "DE",
        whopAccountId: "biz_readback",
        requiredActions: ["verify_identity"],
        accountId: "biz_readback",
      });
      expect(result.verification).toBeUndefined();
      expect(result).not.toHaveProperty("account");
      expect(result).not.toHaveProperty("private_provider_field");
    });
  }

  for (const invalid of [null, "verified", 42, { status: "active" }]) {
    it(`omits invalid status/policy ${JSON.stringify(invalid)} without using stale values`, async () => {
      const result = await readResponse({
        status: invalid,
        sale_policy: invalid,
        seller: { id: "seller_readback", status: "active", salePolicy: "direct" },
      });
      expect(result.status).toBeUndefined();
      expect(result.salePolicy ?? result.sale_policy).toBeUndefined();
      expect(result.verification).toBeUndefined();
    });
  }

  it("leaves missing status, policy and verification unreported", async () => {
    const result = await readResponse({ seller: { id: "seller_readback", country: "BR" } });
    expect(result.status).toBeUndefined();
    expect(result.salePolicy ?? result.sale_policy).toBeUndefined();
    expect(result.verification).toBeUndefined();
    expect(result.capabilities).toBeUndefined();
  });
});
