import { err, ok, type Result, type WhopPort, whopAccountId } from "@ledgerly/core";
import { afterEach, expect, it, vi } from "vitest";
import { readPlatformCapabilities } from "../src/index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const platformAccountId = value(whopAccountId("biz_platform"));

// Every other WhopPort method is unused by the capability reader; a call to any of
// them here would mean the reader reached past the single account read it is allowed.
function unusedMethod(name: string) {
  return async () => {
    throw new Error(`${name} should not be called by the capability reader`);
  };
}
function fakeSandbox(getAccount: WhopPort["getAccount"]): WhopPort {
  return {
    createAccount: unusedMethod("createAccount"),
    createOrFetchAccount: unusedMethod("createOrFetchAccount"),
    updateAccount: unusedMethod("updateAccount"),
    listPayments: unusedMethod("listPayments"),
    listTransfers: unusedMethod("listTransfers"),
    createOnboardingLink: unusedMethod("createOnboardingLink"),
    createCheckoutConfiguration: unusedMethod("createCheckoutConfiguration"),
    suspendAccount: unusedMethod("suspendAccount"),
    getCheckoutConfiguration: unusedMethod("getCheckoutConfiguration"),
    listRefunds: unusedMethod("listRefunds"),
    getRefund: unusedMethod("getRefund"),
    listDisputes: unusedMethod("listDisputes"),
    getDispute: unusedMethod("getDispute"),
    getTransfer: unusedMethod("getTransfer"),
    listTransferRecipients: unusedMethod("listTransferRecipients"),
    listPayouts: unusedMethod("listPayouts"),
    getPayout: unusedMethod("getPayout"),
    createPayout: unusedMethod("createPayout"),
    listPayoutMethods: unusedMethod("listPayoutMethods"),
    listSupportedPayoutMethods: unusedMethod("listSupportedPayoutMethods"),
    listFeeMarkups: unusedMethod("listFeeMarkups"),
    createFeeMarkup: unusedMethod("createFeeMarkup"),
    createTopup: unusedMethod("createTopup"),
    listWebhooks: unusedMethod("listWebhooks"),
    getWebhook: unusedMethod("getWebhook"),
    createWebhook: unusedMethod("createWebhook"),
    updateWebhook: unusedMethod("updateWebhook"),
    sendWebhookTest: unusedMethod("sendWebhookTest"),
    listWebhookDeliveries: unusedMethod("listWebhookDeliveries"),
    replayWebhookDelivery: unusedMethod("replayWebhookDelivery"),
    createApiKey: unusedMethod("createApiKey"),
    listApiKeyPermissions: unusedMethod("listApiKeyPermissions"),
    listFinancialActivity: unusedMethod("listFinancialActivity"),
    getLedgerAccount: unusedMethod("getLedgerAccount"),
    getAccount,
    getPayment: unusedMethod("getPayment"),
    listPaymentFees: unusedMethod("listPaymentFees"),
    refundPayment: unusedMethod("refundPayment"),
    createTransfer: unusedMethod("createTransfer"),
    createAccessToken: unusedMethod("createAccessToken"),
    createPayoutPortalLink: unusedMethod("createPayoutPortalLink"),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it("reads the platform account once and caches capabilities within the TTL", async () => {
  const getAccount = vi.fn<WhopPort["getAccount"]>().mockImplementation(async () =>
    ok({
      id: platformAccountId,
      raw: {
        capabilities: { transfer: "inactive", standard_payout: "inactive" },
        required_actions: [{ action: "verify_identity" }],
      },
    }),
  );
  const reader = readPlatformCapabilities(fakeSandbox(getAccount), platformAccountId, {
    now: () => new Date("2026-09-08T12:00:00Z"),
  });
  const first = await reader.read();
  expect(first).toEqual({
    capabilities: { transfer: "inactive", standard_payout: "inactive" },
    requiredActions: ["verify_identity"],
    readAt: new Date("2026-09-08T12:00:00Z"),
  });
  const second = await reader.read();
  expect(second).toEqual(first);
  expect(getAccount).toHaveBeenCalledTimes(1);
});

it("refresh() re-reads regardless of the cache", async () => {
  let calls = 0;
  const getAccount = vi.fn<WhopPort["getAccount"]>().mockImplementation(async () => {
    calls++;
    return ok({
      id: platformAccountId,
      raw: { capabilities: { transfer: calls === 1 ? "inactive" : "active" } },
    });
  });
  const reader = readPlatformCapabilities(fakeSandbox(getAccount), platformAccountId, {
    now: () => new Date("2026-09-08T12:00:00Z"),
  });
  expect((await reader.read()).capabilities.transfer).toBe("inactive");
  expect((await reader.refresh()).capabilities.transfer).toBe("active");
  expect(getAccount).toHaveBeenCalledTimes(2);
});

it("re-reads once the TTL elapses", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  let calls = 0;
  const getAccount = vi.fn<WhopPort["getAccount"]>().mockImplementation(async () => {
    calls++;
    return ok({
      id: platformAccountId,
      raw: { capabilities: { transfer: calls === 1 ? "inactive" : "active" } },
    });
  });
  const reader = readPlatformCapabilities(fakeSandbox(getAccount), platformAccountId, {
    now: () => new Date(),
    ttlMs: 10 * 60 * 1000,
  });
  expect((await reader.read()).capabilities.transfer).toBe("inactive");
  vi.setSystemTime(new Date("2026-09-08T12:09:59Z"));
  expect((await reader.read()).capabilities.transfer).toBe("inactive");
  expect(getAccount).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date("2026-09-08T12:10:00.001Z"));
  expect((await reader.read()).capabilities.transfer).toBe("active");
  expect(getAccount).toHaveBeenCalledTimes(2);
});

it("reports readAt: null and no capabilities when the sandbox read fails", async () => {
  const getAccount = vi
    .fn<WhopPort["getAccount"]>()
    .mockImplementation(async () => err({ kind: "http", status: 500, body: null }));
  const reader = readPlatformCapabilities(fakeSandbox(getAccount), platformAccountId, {
    now: () => new Date("2026-09-08T12:00:00Z"),
  });
  expect(await reader.read()).toEqual({ capabilities: {}, requiredActions: [], readAt: null });
});

it("treats an unparseable raw payload as no known capabilities rather than throwing", async () => {
  const getAccount = vi
    .fn<WhopPort["getAccount"]>()
    .mockImplementation(async () => ok({ id: platformAccountId, raw: "not-an-object" }));
  const reader = readPlatformCapabilities(fakeSandbox(getAccount), platformAccountId, {
    now: () => new Date("2026-09-08T12:00:00Z"),
  });
  const snapshot = await reader.read();
  expect(snapshot.capabilities).toEqual({});
  expect(snapshot.requiredActions).toEqual([]);
  expect(snapshot.readAt).toEqual(new Date("2026-09-08T12:00:00Z"));
});
