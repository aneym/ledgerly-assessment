// Shared serialization for the admin issue resolution routes under
// apps/web/src/app/api/admin/issues/**, matching the marketplace issues contract exactly
// (see docs/lanes/architecture/admin-resolution-contract.md). The internal tables/columns
// and the core ResolutionCase/ResolutionAction shapes are unchanged from the original
// brief — this module is the only place that translates them into the marketplace's field
// names and nesting.
import { type Money, money, subtract } from "../../../../../../../packages/core/src/money";
import type { Seller } from "../../../../../../../packages/core/src/services/ports";
import {
  allowedActionsFor,
  type ResolutionAction,
  type ResolutionCase,
} from "../../../../../../../packages/core/src/services/resolution";

export type IssueActionId = "refetch" | "import_confirmed" | "recheck" | "escalate";

const ACTION_COPY: Record<IssueActionId, { label: string; reason: string }> = {
  refetch: {
    label: "Refetch from provider",
    reason: "Re-pull the provider record to confirm the discrepancy still exists.",
  },
  import_confirmed: {
    label: "Import confirmed payment",
    reason: "The provider confirms this payment succeeded; import it into the ledger.",
  },
  recheck: {
    label: "Recheck",
    reason: "Re-run reconciliation to see whether the discrepancy has cleared.",
  },
  escalate: {
    label: "Escalate",
    reason: "Hand this issue to a person for manual review.",
  },
};

function isIssueActionId(value: string): value is IssueActionId {
  return (
    value === "refetch" ||
    value === "import_confirmed" ||
    value === "recheck" ||
    value === "escalate"
  );
}

// next_safe_action is new business logic the marketplace contract requires (label/reason/
// available/provenance) that nothing in the codebase computed before this pass. It is built
// from the case's own already-stored nextSafeAction string plus ALLOWED_ACTIONS for the
// case's kind — a resolved or escalated case, or a case with no stored suggestion, reports
// id: null / available: false rather than inventing one.
function buildNextSafeAction(kase: ResolutionCase) {
  const raw = kase.nextSafeAction;
  const canAct = kase.status !== "resolved" && kase.status !== "escalated";
  if (!raw || !isIssueActionId(raw) || !canAct) {
    return {
      id: null,
      label: "No safe action available",
      reason:
        kase.status === "resolved"
          ? "This issue is already resolved."
          : kase.status === "escalated"
            ? "This issue has been escalated for manual review."
            : "No safe automated action is available for this issue right now.",
      available: false,
      provenance: kase.provenance,
    };
  }
  const copy = ACTION_COPY[raw];
  return {
    id: raw,
    label: copy.label,
    reason: copy.reason,
    available: (allowedActionsFor(kase.kind) as readonly string[]).includes(raw),
    provenance: kase.provenance,
  };
}

// amounts.difference is typed as Money by the contract, so a currency mismatch (which
// cannot be expressed as a single Money value) is omitted rather than surfaced as a marker
// object the way the old case-detail route's diff() did.
function amountDifference(local: Money | null, provider: Money | null): Money | undefined {
  if (!local || !provider || local.currency !== provider.currency) return undefined;
  const delta = subtract(provider, local);
  return delta.ok ? delta.value : undefined;
}

// evidence_ref has no backing column (resolution_actions only stores `detail: jsonb`) — it
// is derived from whatever `detail` already carries under the "evidence" or "reason" keys
// that runAction's own branches already populate, never a new stored field.
function evidenceRef(detail: unknown): string | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const d = detail as Record<string, unknown>;
  if (typeof d.evidence === "string") return d.evidence;
  if (typeof d.reason === "string") return d.reason;
  return undefined;
}

// A "note" action's own free-text note becomes its history label, so the synthetic
// "demo fault injected" row (see injectSimulatedFault) reads as intended in an issue's
// history array without adding a new action type to the enum.
function historyActionLabel(action: ResolutionAction): string {
  if (action.action === "note") {
    const detail = action.detail as Record<string, unknown> | null;
    if (detail && typeof detail.note === "string" && detail.note.trim()) return detail.note;
    return "note";
  }
  return action.action;
}

function serializeHistory(action: ResolutionAction, caseProvenance: string) {
  const ref = evidenceRef(action.detail);
  return {
    at: action.at.toISOString(),
    actor: action.actorUserId,
    action: historyActionLabel(action),
    outcome: action.outcome,
    // No per-action provenance column exists; echoes the parent case's provenance, which is
    // the only provenance value this service tracks.
    provenance: caseProvenance,
    ...(ref !== undefined ? { evidence_ref: ref } : {}),
  };
}

// Case expected/observed columns retain detection/refetch evidence. Recheck records the
// actual current ledger/provider snapshot in its action; project only those Money fields.
function currentIssueAmounts(kase: ResolutionCase, actions: ResolutionAction[]) {
  const latest = [...actions]
    .reverse()
    .find(
      (action) =>
        action.caseId === kase.id && (action.action === "recheck" || action.action === "resolve"),
    );
  const detail = latest?.detail;
  if (detail && typeof detail === "object" && "currentAmounts" in detail) {
    const snapshot = detail.currentAmounts;
    if (snapshot && typeof snapshot === "object" && "local" in snapshot && "provider" in snapshot) {
      return { local: readMoney(snapshot.local), provider: readMoney(snapshot.provider) };
    }
  }
  // Missing-payment detection stores the provider's amount in expected. It provides no
  // evidence that a local entry exists, even after import; only a recheck can show that.
  return {
    local: kase.kind === "missing_local_payment" ? null : kase.expected,
    provider:
      kase.kind === "missing_local_payment" ? (kase.observed ?? kase.expected) : kase.observed,
  };
}

function readMoney(value: unknown): Money | null {
  if (!value || typeof value !== "object" || !("amountMinor" in value) || !("currency" in value))
    return null;
  if (
    typeof value.amountMinor !== "number" ||
    (value.currency !== "USD" && value.currency !== "EUR" && value.currency !== "BRL")
  )
    return null;
  const decoded = money(value.amountMinor, value.currency);
  return decoded.ok ? decoded.value : null;
}

export function serializeIssue(
  kase: ResolutionCase,
  seller: Seller | null,
  actions: ResolutionAction[],
  now: Date,
) {
  const { local, provider } = currentIssueAmounts(kase, actions);
  const difference = amountDifference(local, provider);
  return {
    id: kase.id,
    kind: kase.kind,
    // seller.name: the Seller port carries no display-name field today (only externalId);
    // sellers.display_name exists in the DB for the admin-ledger feature but isn't wired
    // through SellerRepo yet. Using externalId as a stand-in rather than extending the
    // shared Seller port for this one field — surfaced as a judgment call, not silent.
    seller: seller
      ? { id: seller.id, name: seller.externalId, whop_account_id: seller.whopAccountId }
      : null,
    subject: {
      ...(kase.orderId ? { order_id: kase.orderId } : {}),
      ...(kase.providerResourceType === "transfer" ? { transfer_id: kase.providerResourceId } : {}),
      provider_resource_id: kase.providerResourceId,
    },
    impact: kase.impact,
    amounts: {
      ...(local ? { local } : {}),
      ...(provider ? { provider } : {}),
      ...(difference ? { difference } : {}),
    },
    detected_at: kase.openedAt.toISOString(),
    age_seconds: Math.max(0, Math.floor((now.getTime() - kase.openedAt.getTime()) / 1000)),
    status: kase.status,
    ...(kase.assignedTo ? { assigned_to: kase.assignedTo } : {}),
    next_safe_action: buildNextSafeAction(kase),
    history: actions.map((action) => serializeHistory(action, kase.provenance)),
    provenance: kase.provenance,
    simulated: kase.simulated,
  };
}
