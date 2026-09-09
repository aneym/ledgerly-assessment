// POST /api/sellers/[id]/onboarding-link: mint a fresh onboarding link for a seller that
// already exists, for the "refresh" control on the onboarding-status screen
// (docs/lanes/marketplace/anchors.md's sell.onboarding.refresh). Re-runs the same
// onboarding service the create route uses: with the seller's own identity fed back in,
// its create-or-fetch step is a no-op read, so this only ever repeats the link step.

import { sellerId as parseSellerId, type Seller } from "@ledgerly/core";
// onboarding.ts is forbidden and not exported from core's barrel, so this stays a relative,
// type-only import.
import type { createOnboardingService } from "../../../../../../../../packages/core/src/services/onboarding";
import type { AuthzDeps } from "../../../../../lib/authz";
import { authorizeSeller } from "../../../../../lib/authz";
import { getCommerce } from "../../../../../lib/commerce";
import { instrumented } from "../../../../../lib/instrument";
import { extractProviderError } from "../../../../../lib/provider-error";
import { provenanceOf } from "../../../../../lib/seller-view";
import { getServer } from "../../../../../lib/server";
import { getSession } from "../../../../../lib/session";

export const runtime = "nodejs";

export type OnboardingLinkDeps = AuthzDeps & {
  getSeller: (id: string) => Promise<Seller | null>;
  onboardSeller: ReturnType<typeof createOnboardingService>;
  // Not Pick<NodeJS.ProcessEnv, "WHOP_MODE">: process.env only carries an index signature,
  // which TS does not accept as satisfying a Pick'd named property (see seller-view.ts's
  // provenanceOf for the full explanation).
  env: { WHOP_MODE?: string };
};

export function createOnboardingLinkHandler(
  deps: OnboardingLinkDeps,
): (request: Request, id: string) => Promise<Response> {
  return async function handleOnboardingLink(_request: Request, id: string) {
    const authz = await authorizeSeller(deps, id);
    if (!authz.ok) return Response.json({ error: "forbidden" }, { status: authz.status });

    const seller = await deps.getSeller(id);
    if (!seller) return Response.json({ error: "not_found" }, { status: 404 });

    const result = await deps.onboardSeller({
      runId: seller.runId,
      externalId: seller.externalId,
      email: seller.email,
      country: seller.country,
    });
    if (!result.ok) {
      const kind = result.error.kind;
      if (kind === "http")
        return Response.json(
          { error: "provider_http", ...extractProviderError(result.error) },
          { status: 502 },
        );
      const status = kind === "invalid_identity" || kind === "identity_conflict" ? 409 : 502;
      return Response.json({ error: kind }, { status });
    }

    // onboarding.ts's WhopLink (packages/core/src/ports/whop-types.ts) discards the
    // provider result's meta and has no expiry field, so provenance falls back to
    // WHOP_MODE and expires_at is always null.
    return Response.json({
      url: result.value.onboardingUrl,
      expires_at: null,
      provenance: provenanceOf(deps.env),
    });
  };
}

const handleOnboardingLink = createOnboardingLinkHandler({
  getSession,
  getSellerOwner: (sellerId) => getCommerce().users.getSellerOwner(sellerId),
  async getSeller(id) {
    const parsed = parseSellerId(id);
    if (!parsed.ok) return null;
    return getCommerce().sellers.get(parsed.value);
  },
  onboardSeller: (input) => getServer().onboardSeller(input),
  // Not `env: process.env` directly: Next.js's own next/types/global.d.ts merges a
  // `readonly NODE_ENV` member into NodeJS.ProcessEnv, which makes the whole interface a
  // "weak type" TS refuses to assign to any narrower WHOP_MODE-only type. Reading just
  // WHOP_MODE off it up front sidesteps the issue.
  env: { WHOP_MODE: process.env.WHOP_MODE },
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return instrumented((req) => handleOnboardingLink(req, id))(request);
}
