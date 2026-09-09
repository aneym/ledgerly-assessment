import { sellerId } from "@ledgerly/core";
import { authorizeSeller } from "@/lib/authz";
import { getCommerce } from "@/lib/commerce";
import { instrumented } from "@/lib/instrument";
import { requireLocalRequest } from "@/lib/local-identities";
import { createPayoutSimulationStore } from "@/lib/payout-simulation";
import { getSession } from "@/lib/session";
export const runtime = "nodejs";
const store = createPayoutSimulationStore();
async function handle(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  // Next rewrites loopback Request URLs to localhost. Normalize only after the local
  // boundary validates the configured origin, exact inbound Host and fetch-site guard.
  if (
    process.env.DEMO_MODE === "1" &&
    process.env.LEDGERLY_LOCAL_RUNTIME !== undefined &&
    request.method === "POST"
  ) {
    if (!requireLocalRequest(request) || request.headers.get("origin") !== process.env.APP_BASE_URL)
      return Response.json({ source: "mock", error: "invalid_origin" }, { status: 403 });
    const url = new URL(request.url);
    request = new Request(`${process.env.APP_BASE_URL}${url.pathname}${url.search}`, request);
  }
  return instrumented((req) =>
    store.handle(req, id, {
      enabled: process.env.DEMO_MODE === "1",
      authorize: (request, id) =>
        authorizeSeller(
          {
            getSession,
            getSellerOwner: (id) => getCommerce().users.getSellerOwner(id),
            getRequest: async () => request,
          },
          id,
        ),
      getSeller: async (id) => {
        const parsed = sellerId(id);
        return parsed.ok ? getCommerce().sellers.get(parsed.value) : null;
      },
      now: () => new Date(),
    }),
  )(request);
}
export const GET = handle;
export const POST = handle;
