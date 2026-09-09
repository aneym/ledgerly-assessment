import { sellerInScope } from "@/lib/demo-scope";
import { getServer } from "@/lib/server";
// POST /api/admin/issues/detect: runs reconcileSeller (via
// packages/core/src/services/resolution.ts's detectResolutionCases) and turns any
// discrepancy it finds into a tracked issue. Body `{ seller_id }` detects for one seller; an
// empty body detects for a bounded, time-rotating batch of sellers, mirroring
// apps/web/src/lib/server.ts's reconcileBounded() (see admin-resolution.ts's detectBounded).
// Provenance is not computed here from adapter internals — packages/core stays
// adapter-oblivious per its own module comment — so both paths pass the configured
// WHOP_MODE as the provenance string, the same convention getAdminResolution().detectBounded
// already uses for the all-sellers path.
//
// Not part of the marketplace issues contract (the addendum only names list/detail/actions/
// demo-fault): this is an internal trigger an operator or a cron calls to populate issues in
// the first place, so it stays under /api/admin/issues/detect rather than disappearing.
// Surfaced as a judgment call, not a silent carry-over — see the final report.
import {
  sellerId as parseSellerId,
  type SellerId,
} from "../../../../../../../../packages/core/src/ids";
import type { Seller } from "../../../../../../../../packages/core/src/services/ports";
import type { ResolutionCase } from "../../../../../../../../packages/core/src/services/resolution";
import { getAdminResolution } from "../../../../../lib/admin-resolution";
import { instrumented } from "../../../../../lib/instrument";
import { getSession } from "../../../../../lib/session";
import { type OperatorAuthzDeps, requireOperator } from "../authz";

export const runtime = "nodejs";

type DetectBody = { sellerId?: string };

function parseBody(value: unknown): DetectBody | null {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.seller_id === undefined) return {};
  if (typeof body.seller_id !== "string" || !body.seller_id.trim()) return null;
  return { sellerId: body.seller_id };
}

type DetectOneResult =
  | { ok: true; value: ResolutionCase[] }
  | { ok: false; error: { kind: string } };
type DetectAllResult = { sellers: number; failed: number; casesDetected: number };

export type DetectIssuesDeps = OperatorAuthzDeps & {
  getSeller?: (id: SellerId) => Promise<Seller | null>;
  listDemoSellers?: (runId: string) => Promise<Seller[]>;
  detectForSeller: (sellerId: SellerId, provenance: string) => Promise<DetectOneResult>;
  detectBounded: () => Promise<DetectAllResult>;
  provenance: () => string;
};

export function createDetectIssuesHandler(
  deps: DetectIssuesDeps,
): (request: Request) => Promise<Response> {
  return async function handleDetectIssues(request: Request): Promise<Response> {
    const authz = await requireOperator(deps, request);
    if (!authz.ok) return Response.json({ error: authz.error }, { status: authz.status });

    let json: unknown;
    try {
      json = request.headers.get("content-length") === "0" ? null : await request.json();
    } catch {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const body = parseBody(json);
    if (!body) return Response.json({ error: "invalid_body" }, { status: 400 });

    if (body.sellerId === undefined) {
      if (authz.scope.kind === "demo") {
        if (!deps.listDemoSellers) return Response.json({ error: "demo_scope" }, { status: 403 });
        const batch = await deps.listDemoSellers(authz.scope.runId);
        let sellers = 0;
        let failed = 0;
        let casesDetected = 0;
        for (const seller of batch) {
          if (!sellerInScope(authz.scope, seller)) continue;
          const result = await deps.detectForSeller(seller.id, deps.provenance());
          sellers++;
          if (!result.ok) failed++;
          else casesDetected += result.value.length;
        }
        return Response.json({ mode: "all_sellers", sellers, failed, casesDetected });
      }
      const result = await deps.detectBounded();
      return Response.json({ mode: "all_sellers", ...result });
    }

    const parsed = parseSellerId(body.sellerId);
    if (!parsed.ok) return Response.json({ error: "invalid_seller_id" }, { status: 400 });

    if (
      authz.scope.kind === "demo" &&
      !sellerInScope(authz.scope, await deps.getSeller?.(parsed.value))
    )
      return Response.json({ error: "demo_scope" }, { status: 403 });
    const result = await deps.detectForSeller(parsed.value, deps.provenance());
    if (!result.ok) {
      const status = result.error.kind === "seller_not_connected" ? 422 : 502;
      return Response.json({ error: result.error.kind }, { status });
    }

    return Response.json({
      mode: "single_seller",
      cases: result.value.map((kase) => ({
        id: kase.id,
        kind: kase.kind,
        status: kase.status,
        providerResourceId: kase.providerResourceId,
        simulated: kase.simulated,
      })),
    });
  };
}

const handleDetectIssues = createDetectIssuesHandler({
  getSession,
  getSeller: (id) => getAdminResolution().getSeller(id),
  listDemoSellers: async (runId) => {
    const rows = await getServer().db.query.sellers.findMany({
      columns: { id: true },
      where: (seller, { eq }) => eq(seller.runId, runId),
      limit: 10,
    });
    const found = await Promise.all(
      rows.map(async (row) => {
        const id = parseSellerId(row.id);
        return id.ok ? getAdminResolution().getSeller(id.value) : null;
      }),
    );
    return found.filter((seller): seller is Seller => seller !== null);
  },
  detectForSeller: (sellerIdValue, provenance) =>
    getAdminResolution().resolution.detectResolutionCases({
      sellerId: sellerIdValue,
      provider: getAdminResolution().provider,
      provenance,
    }),
  detectBounded: () => getAdminResolution().detectBounded(),
  provenance: () => process.env.WHOP_MODE ?? "mock",
});

export const POST = instrumented(handleDetectIssues);
