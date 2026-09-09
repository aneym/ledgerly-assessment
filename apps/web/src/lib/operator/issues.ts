/**
 * Words and rules for the issue resolution center. Kinds get different
 * explanations. Which actions a kind allows follows the resolution contract's table;
 * which one is next, and whether it is available, comes from the API.
 */
import type { Tone } from "./format";
import {
  ISSUE_KINDS,
  ISSUE_STATUSES,
  type Issue,
  type IssueActionKind,
  type IssueKind,
  type IssueStatus,
} from "./types";

export const KIND_LABEL: Record<IssueKind, string> = {
  missing_local_payment: "Missing local payment",
  unconfirmed_transfer: "Unconfirmed transfer",
  amount_mismatch: "Amount mismatch",
};

export const KIND_EXPLANATION: Record<IssueKind, string> = {
  missing_local_payment:
    "The provider shows a confirmed payment that the ledger never recorded. The safe path is to refetch that record from the provider and import it once, keyed on the provider id, so a second import is a no-op.",
  unconfirmed_transfer:
    "The ledger holds a transfer the provider does not confirm. The outcome is unknown. It is never retried blindly: refetch, recheck, and escalate if the provider still returns nothing.",
  amount_mismatch:
    "Both sides have the record and the amounts disagree. Nothing is repaired automatically. The two amounts and the difference are recorded and the case is escalated with that evidence.",
};

export const STATUS_LABEL: Record<IssueStatus, string> = {
  detected: "Detected",
  investigating: "Investigating",
  action_pending: "Action pending",
  rechecking: "Rechecking",
  resolved: "Resolved",
  escalated: "Escalated",
};

export function issueStatusTone(status: IssueStatus): Tone {
  switch (status) {
    case "resolved":
      return "ok";
    case "detected":
    case "action_pending":
    case "escalated":
      return "bad";
    case "investigating":
    case "rechecking":
      return "warn";
    default:
      return "plain";
  }
}

export const ACTION_LABEL: Record<IssueActionKind, string> = {
  refetch: "Fetch from Whop",
  import_confirmed: "Import confirmed payment",
  recheck: "Recheck",
  escalate: "Escalate",
};

export const ACTION_SENTENCE: Record<IssueActionKind, string> = {
  refetch: "Reads the provider record again. Changes nothing in the ledger.",
  import_confirmed:
    "Posts the ledger effect a payment webhook would have posted, once, under the same effect key.",
  recheck:
    "Re-runs reconciliation and records the outcome. Resolves only if the discrepancy is gone.",
  escalate: "Hands the issue to a person with the evidence attached. Keeps the ledger as it is.",
};

/** Allowed actions per kind, from the contract's table. import_confirmed is for missing payments only. */
export const KIND_ACTIONS: Record<IssueKind, IssueActionKind[]> = {
  missing_local_payment: ["refetch", "import_confirmed", "recheck", "escalate"],
  unconfirmed_transfer: ["refetch", "recheck", "escalate"],
  amount_mismatch: ["refetch", "recheck", "escalate"],
};

export const OPEN_STATUSES: IssueStatus[] = [
  "detected",
  "investigating",
  "action_pending",
  "rechecking",
];

export const isOpen = (issue: Issue) => OPEN_STATUSES.includes(issue.status);

/** The one id that names the record: the order when there is one, else the provider resource. */
export function issueRef(issue: Issue): string {
  return (
    issue.subject.order_id ??
    issue.subject.transfer_id ??
    issue.subject.provider_resource_id ??
    issue.id
  );
}

/** "3 hours", "2 days", from the contract's age_seconds. */
export function ageLabel(seconds: number): string {
  if (seconds < 60) return "under a minute";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  const d = Math.floor(seconds / 86_400);
  return `${d} ${d === 1 ? "day" : "days"}`;
}

export type IssueFilters = {
  status: IssueStatus | "";
  kind: IssueKind | "";
  seller_id: string;
  issue: string;
};

export const EMPTY_ISSUE_FILTERS: IssueFilters = { status: "", kind: "", seller_id: "", issue: "" };

const isStatus = (v: string): v is IssueStatus => (ISSUE_STATUSES as readonly string[]).includes(v);
const isKind = (v: string): v is IssueKind => (ISSUE_KINDS as readonly string[]).includes(v);

export function parseIssueFilters(params: URLSearchParams): IssueFilters {
  const get = (key: string) => (params.get(key) ?? "").trim();
  const status = get("status");
  const kind = get("kind");
  return {
    status: isStatus(status) ? status : "",
    kind: isKind(kind) ? kind : "",
    seller_id: get("seller_id").slice(0, 60),
    issue: get("issue").slice(0, 60),
  };
}

/** The query the API gets. `issue` is a page selection, not a filter, so it stays out. */
export function toIssueQuery(filters: IssueFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.seller_id) params.set("seller_id", filters.seller_id);
  return params.toString();
}

export function toIssueUrl(filters: IssueFilters): string {
  const params = new URLSearchParams(toIssueQuery(filters));
  if (filters.issue) params.set("issue", filters.issue);
  const q = params.toString();
  return q ? `/admin/issues?${q}` : "/admin/issues";
}

export function applyIssueFilters(issues: Issue[], filters: IssueFilters): Issue[] {
  return issues.filter((issue) => {
    if (filters.status && issue.status !== filters.status) return false;
    if (filters.kind && issue.kind !== filters.kind) return false;
    if (filters.seller_id && issue.seller?.id !== filters.seller_id) return false;
    return true;
  });
}
