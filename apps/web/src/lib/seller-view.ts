// Shared serialization for the seller-facing JSON shapes the marketplace pages are coded
// against (team-lead's JSON-shapes addendum): provenance derivation, the hand-rolled
// capabilities/verification parsing that stands in for packages/whop/src/capabilities.ts's
// zod-based reader (apps/web carries no zod dependency, and that reader is scoped to one
// fixed platform account rather than an arbitrary seller account), and the seller response
// body itself.

import type { ProviderSource, Seller } from "@ledgerly/core";

// --- provenance ---
//
// "Map provenance from the adapter result's meta.source when present (the hybrid adapter
// adds it), else from WHOP_MODE." A hybrid adapter attaches `meta.source` to a successful
// WhopResult; the plain WhopPort return type doesn't declare it, so callers pass it through
// defensively rather than this module reaching into the result itself.
export function provenanceOf(
  // Not Pick<NodeJS.ProcessEnv, "WHOP_MODE">: process.env's type is only an index signature
  // (Dict<string>), which TS does not treat as structurally having a named WHOP_MODE
  // property, so passing process.env straight into a Pick-typed parameter fails to compile.
  // A plain optional-property type is what process.env (and every test's plain object) can
  // actually satisfy.
  env: { WHOP_MODE?: string },
  meta?: { source?: ProviderSource },
): ProviderSource {
  if (meta?.source) return meta.source;
  // Hybrid talks to the real sandbox for every non-gated operation, and a signed webhook
  // delivery always comes from the sandbox, so only mock mode is labelled mock. This matches
  // commerce.ts's defaultProvenanceFor.
  return env.WHOP_MODE === "sandbox" || env.WHOP_MODE === "hybrid" ? "sandbox" : "mock";
}

// --- capabilities / required_actions, parsed off WhopAccount.raw ---

export type CapabilityStatus = "active" | "inactive";
type RawAccount = {
  capabilities?: Record<string, CapabilityStatus>;
  required_actions?: Array<{ action?: unknown }>;
};

export function parseAccountRaw(raw: unknown): {
  capabilities: Record<string, CapabilityStatus>;
  requiredActions: string[];
} {
  if (typeof raw !== "object" || raw === null) return { capabilities: {}, requiredActions: [] };
  const value = raw as RawAccount;
  const capabilities: Record<string, CapabilityStatus> = {};
  if (value.capabilities && typeof value.capabilities === "object") {
    for (const [key, status] of Object.entries(value.capabilities)) {
      if (status === "active" || status === "inactive") capabilities[key] = status;
    }
  }
  const requiredActions = Array.isArray(value.required_actions)
    ? value.required_actions
        .map((entry) => (entry && typeof entry.action === "string" ? entry.action : null))
        .filter((action): action is string => action !== null)
    : [];
  return { capabilities, requiredActions };
}

// "Capabilities map: payments from accept_card_payments, transfers from transfer, payouts
// from standard_payout; 'pending' when the account has a required_action for that
// capability." An account with no raw capabilities payload at all (mock mode, or a seller
// that has never been read back from the provider) reports every capability inactive
// rather than pending, since there is no required_action signal either.
export type Capabilities = {
  payments: "active" | "inactive" | "pending";
  transfers: "active" | "inactive" | "pending";
  payouts: "active" | "inactive" | "pending";
};

const CAPABILITY_KEYS = {
  payments: "accept_card_payments",
  transfers: "transfer",
  payouts: "standard_payout",
} as const;

export function deriveCapabilities(
  capabilities: Record<string, CapabilityStatus>,
  requiredActions: string[],
): Capabilities {
  const result = {} as Capabilities;
  for (const [field, rawKey] of Object.entries(CAPABILITY_KEYS) as Array<
    [keyof Capabilities, string]
  >) {
    if (capabilities[rawKey] === "active") result[field] = "active";
    else if (requiredActions.includes(rawKey)) result[field] = "pending";
    else result[field] = "inactive";
  }
  return result;
}

// --- verification ---
//
// No prior vocabulary exists for this field anywhere in the codebase; this is a judgment
// call, not a pre-existing contract. A seller with no Whop account at all cannot be
// verifying anything yet ("unverified"); once attached, "verify_identity" showing up in
// required_actions means Whop is still waiting on it ("pending"); otherwise treat identity
// as settled ("verified"). Flagged for team-lead in the completion report.
export type Verification = "unverified" | "pending" | "verified";

export function deriveVerification(
  whopAccountId: string | null,
  requiredActions: string[],
): Verification {
  if (!whopAccountId) return "unverified";
  if (requiredActions.includes("verify_identity")) return "pending";
  return "verified";
}

// --- seller response body ---
//
// Top-level, unwrapped: "the marketplace pages are coded against these exact response
// shapes" reads as the parsed JSON body itself, not a body nested under a `seller` key (the
// old routes' shape). `name` prefers the schema's `sellers.display_name` column (the
// admin-ledger lane's additive column, read via packages/db's createSellerDisplayNameRepo
// since packages/core's Seller type does not expose it) and falls back to externalId when
// no display name has been set.
export type SerializeSellerOptions = {
  // string mints a fresh link; null records that onboarding otherwise succeeded but the
  // link step itself failed (the partial-onboarding-recovery response); omitted entirely
  // when the route has no onboarding link to report at all (plain GET).
  onboardingUrl?: string | null;
  displayName?: string | null;
  // Set only for the partial-onboarding-recovery response (account created, onboarding
  // link mint failed): the seller is still returned with a real 201, but the caller needs
  // to know the link step did not complete.
  error?: { stage: "onboarding_link"; status?: number; whop_error_code?: string; message?: string };
};

export function serializeSeller(
  seller: Seller,
  raw: unknown,
  // Widened past ProviderSource ("sandbox" | "mock") for POST /api/sellers/{id}/policy and
  // /suspend: both are pure local writes that never read Whop, so "app" reports the seller
  // row's own decision rather than a provider readback's provenance.
  provenance: ProviderSource | "app",
  options: SerializeSellerOptions = {},
) {
  const { capabilities, requiredActions } = parseAccountRaw(raw);
  return {
    id: seller.id,
    name: options.displayName ?? seller.externalId,
    country: seller.country,
    sale_policy: seller.salePolicy,
    status: seller.status,
    whop_account_id: seller.whopAccountId,
    verification: deriveVerification(seller.whopAccountId, requiredActions),
    required_actions: requiredActions,
    capabilities: deriveCapabilities(capabilities, requiredActions),
    provenance,
    ...(options.onboardingUrl !== undefined
      ? { onboarding_url: options.onboardingUrl, onboardingUrl: options.onboardingUrl }
      : {}),
    ...(options.error !== undefined ? { error: options.error } : {}),
    // Compatibility envelope for callers written against the first response shape (the
    // marketplace SellForm reads `seller.id`, the QA journeys read `seller.whopAccountId`
    // and `account.id`). The flat fields above are the contract; these duplicate them.
    seller: {
      id: seller.id,
      externalId: seller.externalId,
      country: seller.country,
      whopAccountId: seller.whopAccountId,
      displayName: options.displayName ?? null,
    },
    account: accountIdOf(raw) === null ? null : { id: accountIdOf(raw) },
  };
}
function accountIdOf(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

// --- Whop provider HTTP error body ---
//
// Confirmed shape from a real captured sandbox response (packages/whop/fixtures/*.json,
// e.g. create-checkout-legacy.json): `{ error: { type: "bad_request", message: "..." } }`.
// WhopHttpError.body (packages/whop/src/client.ts) and the port-level WhopError.body
// (packages/core/src/ports/whop-types.ts) both carry this same raw JSON on an http-kind
// error, so this one parser covers both.
export function parseWhopErrorBody(body: unknown): { code?: string; message?: string } {
  if (typeof body !== "object" || body === null) return {};
  const outer = body as { error?: unknown };
  if (typeof outer.error !== "object" || outer.error === null) return {};
  const inner = outer.error as { type?: unknown; message?: unknown };
  return {
    ...(typeof inner.type === "string" ? { code: inner.type } : {}),
    ...(typeof inner.message === "string" ? { message: inner.message } : {}),
  };
}
