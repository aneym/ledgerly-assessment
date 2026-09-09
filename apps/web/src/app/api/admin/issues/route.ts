import { sellerInScope } from "@/lib/demo-scope";
// GET /api/admin/issues: the issue resolution center's list view, matching the marketplace
// issues contract exactly (see docs/lanes/architecture/admin-resolution-contract.md).
// Query params: status, kind, seller_id, provenance, cursor, limit. Each row is the same
// nested Issue JSON shape the detail and action routes return (see ./serialize.ts), so the
// UI never needs a second fetch to render a list card's history or next safe action.
// Operator-only (see ./authz.ts).
import type { SellerId } from "../../../../../../../packages/core/src/ids";
import { sellerId as parseSellerId } from "../../../../../../../packages/core/src/ids";
import type { Seller } from "../../../../../../../packages/core/src/services/ports";
import type {
  ResolutionAction,
  ResolutionCase,
  ResolutionCaseFilter,
  ResolutionCaseKind,
  ResolutionCaseStatus,
} from "../../../../../../../packages/core/src/services/resolution";
import { getAdminResolution } from "../../../../lib/admin-resolution";
import { instrumented } from "../../../../lib/instrument";
import { getSession } from "../../../../lib/session";
import { type OperatorAuthzDeps, requireOperator } from "./authz";
import { serializeIssue } from "./serialize";

export const runtime = "nodejs";

const KINDS = new Set<ResolutionCaseKind>([
  "missing_local_payment",
  "unconfirmed_transfer",
  "amount_mismatch",
]);
const STATUSES = new Set<ResolutionCaseStatus>([
  "detected",
  "investigating",
  "action_pending",
  "rechecking",
  "resolved",
  "escalated",
]);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export type ListIssuesDeps = OperatorAuthzDeps & {
  listCases: (filter: ResolutionCaseFilter) => Promise<ResolutionCase[]>;
  getSeller: (id: SellerId) => Promise<Seller | null>;
  listActionsForCase: (caseId: string) => Promise<ResolutionAction[]>;
  now: () => Date;
};

function parseFilter(url: URL): ResolutionCaseFilter | null {
  const params = url.searchParams;
  const kind = params.get("kind");
  if (kind !== null && !KINDS.has(kind as ResolutionCaseKind)) return null;
  const status = params.get("status");
  if (status !== null && !STATUSES.has(status as ResolutionCaseStatus)) return null;
  const sellerIdParam = params.get("seller_id");
  let sellerId: SellerId | undefined;
  if (sellerIdParam !== null) {
    const parsed = parseSellerId(sellerIdParam);
    if (!parsed.ok) return null;
    sellerId = parsed.value;
  }
  const limitParam = params.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) return null;
    limit = parsed;
  }
  return {
    ...(kind ? { kind: kind as ResolutionCaseKind } : {}),
    ...(status ? { status: status as ResolutionCaseStatus } : {}),
    ...(sellerId ? { sellerId } : {}),
    ...(params.get("provenance") ? { provenance: params.get("provenance") as string } : {}),
    ...(params.get("cursor") ? { cursor: params.get("cursor") as string } : {}),
    limit,
  };
}

export function createListIssuesHandler(
  deps: ListIssuesDeps,
): (request: Request) => Promise<Response> {
  return async function handleListIssues(request: Request): Promise<Response> {
    const authz = await requireOperator(deps, request);
    if (!authz.ok) return Response.json({ error: authz.error }, { status: authz.status });

    const filter = parseFilter(new URL(request.url));
    if (!filter) return Response.json({ error: "invalid_query" }, { status: 400 });

    const cases = await deps.listCases(filter);
    const now = deps.now();
    const sellerCache = new Map<string, Seller | null>();
    const issues = [];
    for (const kase of cases) {
      let seller: Seller | null = null;
      if (kase.sellerId) {
        if (!sellerCache.has(kase.sellerId))
          sellerCache.set(kase.sellerId, await deps.getSeller(kase.sellerId));
        seller = sellerCache.get(kase.sellerId) ?? null;
      }
      if (!sellerInScope(authz.scope, seller)) continue;
      const actions = await deps.listActionsForCase(kase.id);
      issues.push(serializeIssue(kase, seller, actions, now));
    }
    const nextCursor = cases.length === filter.limit ? (cases[cases.length - 1]?.id ?? null) : null;
    return Response.json({ issues, next_cursor: nextCursor });
  };
}

export const GET = instrumented(
  createListIssuesHandler({
    getSession,
    listCases: (filter) => getAdminResolution().listCases(filter),
    getSeller: (id) => getAdminResolution().getSeller(id),
    listActionsForCase: (caseId) => getAdminResolution().listActionsForCase(caseId),
    now: () => getAdminResolution().clock.now(),
  }),
);
