// GET /api/sellers/me: the same payload as GET /api/sellers/{id} (docs/lanes/marketplace's
// seller-facing screens all key off a concrete seller id), but resolves "me" to the
// signed-in caller's own seller record via seller_owners first. This exists because the
// /sell screens have no seller id to put in the URL right after sign-in - only a session.
//
// A user can, in principle, own more than one seller (seller_owners.user_id carries no
// unique constraint - only seller_id, the owned side, is unique per
// packages/db/src/repos/users.ts's own comment: "a seller has exactly one owner"). Nothing
// in this round builds multi-seller support end to end, so "me" resolves to that user's
// first-created seller when more than one exists; a judgment call, flagged in the final
// report.
//
// Delegates everything past that resolution - the account readback, display name and JSON
// shape - to sellers/[id]'s own handler, rather than duplicating it.
import { sellerId as parseSellerId } from "@ledgerly/core";
import { getCommerce } from "../../../../lib/commerce";
import { instrumented } from "../../../../lib/instrument";
import { getSession } from "../../../../lib/session";
import { createGetSellerHandler, type GetSellerDeps } from "../[id]/route";

export const runtime = "nodejs";

export type GetOwnSellerDeps = GetSellerDeps & {
  getSellerIdForUser: (userId: string) => Promise<string | null>;
};

export function createGetOwnSellerHandler(
  deps: GetOwnSellerDeps,
): (request: Request) => Promise<Response> {
  const getSeller = createGetSellerHandler(deps);
  return async function handleGetOwnSeller(request: Request) {
    const session = await deps.getSession();
    // Same error shape as the id-keyed route's own signed-out case (authorizeSeller's
    // {error:"forbidden"}, not {error:"unauthenticated"}): both answer "no seller for
    // you to read", and sellers/[id] never distinguishes the two either.
    if (!session) return Response.json({ error: "forbidden" }, { status: 401 });

    const sellerId = await deps.getSellerIdForUser(session.userId);
    if (!sellerId) return Response.json({ error: "not_found" }, { status: 404 });

    return getSeller(request, sellerId);
  };
}

const handleGetOwnSeller = createGetOwnSellerHandler({
  getSession,
  getSellerOwner: (sellerId) => getCommerce().users.getSellerOwner(sellerId),
  getSellerIdForUser: (userId) => getCommerce().users.getSellerIdForUser(userId),
  async getSeller(id) {
    const parsed = parseSellerId(id);
    if (!parsed.ok) return null;
    return getCommerce().sellers.get(parsed.value);
  },
  getAccount: (accountId, key) => getCommerce().provider.getAccount(accountId, key),
  getDisplayName: (id) => getCommerce().sellerDisplayNames.get(id),
});

export const GET = instrumented((request: Request) => handleGetOwnSeller(request));
