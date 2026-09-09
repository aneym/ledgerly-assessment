// GET /api/orders/[id]: the receipt screen's data source (docs/lanes/marketplace/anchors.md's
// receipt anchor). An order carries the seller's fee and purchase URL, both sensitive, so
// this authorizes two different ways: the buyer who created the order (orders.buyer_user_id,
// set when checkout happened while signed in) may always read their own receipt, and
// otherwise this falls back to the seller-owner-or-operator rule used on the explicitly-named
// seller routes, keyed off the order's own sellerId. The seller-owner fallback (for orders
// with no buyer identity, e.g. guest checkouts, or a seller/operator checking a receipt on a
// buyer's behalf) was a judgment call this round, not stated in the brief — flagged in the
// final report.
import {
  type Order,
  orderId as parseOrderId,
  type Seller,
  type SellerId,
  subtract,
} from "@ledgerly/core";
import type { AuthzDeps } from "../../../../lib/authz";
import { authorizeSeller } from "../../../../lib/authz";
import { allProducts } from "../../../../lib/catalog";
import { getCommerce } from "../../../../lib/commerce";
import { instrumented } from "../../../../lib/instrument";
import { getSession } from "../../../../lib/session";

export const runtime = "nodejs";

export type GetOrderDeps = AuthzDeps & {
  getOrder: (id: string) => Promise<Order | null>;
  getSeller: (id: SellerId) => Promise<Seller | null>;
  /** The product row behind order.productExternalId, for its slug; absent rows resolve to null. */
  getProduct?: (id: string) => Promise<ProductRef | null>;
};

/** The one product field the receipt needs beyond what the order stores. */
export type ProductRef = { slug: string };

// The order stores the product's id (productExternalId) and title, never its slug. The
// serialized `product.slug` used to carry that id, so the buyer screens looked the cover up
// by a slug that was really "prd_grain" and drew a blank plate (ui-fixes, 2026-09-08).
// Now `product.id` carries the id and `product.slug` is the real slug: from the product row
// when the route can read it, else from the bundled catalog fixture, else null.
export function resolveProductSlug(
  productExternalId: string | null,
  product: ProductRef | null,
): string | null {
  if (product) return product.slug;
  if (!productExternalId) return null;
  return allProducts().find((candidate) => candidate.id === productExternalId)?.slug ?? null;
}
export async function productRefFor(
  deps: Pick<GetOrderDeps, "getProduct">,
  order: Order,
): Promise<ProductRef | null> {
  if (!order.productExternalId || !deps.getProduct) return null;
  try {
    return await deps.getProduct(order.productExternalId);
  } catch {
    return null;
  }
}

// Exported so GET /api/orders (the buyer's own order list) serializes each row the same
// way as this single-order route - one contract shape, not two independently maintained
// ones.
export function serializeOrder(order: Order, seller: Seller, product: ProductRef | null = null) {
  const shareResult = subtract(order.gross, order.fee);
  return {
    id: order.id,
    product: {
      id: order.productExternalId,
      slug: resolveProductSlug(order.productExternalId, product),
      title: order.productTitle,
    },
    seller: {
      id: seller.id,
      name: seller.externalId,
      sale_policy: seller.salePolicy,
    },
    gross: order.gross,
    fee: order.fee,
    seller_share: shareResult.ok ? shareResult.value : order.gross,
    status: order.status,
    flow: order.flow,
    created_at: order.createdAt.toISOString(),
    provenance: order.provenance,
    // The hosted checkout link, so the checkout page can show it again after a redirect;
    // only the order's owner or an operator gets this far (see the authz check above).
    purchase_url: order.purchaseUrl,
    // The provider's checkout configuration (ch_...), which the embedded checkout mounts
    // from. Null until the provider issued one. Carries no card data and no price authority:
    // the configuration itself holds the server-computed price and fee.
    checkout_configuration_id: order.checkoutConfigurationId,
    // Null until a payment has actually settled (see packages/core/src/services/
    // orders.ts's Order.paymentId comment) - written by the reconciliation/webhook path,
    // out of scope here.
    payment_id: order.paymentId,
  };
}

export function createGetOrderHandler(
  deps: GetOrderDeps,
): (request: Request, id: string) => Promise<Response> {
  return async function handleGetOrder(_request: Request, id: string) {
    const order = await deps.getOrder(id);
    if (!order) return Response.json({ error: "not_found" }, { status: 404 });

    // A signed-in buyer reading their own receipt short-circuits straight past the
    // seller-owner-or-operator rule below; an order with no buyer identity (a guest
    // checkout) or a request from someone other than that buyer still falls through to it.
    const session = await deps.getSession();
    const isOwnPurchase =
      session !== null && order.buyerUserId !== null && order.buyerUserId === session.userId;

    if (!isOwnPurchase) {
      const authz = await authorizeSeller(deps, order.sellerId);
      if (!authz.ok) return Response.json({ error: "forbidden" }, { status: authz.status });
    }

    const seller = await deps.getSeller(order.sellerId);
    if (!seller) return Response.json({ error: "not_found" }, { status: 404 });

    return Response.json(serializeOrder(order, seller, await productRefFor(deps, order)));
  };
}

const handleGetOrder = createGetOrderHandler({
  getSession,
  getSellerOwner: (sellerId) => getCommerce().users.getSellerOwner(sellerId),
  async getOrder(id) {
    const parsed = parseOrderId(id);
    if (!parsed.ok) return null;
    return getCommerce().orders.get(parsed.value);
  },
  getSeller: (id) => getCommerce().sellers.get(id),
  getProduct: (id) => getCommerce().products.get(id),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return instrumented((req) => handleGetOrder(req, id))(request);
}
