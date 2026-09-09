import { headers } from "next/headers";
import { getAuth } from "./auth";
import { hasProfileBinding } from "./demo-profile-binding";
import { parseProfileEmail } from "./demo-profiles";
import { demoScopeFor } from "./demo-scope";

export type Role = "buyer" | "seller" | "operator" | "demo";
export type Session = { userId: string; role: Role; demoRunId?: string };

// Real session lookup, backed by Better Auth. Better Auth reads the
// session cookie off the incoming request's headers, so this must run in
// a request context (a route handler or a server component), not at
// module load time.
export async function getSession(): Promise<Session | null> {
  const requestHeaders = await headers();
  const result = await getAuth().api.getSession({ headers: requestHeaders });
  if (!result) return null;
  const profile = process.env.DEMO_MODE === "1" ? parseProfileEmail(result.user.email) : null;
  const demoRunId =
    profile &&
    hasProfileBinding(
      requestHeaders,
      result.user.id,
      profile.run,
      process.env.BETTER_AUTH_SECRET ?? "",
    )
      ? profile.run
      : undefined;
  // A reserved profile email without its issued proof must not fall through as a buyer.
  if (profile && !demoRunId) return null;
  const scope = demoRunId ? { demoRunId } : {};
  const personaEmail = process.env.DEMO_PERSONA_EMAIL?.trim();
  // Legacy shared personas have no per-user run proof and cannot claim one from a cookie.
  if (
    process.env.DEMO_MODE === "1" &&
    ((personaEmail && result.user.email?.toLowerCase() === personaEmail.toLowerCase()) ||
      profile?.profile === "operator")
  )
    return { userId: result.user.id, role: "demo", ...scope };
  const role = result.user.role;
  if (role !== "buyer" && role !== "seller" && role !== "operator") return null;
  return { userId: result.user.id, role, ...scope };
}

export type RoleCheck =
  | { ok: true; session: Session }
  | { ok: false; error: "unauthenticated" | "forbidden" };

// Requires a signed-in user whose role is `role`, or an operator (an
// operator may act as any role). Routes that gate on ownership instead of
// role should call getSession() directly and compare userId themselves.
// Demo sessions satisfy buyer/seller gates. An operator gate must explicitly supply
// the scoped request, then enforce its scope on every target record.
export async function requireRole(role: Role, demoRequest?: Request): Promise<RoleCheck> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (
    session.role !== role &&
    session.role !== "operator" &&
    !(
      session.role === "demo" &&
      (role === "buyer" ||
        role === "seller" ||
        (role === "operator" && demoRequest && demoScopeFor(session, demoRequest) !== null))
    )
  )
    return { ok: false, error: "forbidden" };
  return { ok: true, session };
}
