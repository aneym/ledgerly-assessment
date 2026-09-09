// POST /api/sellers/{id}/suspend: an operator suspends a seller
// (apps/web/src/components/operator/seller-panel.tsx's suspend action). Operator-only.
//
// Local-only, by design (coordinator correction): this does NOT call WhopPort.updateAccount
// or encode suspension into its metadata bag - the provider port has no suspend operation,
// and sending a metadata write while calling it "suspend" would be a real provider write
// mislabeled as one that does nothing the seller's account actually feels. Suspension is
// purely core-enforced: canSellDirect (packages/core/src/seller.ts) already blocks a
// suspended seller's checkouts, so flipping sellers.status locally is the whole mechanism.
// The response says so explicitly via `provider.suspended: false`.
import { sellerId as parseSellerId, type Seller } from "@ledgerly/core";
import { getCommerce } from "../../../../../lib/commerce";
import { instrumented } from "../../../../../lib/instrument";
import { serializeSeller } from "../../../../../lib/seller-view";
import { getSession } from "../../../../../lib/session";
import { type OperatorAuthzDeps, requireOperator } from "../../../admin/issues/authz";

export const runtime = "nodejs";

export type SuspendSellerDeps = OperatorAuthzDeps & {
  getSeller: (id: string) => Promise<Seller | null>;
  suspend: (id: string) => Promise<void>;
  getDisplayName: (id: string) => Promise<string | null>;
};

export function createSuspendSellerHandler(
  deps: SuspendSellerDeps,
): (request: Request, id: string) => Promise<Response> {
  return async function handleSuspendSeller(_request: Request, id: string) {
    const authz = await requireOperator(deps);
    if (!authz.ok) return Response.json({ error: "unauthorized" }, { status: authz.status });

    const seller = await deps.getSeller(id);
    if (!seller) return Response.json({ error: "not_found" }, { status: 404 });

    await deps.suspend(id);
    const updated = await deps.getSeller(id);
    if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
    const displayName = await deps.getDisplayName(id);

    return Response.json({
      ...serializeSeller(updated, null, "app", { displayName }),
      provider: { suspended: false, reason: "no suspend operation in the provider port" },
    });
  };
}

const handleSuspendSeller = createSuspendSellerHandler({
  getSession,
  async getSeller(id) {
    const parsed = parseSellerId(id);
    if (!parsed.ok) return null;
    return getCommerce().sellers.get(parsed.value);
  },
  suspend: (id) => getCommerce().sellerAdminWrites.suspend(id),
  getDisplayName: (id) => getCommerce().sellerDisplayNames.get(id),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return instrumented((req) => handleSuspendSeller(req, id))(request);
}
