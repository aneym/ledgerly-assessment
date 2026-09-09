import { deliveryId } from "@ledgerly/core";
import { getCommerce } from "@/lib/commerce";
import { requireLocalRequest } from "@/lib/local-identities";
import { actualNodeEnvironment } from "@/lib/runtime-test-contract/runtime-environment.server";
import { createTestEventHandlers } from "@/lib/runtime-test-contract/test-events";
import { getServer } from "@/lib/server";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request) {
  if (process.env.LEDGERLY_LOCAL_RUNTIME === undefined) return new Response(null, { status: 404 });
  if (!requireLocalRequest(request) || request.headers.get("origin") !== process.env.APP_BASE_URL)
    return Response.json({ error: "forbidden_origin" }, { status: 403 });
  const principal = await getSession();
  if (principal?.role !== "buyer" || !principal.demoRunId)
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  const server = getServer();
  await server.ready;
  if (!server.localRefundIsolation) throw new Error("Missing enforced local refund isolation");
  const commerce = getCommerce();
  const handlers = createTestEventHandlers({
    config: {
      enabled: true,
      nodeEnv: actualNodeEnvironment() ?? "",
      provider: "mock",
      database: "pglite",
      origin: process.env.APP_BASE_URL as string,
      runId: principal.demoRunId,
      platformAccountId: process.env.WHOP_PLATFORM_ACCOUNT_ID ?? "biz_platform_sim",
    },
    authenticate: async () => ({ userId: principal.userId, runId: principal.demoRunId as string }),
    orders: commerce.orders,
    sellers: commerce.sellers,
    uow: server.uow,
    inbox: server.localRefundIsolation.syntheticInbox,
    refundSafety: server.localRefundIsolation.refundSafety,
    readDelivery: async (id) => {
      const parsed = deliveryId(id);
      if (!parsed.ok) return null;
      const stored = await server.db.query.webhookInbox.findFirst({
        where: (table, { eq }) => eq(table.deliveryId, id),
      });
      if (!stored) return null;
      return {
        row: await server.uow.run((repos) => repos.inbox.get(parsed.value)),
        error: stored.error,
      };
    },
    webhookSecret: server.webhookSecret,
    now: () => new Date(),
  });
  // Next's custom server normalizes the Request URL hostname. Exact inbound Host and
  // Origin were checked above; pass the verified loopback origin to the strict helper.
  const url = new URL(request.url);
  const normalized = new Request(
    `${process.env.APP_BASE_URL}${url.pathname}${url.search}`,
    request,
  );
  return request.method === "POST" ? handlers.post(normalized) : handlers.get(normalized);
}
export const POST = handle;
export const GET = handle;
