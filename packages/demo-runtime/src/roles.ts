import type { Role } from "./contract";

/**
 * Server-side principal. It comes from the authenticated session, never from
 * the demo role selector. The demo role is a view; this is the authority.
 */
export interface ServerPrincipal {
  session_id: string;
  /** Local seller mapping ids this principal may act for. */
  seller_ids: string[];
  /** Explicit server-granted permissions. */
  permissions: string[];
}

export interface AuthDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Authorization ignores the demo role on purpose. A caller-provided role or
 * seller id is not authorization; only the principal's own grants count.
 */
export function authorize(
  principal: ServerPrincipal | null,
  action: string,
  seller_id: string | null,
  _demoRole?: Role,
): AuthDecision {
  if (!principal) return { allowed: false, reason: "no authenticated session" };
  if (!principal.permissions.includes(action))
    return { allowed: false, reason: `session lacks ${action}` };
  if (seller_id && !principal.seller_ids.includes(seller_id))
    return { allowed: false, reason: `session is not mapped to ${seller_id}` };
  return { allowed: true, reason: "granted by session" };
}

/** Screens each demo role can see in the walkthrough. Presentation only. */
export const ROLE_VIEWS: Record<Role, string[]> = {
  buyer: ["catalog", "product", "checkout", "receipt"],
  creator: ["dashboard", "onboarding", "payouts", "sales"],
  admin: ["sellers", "ledger", "webhooks", "reconciliation", "incidents"],
};
