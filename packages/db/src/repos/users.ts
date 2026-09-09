import { asc, eq } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { sellerOwners, user } from "../schema";
import type { Database } from "./orders";

export type Role = "buyer" | "seller" | "operator";

export type UserProfile = { id: string; email: string; name: string; role: Role };

// Role and seller-ownership queries against the Better Auth `user` table and
// the `seller_owners` mapping table. Neither is a core domain concept, so
// this stays in packages/db rather than behind a core port: it exists only
// to answer "what can this signed-in user do", which is an app-layer
// question, not a business rule.
export interface UsersRepo {
  getRole(userId: string): Promise<Role | null>;
  // The signed-in user's own profile, for GET /api/account. A thin read of the Better Auth
  // `user` table - no password/session fields, only what the account page shows.
  getUser(userId: string): Promise<UserProfile | null>;
  // Server-only promotion. Called when a signed-in buyer creates their first
  // seller record; Better Auth's client can never set this field itself
  // (see apps/web/src/lib/auth.ts's `input: false` on the role field).
  setRole(userId: string, role: Role): Promise<void>;
  // A seller has exactly one owner, fixed at creation; re-attaching the same
  // seller is a no-op so retries of seller creation stay idempotent here too.
  attachSellerOwner(sellerId: string, userId: string): Promise<void>;
  getSellerOwner(sellerId: string): Promise<string | null>;
  // Reverse of getSellerOwner: which seller (if any) this user owns, for GET
  // /api/sellers/me. seller_owners.user_id carries no unique constraint - only
  // seller_id (the owned side) does - so a user could in principle own more than one
  // seller. Nothing in this round builds multi-seller support, so this resolves to the
  // first-created match when more than one exists; a judgment call, flagged in the
  // final report.
  getSellerIdForUser(userId: string): Promise<string | null>;
}

export function createUsersRepo<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
): UsersRepo {
  return {
    async getRole(userId) {
      const rows = await db.select({ role: user.role }).from(user).where(eq(user.id, userId));
      return rows[0]?.role ?? null;
    },
    async getUser(userId) {
      const rows = await db
        .select({ id: user.id, email: user.email, name: user.name, role: user.role })
        .from(user)
        .where(eq(user.id, userId));
      return rows[0] ?? null;
    },
    async setRole(userId, role) {
      await db.update(user).set({ role }).where(eq(user.id, userId));
    },
    async attachSellerOwner(sellerId, userId) {
      await db
        .insert(sellerOwners)
        .values({ sellerId, userId })
        .onConflictDoNothing({ target: sellerOwners.sellerId });
    },
    async getSellerOwner(sellerId) {
      const rows = await db
        .select({ userId: sellerOwners.userId })
        .from(sellerOwners)
        .where(eq(sellerOwners.sellerId, sellerId));
      return rows[0]?.userId ?? null;
    },
    async getSellerIdForUser(userId) {
      const rows = await db
        .select({ sellerId: sellerOwners.sellerId })
        .from(sellerOwners)
        .where(eq(sellerOwners.userId, userId))
        .orderBy(asc(sellerOwners.createdAt))
        .limit(1);
      return rows[0]?.sellerId ?? null;
    },
  };
}
