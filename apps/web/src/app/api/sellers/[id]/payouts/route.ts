// Accounting rows retain signed ledger effects; history projects one row per payout.
import {
  buildEarningsRows,
  buildPayoutHistory,
  type LedgerEntry,
  sellerId as parseSellerId,
  type Seller,
} from "@ledgerly/core";
import type { AuthzDeps } from "../../../../../lib/authz";
import { authorizeSeller } from "../../../../../lib/authz";
import { getCommerce } from "../../../../../lib/commerce";
import { instrumented } from "../../../../../lib/instrument";
import { provenanceOf } from "../../../../../lib/seller-view";
import { getSession } from "../../../../../lib/session";

export const runtime = "nodejs";

export type GetPayoutsDeps = AuthzDeps & {
  getSeller: (id: string) => Promise<Seller | null>;
  getLedgerEntries: (sellerId: string) => Promise<LedgerEntry[]>;
  // Not Pick<NodeJS.ProcessEnv, "WHOP_MODE">: see earnings/route.ts's identical comment on
  // why process.env itself does not satisfy a narrower type here.
  env: { WHOP_MODE?: string };
};

export function createGetPayoutsHandler(
  deps: GetPayoutsDeps,
): (request: Request, id: string) => Promise<Response> {
  return async function handleGetPayouts(_request: Request, id: string) {
    const authz = await authorizeSeller(deps, id);
    if (!authz.ok) return Response.json({ error: "forbidden" }, { status: authz.status });

    // Mirrors earnings/route.ts: authorizeSeller alone cannot tell "not yours" apart from
    // "doesn't exist" for a non-owner (both 403, so a seller id can't be enumerated that
    // way), but an operator sails past authorizeSeller regardless, so existence still needs
    // its own check to 404 correctly for them.
    const seller = await deps.getSeller(id);
    if (!seller) return Response.json({ error: "not_found" }, { status: 404 });

    const entries = await deps.getLedgerEntries(id);
    const provenance = provenanceOf(deps.env);
    const rows = buildEarningsRows(entries, provenance).filter((row) => row.item === "payout");

    return Response.json({
      rows,
      provenance,
      history: buildPayoutHistory(entries),
    });
  };
}

const handleGetPayouts = createGetPayoutsHandler({
  getSession,
  getSellerOwner: (sellerId) => getCommerce().users.getSellerOwner(sellerId),
  async getSeller(id) {
    const parsed = parseSellerId(id);
    if (!parsed.ok) return null;
    return getCommerce().sellers.get(parsed.value);
  },
  async getLedgerEntries(id) {
    const parsed = parseSellerId(id);
    if (!parsed.ok) throw new Error("Invalid seller id reached getLedgerEntries");
    return getCommerce().ledger.forSeller(parsed.value);
  },
  // Not `env: process.env` directly: see earnings/route.ts's identical comment.
  env: { WHOP_MODE: process.env.WHOP_MODE },
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return instrumented((req) => handleGetPayouts(req, id))(request);
}
