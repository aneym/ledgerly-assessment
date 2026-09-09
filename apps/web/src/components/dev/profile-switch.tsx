import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { DEMO_PROFILES, PROFILE_LABEL, profileUrl } from "@/lib/demo-profile-url";
import { demoProfilesEnabled, parseProfileEmail } from "@/lib/demo-profiles";

/**
 * Profile switcher for the sandbox demonstration: Buyer, Seller, Operator as plain links
 * to /demo/profile/<role>, which mints the session server-side. Rendered by DevPanelMount
 * only when the deployment enables demo profiles; the current profile is read from the
 * session's email, never from anything the browser can set.
 */
export async function ProfileSwitch({ next }: { next: string | null }) {
  if (!demoProfilesEnabled()) return null;
  let current: string | null = null;
  try {
    const session = await getAuth().api.getSession({ headers: await headers() });
    current = parseProfileEmail(session?.user.email)?.profile ?? null;
  } catch {
    current = null;
  }
  return (
    <nav className="dp-switch" aria-label="Demo profile" data-demo-profile={current ?? "none"}>
      <span className="dp-switch-label">Viewing as</span>
      {DEMO_PROFILES.map((profile) => (
        <a
          key={profile}
          className={`dp-switch-link${current === profile ? " is-current" : ""}`}
          href={profileUrl(profile, next)}
          aria-current={current === profile ? "true" : undefined}
          data-profile-switch={profile}
        >
          {PROFILE_LABEL[profile]}
        </a>
      ))}
    </nav>
  );
}
