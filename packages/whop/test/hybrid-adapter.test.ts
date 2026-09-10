import {
  type InstrumentationEvent,
  ok,
  type Result,
  type WhopPort,
  whopAccountId,
  whopPaymentId,
} from "@ledgerly/core";
import { expect, it, vi } from "vitest";
import {
  createCredentialMissingAdapter,
  createHybridAdapter,
  createMockAdapter,
  createSandboxAdapter,
  createWhopAdapter,
  createWhopClient,
  type HybridWhopAdapter,
  type RoutedEvent,
  readPlatformCapabilities,
  wrapWithCapabilityGate,
} from "../src/index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const platformAccountId = value(whopAccountId("biz_platform"));
const seller = {
  externalId: "run1:seller1",
  runId: "run1",
  email: "seller@example.invalid",
  country: "US" as const,
  title: "Seller",
};

type Capabilities = Record<string, "active" | "inactive"> | "fail";

function setup(capabilities: Capabilities, now = () => new Date("2026-09-08T12:00:00Z")) {
  let current = capabilities;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === `/api/v1/accounts/${platformAccountId}`) {
      if (current === "fail") return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ id: platformAccountId, capabilities: current }));
    }
    if (method === "GET" && url.pathname.startsWith("/api/v1/accounts/"))
      return new Response(JSON.stringify({ id: url.pathname.replace("/api/v1/accounts/", "") }));
    if (method === "GET" && url.pathname.startsWith("/api/v1/ledger_accounts/"))
      return new Response(JSON.stringify({ id: "ldgr_sandbox_test" }));
    if (method === "POST" && url.pathname === "/api/v1/transfers")
      return new Response(JSON.stringify({ id: "tsf_sandbox_test" }));
    if (method === "POST" && url.pathname === "/api/v1/access_tokens")
      return new Response(JSON.stringify({ token: "token_sandbox_test" }));
    if (method === "POST" && url.pathname === "/api/v1/account_links")
      return new Response(JSON.stringify({ url: "https://sandbox.invalid/payout" }));
    throw new Error(`Unexpected sandbox request: ${method} ${url.pathname}`);
  });
  const client = createWhopClient({
    baseUrl: "https://sandbox.invalid/api/v1",
    apiKey: "fixture-key",
    apiVersionDate: "2026-08-21",
    fetch,
  });
  const sandbox = createSandboxAdapter({ client, parentAccountId: platformAccountId, now });
  const mock = createMockAdapter({ now });
  const capabilityReader = readPlatformCapabilities(sandbox, platformAccountId, { now });
  const onRouted = vi.fn<(event: RoutedEvent) => void>();
  const adapter = createHybridAdapter({ sandbox, mock, capabilities: capabilityReader, onRouted });
  return {
    adapter,
    fetch,
    mock,
    onRouted,
    setCapabilities(next: Capabilities) {
      current = next;
    },
  };
}

it("routes createTransfer to the mock adapter when transfer is inactive", async () => {
  const { adapter, fetch, mock, onRouted } = setup({
    transfer: "inactive",
    standard_payout: "inactive",
  });
  const origin = value(await mock.createOrFetchAccount(seller, "origin"));
  const destination = value(
    await mock.createOrFetchAccount(
      { ...seller, externalId: "s2", email: "s2@example.invalid" },
      "dest",
    ),
  );
  mock.seedBalance(origin.id, { amountMinor: 5000, currency: "USD" });
  const result = value(
    await adapter.createTransfer(
      {
        originId: origin.id,
        destinationId: destination.id,
        amount: { amountMinor: 1000, currency: "USD" },
        metadata: {},
      },
      "transfer-1",
    ),
  );
  expect(result.id).toBe("tsf_mock_1");
  expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  expect(onRouted).toHaveBeenCalledWith({ operation: "createTransfer", source: "mock" });
});

it("routes createTransfer to sandbox when transfer is active", async () => {
  const originId = value(whopAccountId("biz_origin"));
  const destinationId = value(whopAccountId("biz_destination"));
  const { adapter, fetch, onRouted } = setup({ transfer: "active", standard_payout: "inactive" });
  const result = value(
    await adapter.createTransfer(
      { originId, destinationId, amount: { amountMinor: 1000, currency: "USD" }, metadata: {} },
      "transfer-1",
    ),
  );
  expect(result.id).toBe("tsf_sandbox_test");
  const transferCall = fetch.mock.calls.find(([, init]) => init?.method === "POST");
  expect(String(transferCall?.[0])).toBe("https://sandbox.invalid/api/v1/transfers");
  expect(onRouted).toHaveBeenCalledWith({ operation: "createTransfer", source: "sandbox" });
});

it("routes createAccessToken and createPayoutPortalLink on standard_payout", async () => {
  const inactive = setup({ transfer: "inactive", standard_payout: "inactive" });
  const account = value(await inactive.mock.createOrFetchAccount(seller, "a"));
  const mockToken = value(
    await inactive.adapter.createAccessToken(
      {
        accountId: account.id,
        scopedActions: ["payout:read"],
        expiresAt: new Date("2026-09-08T13:00:00Z"),
      },
      "token-1",
    ),
  );
  expect(mockToken.token).toBe("mock_token_1");
  expect(inactive.onRouted).toHaveBeenCalledWith({
    operation: "createAccessToken",
    source: "mock",
  });

  const active = setup({ transfer: "inactive", standard_payout: "active" });
  const accountId = value(whopAccountId("biz_seller"));
  const sandboxLink = value(
    await active.adapter.createPayoutPortalLink(
      { accountId, returnUrl: "https://example.invalid/done" },
      "portal-1",
    ),
  );
  expect(sandboxLink.url).toBe("https://sandbox.invalid/payout");
  expect(active.onRouted).toHaveBeenCalledWith({
    operation: "createPayoutPortalLink",
    source: "sandbox",
  });
});

it("routes every static operation to sandbox and fires onRouted for it", async () => {
  const { adapter, onRouted } = setup({ transfer: "inactive", standard_payout: "inactive" });
  const accountId = value(whopAccountId("biz_seller"));
  await adapter.getAccount(accountId, "read");
  expect(onRouted).toHaveBeenCalledWith({ operation: "getAccount", source: "sandbox" });
});

it("describe() lists the source for every WhopPort operation", async () => {
  const { adapter } = setup({ transfer: "active", standard_payout: "inactive" });
  const description = await adapter.describe();
  expect(description).toEqual({
    mode: "hybrid",
    routing: {
      createAccount: "sandbox",
      createOrFetchAccount: "sandbox",
      updateAccount: "sandbox",
      getAccount: "sandbox",
      createOnboardingLink: "sandbox",
      createCheckoutConfiguration: "sandbox",
      getPayment: "sandbox",
      listPaymentFees: "sandbox",
      refundPayment: "sandbox",
      listPayments: "sandbox",
      listTransfers: "sandbox",
      createTransfer: "sandbox",
      createAccessToken: "mock",
      createPayoutPortalLink: "mock",
      suspendAccount: "sandbox",
      getCheckoutConfiguration: "sandbox",
      listRefunds: "sandbox",
      getRefund: "sandbox",
      listDisputes: "sandbox",
      getDispute: "sandbox",
      getTransfer: "sandbox",
      listTransferRecipients: "sandbox",
      listPayouts: "sandbox",
      getPayout: "mock",
      createPayout: "mock",
      listPayoutMethods: "sandbox",
      listSupportedPayoutMethods: "sandbox",
      listFeeMarkups: "sandbox",
      createFeeMarkup: "sandbox",
      createTopup: "mock",
      listWebhooks: "sandbox",
      getWebhook: "sandbox",
      createWebhook: "sandbox",
      updateWebhook: "sandbox",
      sendWebhookTest: "sandbox",
      listWebhookDeliveries: "sandbox",
      replayWebhookDelivery: "sandbox",
      createApiKey: "sandbox",
      listApiKeyPermissions: "sandbox",
      listFinancialActivity: "sandbox",
      getLedgerAccount: "sandbox",
    },
    readAt: new Date("2026-09-08T12:00:00Z"),
  });
});

it("re-routes a gated operation once the capability cache TTL elapses", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  const { adapter, setCapabilities } = setup(
    { transfer: "inactive", standard_payout: "inactive" },
    () => new Date(),
  );
  expect(await adapter.sourceOf("createTransfer")).toBe("mock");
  setCapabilities({ transfer: "active", standard_payout: "inactive" });
  vi.setSystemTime(new Date("2026-09-08T12:09:59Z"));
  expect(await adapter.sourceOf("createTransfer")).toBe("mock");
  vi.setSystemTime(new Date("2026-09-08T12:10:00.001Z"));
  expect(await adapter.sourceOf("createTransfer")).toBe("sandbox");
  vi.useRealTimers();
});

it("falls back gated operations to mock and reports readAt: null when the capability read fails", async () => {
  const { adapter, mock } = setup("fail");
  expect(await adapter.sourceOf("createTransfer")).toBe("mock");
  expect(await adapter.sourceOf("createAccessToken")).toBe("mock");
  expect(await adapter.sourceOf("createPayoutPortalLink")).toBe("mock");
  const description = await adapter.describe();
  expect(description.readAt).toBeNull();
  const account = value(await mock.createOrFetchAccount(seller, "a"));
  const token = value(
    await adapter.createAccessToken(
      {
        accountId: account.id,
        scopedActions: ["payout:read"],
        expiresAt: new Date("2026-09-08T13:00:00Z"),
      },
      "token-1",
    ),
  );
  expect(token.token).toBe("mock_token_1");
});

// --- meta enrichment -------------------------------------------------------------
// Every successful value the hybrid adapter returns carries a `meta` field so the
// demo-runtime tour can tell where a result came from. status/requestId stay undefined
// for sandbox-routed calls: the underlying client only threads HTTP status and
// request-id into its error branch and its own telemetry, never onto a successful
// Result, and changing that is outside this package's ownership (client.ts).

it("attaches sandbox-source meta with no gate to a static operation", async () => {
  const { adapter } = setup({ transfer: "inactive", standard_payout: "inactive" });
  const accountId = value(whopAccountId("biz_seller"));
  const result = await adapter.getAccount(accountId, "read");
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  expect(result.value.meta).toEqual({ source: "sandbox", status: undefined, requestId: undefined });
});

it("attaches gate: null to a gated operation routed to sandbox", async () => {
  const originId = value(whopAccountId("biz_origin"));
  const destinationId = value(whopAccountId("biz_destination"));
  const { adapter } = setup({ transfer: "active", standard_payout: "inactive" });
  const result = await adapter.createTransfer(
    { originId, destinationId, amount: { amountMinor: 1000, currency: "USD" }, metadata: {} },
    "transfer-meta-sandbox",
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  expect(result.value.meta).toEqual({
    source: "sandbox",
    status: undefined,
    requestId: undefined,
    gate: null,
  });
});

it("attaches gate: G01 to a gated operation routed to mock, so the tour can choose to block it", async () => {
  const { adapter, mock } = setup({ transfer: "inactive", standard_payout: "inactive" });
  const origin = value(await mock.createOrFetchAccount(seller, "meta-origin"));
  const destination = value(
    await mock.createOrFetchAccount(
      { ...seller, externalId: "meta-dest", email: "meta-dest@example.invalid" },
      "meta-dest",
    ),
  );
  mock.seedBalance(origin.id, { amountMinor: 5000, currency: "USD" });
  const result = await adapter.createTransfer(
    {
      originId: origin.id,
      destinationId: destination.id,
      amount: { amountMinor: 1000, currency: "USD" },
      metadata: {},
    },
    "transfer-meta-mock",
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  expect(result.value.meta).toEqual({
    source: "mock",
    status: undefined,
    requestId: undefined,
    gate: "G01",
  });
});

it("attaches meta to an array result (listPaymentFees) without losing array semantics", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ data: [{ amount: { amount: "5.00", currency: "usd" } }] })),
    );
  const client = createWhopClient({
    baseUrl: "https://sandbox.invalid/api/v1",
    apiKey: "fixture-key",
    apiVersionDate: "2026-08-21",
    fetch,
  });
  const sandbox = createSandboxAdapter({ client, parentAccountId: platformAccountId });
  const adapter = createHybridAdapter({
    sandbox,
    mock: createMockAdapter(),
    capabilities: readPlatformCapabilities(sandbox, platformAccountId),
  });
  const paymentId = value(whopPaymentId("pay_fixture"));
  const result = await adapter.listPaymentFees(paymentId, "fees-1");
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  expect(Array.isArray(result.value)).toBe(true);
  expect(result.value).toHaveLength(1);
  expect(result.value[0]?.amount).toEqual({ amountMinor: 500, currency: "USD" });
  expect(result.value.meta).toEqual({ source: "sandbox", status: undefined, requestId: undefined });
});

// --- standalone-sandbox capability gate -------------------------------------------
// WHOP_MODE=sandbox has no mock to fall back to, so an inactive gated capability must
// refuse the call outright rather than reaching the real API.

function fakeSandbox(capabilities: Record<string, "active" | "inactive">) {
  const mock = createMockAdapter({ now: () => new Date("2026-09-08T12:00:00Z") });
  const port: WhopPort = {
    ...mock,
    getAccount: async (accountId, key) =>
      accountId === platformAccountId
        ? ok({ id: platformAccountId, raw: { capabilities } })
        : mock.getAccount(accountId, key),
  };
  return { port, mock };
}

it.each(["inactive", "unknown"] as const)(
  "wrapWithCapabilityGate refuses an %s capability with no request and one event pair",
  async (state) => {
    const events: InstrumentationEvent[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("Unexpected request"));
    const client = createWhopClient({
      baseUrl: "https://sandbox.invalid/api/v1",
      apiKey: "fixture-key",
      apiVersionDate: "2026-08-21",
      fetch,
      onEvent: (event) => events.push(event),
    });
    const sandbox = createSandboxAdapter({ client, parentAccountId: platformAccountId });
    // Read capabilities from the local fixture so the assertion measures refusal dispatch.
    const { port } = fakeSandbox(state === "inactive" ? { transfer: "inactive" } : {});
    const reader = readPlatformCapabilities(port, platformAccountId);
    const gated = wrapWithCapabilityGate(sandbox, reader, (event) => events.push(event));
    expect(
      await gated.createTransfer(
        {
          originId: platformAccountId,
          destinationId: value(whopAccountId("biz_seller")),
          amount: { amountMinor: 1000, currency: "USD" },
          metadata: {},
        },
        "gate-transfer",
      ),
    ).toEqual({
      ok: false,
      error: { kind: "capability_inactive", capability: "transfer", gate: "G01" },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(events).toHaveLength(2);
    const [start, end] = events;
    expect(start).toMatchObject({
      source: "whop",
      phase: "start",
      provenance: "mock",
      method: "POST",
      path: "/transfers",
      status: null,
    });
    expect(end).toMatchObject({
      source: "whop",
      phase: "end",
      provenance: "mock",
      method: "POST",
      path: "/transfers",
      status: null,
      gate: { id: "G01", reason: "Whop capability is not active on this account (transfer)" },
    });
    expect(start?.correlationId).toBe(end?.correlationId);
  },
);

it("wrapWithCapabilityGate calls the sandbox once the capability is active", async () => {
  const { port, mock } = fakeSandbox({ transfer: "active", standard_payout: "inactive" });
  const reader = readPlatformCapabilities(port, platformAccountId, {
    now: () => new Date("2026-09-08T12:00:00Z"),
  });
  const gated = wrapWithCapabilityGate(port, reader);
  const origin = value(await port.createOrFetchAccount(seller, "gate-origin-2"));
  const destination = value(
    await port.createOrFetchAccount(
      { ...seller, externalId: "gate-dest-2", email: "gate-dest-2@example.invalid" },
      "gate-dest-2",
    ),
  );
  mock.seedBalance(origin.id, { amountMinor: 5000, currency: "USD" });
  const transfer = value(
    await gated.createTransfer(
      {
        originId: origin.id,
        destinationId: destination.id,
        amount: { amountMinor: 1000, currency: "USD" },
        metadata: {},
      },
      "gate-transfer-2",
    ),
  );
  expect(transfer.id).toBe("tsf_mock_1");
});

it("wrapWithCapabilityGate passes non-gated operations straight through", async () => {
  const { port } = fakeSandbox({ transfer: "inactive", standard_payout: "inactive" });
  const reader = readPlatformCapabilities(port, platformAccountId, {
    now: () => new Date("2026-09-08T12:00:00Z"),
  });
  const gated = wrapWithCapabilityGate(port, reader);
  const account = value(await gated.createOrFetchAccount(seller, "passthrough"));
  expect(account.disposition).toBe("unknown");
});

// --- credential_missing ------------------------------------------------------------

it("createCredentialMissingAdapter reports the same failure on every operation without any network call", async () => {
  const stub = createCredentialMissingAdapter();
  const accountId = value(whopAccountId("biz_seller"));
  expect(await stub.getAccount(accountId, "k")).toEqual({
    ok: false,
    error: { kind: "credential_missing", gate: "CRED" },
  });
  expect(
    await stub.createTransfer(
      {
        originId: accountId,
        destinationId: platformAccountId,
        amount: { amountMinor: 100, currency: "USD" },
        metadata: {},
      },
      "k",
    ),
  ).toEqual({ ok: false, error: { kind: "credential_missing", gate: "CRED" } });
});

it("createWhopAdapter returns a working sandbox adapter instead of throwing when WHOP_API_KEY is absent", async () => {
  const adapter = createWhopAdapter({
    WHOP_MODE: "sandbox",
    WHOP_API_VERSION_DATE: "2026-08-21",
    WHOP_PLATFORM_ACCOUNT_ID: "biz_platform",
  });
  const accountId = value(whopAccountId("biz_seller"));
  expect(await adapter.getAccount(accountId, "k")).toEqual({
    ok: false,
    error: { kind: "credential_missing", gate: "CRED" },
  });
});

it("createWhopAdapter in hybrid mode without WHOP_API_KEY falls gated operations back to mock", async () => {
  const adapter = createWhopAdapter({
    WHOP_MODE: "hybrid",
    WHOP_API_VERSION_DATE: "2026-08-21",
    WHOP_PLATFORM_ACCOUNT_ID: "biz_platform",
  }) as HybridWhopAdapter;
  expect(await adapter.sourceOf("createTransfer")).toBe("mock");
  const accountId = value(whopAccountId("biz_seller"));
  expect(await adapter.getAccount(accountId, "k")).toEqual({
    ok: false,
    error: { kind: "credential_missing", gate: "CRED" },
  });
});

// --- instrumentation for mock-routed and gated/credential-missing short-circuits --------
// Both of these paths resolve before client.ts's own withSpan call ever runs (a mock-routed
// operation never touches the real client; a gated or credential-missing short-circuit
// refuses before reaching it), so without a synthetic frame the demo-runtime tour overlay
// would see nothing for them. onEvent threads into createHybridAdapter,
// wrapWithCapabilityGate, and createCredentialMissingAdapter to close that gap.

function whopFrames(events: InstrumentationEvent[]): InstrumentationEvent[] {
  return events.filter((event) => event.source === "whop");
}

it("a mock-routed transfer emits a start and end frame with provenance mock and gate G01", async () => {
  const events: InstrumentationEvent[] = [];
  const mock = createMockAdapter({ now: () => new Date("2026-09-08T12:00:00Z") });
  const sandbox = createMockAdapter({ now: () => new Date("2026-09-08T12:00:00Z") });
  const capabilities = readPlatformCapabilities(sandbox, platformAccountId, {
    now: () => new Date("2026-09-08T12:00:00Z"),
  });
  const adapter = createHybridAdapter({
    sandbox,
    mock,
    capabilities,
    onEvent: (event) => events.push(event),
  });
  const origin = value(await mock.createOrFetchAccount(seller, "instr-origin"));
  const destination = value(
    await mock.createOrFetchAccount(
      { ...seller, externalId: "instr-dest", email: "instr-dest@example.invalid" },
      "instr-dest",
    ),
  );
  mock.seedBalance(origin.id, { amountMinor: 5000, currency: "USD" });
  const result = await adapter.createTransfer(
    {
      originId: origin.id,
      destinationId: destination.id,
      amount: { amountMinor: 1000, currency: "USD" },
      metadata: {},
    },
    "instr-transfer",
  );
  expect(result.ok).toBe(true);
  const frames = whopFrames(events);
  expect(frames).toHaveLength(2);
  const [start, end] = frames;
  expect(start).toMatchObject({
    phase: "start",
    provenance: "mock",
    method: "POST",
    path: "/transfers",
    status: null,
  });
  expect(end).toMatchObject({
    phase: "end",
    provenance: "mock",
    method: "POST",
    path: "/transfers",
    status: null,
    gate: { id: "G01", reason: "transfer capability is not active on this account" },
  });
  expect(start?.correlationId).toBe(end?.correlationId);
});

it("a credential_missing short-circuit emits a whop end frame with gate CRED", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected request"));
  try {
    const events: InstrumentationEvent[] = [];
    const stub = createCredentialMissingAdapter((event) => events.push(event));
    const accountId = value(whopAccountId("biz_seller"));
    const result = await stub.getAccount(accountId, "instr-key");
    expect(result).toEqual({ ok: false, error: { kind: "credential_missing", gate: "CRED" } });
    const frames = whopFrames(events);
    expect(fetch).not.toHaveBeenCalled();
    expect(events).toHaveLength(2);
    const [start, end] = frames;
    expect(start).toMatchObject({ phase: "start", provenance: "mock", method: "GET" });
    expect(end).toMatchObject({
      phase: "end",
      provenance: "mock",
      method: "GET",
      path: "/accounts/:accountId",
      status: null,
      gate: { id: "CRED", reason: "No Whop credential is configured" },
    });
    expect(start?.correlationId).toBe(end?.correlationId);
  } finally {
    fetch.mockRestore();
  }
});

it("a sandbox-routed call through the hybrid adapter emits nothing extra beyond client.ts's own frames", async () => {
  const events: InstrumentationEvent[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "GET" && url.pathname.startsWith("/api/v1/accounts/"))
      return new Response(JSON.stringify({ id: url.pathname.replace("/api/v1/accounts/", "") }));
    throw new Error(`Unexpected sandbox request: ${init?.method} ${url.pathname}`);
  });
  const client = createWhopClient({
    baseUrl: "https://sandbox.invalid/api/v1",
    apiKey: "fixture-key",
    apiVersionDate: "2026-08-21",
    fetch,
    onEvent: (event) => events.push(event),
  });
  const sandbox = createSandboxAdapter({ client, parentAccountId: platformAccountId });
  const mock = createMockAdapter();
  const adapter = createHybridAdapter({
    sandbox,
    mock,
    capabilities: readPlatformCapabilities(sandbox, platformAccountId),
    onEvent: (event) => events.push(event),
  });
  const accountId = value(whopAccountId("biz_seller"));
  const result = await adapter.getAccount(accountId, "instr-sandbox");
  expect(result.ok).toBe(true);
  const frames = whopFrames(events);
  // Exactly the one start/end pair client.ts's own withSpan call emits — the hybrid
  // adapter's onEvent is wired to the same array, so a double-emit would show up here too.
  expect(frames).toHaveLength(2);
  expect(frames[0]).toMatchObject({ phase: "start" });
  expect(frames[1]).toMatchObject({ phase: "end", status: 200 });
});
