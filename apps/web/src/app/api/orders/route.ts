// GET /api/orders: the signed-in buyer's own order history, newest first, cursor-paged.
// Contract: `{ orders: [...same shape as GET /api/orders/{id}...], next_cursor }`. Reuses
// serializeOrder from the single-order route so the two endpoints never drift into two
// independently maintained JSON shapes.
import type { Order, Seller } from "@ledgerly/core";
import { getCommerce } from "../../../lib/commerce";
import { instrumented } from "../../../lib/instrument";
import { getSession } from "../../../lib/session";
import type { ProductRef } from "./[id]/route";
import { productRefFor, serializeOrder } from "./[id]/route";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 20;

export type ListOrdersDeps = {
  getSession: typeof getSession;
  listOrders: (
    buyerUserId: string,
    opts: { limit: number; cursor?: string | null },
  ) => Promise<{ orders: Order[]; nextCursor: string | null }>;
  getSeller: (id: Order["sellerId"]) => Promise<Seller | null>;
  getProduct?: (id: string) => Promise<ProductRef | null>;
};

export function createListOrdersHandler(
  deps: ListOrdersDeps,
): (request: Request) => Promise<Response> {
  return async function handleListOrders(request: Request) {
    const session = await deps.getSession();
    if (!session) return Response.json({ error: "forbidden" }, { status: 401 });

    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const limitParam = url.searchParams.get("limit");
    const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : DEFAULT_LIMIT;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT;

    const page = await deps.listOrders(session.userId, { limit, cursor });

    // An order whose seller has since vanished is dropped from the page rather than
    // failing the whole request (unlike the single-order route's 404, there is no single
    // resource here to 404 on) - a judgment call, flagged in the final report.
    const serialized = (
      await Promise.all(
        page.orders.map(async (order) => {
          const seller = await deps.getSeller(order.sellerId);
          return seller ? serializeOrder(order, seller, await productRefFor(deps, order)) : null;
        }),
      )
    ).filter((row): row is NonNullable<typeof row> => row !== null);

    return Response.json({ orders: serialized, next_cursor: page.nextCursor });
  };
}

const handleListOrders = createListOrdersHandler({
  getSession,
  listOrders: (buyerUserId, opts) => getCommerce().orders.listForBuyer(buyerUserId, opts),
  getSeller: (id) => getCommerce().sellers.get(id),
  getProduct: (id) => getCommerce().products.get(id),
});

export const GET = instrumented((request: Request) => handleListOrders(request));
