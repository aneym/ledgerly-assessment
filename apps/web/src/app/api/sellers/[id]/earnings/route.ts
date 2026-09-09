// GET /api/sellers/[id]/earnings: the seller-facing earnings summary
// (docs/lanes/marketplace/anchors.md's sell.earnings screen), reshaped to the JSON-shapes
// addendum's exact body: available/pending/held balances, a row-per-ledger-entry table, and
// the seller's charge model.
import {
  buildEarningsRows,
  type Earnings,
  getProviderEarnings,
  type LedgerEntry,
  sellerId as parseSellerId,
  type Seller,
  summarize,
  type WhopPort,
} from "@ledgerly/core";
import type { AuthzDeps } from "../../../../../lib/authz";
import { authorizeSeller } from "../../../../../lib/authz";
import { getCommerce } from "../../../../../lib/commerce";
import { instrumented } from "../../../../../lib/instrument";
import { provenanceOf } from "../../../../../lib/seller-view";
import { getSession } from "../../../../../lib/session";

export const runtime = "nodejs";

export type GetEarningsDeps = AuthzDeps & {
  provider: Pick<WhopPort, "listFinancialActivity">;
  getSeller: (id: string) => Promise<Seller | null>;
  getEarnings: (sellerId: string) => Promise<Earnings>;
  getLedgerEntries: (sellerId: string) => Promise<LedgerEntry[]>;
  // Not Pick<NodeJS.ProcessEnv, "WHOP_MODE">: process.env only carries an index signature,
  // which TS does not accept as satisfying a Pick'd named property (see seller-view.ts's
  // provenanceOf for the full explanation).
  env: { WHOP_MODE?: string };
};

export function createGetEarningsHandler(
  deps: GetEarningsDeps,
): (request: Request, id: string) => Promise<Response> {
  return async function handleGetEarnings(_request: Request, id: string) {
    const authz = await authorizeSeller(deps, id);
    if (!authz.ok) return Response.json({ error: "forbidden" }, { status: authz.status });

    const seller = await deps.getSeller(id);
    if (!seller) return Response.json({ error: "not_found" }, { status: 404 });

    const provenance = provenanceOf(deps.env);
    const [earnings, entries, providerEarnings] = await Promise.all([
      deps.getEarnings(id),
      deps.getLedgerEntries(id),
      getProviderEarnings(deps.provider, seller.whopAccountId, provenance),
    ]);
    const { available, pending, held } = summarize(earnings.totals);

    return Response.json({
      ...providerEarnings,
      available,
      pending,
      held,
      rows: buildEarningsRows(entries, provenance),
      charge_model: seller.salePolicy === "direct" ? "direct" : "platform_transfer",
    });
  };
}

const handleGetEarnings = createGetEarningsHandler({
  getSession,
  provider: {
    listFinancialActivity: (input) => getCommerce().provider.listFinancialActivity(input),
  },
  getSellerOwner: (sellerId) => getCommerce().users.getSellerOwner(sellerId),
  async getSeller(id) {
    const parsed = parseSellerId(id);
    if (!parsed.ok) return null;
    return getCommerce().sellers.get(parsed.value);
  },
  async getEarnings(id) {
    const parsed = parseSellerId(id);
    if (!parsed.ok) throw new Error("Invalid seller id reached getEarnings");
    return getCommerce().getEarnings(parsed.value);
  },
  async getLedgerEntries(id) {
    const parsed = parseSellerId(id);
    if (!parsed.ok) throw new Error("Invalid seller id reached getLedgerEntries");
    return getCommerce().ledger.forSeller(parsed.value);
  },
  // Not `env: process.env` directly: Next.js's own next/types/global.d.ts merges a
  // `readonly NODE_ENV` member into NodeJS.ProcessEnv, which makes the whole interface a
  // "weak type" TS refuses to assign to any narrower WHOP_MODE-only type (they end up with
  // no declared property in common — the shared index signature doesn't count for that
  // check). Reading just WHOP_MODE off it up front sidesteps the issue entirely.
  env: { WHOP_MODE: process.env.WHOP_MODE },
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return instrumented((req) => handleGetEarnings(req, id))(request);
}
