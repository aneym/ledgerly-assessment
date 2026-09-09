// Browser-safe half of the demo profiles: names, the switch URL and its destination check.
// No Node imports, so the tour bar and the dev panel can build switch links; the server
// half (demo-profiles.ts) re-exports these and adds the credential derivation.

export const DEMO_PROFILES = ["buyer", "seller", "operator"] as const;
export type DemoProfile = (typeof DEMO_PROFILES)[number];

export const PROFILE_LABEL: Record<DemoProfile, string> = {
  buyer: "Buyer",
  seller: "Seller",
  operator: "Operator",
};

export function isDemoProfile(value: string | null | undefined): value is DemoProfile {
  return value === "buyer" || value === "seller" || value === "operator";
}

/** Only same-origin paths may follow a switch. */
export function safeProfileNext(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  return /^\/(?![/\\])/.test(candidate) ? candidate : null;
}

/** The switch link for a profile, with an optional same-origin destination. */
export function profileUrl(profile: DemoProfile, next?: string | null): string {
  const safe = safeProfileNext(next);
  return `/demo/profile/${profile}${safe ? `?next=${encodeURIComponent(safe)}` : ""}`;
}
