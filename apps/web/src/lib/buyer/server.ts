import { headers } from "next/headers";
import { type ApiResult, apiRequest, CORRELATION_HEADER, pickCorrelationId } from "./api";

/**
 * Origin the server-side helpers resolve `/api/...` paths against.
 * Defaults to the origin of the incoming request so dev, preview and
 * production all call themselves. `LEDGERLY_API_ORIGIN` overrides it for
 * local work against a separately running API.
 */
export async function requestOrigin(): Promise<string> {
  const override = process.env.LEDGERLY_API_ORIGIN?.trim();
  if (override) return override.replace(/\/+$/, "");
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost:3000";
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(host);
  const proto = incoming.get("x-forwarded-proto") ?? (local ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * The correlation id for this page render: the `correlationId` search param
 * when the demo runtime supplied one, else the header it may have set on the
 * page request, else a fresh id.
 */
export async function serverCorrelationId(fromSearch?: string | string[] | null): Promise<string> {
  if (fromSearch) return pickCorrelationId(fromSearch);
  const incoming = await headers();
  return pickCorrelationId(incoming.get(CORRELATION_HEADER));
}

async function forwardedHeaders(): Promise<Record<string, string>> {
  const incoming = await headers();
  const cookie = incoming.get("cookie");
  return cookie ? { cookie } : {};
}

export async function getOrder(
  orderId: string,
  correlationId: string,
): Promise<ApiResult<unknown>> {
  return apiRequest<unknown>(`/api/orders/${encodeURIComponent(orderId)}`, {
    method: "GET",
    correlationId,
    origin: await requestOrigin(),
    headers: await forwardedHeaders(),
  });
}

/** The signed-in user's row, from Better Auth's session endpoint. */
export async function getAccount(correlationId: string): Promise<ApiResult<unknown>> {
  return apiRequest<unknown>("/api/auth/get-session", {
    method: "GET",
    correlationId,
    origin: await requestOrigin(),
    headers: await forwardedHeaders(),
  });
}

export async function getMyRefunds(correlationId: string): Promise<ApiResult<unknown>> {
  return apiRequest<unknown>("/api/refunds?buyer=me", {
    method: "GET",
    correlationId,
    origin: await requestOrigin(),
    headers: await forwardedHeaders(),
  });
}

export async function getMyOrders(correlationId: string): Promise<ApiResult<unknown>> {
  return apiRequest<unknown>("/api/orders?buyer=me", {
    method: "GET",
    correlationId,
    origin: await requestOrigin(),
    headers: await forwardedHeaders(),
  });
}

/**
 * Which Whop environment the embedded checkout targets: sandbox whenever the server talks
 * to the sandbox API (WHOP_API_BASE) or runs the mock/hybrid modes, production only for a
 * production API base. Read on the server so the client never guesses.
 */
export function checkoutEmbedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): "sandbox" | "production" {
  const base = env.WHOP_API_BASE ?? "";
  if (/sandbox/i.test(base)) return "sandbox";
  if (env.WHOP_MODE === "mock" || env.WHOP_MODE === "hybrid" || env.WHOP_MODE === "sandbox")
    return "sandbox";
  return base ? "production" : "sandbox";
}
