// POST /api/checkouts: create (or idempotently re-fetch) a checkout for a buyer, on the
// buy button described in docs/lanes/marketplace/anchors.md. This route takes no required
// authentication: checkout stays anonymous/guest-friendly (a hosted Whop checkout page
// does its own buyer identification), a design decision this round, not an instruction
// from the brief — flagged in the final report. When the caller IS signed in, though, the
// session's own userId is recorded as orders.buyer_user_id, so GET /api/orders/{id} can
// later let that buyer read their own receipt. The client-supplied `buyer_id` request
// field is intentionally never used for that column: it is unauthenticated and therefore
// spoofable, so it stays accepted-but-unwired per the JSON-shapes addendum, exactly as
// before this change.
import {
  type CreateOrderInput,
  type Currency,
  money,
  type Order,
  type OrderError,
  orderId,
  sellerId as parseSellerId,
  type Result,
} from "@ledgerly/core";
import { getCommerce } from "../../../lib/commerce";
import { instrumented } from "../../../lib/instrument";
import { extractProviderError } from "../../../lib/provider-error";
import { getSession } from "../../../lib/session";

export const runtime = "nodejs";

const CURRENCIES = new Set<Currency>(["USD", "EUR", "BRL"]);

type ResolvedProduct = {
  productTitle: string;
  productExternalId?: string;
  priceMinor: number;
  currency: Currency;
};

// Resolve by seller and slug so identical slugs from different sellers stay isolated.
// Direct pricing is supported only for legacy requests without a product slug.
export type LookupProduct = (sellerId: string, slug: string) => Promise<ResolvedProduct | null>;

type CheckoutBody = {
  sellerId: string;
  buyerId?: string;
  productSlug?: string;
  productTitle?: string;
  productExternalId?: string;
  priceMinor?: number;
  currency?: Currency;
};

function parseBody(value: unknown): CheckoutBody | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const sellerIdValue = body.seller_id ?? body.sellerId;
  if (typeof sellerIdValue !== "string" || !sellerIdValue.trim()) return null;
  const buyerIdValue = body.buyer_id ?? body.buyerId;
  if (buyerIdValue !== undefined && typeof buyerIdValue !== "string") return null;
  const productSlugValue = body.product_slug ?? body.productSlug;
  if (
    (Object.hasOwn(body, "product_slug") || Object.hasOwn(body, "productSlug")) &&
    (typeof productSlugValue !== "string" || !productSlugValue.trim())
  )
    return null;
  const productExternalIdValue = body.productExternalId;
  if (productExternalIdValue !== undefined && typeof productExternalIdValue !== "string")
    return null;
  if (body.productTitle !== undefined && typeof body.productTitle !== "string") return null;
  if (body.priceMinor !== undefined && typeof body.priceMinor !== "number") return null;
  if (body.currency !== undefined && !CURRENCIES.has(body.currency as Currency)) return null;

  return {
    sellerId: sellerIdValue,
    ...(typeof buyerIdValue === "string" ? { buyerId: buyerIdValue } : {}),
    ...(typeof productSlugValue === "string" ? { productSlug: productSlugValue } : {}),
    ...(typeof body.productTitle === "string" ? { productTitle: body.productTitle } : {}),
    ...(typeof productExternalIdValue === "string"
      ? { productExternalId: productExternalIdValue }
      : {}),
    ...(typeof body.priceMinor === "number" ? { priceMinor: body.priceMinor } : {}),
    ...(body.currency !== undefined ? { currency: body.currency as Currency } : {}),
  };
}

export type CreateCheckoutDeps = {
  getSellerRunId: (sellerId: string) => Promise<CreateOrderInput["runId"] | null>;
  createOrder: (input: CreateOrderInput) => Promise<Result<Order, OrderError>>;
  lookupProduct: LookupProduct;
  // Optional: null when the caller is signed out, which stays a valid, expected checkout.
  getSession: () => Promise<{ userId: string; role: string } | null>;
};

export function createCheckoutHandler(
  deps: CreateCheckoutDeps,
): (request: Request) => Promise<Response> {
  return async function handleCreateCheckout(request: Request): Promise<Response> {
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    // Check field presence before parsing: even null or catalog-matching prices
    // are caller-supplied pricing and must be rejected on the slug-based path.
    if (
      json !== null &&
      typeof json === "object" &&
      (Object.hasOwn(json, "product_slug") || Object.hasOwn(json, "productSlug")) &&
      ["priceMinor", "price_minor", "amount", "amountMinor", "amount_minor", "currency"].some(
        (field) => Object.hasOwn(json, field),
      )
    ) {
      return Response.json({ error: "product_pricing_not_allowed" }, { status: 400 });
    }
    const body = parseBody(json);
    if (!body) return Response.json({ error: "invalid_body" }, { status: 400 });

    const parsedSellerId = parseSellerId(body.sellerId);
    if (!parsedSellerId.ok) return Response.json({ error: "seller_not_found" }, { status: 404 });

    const runId = await deps.getSellerRunId(parsedSellerId.value);
    if (!runId) return Response.json({ error: "seller_not_found" }, { status: 404 });

    const product: ResolvedProduct | null =
      body.productSlug !== undefined
        ? await deps.lookupProduct(parsedSellerId.value, body.productSlug)
        : body.productTitle !== undefined &&
            body.priceMinor !== undefined &&
            body.currency !== undefined
          ? {
              productTitle: body.productTitle,
              ...(body.productExternalId ? { productExternalId: body.productExternalId } : {}),
              priceMinor: body.priceMinor,
              currency: body.currency,
            }
          : null;
    if (!product) return Response.json({ error: "invalid_body" }, { status: 400 });

    const gross = money(product.priceMinor, product.currency);
    if (!gross.ok) return Response.json({ error: gross.error.kind }, { status: 400 });

    const session = await deps.getSession();

    const result = await deps.createOrder({
      runId,
      sellerId: parsedSellerId.value,
      productTitle: product.productTitle,
      ...(product.productExternalId ? { productExternalId: product.productExternalId } : {}),
      gross: gross.value,
      ...(session ? { buyerUserId: session.userId } : {}),
    });
    if (!result.ok) {
      const kind = result.error.kind;
      const status =
        kind === "seller_not_found"
          ? 404
          : kind === "seller_suspended"
            ? 403
            : kind === "seller_not_onboarded"
              ? 409
              : kind === "invalid_amount" ||
                  kind === "invalid_currency" ||
                  kind === "currency_mismatch" ||
                  kind === "invalid_decimal" ||
                  kind === "overflow" ||
                  kind === "invalid_request"
                ? 400
                : kind === "idempotency_conflict"
                  ? 409
                  : kind === "not_found"
                    ? 404
                    : 502;
      // A provider HTTP failure carries the upstream status and Whop's error code and
      // message (same shape as POST /api/sellers), so a sandbox hiccup reads differently
      // from a misconfiguration in the Lab and the trace panel.
      return Response.json(
        kind === "http"
          ? { error: "provider_http", ...extractProviderError(result.error) }
          : { error: kind },
        { status },
      );
    }

    return Response.json(
      {
        order_id: result.value.id,
        purchase_url: result.value.purchaseUrl,
        status: result.value.status,
        provenance: result.value.provenance,
      },
      { status: 201 },
    );
  };
}

export const POST = instrumented(
  createCheckoutHandler({
    async getSellerRunId(id) {
      const parsed = parseSellerId(id);
      if (!parsed.ok) return null;
      const seller = await getCommerce().sellers.get(parsed.value);
      return seller ? seller.runId : null;
    },
    createOrder: (input) => getCommerce().createOrder(input),
    async lookupProduct(sellerIdValue, slug) {
      const product = await getCommerce().products.getBySlug(sellerIdValue, slug);
      if (!product) return null;
      return {
        productTitle: product.title,
        productExternalId: product.id,
        priceMinor: product.priceMinor,
        currency: product.currency,
      };
    },
    getSession,
  }),
);

// orderId is imported for consumers of this module (tests) that need to construct valid
// order ids for stubbed repos; re-exported so tests don't need a second deep import.
export { orderId };
