import type { Role } from "./contract";

/**
 * The seven-step seller, buyer and repair story. Requirement ids come
 * from docs/wiki/requirements.json; scenario ids from the evidence lane.
 */
export interface StepDefinition {
  id: string;
  title: string;
  requirement_ids: string[];
  scenario_id: string;
  /** Presentation role the walkthrough animates for this step. */
  role: Role;
  /** Provider operations the step performs, in order. Names are internal; the provider adapter owns request shapes. */
  operations: string[];
  /** Owner gates that block the sandbox path until resolved. */
  gates: { id: string; reason: string }[];
  /** True when a human must act in a hosted flow; the runtime records the hand-off, it cannot complete it. */
  human_gate: boolean;
  /** `data-tour` value of the control the overlay anchors to. Marketplace owns the element. */
  anchor: string;
  /** What the tour does at the anchor: a visible click, typing, or observing until an outcome arrives. */
  action: { kind: "click" | "type" | "observe"; label: string };
  fill?: { anchor: string; value: "name" | "email" | "password" }[];
  /**
   * Observed outcomes that advance the step. A route ending in "/" matches by
   * prefix (ids in the path); anchors are the data-tour values marketplace ships.
   */
  expects: { route: string | null; db: string[]; provider: string[]; terminal?: "onboarding-product" | "paid-order" | "earnings-order" | "sample-payout" | "injected-case" | "resolved-case" };
  /** Tooltip body, plain language, one or two sentences. */
  content: string;
  /** Screen the control lives on; the tour navigates there when playing and the anchor is absent. */
  path: string | null;
}

export const STEPS: readonly StepDefinition[] = [
  {
    id: "C01",
    title: "The seller joins",
    requirement_ids: ["BUILD-02", "BUILD-03", "BUILD-04", "CODE-01", "SUBMIT-01"],
    scenario_id: "S02",
    role: "creator",
    operations: ["account.createOrFetch"],
    gates: [],
    human_gate: false,
    anchor: "sell.start.submit",
    action: { kind: "type", label: "Become a seller" },
    fill: [
      { anchor: "sell.start.name", value: "name" },
      { anchor: "sell.start.email", value: "email" },
    ],
    expects: { route: "POST /api/sellers", db: ["sellers"], provider: ["createOrFetchAccount"] },
    content:
      "Ledgerly creates the connected Whop account for this seller with parent, email and external id. The panel shows the biz_ id Whop returned.",
    path: "/sell",
  },
  {
    id: "C02",
    title: "Open Whop onboarding",
    requirement_ids: ["BUILD-07", "BUILD-08"],
    scenario_id: "S04",
    role: "creator",
    operations: ["accountLink.create"],
    gates: [],
    human_gate: true,
    anchor: "sell.onboarding.link",
    action: { kind: "click", label: "Open onboarding" },
    expects: { route: "POST /api/sellers/", db: [], provider: ["createOnboardingLink"], terminal: "onboarding-product" },
    content:
      "Whop hosts the identity check, which stops at Sumsub in the sandbox. After the link is created, publish a sample product for this seller. The tour does not claim identity verification.",
    path: "/sell/onboarding",
  },
  {
    id: "C03",
    title: "The buyer makes a purchase",
    requirement_ids: ["BUILD-09", "BUILD-10", "BUILD-11", "CODE-02", "SUBMIT-02"],
    scenario_id: "S05",
    role: "buyer",
    operations: ["checkout.create"],
    gates: [],
    human_gate: false,
    anchor: "product.buy",
    action: { kind: "click", label: "Buy as the test buyer" },
    expects: { route: "POST /api/checkouts", db: ["orders"], provider: ["createCheckoutConfiguration"], terminal: "paid-order" },
    content:
      "Open checkout and follow the payment to its paid receipt. Local completion uses the isolated mock provider; sandbox payment requires the actual hosted payment outcome.",
    path: "/p/grain-and-gradient",
  },
  {
    id: "C04",
    title: "Follow that payment",
    requirement_ids: ["BUILD-10", "CODE-02", "SUBMIT-02"],
    scenario_id: "S05",
    role: "creator",
    operations: ["ledger.read"],
    gates: [],
    human_gate: false,
    anchor: "sell.earnings.table",
    action: { kind: "observe", label: "Read the fee split" },
    expects: { route: "GET /api/sellers/", db: [], provider: [], terminal: "earnings-order" },
    content:
      "Follow the payment into the seller's earnings and read the platform fee and seller share. The tour advances when the earnings read contains this purchase.",
    path: "/sell/earnings",
  },
  {
    id: "C05",
    title: "The seller's payout controls",
    requirement_ids: ["BUILD-14", "BUILD-15", "BUILD-17", "SUBMIT-03"],
    scenario_id: "S07",
    role: "creator",
    operations: ["accessToken.create"],
    gates: [],
    human_gate: false,
    anchor: "sell.payouts.sample.start",
    action: { kind: "click", label: "Start the local payout sample" },
    expects: { route: "POST /api/sellers/", db: [], provider: [], terminal: "sample-payout" },
    content:
      "Start the separate local payout sample, then request a sample withdrawal. This uses mock funds and records a requested payout, without claiming bank settlement or changing seller earnings.",
    path: "/sell/payouts",
  },
  {
    id: "C06",
    title: "Your team handles a problem",
    requirement_ids: ["CODE-04"],
    scenario_id: "S10",
    role: "admin",
    operations: ["issues.demoFault"],
    gates: [],
    human_gate: false,
    anchor: "admin.issues.inject",
    action: { kind: "click", label: "Inject the fault" },
    expects: { route: "POST /api/admin/issues/demo-fault", db: [], provider: [], terminal: "injected-case" },
    content:
      "Prepare a fresh simulated payment for this run’s seller and open its missing-payment case. The fault remains explicitly simulated; no existing payment is deleted.",
    path: "/admin/issues",
  },
  {
    id: "C07",
    title: "Detect and repair",
    requirement_ids: ["DEBUG-02", "DEBUG-03"],
    scenario_id: "S11",
    role: "admin",
    operations: ["reconcile.run", "issues.refetch", "issues.importConfirmed", "issues.recheck", "issues.resolve"],
    gates: [],
    human_gate: false,
    anchor: "admin.issues.guided.refetch",
    action: { kind: "click", label: "Repair" },
    expects: { route: "POST /api/admin/issues/", db: ["resolution_run"], provider: [], terminal: "resolved-case" },
    content:
      "This one control walks the case through multiple real actions: refetch and import the missing record, then recheck. Continue until the ledger matches and the case resolves.",
    path: "/admin/issues",
  },
];

export const STEP_IDS = STEPS.map((s) => s.id);

/**
 * How a port operation appears in architecture's instrumentation stream
 * (`METHOD /path`). Proposal from the pinned Whop docs and the sandbox
 * adapter; architecture confirms the paths its client emits.
 */
export const OPERATION_PATHS: Readonly<Record<string, RegExp>> = {
  createOrFetchAccount: /^POST \/accounts$/,
  getAccount: /^GET \/accounts\//,
  createOnboardingLink: /^POST \/account_links/,
  createCheckoutConfiguration: /^POST \/checkout_configurations/,
  getPayment: /^GET \/payments\//,
  listPaymentFees: /^GET \/payments\/.*fees/,
  refundPayment: /^POST \/payments\/.*refund/,
  createTransfer: /^POST \/transfers/,
  createAccessToken: /^POST \/access_tokens/,
  createPayoutPortalLink: /^POST \/(payout_portal|account_links)/,
  createFeeMarkup: /^POST \/fee_markups/,
  sendTestWebhook: /^POST \/webhooks\/.*test/,
  replayDelivery: /^POST \/webhooks\/.*replay/,
  suspendAccount: /^POST \/accounts\/.*suspend/,
  listPayments: /^GET \/payments/,
  listTransfers: /^GET \/transfers/,
  getPayout: /^GET \/payouts\//,
};

/** True when an observed operation label satisfies an expected port operation. */
export function operationMatches(expected: string, observed: string): boolean {
  if (observed === expected) return true;
  const re = OPERATION_PATHS[expected];
  return re ? re.test(observed) : false;
}

export function getStep(id: string): StepDefinition {
  const s = STEPS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown step ${id}`);
  return s;
}

export function isStepScreen(path: string | null, location: { pathname: string; search: string }): boolean {
  if (!path) return false;
  const target = new URL(path, "http://tour.local");
  if (target.pathname !== location.pathname) return false;
  const current = new URLSearchParams(location.search);
  return [...target.searchParams].every(([key, value]) => current.get(key) === value);
}
