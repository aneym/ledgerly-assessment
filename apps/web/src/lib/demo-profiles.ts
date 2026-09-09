// Demo profiles: automatic sample-profile access for the sandbox demonstration (Alex,
// 2026-09-08). Every demo run (the ledgerly_demo_run cookie) owns three fictional accounts,
// one per profile, minted on first use by /demo/profile/<role>. Nobody types a password:
// the server derives each account's password from BETTER_AUTH_SECRET and the run, signs in
// through Better Auth's own API and forwards the session cookie. The operator profile is
// the restricted `demo` role from lib/session.ts, so it only reaches records of its own run.
// Server only (node:crypto); the browser-safe part lives in demo-profile-url.ts.
import { createHmac, randomBytes } from "node:crypto";
import users from "../../../../fixtures/demo/test-users.json";
import { type DemoProfile, isDemoProfile } from "./demo-profile-url";

export {
  DEMO_PROFILES,
  type DemoProfile,
  isDemoProfile,
  PROFILE_LABEL,
  profileUrl,
  safeProfileNext,
} from "./demo-profile-url";

export const DEMO_PROFILE_DOMAIN = "ledgerly.test";
const RUN_PATTERN = /^run_[A-Za-z0-9]{1,32}$/;
const EMAIL_PATTERN = /^demo-(buyer|seller|operator)\+(run_[A-Za-z0-9]{1,32})@ledgerly\.test$/i;

/** Profiles are on only where the deployment says so; the flag never reaches the browser. */
export function demoProfilesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEMO_MODE === "1" && env.DEMO_PROFILES_ENABLED === "1";
}

export function isValidRunId(run: string | null | undefined): run is string {
  return typeof run === "string" && RUN_PATTERN.test(run);
}

/** run_<16 hex>, the same shape seat/demo-scope accepts as an operator scope. */
export function mintRunId(): string {
  return `run_${randomBytes(8).toString("hex")}`;
}

export function profileEmail(profile: DemoProfile, run: string): string {
  return `demo-${profile}+${run}@${DEMO_PROFILE_DOMAIN}`;
}

export function profileName(profile: DemoProfile): string {
  return users[profile].name;
}

/**
 * The account password for one profile of one run. Deterministic so a later switch finds
 * the same account, secret-keyed so nothing outside this server can compute it, and never
 * stored anywhere: Better Auth only keeps its hash.
 */
export function profilePassword(profile: DemoProfile, run: string, secret: string): string {
  if (!secret) throw new Error("Missing BETTER_AUTH_SECRET");
  return createHmac("sha256", secret).update(`demo-profile:${run}:${profile}`).digest("base64url");
}

/** Which profile and run a designated demo email belongs to, or null for any other email. */
export function parseProfileEmail(
  email: string | null | undefined,
): { profile: DemoProfile; run: string } | null {
  if (!email) return null;
  const match = EMAIL_PATTERN.exec(email);
  if (!match) return null;
  const profile = match[1]?.toLowerCase();
  return isDemoProfile(profile) ? { profile, run: match[2] as string } : null;
}

/**
 * Runtime role for a signed-in demo profile, read at session time like the sample persona.
 * The operator profile never holds the stored operator role: it is the run-scoped `demo`
 * role, so admin reads and writes stay inside its run. Buyer and seller keep their stored
 * roles, which already limit them to their own records.
 */
export function profileRoleFor(email: string | null | undefined): "demo" | null {
  const parsed = parseProfileEmail(email);
  return parsed?.profile === "operator" ? "demo" : null;
}

/** Where a profile lands after a switch when the caller named no destination. */
export function profileHome(profile: DemoProfile, ownsSeller: boolean): string {
  if (profile === "buyer") return "/browse";
  if (profile === "seller") return ownsSeller ? "/sell/products" : "/sell";
  return "/admin/sellers";
}
