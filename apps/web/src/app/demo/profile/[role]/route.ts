// GET /demo/profile/<buyer|seller|operator>?next=<path>: switches the browser to one of the
// run's fictional demo profiles without a password form. The account is minted on first use
// through Better Auth's server API (sign-in, else sign-up), the password is derived from
// BETTER_AUTH_SECRET and never stored or sent, and the browser receives only the session
// cookie Better Auth sets plus the run cookie when the browser had none. 404 unless the
// deployment sets DEMO_MODE=1 and DEMO_PROFILES_ENABLED=1 (lib/demo-profiles.ts).
import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { getCommerce } from "@/lib/commerce";
import { PROFILE_BINDING_COOKIE, profileBinding } from "@/lib/demo-profile-binding";
import {
  type DemoProfile,
  demoProfilesEnabled,
  isDemoProfile,
  mintRunId,
  profileEmail,
  profileHome,
  profileName,
  profilePassword,
  safeProfileNext,
} from "@/lib/demo-profiles";
import { requestedDemoRuns } from "@/lib/demo-scope";
import { ownedSeller } from "@/lib/seller/owned";
import { getSession, type Session } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUN_COOKIE = "ledgerly_demo_run";
const RUN_COOKIE_ATTRIBUTES = "Path=/; SameSite=Lax; HttpOnly";

export type ProfileAuthCall = (input: {
  email: string;
  password: string;
  name: string;
  headers: Headers;
}) => Promise<Response>;

export type ProfileSessionDeps = {
  enabled: () => boolean;
  getSession: () => Promise<Session | null>;
  secret: () => string;
  signIn: ProfileAuthCall;
  signUp: ProfileAuthCall;
  /** Gives the seller profile its stored seller role. Idempotent. */
  setSellerRole: (userId: string) => Promise<void>;
  ownsSeller: (userId: string) => Promise<boolean>;
  mintRun?: () => string;
};

function noStore(status: number, body: string | null = null): Response {
  return new Response(body, { status, headers: { "cache-control": "no-store" } });
}

async function userIdFrom(response: Response): Promise<string | null> {
  try {
    const parsed = (await response.clone().json()) as { user?: { id?: unknown } } | null;
    const id = parsed?.user?.id;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

function setCookies(from: Response): string[] {
  return typeof from.headers.getSetCookie === "function"
    ? from.headers.getSetCookie()
    : [from.headers.get("set-cookie") ?? ""].filter(Boolean);
}

export function profileSessionHandler(deps: ProfileSessionDeps) {
  return async (
    req: Request,
    context: { params: Promise<{ role: string }> },
  ): Promise<Response> => {
    if (!deps.enabled()) return noStore(404);
    const { role } = await context.params;
    if (!isDemoProfile(role)) return noStore(404);
    const profile: DemoProfile = role;

    const session = await deps.getSession();
    const existingRun = session?.demoRunId;
    const url = new URL(req.url);
    const explicitRuns = [...url.searchParams.getAll("run"), ...url.searchParams.getAll("run_id")];
    const headerRun = req.headers.get("x-demo-run");
    if (headerRun !== null) explicitRuns.push(headerRun);
    // Expired and signed-out sessions leave a run cookie behind. Start a new run;
    // only an authenticated profile may resume a run or explicitly request one.
    const requested = existingRun ? requestedDemoRuns(req) : [];
    if (!requested || [...requested, ...explicitRuns].some((run) => run !== existingRun))
      return noStore(403, "Demo run does not belong to this session.");
    const run = existingRun ?? (deps.mintRun ?? mintRunId)();
    const email = profileEmail(profile, run);
    const name = profileName(profile);
    const password = profilePassword(profile, run, deps.secret());
    const call = { email, password, name, headers: req.headers };

    let signed: Response;
    try {
      signed = await deps.signIn(call);
      if (!signed.ok) signed = await deps.signUp(call);
    } catch {
      return noStore(503, `Could not prepare the ${profile} profile.`);
    }
    if (!signed.ok) return noStore(503, `Could not prepare the ${profile} profile.`);
    const userId = await userIdFrom(signed);
    if (!userId) return noStore(503, `Could not prepare the ${profile} profile.`);
    if (profile === "seller") await deps.setSellerRole(userId);

    const destination =
      safeProfileNext(url.searchParams.get("next")) ??
      profileHome(profile, profile === "seller" ? await deps.ownsSeller(userId) : false);

    const out = new Headers({ "cache-control": "no-store", location: destination });
    for (const cookie of setCookies(signed)) out.append("set-cookie", cookie);
    out.append(
      "set-cookie",
      `${PROFILE_BINDING_COOKIE}=${profileBinding(userId, run, deps.secret())}; ${RUN_COOKIE_ATTRIBUTES}${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`,
    );
    if (requested.length === 0) {
      out.append(
        "set-cookie",
        `${RUN_COOKIE}=${encodeURIComponent(run)}; ${RUN_COOKIE_ATTRIBUTES}`,
      );
    }
    return new Response(null, { status: 303, headers: out });
  };
}

export const GET = profileSessionHandler({
  enabled: () => demoProfilesEnabled(),
  getSession,
  secret: () => process.env.BETTER_AUTH_SECRET ?? "",
  signIn: async ({ email, password }) =>
    getAuth().api.signInEmail({
      body: { email, password },
      headers: await headers(),
      asResponse: true,
    }),
  signUp: async ({ email, password, name }) =>
    getAuth().api.signUpEmail({
      body: { email, password, name },
      headers: await headers(),
      asResponse: true,
    }),
  setSellerRole: (userId) => getCommerce().users.setRole(userId, "seller"),
  ownsSeller: async (userId) => (await ownedSeller(userId)) !== null,
});
