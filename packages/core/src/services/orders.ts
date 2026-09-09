import { computePlatformFee, type FeeError } from "../fee";
import type { OrderId, RunId, SellerId, WhopAccountId } from "../ids";
import type { Money } from "../money";
import type { WhopPort } from "../ports/whop";
import type { WhopError } from "../ports/whop-types";
import { err, ok, type Result } from "../result";
import { canSellDirect, type Seller } from "../seller";
import type { UnitOfWork } from "./ports";

export type OrderStatus = "pending" | "checkout_created" | "failed" | "paid" | "refunded";
export type OrderFlow = "direct" | "platform_transfer";

// Which Whop path produced this order's checkout: the real sandbox API, or the in-memory
// mock. Mirrors packages/whop's WhopSource vocabulary (a hybrid adapter's `meta.source`),
// narrowed to the two values the app-facing API ever reports (see apps/web/src/lib/
// seller-view.ts's provenanceOf, which resolves the same value for the seller/onboarding
// routes from the same source of truth).
export type ProviderSource = "sandbox" | "mock";

// The order as the rest of the app sees it: money fields decoded, flow and
// status resolved. packages/db/src/repos/orders.ts maps this to and from the
// orders table.
export type Order = {
  id: OrderId;
  runId: RunId;
  sellerId: SellerId;
  productTitle: string;
  productExternalId: string | null;
  gross: Money;
  fee: Money;
  flow: OrderFlow;
  checkoutConfigurationId: string | null;
  purchaseUrl: string | null;
  status: OrderStatus;
  createdAt: Date;
  // Set once a checkout configuration exists, from that provider call's own result (a hybrid
  // adapter attaches `meta.source`); "mock" until then, matching the orders table's default.
  provenance: ProviderSource;
  // The signed-in buyer who created this order, when checkout happened while signed in;
  // null for a guest checkout. Lets a buyer's own GET /api/orders/{id} call authorize
  // against this instead of seller ownership.
  buyerUserId: string | null;
  // Additive (admin-ledger): the provider payment id this order settled under, once a
  // payment has actually landed. Null until then - nothing in this service sets it; it is
  // written by the reconciliation/webhook path (out of scope here) and only read back by
  // the order-facing GET routes.
  paymentId: string | null;
};

export type CreateOrderInput = {
  runId: RunId;
  sellerId: SellerId;
  productTitle: string;
  productExternalId?: string;
  gross: Money;
  buyerUserId?: string;
};

// Fee and flow are decided by the service before the row is written, so the
// repo only ever inserts a fully-formed order.
export type NewOrder = CreateOrderInput & { fee: Money; flow: OrderFlow };

export interface OrdersRepo {
  // Insert-or-fetch keyed by `id`: a second call with the SAME id returns the
  // row created by the first call unchanged, so a caller-retried request
  // never double-charges or double-creates a checkout. A different id for
  // the same buyer/product is a distinct order on purpose; unlike sellers,
  // orders have no natural business key to dedupe on.
  createOrFetch(input: NewOrder, id: OrderId): Promise<Order>;
  get(id: OrderId): Promise<Order | null>;
  setCheckout(
    id: OrderId,
    update: {
      checkoutConfigurationId: string;
      purchaseUrl: string | null;
      status: OrderStatus;
      provenance: ProviderSource;
    },
  ): Promise<Order>;
  // The signed-in buyer's own order history for GET /api/orders: newest first, cursor-paged.
  // `cursor` is opaque to callers - pass back exactly what a previous page's `nextCursor`
  // returned, or omit it for the first page. `limit` bounds the page size; the repo is free
  // to clamp it. `nextCursor` is null once there is no further page.
  listForBuyer(
    buyerUserId: string,
    opts: { limit: number; cursor?: string | null },
  ): Promise<{ orders: Order[]; nextCursor: string | null }>;
}

// The seller record this service needs, with the sale-policy and status
// fields ports.ts's narrower Seller does not carry. Implemented against the
// same `sellers` table used elsewhere, just with more columns selected.
export interface SellerLookup {
  get(id: SellerId): Promise<Seller | null>;
}

export type OrderError =
  | FeeError
  | { kind: "seller_not_found" }
  | { kind: "seller_suspended" }
  | { kind: "seller_not_onboarded" }
  | WhopError;

export function createOrderService(deps: {
  uow: Pick<UnitOfWork, "exclusive">;
  provider: Pick<WhopPort, "createCheckoutConfiguration">;
  sellers: SellerLookup;
  orders: OrdersRepo;
  ids: { order(): OrderId };
  redirectUrl: (orderId: OrderId) => string;
  rateBps?: number;
  // Provenance to record when the provider result carries no meta.source of its own (plain
  // mock-mode calls attach no meta at all). Callers derive this once from WHOP_MODE; defaults
  // to "mock" so a caller that omits it still gets a valid, conservative value.
  defaultProvenance?: ProviderSource;
}) {
  return async function createOrder(input: CreateOrderInput): Promise<Result<Order, OrderError>> {
    const fee = computePlatformFee(input.gross, deps.rateBps);
    if (!fee.ok) return fee;
    const seller = await deps.sellers.get(input.sellerId);
    if (!seller) return err({ kind: "seller_not_found" });
    const policy = canSellDirect(seller);
    let flow: OrderFlow;
    let accountId: WhopAccountId | null;
    if (policy.ok) {
      // Direct flow puts the checkout on the seller's own account, so it
      // cannot exist until onboarding has attached one.
      if (!seller.whopAccountId) return err({ kind: "seller_not_onboarded" });
      flow = "direct";
      accountId = seller.whopAccountId;
    } else if (policy.error.kind === "seller_suspended") {
      return err({ kind: "seller_suspended" });
    } else {
      // platform_only: the checkout runs on the platform's own account, no
      // application fee is charged at checkout time, but the fee is still
      // recorded on the order for the later transfer that pays the seller.
      flow = "platform_transfer";
      accountId = null;
    }
    const id = deps.ids.order();
    // Held for the whole read-decide-call-provider-write sequence, mirroring
    // onboarding.ts, so two concurrent retries of the same request can't
    // both call the provider.
    return deps.uow.exclusive(`order:${id}`, async () => {
      const order = await deps.orders.createOrFetch({ ...input, fee: fee.value.fee, flow }, id);
      if (order.checkoutConfigurationId) return ok(order);
      const applicationFee = flow === "direct" ? fee.value.fee : null;
      const checkout = await deps.provider.createCheckoutConfiguration(
        {
          accountId,
          productTitle: order.productTitle,
          ...(order.productExternalId ? { productExternalId: order.productExternalId } : {}),
          price: order.gross,
          applicationFee,
          redirectUrl: deps.redirectUrl(order.id),
        },
        `checkout:${order.id}`,
      );
      if (!checkout.ok) return checkout;
      // A hybrid adapter attaches `meta.source` to a successful result; the plain WhopPort
      // type doesn't declare it, so read it defensively rather than widening the port type.
      const meta = (checkout.value as { meta?: { source?: ProviderSource } }).meta;
      const provenance = meta?.source ?? deps.defaultProvenance ?? "mock";
      const updated = await deps.orders.setCheckout(order.id, {
        checkoutConfigurationId: checkout.value.id,
        purchaseUrl: checkout.value.purchaseUrl ?? null,
        status: "checkout_created",
        provenance,
      });
      return ok(updated);
    });
  };
}
