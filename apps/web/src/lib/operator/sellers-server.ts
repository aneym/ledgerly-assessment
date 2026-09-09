import { headers } from "next/headers";
import { parseSellerList, SELLERS_PATH, type SellersRead } from "./sellers";

/**
 * Reads GET /api/sellers on the server with the operator's own cookies, so the list
 * carries the same session the page did. The base URL is APP_BASE_URL when set and
 * the request's own host otherwise. Anything but a 200 is returned as a miss that
 * names method, path and status; the page then shows the fixture and says so.
 */
export async function readSellers(): Promise<SellersRead> {
  const incoming = await headers();
  const host = incoming.get("host") ?? "localhost:3000";
  const proto = incoming.get("x-forwarded-proto") ?? "http";
  const base = process.env.APP_BASE_URL?.replace(/\/$/, "") || `${proto}://${host}`;
  const miss = (status: number, detail?: string): SellersRead => ({
    kind: "miss",
    miss: {
      ok: false,
      kind: status === 0 ? "network" : "http",
      status,
      path: SELLERS_PATH,
      method: "GET",
      ...(detail ? { detail } : {}),
    },
  });
  try {
    const response = await fetch(`${base}${SELLERS_PATH}`, {
      headers: {
        accept: "application/json",
        cookie: incoming.get("cookie") ?? "",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      let detail: string | undefined;
      try {
        const body = (await response.json()) as { error?: unknown; message?: unknown };
        detail =
          typeof body.message === "string"
            ? body.message
            : typeof body.error === "string"
              ? body.error
              : undefined;
      } catch {
        detail = undefined;
      }
      return miss(response.status, detail);
    }
    const { sellers, provenance } = parseSellerList(await response.json());
    return { kind: "live", sellers, provenance };
  } catch (error) {
    return miss(0, error instanceof Error ? error.message : "could not reach the app API");
  }
}
