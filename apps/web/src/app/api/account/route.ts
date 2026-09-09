// GET /api/account: the signed-in user's own profile. No client caller exists yet (no
// account page reads this in the current UI), but it is named in the brief's contract, so it
// exists ahead of one - flagged as a judgment call in the final report.
import { getCommerce } from "../../../lib/commerce";
import { instrumented } from "../../../lib/instrument";
import { getSession } from "../../../lib/session";

export const runtime = "nodejs";

export type GetAccountDeps = {
  getSession: () => Promise<{ userId: string; role: string } | null>;
  getUser: (userId: string) => Promise<{
    id: string;
    email: string;
    name: string;
    role: string;
  } | null>;
  getSellerIdForUser: (userId: string) => Promise<string | null>;
};

export function createGetAccountHandler(
  deps: GetAccountDeps,
): (request: Request) => Promise<Response> {
  return async function handleGetAccount(_request: Request) {
    const session = await deps.getSession();
    if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });

    const user = await deps.getUser(session.userId);
    if (!user) return Response.json({ error: "not_found" }, { status: 404 });

    const sellerId = await deps.getSellerIdForUser(session.userId);

    return Response.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      seller: sellerId ? { id: sellerId } : null,
    });
  };
}

export const GET = instrumented(
  createGetAccountHandler({
    getSession,
    getUser: (userId) => getCommerce().users.getUser(userId),
    getSellerIdForUser: (userId) => getCommerce().users.getSellerIdForUser(userId),
  }),
);
