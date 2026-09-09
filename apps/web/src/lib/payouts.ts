import { isIP } from "node:net";
import type { Seller, WhopPort } from "@ledgerly/core";

// BUILD-14: explicit scopes observed in the pinned sandbox token request.
// Bank-detail changes remain in Whop's hosted portal, not in Ledgerly forms.
export const PAYOUT_SCOPES = [
  "company:balance:read",
  "payout:withdrawal:read",
  "payout:destination:read",
  "payout:account:read",
  "payout:withdraw_funds",
] as const;
export const PAYOUT_TOKEN_TTL_MS = 5 * 60 * 1000;

type PayoutProvider = Pick<WhopPort, "createAccessToken" | "createPayoutPortalLink"> & {
  sourceOf?: (operation: "createAccessToken" | "createPayoutPortalLink") => Promise<string>;
};
export type PayoutSessionDeps = {
  getSession: () => Promise<{ userId: string; role: string } | null>;
  getSellerOwner: (id: string) => Promise<string | null>;
  getSeller: (id: string) => Promise<Seller | null>;
  getProvider: () => PayoutProvider;
  mode: string | undefined;
  appBaseUrl: string | undefined;
  payoutReturnUrl?: string;
  now: () => Date;
  nonce: () => string;
};

function reply(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store, private", Pragma: "no-cache", Vary: "Cookie" },
  });
}

export function safePayoutPortalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "whop.com" || url.hostname.endsWith(".whop.com"))
    );
  } catch {
    return false;
  }
}

function payoutReturnUrl(app: URL, explicit: string | undefined): string | null {
  if (app.protocol !== "https:") return null;
  try {
    // An invalid explicit value must fail rather than silently select another callback.
    const url = new URL(
      explicit === undefined ? new URL("/sell/payouts", app.origin).href : explicit,
    );
    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      isIP(hostname) !== 0
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function createPayoutSessionHandler(deps: PayoutSessionDeps) {
  return async (request: Request, sellerId: string): Promise<Response> => {
    // Session credentials must never reach the shared route-error logger.
    try {
      const session = await deps.getSession();
      if (!session) return reply({ error: "unauthenticated" }, 401);
      // Read authorization for operators/demo is deliberately not a credential grant.
      if (
        session.role === "demo" ||
        session.role === "operator" ||
        (await deps.getSellerOwner(sellerId)) !== session.userId
      )
        return reply({ error: "seller_owner_required" }, 403);
      if (!deps.appBaseUrl) return reply({ error: "payouts_not_configured" }, 503);
      const base = new URL(deps.appBaseUrl);
      if (
        request.headers.get("origin") !== base.origin ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        return reply({ error: "invalid_origin" }, 403);
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return reply({ error: "invalid_request" }, 400);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return reply({ error: "invalid_request" }, 400);
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("view" in body) ||
        (body.view !== "embedded" && body.view !== "hosted")
      )
        return reply({ error: "invalid_request" }, 400);
      const seller = await deps.getSeller(sellerId);
      if (!seller) return reply({ error: "not_found" }, 404);
      if (seller.status !== "active") return reply({ error: "seller_suspended" }, 409);
      if (!seller.whopAccountId) return reply({ error: "account_not_connected" }, 409);
      if (deps.mode !== "sandbox" && deps.mode !== "hybrid")
        return reply({ error: "fixture_mode", source: "mock" }, 409);
      // Browser auth stays on the actual app origin. Provider verification can return to
      // an explicitly configured non-loopback HTTPS page when the app itself uses local TLS.
      const returnUrl = payoutReturnUrl(base, deps.payoutReturnUrl);
      if (!returnUrl) return reply({ error: "hosted_origin_required" }, 409);
      const provider = deps.getProvider();
      const operation = body.view === "embedded" ? "createAccessToken" : "createPayoutPortalLink";
      if (
        deps.mode === "hybrid" &&
        (!provider.sourceOf || (await provider.sourceOf(operation)) !== "sandbox")
      )
        return reply({ error: "sandbox_payouts_unavailable", source: "mock" }, 409);
      const key = `payout-session:${seller.id}:${deps.nonce()}`;
      if (body.view === "hosted") {
        const result = await provider.createPayoutPortalLink(
          { accountId: seller.whopAccountId, returnUrl },
          key,
        );
        if (!result.ok)
          return reply(
            { error: result.error.kind },
            result.error.kind === "capability_inactive" ? 409 : 502,
          );
        if (
          "meta" in result.value &&
          (result.value.meta as { source?: string })?.source !== "sandbox"
        )
          return reply({ error: "sandbox_payouts_unavailable" }, 409);
        if (!safePayoutPortalUrl(result.value.url))
          return reply({ error: "invalid_provider_link" }, 502);
        return reply({ kind: "hosted", url: result.value.url, source: "sandbox" });
      }
      const expiresAt = new Date(
        Math.floor((deps.now().getTime() + PAYOUT_TOKEN_TTL_MS) / 1000) * 1000,
      );
      const result = await provider.createAccessToken(
        {
          accountId: seller.whopAccountId,
          scopedActions: [...PAYOUT_SCOPES],
          expiresAt,
        },
        key,
      );
      if (!result.ok)
        return reply(
          { error: result.error.kind },
          result.error.kind === "capability_inactive" ? 409 : 502,
        );
      if (
        "meta" in result.value &&
        (result.value.meta as { source?: string })?.source !== "sandbox"
      )
        return reply({ error: "sandbox_payouts_unavailable" }, 409);
      return reply({
        kind: "embedded",
        token: result.value.token,
        accountId: seller.whopAccountId,
        expiresAt: expiresAt.toISOString(),
        scopedActions: PAYOUT_SCOPES,
        environment: "sandbox",
        returnUrl,
      });
    } catch {
      // No provider exception message, raw response, token, or link in logs/JSON.
      return reply({ error: "payout_session_failed" }, 502);
    }
  };
}
