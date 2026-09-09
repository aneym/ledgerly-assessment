import type { Money, SalePolicy } from "@ledgerly/core";

export type { Money, SalePolicy };

/** Where a record came from. Set from the API response or the fixture, never typed into a page. */
export type Provenance = "mock" | "sandbox" | "live";

export type CapabilityState = "active" | "inactive" | "pending";

/** The three capability gates the seller row shows as dots. Separate from sale policy on purpose. */
export type Capabilities = {
  payments: CapabilityState;
  transfers: CapabilityState;
  payouts: CapabilityState;
};

export type VerificationState = "not_started" | "pending" | "verified";

/**
 * GET /api/sellers/{id} as confirmed by architecture: id, name, country, sale_policy,
 * whop_account_id, verification, required_actions, capabilities, provenance.
 * The rest are display fields the fixture carries until the route returns them.
 */
export type OperatorSeller = {
  id: string;
  name: string;
  country: string;
  sale_policy: SalePolicy;
  whop_account_id: string | null;
  verification: VerificationState;
  required_actions: string[];
  capabilities: Capabilities;
  provenance: Provenance;
  handle: string;
  kind: "person" | "studio";
  city: string;
  country_name: string;
  avatar: string | null;
  external_id: string;
  created_at: string;
  status: "active" | "suspended";
};

/** The seller block a ledger row carries. `name` is the seller's display name. */
export type SellerRef = {
  id: string;
  name: string;
  whop_account_id: string | null;
  sale_policy: SalePolicy;
};

export const LEDGER_TYPES = ["payment", "fee", "transfer", "refund", "payout"] as const;
export type LedgerEntryType = (typeof LEDGER_TYPES)[number];

export const LEDGER_STATUSES = [
  "settling",
  "settled",
  "pending",
  "held",
  "refunded",
  "paid_out",
  "failed",
] as const;
export type LedgerEntryStatus = (typeof LEDGER_STATUSES)[number];

export type ChargeModel = "direct" | "platform_transfer";

/**
 * One row of GET /api/admin/ledger. Money is minor units plus currency, never a
 * decimal string. item, charge_model and note are display extras the fixture carries;
 * the route omits them.
 */
export type LedgerRow = {
  id: string;
  seller: SellerRef;
  type: LedgerEntryType;
  order_id: string | null;
  provider_resource_id: string | null;
  status: LedgerEntryStatus;
  gross: Money | null;
  fee: Money | null;
  net: Money | null;
  currency: Money["currency"];
  created_at: string;
  updated_at: string;
  settled_at: string | null;
  correlation_id: string;
  provenance: Provenance;
  item?: string;
  charge_model?: ChargeModel;
  note?: string;
};

export type LedgerSummary = {
  currency: Money["currency"];
  gross: Money;
  fee: Money;
  net: Money;
};

/** GET /api/admin/ledger: rows, a summary per currency, and a keyset cursor. */
/** GET /api/admin/ledger/{id} nests the row in an envelope with its order and siblings. */
export type LedgerEntryDetail = {
  row: LedgerRow;
  order: Record<string, unknown> | null;
  siblings: LedgerRow[];
  instrumentation_events: Record<string, unknown>[];
};

export type LedgerPage = {
  rows: LedgerRow[];
  summary: LedgerSummary[];
  next_cursor: string | null;
  provenance: Provenance;
};

/** POST /api/reconcile/{sellerId}: one recorded run and the issues it opened or touched. */
export type ReconciliationRun = {
  id: string;
  seller_id: string;
  recorded_at: string;
  provenance: Provenance;
  issue_ids: string[];
};

/* ---------- issue resolution, docs/lanes/architecture/admin-resolution-contract.md v2 ---------- */

export const ISSUE_KINDS = [
  "missing_local_payment",
  "unconfirmed_transfer",
  "amount_mismatch",
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export const ISSUE_STATUSES = [
  "detected",
  "investigating",
  "action_pending",
  "rechecking",
  "resolved",
  "escalated",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_ACTIONS = ["refetch", "import_confirmed", "recheck", "escalate"] as const;
export type IssueActionKind = (typeof ISSUE_ACTIONS)[number];

/** The issue's seller block. The route sends no sale_policy and may send null. */
export type IssueSeller = { id: string; name: string; whop_account_id: string | null };

/** The next safe action as the API states it. Availability and provenance are never guessed here. */
export type IssueNextAction = {
  id: IssueActionKind | null;
  label: string;
  reason: string;
  available: boolean;
  provenance: string;
};

export type IssueHistoryStep = {
  at: string;
  actor: string;
  action: string;
  outcome: string;
  provenance: string;
  evidence_ref?: string;
};

/** One issue as GET /api/admin/issues returns it. `simulated` marks an injected demo fault. */
export type Issue = {
  id: string;
  kind: IssueKind;
  seller: IssueSeller | null;
  subject: { order_id?: string; transfer_id?: string; provider_resource_id?: string };
  impact: string;
  amounts: { local?: Money; provider?: Money; difference?: Money };
  detected_at: string;
  age_seconds: number;
  status: IssueStatus;
  assigned_to?: string;
  next_safe_action: IssueNextAction;
  history: IssueHistoryStep[];
  provenance: string;
  simulated: boolean;
};

/** GET /api/admin/issues. */
export type IssuesPage = {
  issues: Issue[];
  next_cursor: string | null;
};
