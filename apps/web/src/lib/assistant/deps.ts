// Composition root for the assistant route: wires the real session lookup and the real
// commerce dependencies (db, Whop provider, seller/order repos) into the shapes tools.ts
// and lookups.ts expect, the same way apps/web/src/lib/commerce.ts wires its own services
// on top of apps/web/src/lib/server.ts. Reuses getCommerce() rather than building a second
// db connection/Whop provider: this module owns no state of its own besides the process
// env it reads WHOP_MODE/WHOP_PLATFORM_ACCOUNT_ID from.
import { listInstrumentationEvents } from "@ledgerly/db";
import { getCommerce } from "../commerce";
import { getSession } from "../session";
import type { AssistantToolDeps, ListEventTrailQuery } from "./tools";

export function createAssistantToolDeps(env: NodeJS.ProcessEnv = process.env): AssistantToolDeps {
  const commerce = getCommerce();
  return {
    db: commerce.db,
    provider: commerce.provider,
    sellers: commerce.sellers,
    orders: commerce.orders,
    getSession,
    whopMode: env.WHOP_MODE,
    platformAccountId: env.WHOP_PLATFORM_ACCOUNT_ID,
    async listEventTrail(query: ListEventTrailQuery) {
      return listInstrumentationEvents(commerce.db, query);
    },
  };
}
