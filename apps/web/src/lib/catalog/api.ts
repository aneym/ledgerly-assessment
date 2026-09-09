/**
 * Fetch helper for the app API (POST /api/checkouts, GET /api/orders/{id}, ...).
 * Forwards the demo runtime's correlation id when one is present, so the overlay
 * can join app, database and Whop sandbox events on it. Not used by the storefront yet.
 */
export const CORRELATION_HEADER = "x-ledgerly-correlation-id";

/** Reads the correlation id the runtime hands the page, if any. Browser only. */
export function readCorrelationId(): string | null {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${CORRELATION_HEADER}"]`);
  return meta?.content || null;
}

export type ApiFetchOptions = RequestInit & { correlationId?: string | null };

export async function apiFetch(input: string, options: ApiFetchOptions = {}): Promise<Response> {
  const { correlationId = readCorrelationId(), headers, ...init } = options;
  const merged = new Headers(headers);
  if (correlationId) merged.set(CORRELATION_HEADER, correlationId);
  if (init.body && !merged.has("content-type")) merged.set("content-type", "application/json");
  return fetch(input, { ...init, headers: merged });
}
