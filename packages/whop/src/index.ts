import { type InstrumentationEvent, type WhopPort, whopAccountId } from "@ledgerly/core";
import { readPlatformCapabilities } from "./capabilities";
import { createWhopClient } from "./client";
import {
  createCredentialMissingAdapter,
  createHybridAdapter,
  type HybridWhopAdapter,
  wrapWithCapabilityGate,
} from "./hybrid-adapter";
import { createMockAdapter } from "./mock-adapter";
import { instrumentMockAdapter } from "./mock-instrumentation";
import { createSandboxAdapter } from "./sandbox-adapter";

export * from "./capabilities";
export * from "./client";
export * from "./envelope";
export * from "./hybrid-adapter";
export * from "./mock-adapter";
export * from "./sandbox-adapter";
export * from "./simulator";
export * from "./webhooks";
export type WhopEnvironment = {
  WHOP_MODE?: string;
  WHOP_API_BASE?: string;
  WHOP_API_KEY?: string;
  WHOP_API_VERSION_DATE?: string;
  WHOP_WEBHOOK_SECRET?: string;
  WHOP_PLATFORM_ACCOUNT_ID?: string;
};
// Separate from WhopEnvironment (which mirrors process.env string values) since a callback
// cannot round-trip through env vars. Mock callbacks observe actual local method outcomes;
// only the sandbox path constructs an HTTP client.
export type WhopAdapterOptions = {
  onEvent?: (event: InstrumentationEvent) => void;
  // Additive: lets a caller supply its own mock-leg adapter (e.g. the stateful simulator in
  // ./simulator) instead of the plain createMockAdapter() this function would otherwise build.
  // Every construction site below falls back to createMockAdapter(...) when this is omitted,
  // so existing callers see no behavior change. apps/web/src/lib/server.ts uses this to make
  // the simulator the actual mock/hybrid-fallback leg the deployed app runs, without
  // duplicating this function's mode-selection and credential-check logic there.
  mock?: WhopPort;
};
export function createWhopAdapter(
  env: WhopEnvironment,
  options: WhopAdapterOptions = {},
): WhopPort | HybridWhopAdapter {
  const mode = env.WHOP_MODE ?? "mock";
  if (mode === "mock")
    return instrumentMockAdapter(
      options.mock ??
        createMockAdapter({
          ...(env.WHOP_WEBHOOK_SECRET ? { webhookSecret: env.WHOP_WEBHOOK_SECRET } : {}),
          ...(env.WHOP_API_VERSION_DATE ? { apiVersionDate: env.WHOP_API_VERSION_DATE } : {}),
        }),
      options.onEvent,
    );
  if (mode !== "sandbox" && mode !== "hybrid")
    throw new Error("WHOP_MODE must be mock or sandbox or hybrid");
  const modeLabel = mode === "sandbox" ? "Sandbox" : "Hybrid";
  // The API key is checked separately below: a missing key no longer throws here, so
  // callers can still build a working (if credential-less) adapter around it.
  if (!env.WHOP_API_VERSION_DATE || !env.WHOP_PLATFORM_ACCOUNT_ID)
    throw new Error(`${modeLabel} mode requires API key, version date, and parent account ID`);
  const parent = whopAccountId(env.WHOP_PLATFORM_ACCOUNT_ID);
  if (!parent.ok) throw new Error("Invalid WHOP_PLATFORM_ACCOUNT_ID");
  const baseUrl = env.WHOP_API_BASE ?? "https://sandbox-api.whop.com/api/v1";
  if (new URL(baseUrl).origin !== "https://sandbox-api.whop.com")
    throw new Error(`${modeLabel} mode requires the sandbox API host`);
  // No key: return a working adapter whose sandbox-routed operations report
  // credential_missing rather than throwing at construction time, or ever reaching
  // fetch. In hybrid mode the credential-missing stub stands in for the sandbox leg —
  // its capability read fails the same way any other sandbox outage would, which the
  // existing capability-read-failure path already falls back to mock for.
  if (!env.WHOP_API_KEY) {
    const stub = createCredentialMissingAdapter(options.onEvent);
    if (mode === "sandbox") return stub;
    const mock =
      options.mock ??
      createMockAdapter({
        ...(env.WHOP_WEBHOOK_SECRET ? { webhookSecret: env.WHOP_WEBHOOK_SECRET } : {}),
        ...(env.WHOP_API_VERSION_DATE ? { apiVersionDate: env.WHOP_API_VERSION_DATE } : {}),
      });
    return createHybridAdapter({
      sandbox: stub,
      mock,
      capabilities: readPlatformCapabilities(stub, parent.value),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });
  }
  const sandbox = createSandboxAdapter({
    client: createWhopClient({
      baseUrl,
      apiKey: env.WHOP_API_KEY,
      apiVersionDate: env.WHOP_API_VERSION_DATE,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    }),
    parentAccountId: parent.value,
  });
  if (mode === "sandbox")
    return wrapWithCapabilityGate(
      sandbox,
      readPlatformCapabilities(sandbox, parent.value),
      options.onEvent,
    );
  const mock =
    options.mock ??
    createMockAdapter({
      ...(env.WHOP_WEBHOOK_SECRET ? { webhookSecret: env.WHOP_WEBHOOK_SECRET } : {}),
      ...(env.WHOP_API_VERSION_DATE ? { apiVersionDate: env.WHOP_API_VERSION_DATE } : {}),
    });
  return createHybridAdapter({
    sandbox,
    mock,
    capabilities: readPlatformCapabilities(sandbox, parent.value),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
}
export * from "./payment-observation";
