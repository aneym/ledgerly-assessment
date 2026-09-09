// POST /api/sellers: a signed-in user creates (or re-fetches) their seller record and
// gets back a Whop onboarding link, in one call to the existing onboarding service.
// The route only wraps that service with authentication, request parsing and the
// buyer-to-seller role promotion; the onboarding logic itself (idempotent create,
// account creation, link minting) lives in packages/core/src/services/onboarding.ts,
// out of this round's scope.
import {
  type Country,
  sellerId as parseSellerId,
  runId,
  type Seller,
  type SellerId,
  type WhopPort,
} from "@ledgerly/core";
import { type DemoScopedSession, demoScopeFor, ownDemoRun, sellerInScope } from "@/lib/demo-scope";
// onboarding.ts is forbidden and not exported from core's barrel, so this stays a relative,
// type-only import (the same exception noted for onboarding-link/route.ts below).
import type { createOnboardingService } from "../../../../../../packages/core/src/services/onboarding";
import { getCommerce } from "../../../lib/commerce";
import { instrumented, runIdFromRequest } from "../../../lib/instrument";
import { extractProviderError } from "../../../lib/provider-error";
import { provenanceOf, serializeSeller } from "../../../lib/seller-view";
import { getServer } from "../../../lib/server";
import { getSession } from "../../../lib/session";

export const runtime = "nodejs";

const COUNTRIES = new Set<Country>(["US", "DE", "BR", "CA", "KR", "PT"]);

type CreateSellerBody = {
  externalId: string;
  email: string;
  country: Country;
  // Accepted for forward compatibility with the request shape in the task brief, but not
  // yet wired anywhere: onboarding.ts always sends the seller's own externalId as the
  // Whop account title (see its `title: seller.externalId` request field), which this
  // round does not have ownership to change. A future round that wants a client-supplied
  // title needs to add a `title` parameter to OnboardInput.
  title?: string;
  // The response's own `name` field (JSON-shapes addendum), stored in sellers.display_name
  // (an admin-ledger addition, see packages/db's createSellerDisplayNameRepo). Not sent to
  // Whop at all — that's the `title` field above, still not wired per the note there.
  displayName?: string;
};

// Accepts both the contract's snake_case shape and whatever field names the marketplace
// /sell form happens to submit (team-lead's addendum names external_id/externalId, email,
// country, name/title, and an optional display_name explicitly — the (sellstart)/sell page
// itself is not present in this checkout to read directly, so this goes by that list). On
// failure, the offending field names are returned so the form can highlight them instead of
// showing one bare "invalid_body".
function firstString(body: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = body[key];
    if (typeof raw === "string" && raw.trim()) return raw;
  }
  return undefined;
}

function parseBody(
  value: unknown,
): { ok: true; value: CreateSellerBody } | { ok: false; fields: string[] } {
  if (typeof value !== "object" || value === null) return { ok: false, fields: ["body"] };
  const body = value as Record<string, unknown>;
  const fields: string[] = [];

  const externalId = firstString(body, ["external_id", "externalId"]);
  if (!externalId) fields.push("external_id");

  const email = firstString(body, ["email"]);
  if (!email) fields.push("email");

  const countryRaw = firstString(body, ["country"]);
  const country =
    countryRaw && COUNTRIES.has(countryRaw as Country) ? (countryRaw as Country) : undefined;
  if (!country) fields.push("country");

  if (fields.length > 0) return { ok: false, fields };

  const title = firstString(body, ["name", "title"]);
  const displayName = firstString(body, ["display_name", "displayName"]) ?? title;

  return {
    ok: true,
    value: {
      externalId: externalId as string,
      email: email as string,
      country: country as Country,
      ...(title !== undefined ? { title } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    },
  };
}

export type CreateSellerDeps = {
  getSession: () => Promise<(DemoScopedSession & { userId: string }) | null>;
  onboardSeller: ReturnType<typeof createOnboardingService>;
  attachSellerOwner: (sellerId: string, userId: string) => Promise<void>;
  setRole: (userId: string, role: "seller") => Promise<void>;
  // The run this deployment scopes new sellers and their ledgers under. See
  // apps/web/src/lib/commerce.ts's module comment and the final report: no existing env
  // var carries this, so RUN_ID is a new one this round introduces.
  /** Run the new seller belongs to; the request is passed so a demo run can own its rows. */
  runId: (request: Request) => string;
  // onboarding.ts's own Seller (ports.ts) has no salePolicy/status, and its WhopLink
  // discards the account's raw payload and any meta — both are re-read here, straight
  // from storage and from a fresh provider call, to build the full response shape.
  getSeller: (id: string) => Promise<Seller | null>;
  getAccount: WhopPort["getAccount"];
  // Not Pick<NodeJS.ProcessEnv, "WHOP_MODE">: process.env only carries an index signature,
  // which TS does not accept as satisfying a Pick'd named property (see seller-view.ts's
  // provenanceOf for the full explanation).
  env: { WHOP_MODE?: string };
  // Partial-onboarding recovery: onboarding.ts commits the seller's whopAccountId to the
  // db (r.sellers.attach) before the onboarding-link call that can still fail, so a failed
  // onboardSeller() result does not necessarily mean nothing was created. Looked up by the
  // same identity (runId + externalId) the request itself carries, since a failure result
  // has no seller attached to it.
  getSellerByIdentity: (runId: string, externalId: string) => Promise<Seller | null>;
  getDisplayName: (id: string) => Promise<string | null>;
  setDisplayName: (id: string, displayName: string) => Promise<void>;
};

export function createCreateSellerHandler(
  deps: CreateSellerDeps,
): (request: Request) => Promise<Response> {
  return async function handleCreateSeller(request: Request): Promise<Response> {
    const session = await deps.getSession();
    if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });
    const scopedDemo =
      session.role !== "operator" && (session.role === "demo" || session.demoRunId !== undefined);
    const ownedRun = scopedDemo ? ownDemoRun(session, request) : null;
    if (scopedDemo && !ownedRun) return Response.json({ error: "demo_scope" }, { status: 403 });

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const parsed = parseBody(json);
    if (!parsed.ok)
      return Response.json({ error: "invalid_body", fields: parsed.fields }, { status: 400 });
    const body = parsed.value;

    const run = runId(ownedRun ?? deps.runId(request));
    if (!run.ok) throw new Error("Invalid configured RUN_ID");

    const result = await deps.onboardSeller({
      runId: run.value,
      externalId: body.externalId,
      email: body.email,
      country: body.country,
    });

    if (!result.ok) {
      const recovered = await deps.getSellerByIdentity(run.value, body.externalId);
      if (recovered?.whopAccountId) {
        // The account exists and is attached; only the onboarding-link mint failed. Finish
        // the same owner/role/display-name side effects a full success would have done and
        // answer 201, never a bare 502, per the partial-onboarding-recovery addendum.
        await deps.attachSellerOwner(recovered.id, session.userId);
        if (session.role === "buyer") await deps.setRole(session.userId, "seller");
        if (body.displayName) await deps.setDisplayName(recovered.id, body.displayName);
        const displayName = body.displayName ?? (await deps.getDisplayName(recovered.id));

        let raw: unknown = null;
        let meta: { source?: "sandbox" | "mock" } | undefined;
        const read = await deps.getAccount(
          recovered.whopAccountId,
          `seller-create-recover:${recovered.id}`,
        );
        if (read.ok) {
          raw = read.value.raw;
          meta = (read.value as { meta?: { source?: "sandbox" | "mock" } }).meta;
        }

        return Response.json(
          serializeSeller(recovered, raw, provenanceOf(deps.env, meta), {
            onboardingUrl: null,
            displayName,
            error: { stage: "onboarding_link", ...extractProviderError(result.error) },
          }),
          { status: 201 },
        );
      }

      const kind = result.error.kind;
      if (kind === "http")
        return Response.json(
          { error: "provider_http", ...extractProviderError(result.error) },
          { status: 502 },
        );
      const status =
        kind === "invalid_identity" || kind === "identity_conflict"
          ? 409
          : kind === "invalid_request"
            ? 400
            : kind === "not_found"
              ? 404
              : 502;
      return Response.json({ error: kind }, { status });
    }

    await deps.attachSellerOwner(result.value.seller.id, session.userId);
    if (session.role === "buyer") await deps.setRole(session.userId, "seller");
    if (body.displayName) await deps.setDisplayName(result.value.seller.id, body.displayName);

    // Re-read the full domain Seller (for salePolicy/status, which onboarding.ts's own
    // narrower Seller doesn't carry) and the account's raw payload (for capabilities),
    // rather than trusting the onboarding result's own Seller/WhopLink, which have neither.
    const seller = await deps.getSeller(result.value.seller.id);
    if (!seller) throw new Error("Seller disappeared immediately after onboarding");
    let raw: unknown = null;
    let meta: { source?: "sandbox" | "mock" } | undefined;
    if (seller.whopAccountId) {
      const read = await deps.getAccount(seller.whopAccountId, `seller-create-read:${seller.id}`);
      if (read.ok) {
        raw = read.value.raw;
        meta = (read.value as { meta?: { source?: "sandbox" | "mock" } }).meta;
      }
    }
    const displayName = body.displayName ?? (await deps.getDisplayName(seller.id));

    return Response.json(
      serializeSeller(seller, raw, provenanceOf(deps.env, meta), {
        onboardingUrl: result.value.onboardingUrl,
        displayName,
      }),
      { status: 201 },
    );
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

// Every dependency below calls getServer()/getCommerce() lazily, at request time, the same
// way the existing whop webhook route does — not at module load, when env vars needed to
// construct them may not be set yet (a build, or a test that imports this module only for
// its exported handler factory).
export const POST = instrumented(
  createCreateSellerHandler({
    getSession,
    onboardSeller: (input) => getServer().onboardSeller(input),
    attachSellerOwner: (sellerId, userId) =>
      getCommerce().users.attachSellerOwner(sellerId, userId),
    setRole: (userId, role) => getCommerce().users.setRole(userId, role),
    // Per-run isolation for the guided demo: sellers created inside a demo run carry that run's
    // id (from the run cookie the tour sets), so each take gets its own rows and a fresh take
    // never collides with the previous one. Outside a demo run, the configured RUN_ID.
    runId: (request) => demoRunIdFor(request) ?? required(process.env, "RUN_ID"),
    async getSeller(id) {
      const parsed = parseSellerId(id);
      if (!parsed.ok) return null;
      return getCommerce().sellers.get(parsed.value);
    },
    getAccount: (accountId, key) => getCommerce().provider.getAccount(accountId, key),
    // Not `env: process.env` directly: Next.js's own next/types/global.d.ts merges a
    // `readonly NODE_ENV` member into NodeJS.ProcessEnv, which makes the whole interface a
    // "weak type" TS refuses to assign to any narrower WHOP_MODE-only type (they end up with
    // no declared property in common — the shared index signature doesn't count for that
    // check). Reading just WHOP_MODE off it up front sidesteps the issue entirely.
    env: { WHOP_MODE: process.env.WHOP_MODE },
    getSellerByIdentity: (runIdArg, externalId) =>
      getCommerce().sellerIdentity.getByIdentity(runIdArg, externalId),
    getDisplayName: (id) => getCommerce().sellerDisplayNames.get(id),
    setDisplayName: (id, displayName) => getCommerce().sellerDisplayNames.set(id, displayName),
  }),
);

// GET /api/sellers: the seller list the admin ledger picker and sellers page read. An
// operator sees every seller, newest first, cursor-paged; a seller session sees only the
// seller it owns; a buyer gets 403. Rows are serialized from the local row alone (no live
// account readback per row, so capabilities read inactive and verification comes from the
// local account link); GET /api/sellers/{id} is the per-seller live view.
export type ListSellersDeps = {
  getSession: () => Promise<(DemoScopedSession & { userId: string }) | null>;
  listSellers: (opts: { limit: number; cursor?: string | null }) => Promise<{
    sellers: { seller: Seller; displayName: string | null }[];
    nextCursor: string | null;
  }>;
  getSellerIdForUser: (userId: string) => Promise<string | null>;
  getSeller: (id: SellerId) => Promise<Seller | null>;
  getDisplayName: (id: string) => Promise<string | null>;
  env: { WHOP_MODE?: string };
};
const LIST_DEFAULT_LIMIT = 50;
export function createListSellersHandler(deps: ListSellersDeps) {
  return async function handleListSellers(request: Request): Promise<Response> {
    const session = await deps.getSession();
    if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });
    const provenance = provenanceOf(deps.env);
    if (session.role === "seller") {
      const ownId = await deps.getSellerIdForUser(session.userId);
      const parsed = ownId ? parseSellerId(ownId) : null;
      const seller = parsed?.ok ? await deps.getSeller(parsed.value) : null;
      if (!seller) return Response.json({ sellers: [], next_cursor: null });
      const displayName = await deps.getDisplayName(seller.id);
      return Response.json({
        sellers: [serializeSeller(seller, null, provenance, { displayName })],
        next_cursor: null,
      });
    }
    const scope = demoScopeFor(session, request);
    if (!scope)
      return Response.json(
        { error: session.role === "demo" ? "demo_scope" : "forbidden" },
        { status: 403 },
      );
    const url = new URL(request.url);
    const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : LIST_DEFAULT_LIMIT;
    const page = await deps.listSellers({ limit, cursor: url.searchParams.get("cursor") });
    return Response.json({
      sellers: page.sellers
        .filter(({ seller }) => sellerInScope(scope, seller))
        .map(({ seller, displayName }) =>
          serializeSeller(seller, null, provenance, { displayName }),
        ),
      next_cursor: page.nextCursor,
    });
  };
}

const handleListSellers = createListSellersHandler({
  getSession,
  listSellers: (opts) => getCommerce().sellerList.list(opts),
  getSellerIdForUser: (userId) => getCommerce().users.getSellerIdForUser(userId),
  getSeller: (id) => getCommerce().sellers.get(id),
  getDisplayName: (id) => getCommerce().sellerDisplayNames.get(id),
  env: { WHOP_MODE: process.env.WHOP_MODE },
});
export const GET = instrumented((request) => handleListSellers(request));

const DEMO_RUN = /^run_[A-Za-z0-9]{1,32}$/;

/** The demo run id on the request, only in demo mode and only in the runtime's own shape. */
export function demoRunIdFor(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.DEMO_MODE !== "1") return undefined;
  const id = runIdFromRequest(request);
  return id && DEMO_RUN.test(id) ? id : undefined;
}
