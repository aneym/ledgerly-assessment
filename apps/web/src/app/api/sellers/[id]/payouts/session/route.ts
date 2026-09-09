import { randomUUID } from "node:crypto";
import { sellerId } from "@ledgerly/core";
import { getCommerce } from "@/lib/commerce";
import { instrumented } from "@/lib/instrument";
import { createPayoutSessionHandler } from "@/lib/payouts";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const handler = createPayoutSessionHandler({
    getSession,
    getSellerOwner: (id) => getCommerce().users.getSellerOwner(id),
    getSeller: async (id) => {
      const parsed = sellerId(id);
      return parsed.ok ? getCommerce().sellers.get(parsed.value) : null;
    },
    getProvider: () => getCommerce().provider,
    mode: process.env.WHOP_MODE,
    appBaseUrl: process.env.APP_BASE_URL,
    payoutReturnUrl: process.env.PAYOUT_RETURN_URL,
    now: () => new Date(),
    nonce: randomUUID,
  });
  return instrumented((req) => handler(req, id))(request);
}
