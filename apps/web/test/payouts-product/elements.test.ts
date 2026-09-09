import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type EmbeddedPayoutSession,
  mountPayoutElements,
  requestPayoutSession,
  type WhopElementsSdk,
} from "../../src/lib/seller/payout-session";

const data = (): EmbeddedPayoutSession => ({
  kind: "embedded",
  token: "fixture-first",
  accountId: "biz_owner",
  returnUrl: "https://ledgerly.example/sell/payouts",
  environment: "sandbox",
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
});

function boundary() {
  const mount = vi.fn();
  let callbacks: { onReady: () => void; onError: () => void };
  const breakdown = vi.fn((_type, options) => {
    callbacks = options;
    return { mount };
  });
  const wallet = {
    create: vi.fn(() => ({ create: breakdown })),
    update: vi.fn(),
    destroy: vi.fn(),
  };
  const create = vi.fn(() => wallet);
  const sdk = vi.fn(() => ({ wallet: { create } })) as unknown as WhopElementsSdk;
  const ready = vi.fn();
  const failed = vi.fn();
  const refresh = vi.fn(async (_signal: AbortSignal) => ({
    ...data(),
    token: "fixture-refreshed",
  }));
  const start = (initial = data()) =>
    mountPayoutElements(sdk, initial, refresh, "test", ready, failed);
  return {
    sdk,
    wallet,
    create,
    breakdown,
    mount,
    ready,
    failed,
    refresh,
    start,
    events: () => callbacks,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("current Elements wallet boundary", () => {
  it("mounts the scoped owner's read-only balance with the current callable SDK", () => {
    vi.useFakeTimers();
    const b = boundary();
    const session = b.start();
    expect(b.sdk).toHaveBeenCalledWith({
      environment: "sandbox",
      baseUrl: "https://js.whop.cloud/elements/amber",
      locale: "en",
      analytics: false,
      toasts: false,
    });
    expect(b.create).toHaveBeenCalledWith({
      accountId: "biz_owner",
      accessToken: "fixture-first",
      currency: "usd",
    });
    expect(b.wallet.create).toHaveBeenCalledWith("balances", { openHoldingOnSelect: false });
    expect(b.breakdown).toHaveBeenCalledWith(
      "breakdown",
      expect.objectContaining({ enabled: true }),
    );
    expect(b.mount).toHaveBeenCalledWith("#test-balance");
    b.events().onReady();
    b.events().onReady();
    expect(b.ready).toHaveBeenCalledTimes(1);
    session.destroy();
    session.destroy();
    expect(b.wallet.destroy).toHaveBeenCalledTimes(1);
  });
});

it("updates the token before each expiry without remounting the wallet", async () => {
  vi.useFakeTimers();
  const b = boundary();
  const session = b.start();
  b.events().onReady();
  await vi.advanceTimersByTimeAsync(284_999);
  expect(b.refresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(b.refresh).toHaveBeenCalledTimes(1);
  expect(b.wallet.update).toHaveBeenCalledWith({ accessToken: "fixture-refreshed" });
  expect(b.create).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(285_000);
  expect(b.refresh).toHaveBeenCalledTimes(2);
  expect(b.wallet.destroy).not.toHaveBeenCalled();
  session.destroy();
});

it.each([
  ["account change", { accountId: "biz_sibling" }],
  ["production mode", { environment: "production" }],
  ["mock mode", { environment: "mock" }],
  ["missing token", { token: "" }],
  ["expired response", { expiresAt: "2020-01-01T00:00:00Z" }],
])("rejects a refresh with %s and tears down once", async (_label, change) => {
  vi.useFakeTimers();
  const b = boundary();
  b.refresh.mockImplementation(async () => ({ ...data(), ...change }) as EmbeddedPayoutSession);
  const session = b.start();
  b.events().onReady();
  await vi.advanceTimersByTimeAsync(285_000);
  expect(b.wallet.update).not.toHaveBeenCalled();
  expect(b.failed).toHaveBeenCalledTimes(1);
  expect(b.wallet.destroy).toHaveBeenCalledTimes(1);
  expect(b.refresh.mock.calls[0][0].aborted).toBe(true);
  b.events().onReady();
  b.events().onError();
  session.destroy();
  expect(b.failed).toHaveBeenCalledTimes(1);
  expect(b.wallet.destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("expires and destroys while a refresh request is stalled, ignoring its late result", async () => {
  vi.useFakeTimers();
  const b = boundary();
  let resolve: (value: EmbeddedPayoutSession) => void = () => {};
  b.refresh.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  b.start();
  b.events().onReady();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(b.failed).toHaveBeenCalledTimes(1);
  expect(b.wallet.destroy).toHaveBeenCalledTimes(1);
  resolve(data());
  await Promise.resolve();
  await Promise.resolve();
  expect(b.wallet.update).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("aborts refresh and suppresses callbacks when the owning component unmounts", async () => {
  vi.useFakeTimers();
  const b = boundary();
  let resolve: (value: EmbeddedPayoutSession) => void = () => {};
  b.refresh.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const session = b.start();
  b.events().onReady();
  await vi.advanceTimersByTimeAsync(285_000);
  session.destroy();
  expect(b.refresh.mock.calls[0][0].aborted).toBe(true);
  resolve(data());
  await Promise.resolve();
  await Promise.resolve();
  b.events().onError();
  b.events().onReady();
  expect(b.failed).not.toHaveBeenCalled();
  expect(b.ready).toHaveBeenCalledTimes(1);
  expect(b.wallet.update).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("destroys the frame when owner authentication fails during refresh", async () => {
  vi.useFakeTimers();
  const b = boundary();
  b.refresh.mockRejectedValue(new Error("owner session expired"));
  b.start();
  b.events().onReady();
  await vi.advanceTimersByTimeAsync(285_000);
  expect(b.failed).toHaveBeenCalledTimes(1);
  expect(b.wallet.destroy).toHaveBeenCalledTimes(1);
  expect(b.wallet.update).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["timeout", "error", "mount throw"])("releases resources on %s", async (kind) => {
  vi.useFakeTimers();
  const b = boundary();
  if (kind === "mount throw") {
    b.mount.mockImplementation(() => {
      throw new Error("fixture mount failure");
    });
    expect(() => b.start()).toThrow("fixture mount failure");
  } else {
    b.start();
    if (kind === "error") b.events().onError();
    else await vi.advanceTimersByTimeAsync(30_000);
    expect(b.failed).toHaveBeenCalledTimes(1);
  }
  expect(b.wallet.destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["mock", "production"])("refuses %s before constructing the SDK", (environment) => {
  const b = boundary();
  expect(() => b.start({ ...data(), environment } as EmbeddedPayoutSession)).toThrow();
  expect(b.sdk).not.toHaveBeenCalled();
});
it("refuses an expired token before constructing the SDK", () => {
  const b = boundary();
  expect(() => b.start({ ...data(), expiresAt: "2020-01-01T00:00:00Z" })).toThrow("expired");
  expect(b.sdk).not.toHaveBeenCalled();
});

it("requests the owning seller route with no client-controlled account or scopes", async () => {
  const fetch = vi.fn(async () => Response.json(data()));
  vi.stubGlobal("fetch", fetch);
  const abort = new AbortController();
  expect(await requestPayoutSession("owner/a", "embedded", abort.signal)).toMatchObject({
    accountId: "biz_owner",
  });
  expect(fetch).toHaveBeenCalledWith("/api/sellers/owner%2Fa/payouts/session", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal: abort.signal,
    headers: { "Content-Type": "application/json" },
    body: '{"view":"embedded"}',
  });
});

it("rejects a non-sandbox session response at the client boundary", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ...data(), environment: "production" })),
  );
  await expect(requestPayoutSession("owner", "embedded")).rejects.toThrow();
});
