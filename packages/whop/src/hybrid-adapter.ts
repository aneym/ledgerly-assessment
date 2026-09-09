import { randomUUID } from "node:crypto";
import {
  type Emitter,
  err,
  type Gate,
  gateFromError,
  type InstrumentationEvent,
  noopEmitter,
  type WhopError,
  type WhopPort,
  withSpan,
} from "@ledgerly/core";
import { z } from "zod";
import type { DemoPaymentSeeder } from "../../core/src/services/resolution";
import type { CapabilityReader } from "./capabilities";
import { WHOP_OPERATION_ROUTES } from "./sandbox-adapter";

export type WhopOperation = keyof WhopPort;
export type WhopSource = "sandbox" | "mock";

// Operations that always run against the sandbox: account lifecycle, onboarding,
// checkout, and every payment/transfer read. None of these depend on a capability the
// platform account might not have yet — see docs/lanes/architecture/mock-strategy.md.
const STATIC_SANDBOX_OPERATION_NAMES = [
  "createAccount",
  "createOrFetchAccount",
  "updateAccount",
  "getAccount",
  "createOnboardingLink",
  "createCheckoutConfiguration",
  "getPayment",
  "listPaymentFees",
  "refundPayment",
  "listPayments",
  "listTransfers",
  "suspendAccount",
  "getCheckoutConfiguration",
  "listRefunds",
  "getRefund",
  "listDisputes",
  "getDispute",
  "getTransfer",
  "listPayoutMethods",
  "listSupportedPayoutMethods",
  "listTransferRecipients",
  "listPayouts",
  "listFeeMarkups",
  "createFeeMarkup",
  "listWebhooks",
  "getWebhook",
  "createWebhook",
  "updateWebhook",
  "sendWebhookTest",
  "listWebhookDeliveries",
  "replayWebhookDelivery",
  "listApiKeyPermissions",
  "listFinancialActivity",
  "getLedgerAccount",
  "createApiKey",
] as const satisfies readonly WhopOperation[];
const STATIC_SANDBOX_OPERATIONS: ReadonlySet<WhopOperation> = new Set(
  STATIC_SANDBOX_OPERATION_NAMES,
);

// Operations gated on a capability being "active" on the platform account. Inactive
// (or unknown, on a failed capability read) routes to the mock so the walkthrough keeps
// working while Whop has not yet enabled the operation in sandbox.
// The complement of the static list must be fully gated. A new port operation
// cannot compile until it is assigned a route.
const GATED_OPERATIONS: Readonly<Partial<Record<WhopOperation, string>>> = {
  createTransfer: "transfer",
  createAccessToken: "standard_payout",
  createPayoutPortalLink: "standard_payout",
  createTopup: "card_deposit",
  createPayout: "standard_payout",
  getPayout: "standard_payout",
} satisfies Record<
  Exclude<WhopOperation, (typeof STATIC_SANDBOX_OPERATION_NAMES)[number]>,
  "transfer" | "standard_payout" | "card_deposit"
>;

// The identifier the demo-runtime tour uses to recognize a Whop-enablement gate. Kept as
// a single literal so both the hybrid adapter's mock fallback and the standalone-sandbox
// gate below agree on the string the tour is told to look for.
const WHOP_ENABLEMENT_GATE = "G01" as const;

// The Gate reason attached to a mock-fallback instrumentation frame's `gate` field: every
// mock-routed dispatch is either capability-gated or unsupported in sandbox.
function mockFallbackReason(operation: WhopOperation): string {
  return `${GATED_OPERATIONS[operation]} capability is not active on this account`;
}

export type RoutedEvent = { operation: WhopOperation; source: WhopSource };

// Attached to every successful value the hybrid adapter (and the capability gate below)
// return, so the demo-runtime tour can tell where a result came from without re-deriving
// it from the operation name. status/requestId stay undefined for sandbox-routed calls:
// the underlying client (packages/whop/src/client.ts, owned by another lane) only threads
// HTTP status and request-id into its error branch and its own telemetry callback, never
// onto a successful Result — surfacing real values here would mean editing that file,
// which is out of scope for this change. gate is only meaningful for the
// capability-gated operations; every other operation omits it.
export type RouteMeta = {
  source: WhopSource;
  status?: number | undefined;
  requestId?: string | undefined;
  gate?: "G01" | null;
  fallback_gate?: DemoFallbackGate;
};

export type DemoFallbackGate = {
  id: "settlement-pending" | "sandbox-no-payouts" | "sumsub-pending";
  reason: string;
  observed: { status: number; code: string | null };
};

const demoErrorSchema = z.object({
  kind: z.literal("http"),
  status: z.literal(400),
  body: z.object({
    error: z.object({
      code: z.string().optional(),
      type: z.string().optional(),
      message: z.string().optional(),
    }),
  }),
});
const pendingAccountSchema = z.object({
  raw: z.object({
    verification: z.union([z.literal("pending"), z.object({ status: z.literal("pending") })]),
  }),
});

function demoErrorGate(operation: WhopOperation, error: unknown): DemoFallbackGate | undefined {
  const parsed = demoErrorSchema.safeParse(error);
  if (!parsed.success) return;
  const { code, type, message } = parsed.data.body.error;
  const observed = { status: parsed.data.status, code: code ?? type ?? null };
  if (
    (operation === "refundPayment" || operation === "createTransfer") &&
    [
      "not_enough_balance",
      "insufficient_balance",
      "settlement_pending",
      "pending_settlement",
    ].includes(code ?? "")
  ) {
    return {
      id: "settlement-pending",
      reason: "Sandbox funds are unavailable pending settlement; this result is simulated.",
      observed,
    };
  }
  if (
    [
      "createPayout",
      "listPayoutMethods",
      "listSupportedPayoutMethods",
      "createPayoutPortalLink",
    ].includes(operation) &&
    (["no_payout_method", "no_payout_methods", "payout_method_not_found"].includes(code ?? "") ||
      (!code &&
        ["bad_request", undefined].includes(type) &&
        /^(no payout methods?(?: available| exists?)?|payout method not found)[.!]?$/i.test(
          message ?? "",
        )))
  ) {
    return {
      id: "sandbox-no-payouts",
      reason: "Sandbox has no payout method; this result is simulated.",
      observed,
    };
  }
}

function capabilityInactiveError(capability: string) {
  return { kind: "capability_inactive" as const, capability, gate: WHOP_ENABLEMENT_GATE };
}
function credentialMissingError() {
  return { kind: "credential_missing" as const, gate: "CRED" as const };
}

// A gated-refusal or credential-missing call never reaches client.ts, so it never gets a
// `whop`-source instrumentation frame from the real HTTP client's own withSpan call — the
// demo-runtime tour overlay would see nothing for it. This wraps such a short-circuit (and
// every mock-routed call in route() below) in a synthetic start/end frame pair instead,
// reusing withSpan so the shape matches what client.ts emits for a real request.
// provenance is always "mock": none of these three paths reach the real sandbox API.
// status stays null — there is no real HTTP status to report, the same convention withSpan
// already uses for a start frame. method/path come from sandbox-adapter.ts's exported
// route table so the frame reads as "the request this operation would have made."
type AnyWhopResult = { ok: true; value: unknown } | { ok: false; error: unknown };

function emitMockSpan<T extends AnyWhopResult>(
  onEvent: ((event: InstrumentationEvent) => void) | undefined,
  operation: WhopOperation,
  fn: () => Promise<T>,
  gateOf: (result: T) => Gate | null | undefined,
): Promise<T> {
  const emitter: Emitter = onEvent ? { emit: onEvent } : noopEmitter;
  const route = WHOP_OPERATION_ROUTES[operation];
  return withSpan(
    emitter,
    {
      source: "whop",
      method: route.method,
      path: route.path,
      correlationId: randomUUID(),
      provenance: "mock",
    },
    fn,
    (result) => {
      const gate = gateOf(result);
      return {
        status: null,
        summary: `whop ${route.method} ${route.path} routed to mock`,
        // exactOptionalPropertyTypes rejects an explicit `gate: undefined` on SpanOutcome
        // (its `gate?: Gate | null` means "present and Gate|null, or absent" — not
        // "present and undefined"), so an undefined gateOf() result omits the key entirely.
        ...(gate === undefined ? {} : { gate }),
      };
    },
  );
}

// Adds `meta` to a successful value without disturbing its shape: plain WhopPort results
// get a shallow copy with `meta` attached, and array results (listPaymentFees) keep their
// array identity — Object.assign on a copy of the array attaches `meta` as a non-index
// property rather than converting it into a plain object.
function withMeta<T>(value: T, meta: RouteMeta): T & { meta: RouteMeta } {
  const merged = Array.isArray(value)
    ? Object.assign([...value], { meta })
    : { ...(value as object), meta };
  // TypeScript cannot express "T is either an array or a plain object, and either way the
  // result is T with one extra field" without losing T's identity, so this narrows back
  // with an assertion rather than an `any` — the runtime shape above is exactly that.
  return merged as T & { meta: RouteMeta };
}

// Distributes over a Result union to attach `meta` to the success branch only, leaving a
// failure branch untouched. Naked-generic distribution requires R to stay a bare type
// parameter here rather than something derived from it.
type EnrichedResult<R> = R extends { ok: true; value: infer V }
  ? { ok: true; value: V & { meta: RouteMeta } }
  : R;

// Every hybrid method's declared return type carries `meta`, matching the withMeta call
// route() actually makes at runtime — callers (the demo-runtime tour included) can read
// `.value.meta` without a cast.
export type HybridWhopAdapter = {
  [K in WhopOperation]: (
    ...args: K extends "getAccount"
      ? [...Parameters<WhopPort[K]>, options?: { demoComplete?: boolean }]
      : Parameters<WhopPort[K]>
  ) => Promise<EnrichedResult<Awaited<ReturnType<WhopPort[K]>>>>;
} & DemoPaymentSeeder & {
    describe(): Promise<{
      mode: "hybrid";
      routing: Record<WhopOperation, WhopSource>;
      readAt: Date | null;
    }>;
    sourceOf(operation: WhopOperation): Promise<WhopSource>;
  };

export function createHybridAdapter(options: {
  sandbox: WhopPort;
  mock: WhopPort;
  capabilities: CapabilityReader;
  onRouted?: (event: RoutedEvent) => void;
  onEvent?: (event: InstrumentationEvent) => void;
}): HybridWhopAdapter {
  const { sandbox, mock, capabilities, onRouted, onEvent } = options;
  const demoEnabled = process.env.WHOP_DEMO_FALLBACK === "1";
  const demoMock = mock as WhopPort & DemoPaymentSeeder & { forDemoFallback?: () => WhopPort };
  const fallbackMock = () => demoMock.forDemoFallback?.() ?? mock;

  async function sourceOf(operation: WhopOperation): Promise<WhopSource> {
    if (STATIC_SANDBOX_OPERATIONS.has(operation)) return "sandbox";
    const requiredCapability = GATED_OPERATIONS[operation];
    if (requiredCapability === undefined) throw new Error(`Unrouted Whop operation: ${operation}`);
    const snapshot = await capabilities.read();
    return snapshot.capabilities[requiredCapability] === "active" ? "sandbox" : "mock";
  }

  // Every call is routed through here so onRouted fires exactly once per invocation, for
  // both the sandbox and the mock branch. A successful result is returned with `meta`
  // attached (see withMeta); a failed result is passed through completely unchanged —
  // the routing layer never touches a WhopError.
  async function route<K extends WhopOperation>(
    operation: K,
    source: WhopSource,
    dispatch: () => ReturnType<WhopPort[K]>,
    fallback?: { dispatch: () => ReturnType<WhopPort[K]>; demoComplete?: boolean },
  ): Promise<EnrichedResult<Awaited<ReturnType<WhopPort[K]>>>> {
    if (!demoEnabled || !fallback || source !== "sandbox") onRouted?.({ operation, source });
    // A mock-routed call never reaches client.ts's own withSpan, so it gets a synthetic
    // one here instead; a sandbox-routed call is left untouched — client.ts already emits
    // for it, and wrapping it again here would double-emit.
    const result = (
      source === "mock"
        ? await emitMockSpan(
            onEvent,
            operation,
            dispatch as unknown as () => Promise<AnyWhopResult>,
            (value) =>
              value.ok
                ? GATED_OPERATIONS[operation]
                  ? { id: WHOP_ENABLEMENT_GATE, reason: mockFallbackReason(operation) }
                  : null
                : gateFromError(value.error),
          )
        : await dispatch()
    ) as Awaited<ReturnType<WhopPort[K]>>;
    if (demoEnabled && fallback && source === "sandbox") {
      const gate: DemoFallbackGate | undefined = !result.ok
        ? demoErrorGate(operation, result.error)
        : operation === "getAccount" &&
            fallback.demoComplete === true &&
            pendingAccountSchema.safeParse(result.value).success
          ? {
              id: "sumsub-pending",
              reason:
                "Sandbox identity verification is pending; this demo-complete view is simulated.",
              observed: { status: 200, code: "pending" },
            }
          : undefined;
      onRouted?.({ operation, source: gate ? "mock" : "sandbox" });
      if (gate) {
        const simulated = await emitMockSpan(
          onEvent,
          operation,
          fallback.dispatch as () => Promise<AnyWhopResult>,
          () => null,
        );
        if (!simulated.ok) return simulated as EnrichedResult<Awaited<ReturnType<WhopPort[K]>>>;
        return {
          ok: true,
          value: withMeta(simulated.value, { source: "mock", fallback_gate: gate }),
        } as EnrichedResult<Awaited<ReturnType<WhopPort[K]>>>;
      }
    }
    if (!result.ok) return result as EnrichedResult<Awaited<ReturnType<WhopPort[K]>>>;
    const isGated = GATED_OPERATIONS[operation] !== undefined;
    const meta: RouteMeta = {
      source,
      status: undefined,
      requestId: undefined,
      ...(isGated ? { gate: source === "mock" ? WHOP_ENABLEMENT_GATE : null } : {}),
    };
    // Same reasoning as the cast in withMeta: K is generic here, so TypeScript cannot
    // distribute WhopPort[K]'s return type across the union to confirm this shape lines
    // up, even though every branch of the union looks like { ok: true; value: X }.
    return { ok: true, value: withMeta(result.value, meta) } as EnrichedResult<
      Awaited<ReturnType<WhopPort[K]>>
    >;
  }

  const adapter: HybridWhopAdapter = {
    ...(demoEnabled && demoMock.seedDemoPayment
      ? { seedDemoPayment: demoMock.seedDemoPayment.bind(demoMock) }
      : {}),

    createAccount: (input, key) =>
      route("createAccount", "sandbox", () => sandbox.createAccount(input, key)),
    createOrFetchAccount: (input, key) =>
      route("createOrFetchAccount", "sandbox", () => sandbox.createOrFetchAccount(input, key)),
    updateAccount: (accountId, input, key) =>
      route("updateAccount", "sandbox", () => sandbox.updateAccount(accountId, input, key)),
    getAccount: (accountId, key, view) =>
      route("getAccount", "sandbox", () => sandbox.getAccount(accountId, key), {
        dispatch: () => fallbackMock().getAccount(accountId, key),
        demoComplete: view?.demoComplete === true,
      }),
    createOnboardingLink: (input, key) =>
      route("createOnboardingLink", "sandbox", () => sandbox.createOnboardingLink(input, key)),
    createCheckoutConfiguration: (input, key) =>
      route("createCheckoutConfiguration", "sandbox", () =>
        sandbox.createCheckoutConfiguration(input, key),
      ),
    getPayment: (paymentId, key) =>
      paymentId.startsWith("pay_mock")
        ? route("getPayment", "mock", () => mock.getPayment(paymentId, key))
        : route("getPayment", "sandbox", () => sandbox.getPayment(paymentId, key)),
    listPaymentFees: (paymentId, key) =>
      route("listPaymentFees", "sandbox", () => sandbox.listPaymentFees(paymentId, key)),
    refundPayment: (paymentId, key, partial) =>
      route("refundPayment", "sandbox", () => sandbox.refundPayment(paymentId, key, partial), {
        dispatch: () => fallbackMock().refundPayment(paymentId, key, partial),
      }),
    async listPayments(input) {
      // Page through seeded mock payments before sandbox payments. Keep sandbox
      // cursors intact and never hide a failed sandbox read.
      const prefix = "ledgerly_demo_mock:";
      const sandboxStart = "ledgerly_demo_sandbox";
      if (!input.cursor || input.cursor.startsWith(prefix)) {
        const cursor = input.cursor?.slice(prefix.length);
        const { cursor: _dropped, ...rest } = input;
        const result = await mock.listPayments(cursor ? { ...rest, cursor } : rest);
        if (!result.ok) return result;
        if (result.value.items.length > 0)
          return route("listPayments", "mock", async () => ({
            ...result,
            value: {
              ...result.value,
              nextCursor: result.value.nextCursor ? prefix + result.value.nextCursor : sandboxStart,
            },
          }));
      }
      return route("listPayments", "sandbox", () =>
        sandbox.listPayments(
          input.cursor === sandboxStart ? (({ cursor: _start, ...rest }) => rest)(input) : input,
        ),
      );
    },
    listTransfers: (input) => route("listTransfers", "sandbox", () => sandbox.listTransfers(input)),
    async createTransfer(input, key) {
      const source = await sourceOf("createTransfer");
      return route(
        "createTransfer",
        source,
        () =>
          source === "sandbox"
            ? sandbox.createTransfer(input, key)
            : mock.createTransfer(input, key),
        { dispatch: () => fallbackMock().createTransfer(input, key) },
      );
    },
    async createAccessToken(input, key) {
      const source = await sourceOf("createAccessToken");
      return route("createAccessToken", source, () =>
        source === "sandbox"
          ? sandbox.createAccessToken(input, key)
          : mock.createAccessToken(input, key),
      );
    },
    async createPayoutPortalLink(input, key) {
      const source = await sourceOf("createPayoutPortalLink");
      return route(
        "createPayoutPortalLink",
        source,
        () =>
          source === "sandbox"
            ? sandbox.createPayoutPortalLink(input, key)
            : mock.createPayoutPortalLink(input, key),
        { dispatch: () => fallbackMock().createPayoutPortalLink(input, key) },
      );
    },
    suspendAccount: (...args) =>
      route("suspendAccount", "sandbox", () => sandbox.suspendAccount(...args)),
    getCheckoutConfiguration: (...args) =>
      route("getCheckoutConfiguration", "sandbox", () => sandbox.getCheckoutConfiguration(...args)),
    listRefunds: (...args) => route("listRefunds", "sandbox", () => sandbox.listRefunds(...args)),
    getRefund: (...args) => route("getRefund", "sandbox", () => sandbox.getRefund(...args)),
    listDisputes: (...args) =>
      route("listDisputes", "sandbox", () => sandbox.listDisputes(...args)),
    getDispute: (...args) => route("getDispute", "sandbox", () => sandbox.getDispute(...args)),
    getTransfer: (...args) => route("getTransfer", "sandbox", () => sandbox.getTransfer(...args)),
    listPayoutMethods: (...args) =>
      route("listPayoutMethods", "sandbox", () => sandbox.listPayoutMethods(...args), {
        dispatch: () => fallbackMock().listPayoutMethods(...args),
      }),
    listSupportedPayoutMethods: (...args) =>
      route(
        "listSupportedPayoutMethods",
        "sandbox",
        () => sandbox.listSupportedPayoutMethods(...args),
        { dispatch: () => fallbackMock().listSupportedPayoutMethods(...args) },
      ),
    listTransferRecipients: (...args) =>
      route("listTransferRecipients", "sandbox", () => sandbox.listTransferRecipients(...args)),
    listPayouts: (...args) => route("listPayouts", "sandbox", () => sandbox.listPayouts(...args)),
    listFeeMarkups: (...args) =>
      route("listFeeMarkups", "sandbox", () => sandbox.listFeeMarkups(...args)),
    createFeeMarkup: (...args) =>
      route("createFeeMarkup", "sandbox", () => sandbox.createFeeMarkup(...args)),
    listWebhooks: (...args) =>
      route("listWebhooks", "sandbox", () => sandbox.listWebhooks(...args)),
    getWebhook: (...args) => route("getWebhook", "sandbox", () => sandbox.getWebhook(...args)),
    createWebhook: (...args) =>
      route("createWebhook", "sandbox", () => sandbox.createWebhook(...args)),
    updateWebhook: (...args) =>
      route("updateWebhook", "sandbox", () => sandbox.updateWebhook(...args)),
    sendWebhookTest: (...args) =>
      route("sendWebhookTest", "sandbox", () => sandbox.sendWebhookTest(...args)),
    listWebhookDeliveries: (...args) =>
      route("listWebhookDeliveries", "sandbox", () => sandbox.listWebhookDeliveries(...args)),
    replayWebhookDelivery: (...args) =>
      route("replayWebhookDelivery", "sandbox", () => sandbox.replayWebhookDelivery(...args)),
    listApiKeyPermissions: (...args) =>
      route("listApiKeyPermissions", "sandbox", () => sandbox.listApiKeyPermissions(...args)),
    listFinancialActivity: (...args) =>
      route("listFinancialActivity", "sandbox", () => sandbox.listFinancialActivity(...args)),
    getLedgerAccount: (...args) =>
      route("getLedgerAccount", "sandbox", () => sandbox.getLedgerAccount(...args)),
    async createTopup(...args) {
      const source = await sourceOf("createTopup");
      return route("createTopup", source, () =>
        source === "sandbox" ? sandbox.createTopup(...args) : mock.createTopup(...args),
      );
    },
    async createPayout(...args) {
      const source = await sourceOf("createPayout");
      return route(
        "createPayout",
        source,
        () => (source === "sandbox" ? sandbox.createPayout(...args) : mock.createPayout(...args)),
        { dispatch: () => fallbackMock().createPayout(...args) },
      );
    },
    async getPayout(...args) {
      const source = await sourceOf("getPayout");
      return route("getPayout", source, () =>
        source === "sandbox" ? sandbox.getPayout(...args) : mock.getPayout(...args),
      );
    },
    async createApiKey(...args) {
      const source = await sourceOf("createApiKey");
      return route("createApiKey", source, () =>
        source === "sandbox" ? sandbox.createApiKey(...args) : mock.createApiKey(...args),
      );
    },
    sourceOf,
    async describe() {
      // Listed explicitly (rather than derived from a runtime array) so the compiler
      // enforces that every WhopPort operation has a routing entry.
      const routing: Record<WhopOperation, WhopSource> = {
        createAccount: await sourceOf("createAccount"),
        createOrFetchAccount: await sourceOf("createOrFetchAccount"),
        updateAccount: await sourceOf("updateAccount"),
        getAccount: await sourceOf("getAccount"),
        createOnboardingLink: await sourceOf("createOnboardingLink"),
        createCheckoutConfiguration: await sourceOf("createCheckoutConfiguration"),
        getPayment: await sourceOf("getPayment"),
        listPaymentFees: await sourceOf("listPaymentFees"),
        refundPayment: await sourceOf("refundPayment"),
        listPayments: await sourceOf("listPayments"),
        listTransfers: await sourceOf("listTransfers"),
        createTransfer: await sourceOf("createTransfer"),
        createAccessToken: await sourceOf("createAccessToken"),
        createPayoutPortalLink: await sourceOf("createPayoutPortalLink"),
        suspendAccount: await sourceOf("suspendAccount"),
        getCheckoutConfiguration: await sourceOf("getCheckoutConfiguration"),
        listRefunds: await sourceOf("listRefunds"),
        getRefund: await sourceOf("getRefund"),
        listDisputes: await sourceOf("listDisputes"),
        getDispute: await sourceOf("getDispute"),
        getTransfer: await sourceOf("getTransfer"),
        listPayoutMethods: await sourceOf("listPayoutMethods"),
        listSupportedPayoutMethods: await sourceOf("listSupportedPayoutMethods"),
        listTransferRecipients: await sourceOf("listTransferRecipients"),
        listPayouts: await sourceOf("listPayouts"),
        listFeeMarkups: await sourceOf("listFeeMarkups"),
        createFeeMarkup: await sourceOf("createFeeMarkup"),
        listWebhooks: await sourceOf("listWebhooks"),
        getWebhook: await sourceOf("getWebhook"),
        createWebhook: await sourceOf("createWebhook"),
        updateWebhook: await sourceOf("updateWebhook"),
        sendWebhookTest: await sourceOf("sendWebhookTest"),
        listWebhookDeliveries: await sourceOf("listWebhookDeliveries"),
        replayWebhookDelivery: await sourceOf("replayWebhookDelivery"),
        listApiKeyPermissions: await sourceOf("listApiKeyPermissions"),
        listFinancialActivity: await sourceOf("listFinancialActivity"),
        getLedgerAccount: await sourceOf("getLedgerAccount"),
        createTopup: await sourceOf("createTopup"),
        createPayout: await sourceOf("createPayout"),
        getPayout: await sourceOf("getPayout"),
        createApiKey: await sourceOf("createApiKey"),
      };
      const snapshot = await capabilities.read();
      return { mode: "hybrid", routing, readAt: snapshot.readAt };
    },
  };
  // Guard all request positions before sourceOf can perform a capability read.
  function containsSuspended(value: unknown): boolean {
    if (value === "biz_fixtureSuspended") return true;
    return (
      value !== null && typeof value === "object" && Object.values(value).some(containsSuspended)
    );
  }
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || !(property in WHOP_OPERATION_ROUTES)) return method;
      return (...args: unknown[]) =>
        containsSuspended(args)
          ? Promise.resolve(
              err({
                kind: "invalid_request",
                body: {
                  code: "suspended_seller",
                  message: "Seller biz_fixtureSuspended is suspended and must not be used.",
                },
              }),
            )
          : Reflect.apply(method, target, args);
    },
  });
}

// Standalone WHOP_MODE=sandbox has no mock to fall back to, so a gated operation whose
// capability is inactive cannot just be re-routed — it has to refuse outright, before the
// real API is ever called. Every other WhopPort method passes straight through untouched.
export function wrapWithCapabilityGate(
  sandbox: WhopPort,
  capabilities: CapabilityReader,
  onEvent?: (event: InstrumentationEvent) => void,
): WhopPort {
  async function guard<K extends WhopOperation>(
    operation: K,
    call: () => ReturnType<WhopPort[K]>,
  ): Promise<Awaited<ReturnType<WhopPort[K]>>> {
    const requiredCapability = GATED_OPERATIONS[operation];
    if (requiredCapability === undefined) throw new Error(`Ungated Whop operation: ${operation}`);
    const snapshot = await capabilities.read();
    if (snapshot.capabilities[requiredCapability] !== "active") {
      const refusal = await emitMockSpan(
        onEvent,
        operation,
        () => Promise.resolve(err<WhopError>(capabilityInactiveError(requiredCapability))),
        (result) => (result.ok ? null : gateFromError(result.error)),
      );
      // Every operation accepts WhopError, but TypeScript cannot resolve the indexed
      // return type while K is generic. The error is checked against WhopError above.
      return refusal as Awaited<ReturnType<WhopPort[K]>>;
    }
    return await call();
  }
  return {
    ...sandbox,
    createTransfer: (input, key) =>
      guard("createTransfer", () => sandbox.createTransfer(input, key)),
    createAccessToken: (input, key) =>
      guard("createAccessToken", () => sandbox.createAccessToken(input, key)),
    createPayoutPortalLink: (input, key) =>
      guard("createPayoutPortalLink", () => sandbox.createPayoutPortalLink(input, key)),
    createTopup: (...args) => guard("createTopup", () => sandbox.createTopup(...args)),
    createPayout: (...args) => guard("createPayout", () => sandbox.createPayout(...args)),
    getPayout: (...args) => guard("getPayout", () => sandbox.getPayout(...args)),
  };
}

// Returned instead of a real sandbox/hybrid adapter when WHOP_API_KEY is absent: every
// method reports the same "no credential" failure rather than throwing at construction
// time, so callers can still build the rest of their wiring (routes, services) around a
// working WhopPort and only see the failure when an operation actually runs.
export function createCredentialMissingAdapter(
  onEvent?: (event: InstrumentationEvent) => void,
): WhopPort {
  // A separate closure per operation (rather than one shared function, as before
  // onEvent existed) so each one's synthetic instrumentation frame carries that
  // operation's own method/path from the route table instead of a shared placeholder.
  function credentialMissing(operation: WhopOperation) {
    return () =>
      emitMockSpan(
        onEvent,
        operation,
        () => Promise.resolve(err<WhopError>(credentialMissingError())),
        (result) => (result.ok ? null : gateFromError(result.error)),
      );
  }
  const adapter = {
    createAccount: credentialMissing("createAccount"),
    createOrFetchAccount: credentialMissing("createOrFetchAccount"),
    updateAccount: credentialMissing("updateAccount"),
    getAccount: credentialMissing("getAccount"),
    createOnboardingLink: credentialMissing("createOnboardingLink"),
    createCheckoutConfiguration: credentialMissing("createCheckoutConfiguration"),
    getPayment: credentialMissing("getPayment"),
    listPaymentFees: credentialMissing("listPaymentFees"),
    refundPayment: credentialMissing("refundPayment"),
    listPayments: credentialMissing("listPayments"),
    listTransfers: credentialMissing("listTransfers"),
    createTransfer: credentialMissing("createTransfer"),
    createAccessToken: credentialMissing("createAccessToken"),
    createPayoutPortalLink: credentialMissing("createPayoutPortalLink"),
    suspendAccount: credentialMissing("suspendAccount"),
    getCheckoutConfiguration: credentialMissing("getCheckoutConfiguration"),
    listRefunds: credentialMissing("listRefunds"),
    getRefund: credentialMissing("getRefund"),
    listDisputes: credentialMissing("listDisputes"),
    getDispute: credentialMissing("getDispute"),
    getTransfer: credentialMissing("getTransfer"),
    listPayoutMethods: credentialMissing("listPayoutMethods"),
    listSupportedPayoutMethods: credentialMissing("listSupportedPayoutMethods"),
    listTransferRecipients: credentialMissing("listTransferRecipients"),
    listPayouts: credentialMissing("listPayouts"),
    listFeeMarkups: credentialMissing("listFeeMarkups"),
    createFeeMarkup: credentialMissing("createFeeMarkup"),
    listWebhooks: credentialMissing("listWebhooks"),
    getWebhook: credentialMissing("getWebhook"),
    createWebhook: credentialMissing("createWebhook"),
    updateWebhook: credentialMissing("updateWebhook"),
    sendWebhookTest: credentialMissing("sendWebhookTest"),
    listWebhookDeliveries: credentialMissing("listWebhookDeliveries"),
    replayWebhookDelivery: credentialMissing("replayWebhookDelivery"),
    listApiKeyPermissions: credentialMissing("listApiKeyPermissions"),
    listFinancialActivity: credentialMissing("listFinancialActivity"),
    getLedgerAccount: credentialMissing("getLedgerAccount"),
    createTopup: credentialMissing("createTopup"),
    createPayout: credentialMissing("createPayout"),
    getPayout: credentialMissing("getPayout"),
    createApiKey: credentialMissing("createApiKey"),
  } satisfies WhopPort;
  return adapter;
}
