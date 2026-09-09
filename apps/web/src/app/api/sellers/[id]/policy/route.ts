// POST /api/sellers/{id}/policy: an operator sets a seller's sale_policy
// (apps/web/src/components/operator/seller-panel.tsx's policy toggle). Operator-only, the
// same requireOperator gate apps/web/src/app/api/admin/issues/detect/route.ts uses -
// unlike the buyer/seller-facing routes under this path, ownership never grants this.
//
// Purely a local write: sale_policy is enforced in core before any checkout is created (see
// packages/core/src/services/orders.ts's canSellDirect), so nothing here calls Whop.
// provenance is "app" for the same reason GET /api/sellers/{id}/suspend's response is: this
// reports our own decision, not a readback of provider state.
import { sellerId as parseSellerId, type Seller } from "@ledgerly/core";
import { getCommerce } from "../../../../../lib/commerce";
import { instrumented } from "../../../../../lib/instrument";
import { serializeSeller } from "../../../../../lib/seller-view";
import { getSession } from "../../../../../lib/session";
import { type OperatorAuthzDeps, requireOperator } from "../../../admin/issues/authz";

export const runtime = "nodejs";

const POLICIES = new Set(["direct", "platform_only"]);

function parseBody(value: unknown): "direct" | "platform_only" | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const raw = body.sale_policy ?? body.salePolicy;
  return typeof raw === "string" && POLICIES.has(raw) ? (raw as "direct" | "platform_only") : null;
}

export type SetSellerPolicyDeps = OperatorAuthzDeps & {
  getSeller: (id: string) => Promise<Seller | null>;
  setSalePolicy: (id: string, salePolicy: "direct" | "platform_only") => Promise<void>;
  getDisplayName: (id: string) => Promise<string | null>;
};

export function createSetSellerPolicyHandler(
  deps: SetSellerPolicyDeps,
): (request: Request, id: string) => Promise<Response> {
  return async function handleSetSellerPolicy(request: Request, id: string) {
    const authz = await requireOperator(deps);
    if (!authz.ok) return Response.json({ error: "unauthorized" }, { status: authz.status });

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const salePolicy = parseBody(json);
    if (!salePolicy) return Response.json({ error: "invalid_body" }, { status: 400 });

    const seller = await deps.getSeller(id);
    if (!seller) return Response.json({ error: "not_found" }, { status: 404 });

    await deps.setSalePolicy(id, salePolicy);
    const updated = await deps.getSeller(id);
    if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
    const displayName = await deps.getDisplayName(id);

    return Response.json(serializeSeller(updated, null, "app", { displayName }));
  };
}

const handleSetSellerPolicy = createSetSellerPolicyHandler({
  getSession,
  async getSeller(id) {
    const parsed = parseSellerId(id);
    if (!parsed.ok) return null;
    return getCommerce().sellers.get(parsed.value);
  },
  setSalePolicy: (id, salePolicy) => getCommerce().sellerAdminWrites.setSalePolicy(id, salePolicy),
  getDisplayName: (id) => getCommerce().sellerDisplayNames.get(id),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return instrumented((req) => handleSetSellerPolicy(req, id))(request);
}
