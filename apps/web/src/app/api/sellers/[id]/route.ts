// GET /api/sellers/[id]: the local seller row plus a live readback of the account from
// Whop, so the caller can see drift between what we recorded and what the provider has
// (per docs/lanes/architecture/frontend-ready.md's provenance requirement — this powers
// the seller-facing onboarding status screen's provenance badge).
import { sellerId as parseSellerId, type Seller, type WhopPort } from "@ledgerly/core";
import type { AuthzDeps } from "../../../../lib/authz";
import { authorizeSeller } from "../../../../lib/authz";
import { getCommerce } from "../../../../lib/commerce";
import { instrumented } from "../../../../lib/instrument";
import { provenanceOf, serializeSeller } from "../../../../lib/seller-view";
import { getSession } from "../../../../lib/session";

export const runtime = "nodejs";

export type GetSellerDeps = AuthzDeps & {
  getSeller: (id: string) => Promise<Seller | null>;
  getAccount: WhopPort["getAccount"];
  getDisplayName: (id: string) => Promise<string | null>;
};

export function createGetSellerHandler(
  deps: GetSellerDeps,
): (request: Request, id: string) => Promise<Response> {
  return async function handleGetSeller(_request: Request, id: string) {
    const authz = await authorizeSeller(deps, id);
    if (!authz.ok) return Response.json({ error: "forbidden" }, { status: authz.status });

    const seller = await deps.getSeller(id);
    if (!seller) return Response.json({ error: "not_found" }, { status: 404 });

    // A seller that has never reached onboarding has no account to read back yet; that is
    // expected, not an error — capabilities/verification just fall back to their
    // no-account defaults, and provenance falls back to WHOP_MODE with no meta.source to
    // prefer.
    let raw: unknown = null;
    let meta: { source?: "sandbox" | "mock" } | undefined;
    if (seller.whopAccountId) {
      const read = await deps.getAccount(seller.whopAccountId, `seller-read:${seller.id}`);
      if (read.ok) {
        raw = read.value.raw;
        meta = (read.value as { meta?: { source?: "sandbox" | "mock" } }).meta;
      }
    }

    const displayName = await deps.getDisplayName(seller.id);
    // Not `provenanceOf(process.env, ...)` directly: Next.js's next/types/global.d.ts merges
    // a `readonly NODE_ENV` member into NodeJS.ProcessEnv, which makes the whole interface a
    // "weak type" TS refuses to assign to provenanceOf's narrower WHOP_MODE-only parameter.
    // Reading just WHOP_MODE off it up front sidesteps the issue.
    return Response.json(
      serializeSeller(seller, raw, provenanceOf({ WHOP_MODE: process.env.WHOP_MODE }, meta), {
        displayName,
      }),
    );
  };
}

const handleGetSeller = createGetSellerHandler({
  getSession,
  getSellerOwner: (sellerId) => getCommerce().users.getSellerOwner(sellerId),
  async getSeller(id) {
    const parsed = parseSellerId(id);
    if (!parsed.ok) return null;
    return getCommerce().sellers.get(parsed.value);
  },
  getAccount: (accountId, key) => getCommerce().provider.getAccount(accountId, key),
  getDisplayName: (id) => getCommerce().sellerDisplayNames.get(id),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return instrumented((req) => handleGetSeller(req, id))(request);
}
