import { sellerId as parseSellerId } from "@ledgerly/core";
import { headers } from "next/headers";
import { getCommerce } from "./commerce";
import { demoScopeFor, sellerInScope } from "./demo-scope";

// Shared authorization check for the seller-scoped routes under
// apps/web/src/app/api/sellers and apps/web/src/app/api/orders: the signed-in user must
// either own the seller (apps/web/src/lib/commerce.ts's UsersRepo records that mapping
// when a seller is created) or hold the operator role.
export type AuthzDeps = {
  getSession: () => Promise<{ userId: string; role: string } | null>;
  getSellerOwner: (sellerId: string) => Promise<string | null>;
  getRequest?: () => Promise<Request>;
  getSellerRunId?: (sellerId: string) => Promise<string | null>;
};

export type AuthzResult =
  | { ok: true; userId: string }
  | { ok: false; status: 401 }
  | { ok: false; status: 403 };

export async function authorizeSeller(deps: AuthzDeps, sellerId: string): Promise<AuthzResult> {
  const session = await deps.getSession();
  if (!session) return { ok: false, status: 401 };
  if (session.role === "operator") return { ok: true, userId: session.userId };
  if (session.role === "demo") {
    const request = deps.getRequest
      ? await deps.getRequest()
      : new Request("http://ledgerly.local", { headers: await headers() });
    const scope = demoScopeFor(session, request);
    if (!scope) return { ok: false, status: 403 };
    const parsed = parseSellerId(sellerId);
    if (!parsed.ok) return { ok: false, status: 403 };
    const runId = deps.getSellerRunId
      ? await deps.getSellerRunId(sellerId)
      : (await getCommerce().sellers.get(parsed.value))?.runId;
    return runId && sellerInScope(scope, { runId })
      ? { ok: true, userId: session.userId }
      : { ok: false, status: 403 };
  }
  const owner = await deps.getSellerOwner(sellerId);
  if (owner !== session.userId) return { ok: false, status: 403 };
  return { ok: true, userId: session.userId };
}
