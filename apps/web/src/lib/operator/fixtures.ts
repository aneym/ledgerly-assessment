/**
 * MOCK data for the operator screens. Every record here carries provenance "mock".
 * Sellers mirror fixtures/demo/sellers.json. The ledger and the drift are invented
 * for one seller so the reconciliation view has something to show before the
 * reconcile route is live. Nothing here is a sandbox or live observation.
 */
import { computePlatformFee } from "@ledgerly/core/fee";
import { summarize } from "./ledger-filters";
import type {
  Capabilities,
  ChargeModel,
  Issue,
  IssuesPage,
  LedgerEntryStatus,
  LedgerPage,
  LedgerRow,
  Money,
  OperatorSeller,
  ReconciliationRun,
  SalePolicy,
  SellerRef,
  VerificationState,
} from "./types";

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  DE: "Germany",
  BR: "Brazil",
  CA: "Canada",
  KR: "South Korea",
  PT: "Portugal",
};

type Onboarding = "pending" | "not_started";

/** Verification and capabilities follow the seller's onboarding field in sellers.json. */
function fromOnboarding(onboarding: Onboarding): {
  verification: VerificationState;
  required_actions: string[];
  capabilities: Capabilities;
} {
  if (onboarding === "pending") {
    return {
      verification: "pending",
      required_actions: ["identity_verification", "external_account"],
      capabilities: { payments: "active", transfers: "inactive", payouts: "inactive" },
    };
  }
  return {
    verification: "not_started",
    required_actions: ["hosted_onboarding"],
    capabilities: { payments: "inactive", transfers: "inactive", payouts: "inactive" },
  };
}

type SellerSeed = {
  id: string;
  external_id: string;
  name: string;
  handle: string;
  kind: "person" | "studio";
  city: string;
  country: string;
  avatar: string;
  created_at: string;
  sale_policy: SalePolicy;
  onboarding: Onboarding;
};

/** sale_policy in sellers.json maps to core's SalePolicy. The blocked seller keeps direct as policy; the block is a capability gate. */
const SEED: SellerSeed[] = [
  {
    id: "sel_mara",
    external_id: "usr_mara_okonkwo",
    name: "Mara Okonkwo",
    handle: "mara",
    kind: "person",
    city: "Austin",
    country: "US",
    avatar: "/demo/mara.svg",
    created_at: "2026-08-12T15:04:00Z",
    sale_policy: "direct",
    onboarding: "pending",
  },
  {
    id: "sel_kontur",
    external_id: "usr_studio_kontur",
    name: "Studio Kontur",
    handle: "kontur",
    kind: "studio",
    city: "Berlin",
    country: "DE",
    avatar: "/demo/kontur.svg",
    created_at: "2026-08-14T09:22:00Z",
    sale_policy: "direct",
    onboarding: "pending",
  },
  {
    id: "sel_onda",
    external_id: "usr_onda_sounds",
    name: "Onda Sounds",
    handle: "onda",
    kind: "person",
    city: "São Paulo",
    country: "BR",
    avatar: "/demo/onda.svg",
    created_at: "2026-08-15T18:40:00Z",
    sale_policy: "platform_only",
    onboarding: "pending",
  },
  {
    id: "sel_form",
    external_id: "usr_form_studio",
    name: "Form Studio",
    handle: "form",
    kind: "studio",
    city: "Toronto",
    country: "CA",
    avatar: "/demo/form.svg",
    created_at: "2026-08-21T12:10:00Z",
    sale_policy: "direct",
    onboarding: "not_started",
  },
  {
    id: "sel_pixelfern",
    external_id: "usr_pixelfern",
    name: "Pixelfern",
    handle: "pixelfern",
    kind: "person",
    city: "Seoul",
    country: "KR",
    avatar: "/demo/pixelfern.svg",
    created_at: "2026-08-23T03:55:00Z",
    sale_policy: "direct",
    onboarding: "not_started",
  },
  {
    id: "sel_acme",
    external_id: "usr_acme_studio",
    name: "Acme Studio",
    handle: "acme",
    kind: "studio",
    city: "Lisbon",
    country: "PT",
    avatar: "/demo/acme.svg",
    created_at: "2026-08-27T16:31:00Z",
    sale_policy: "platform_only",
    onboarding: "not_started",
  },
  {
    id: "sel_juno",
    external_id: "usr_juno_hale",
    name: "Juno Hale",
    handle: "juno",
    kind: "person",
    city: "Toronto",
    country: "CA",
    avatar: "/demo/juno.svg",
    created_at: "2026-09-02T11:08:00Z",
    sale_policy: "direct",
    onboarding: "not_started",
  },
];

export const MOCK_SELLERS: OperatorSeller[] = SEED.map(({ onboarding, ...seed }) => ({
  ...seed,
  country_name: COUNTRY_NAMES[seed.country] ?? seed.country,
  whop_account_id: null,
  status: "active",
  ...fromOnboarding(onboarding),
  provenance: "mock",
}));

export function mockSellerById(id: string): OperatorSeller | null {
  return MOCK_SELLERS.find((seller) => seller.id === id) ?? null;
}

/* ---------- platform ledger, all seven sellers, MOCK ---------- */

const money = (amountMinor: number, currency: Money["currency"] = "USD"): Money => ({
  amountMinor,
  currency,
});

/** The 8 percent split from core. Fixture prices are valid by construction, so a failure is a bug. */
function split(gross: Money): { fee: Money; net: Money } {
  const result = computePlatformFee(gross);
  if (!result.ok) throw new Error(`computePlatformFee failed: ${result.error.kind}`);
  return { fee: result.value.fee, net: result.value.sellerShare };
}

const chargeModelOf = (seller_id: string): ChargeModel =>
  mockSellerById(seller_id)?.sale_policy === "platform_only" ? "platform_transfer" : "direct";

/** The seller block a row carries, from the fixture seller list. */
export function sellerRef(seller_id: string): SellerRef {
  const seller = mockSellerById(seller_id);
  if (!seller) throw new Error(`Unknown fixture seller ${seller_id}`);
  return {
    id: seller.id,
    name: seller.name,
    whop_account_id: seller.whop_account_id,
    sale_policy: seller.sale_policy,
  };
}

let sequence = 0;
const nextId = () => `led_${(0x0be7c0 + sequence++ * 7).toString(16)}`;

type RowInput = {
  seller_id: string;
  type: LedgerRow["type"];
  created_at: string;
  settled_at?: string | null;
  updated_at?: string;
  order_id?: string | null;
  item: string;
  status: LedgerEntryStatus;
  gross?: Money | null;
  fee?: Money | null;
  net?: Money | null;
  currency?: Money["currency"];
  provider_resource_id: string | null;
  correlation_id: string;
  note: string;
};

function row(input: RowInput): LedgerRow {
  const currency = input.currency ?? input.net?.currency ?? input.gross?.currency ?? "USD";
  return {
    id: nextId(),
    seller: sellerRef(input.seller_id),
    type: input.type,
    created_at: input.created_at,
    updated_at: input.updated_at ?? input.settled_at ?? input.created_at,
    settled_at: input.settled_at ?? null,
    order_id: input.order_id ?? null,
    item: input.item,
    status: input.status,
    gross: input.gross ?? null,
    fee: input.fee ?? null,
    net: input.net ?? null,
    currency,
    provider_resource_id: input.provider_resource_id,
    correlation_id: input.correlation_id,
    charge_model: chargeModelOf(input.seller_id),
    provenance: "mock",
    note: input.note,
  };
}

type Sale = {
  seller_id: string;
  order_id: string;
  item: string;
  gross: number;
  at: string;
  settled_at: string | null;
  status: LedgerEntryStatus;
  pay: string;
  transfer?: { id: string; status: LedgerEntryStatus; settled_at: string | null; note?: string };
  corr: string;
  note?: string;
};

/** One sale becomes a payment row, a fee row, and for platform sellers a transfer row. */
function sale(input: Sale): LedgerRow[] {
  const gross = money(input.gross);
  const { fee, net } = split(gross);
  const direct = chargeModelOf(input.seller_id) === "direct";
  const rows: LedgerRow[] = [
    row({
      seller_id: input.seller_id,
      type: "payment",
      created_at: input.at,
      settled_at: input.settled_at,
      order_id: input.order_id,
      item: input.item,
      status: input.status,
      gross,
      fee,
      net,
      provider_resource_id: input.pay,
      correlation_id: input.corr,
      note:
        input.note ??
        (direct
          ? "Direct charge on the seller's account. Ledgerly takes the fee as an application fee."
          : "Parent charge on Ledgerly. The seller's share moves by transfer."),
    }),
  ];
  if (input.status !== "failed") {
    rows.push(
      row({
        seller_id: input.seller_id,
        type: "fee",
        created_at: input.at,
        settled_at: input.settled_at,
        order_id: input.order_id,
        item: input.item,
        status: input.status,
        fee,
        provider_resource_id: input.pay,
        correlation_id: input.corr,
        note: `8 percent of ${(input.gross / 100).toFixed(2)} retained by Ledgerly, round half up.`,
      }),
    );
  }
  if (input.transfer) {
    rows.push(
      row({
        seller_id: input.seller_id,
        type: "transfer",
        created_at: input.at,
        settled_at: input.transfer.settled_at,
        order_id: input.order_id,
        item: input.item,
        status: input.transfer.status,
        net,
        provider_resource_id: input.transfer.id,
        correlation_id: input.corr,
        note: input.transfer.note ?? "Internal balance movement to the seller. Not a payout.",
      }),
    );
  }
  return rows;
}

function refund(input: {
  seller_id: string;
  order_id: string;
  item: string;
  gross: number;
  at: string;
  id: string;
  corr: string;
  note: string;
}): LedgerRow {
  const gross = money(input.gross);
  const { fee, net } = split(gross);
  return row({
    seller_id: input.seller_id,
    type: "refund",
    created_at: input.at,
    settled_at: input.at,
    order_id: input.order_id,
    item: input.item,
    status: "refunded",
    gross: money(-gross.amountMinor),
    fee: money(-fee.amountMinor),
    net: money(-net.amountMinor),
    provider_resource_id: input.id,
    correlation_id: input.corr,
    note: input.note,
  });
}

function payout(input: {
  seller_id: string;
  at: string;
  settled_at: string | null;
  status: LedgerEntryStatus;
  amount: number;
  currency: Money["currency"];
  id: string;
  corr: string;
  note: string;
}): LedgerRow {
  return row({
    seller_id: input.seller_id,
    type: "payout",
    created_at: input.at,
    settled_at: input.settled_at,
    updated_at: input.settled_at ?? input.at,
    item: "Withdrawal to bank",
    status: input.status,
    net: money(input.amount, input.currency),
    currency: input.currency,
    provider_resource_id: input.id,
    correlation_id: input.corr,
    note: input.note,
  });
}

const GRAIN = "Grain & Gradient";
const KONTUR = "Kontur Type Specimen Kit";
const DRUMS = "Onda Drum Library";
const STREET = "Streetlight Sessions";
const LAYOUTS = "Ledger Layouts for Framer";
const BOTANICALS = "Lowpoly Botanicals";
const NOTION = "Notion OS for Studios";
const LETTERING = "Comic Lettering Kit";

const ROWS: LedgerRow[] = [
  // Mara Okonkwo, US, direct
  ...sale({
    seller_id: "sel_mara",
    order_id: "ord_8a10f2",
    item: GRAIN,
    gross: 2500,
    at: "2026-09-08T09:12:40Z",
    settled_at: null,
    status: "settling",
    pay: "pay_3Mk9rQ2wE",
    corr: "corr_5f2a9c",
  }),
  ...sale({
    seller_id: "sel_mara",
    order_id: "ord_89e4b7",
    item: GRAIN,
    gross: 2500,
    at: "2026-09-06T21:03:15Z",
    settled_at: "2026-09-08T02:00:00Z",
    status: "settled",
    pay: "pay_7Hd2sL8nA",
    corr: "corr_4c1d88",
  }),
  ...sale({
    seller_id: "sel_mara",
    order_id: "ord_88c1a3",
    item: GRAIN,
    gross: 2500,
    at: "2026-09-02T14:47:09Z",
    settled_at: "2026-09-04T02:00:00Z",
    status: "settled",
    pay: "pay_1Bz6tK4pM",
    corr: "corr_3b9e21",
  }),
  refund({
    seller_id: "sel_mara",
    order_id: "ord_88c1a3",
    item: GRAIN,
    gross: 2500,
    at: "2026-09-05T10:20:31Z",
    id: "rfd_2c8e91",
    corr: "corr_6d0f44",
    note: "Full refund on the buyer's request. Fee treatment on refund is observed in sandbox, not assumed.",
  }),
  payout({
    seller_id: "sel_mara",
    at: "2026-09-04T16:00:00Z",
    settled_at: "2026-09-06T13:22:10Z",
    status: "paid_out",
    amount: 2300,
    currency: "USD",
    id: "pyt_9Rv3wN1cQ",
    corr: "corr_7e5b02",
    note: "External payout to the seller's bank. Separate resource from a transfer.",
  }),

  // Studio Kontur, DE, direct
  ...sale({
    seller_id: "sel_kontur",
    order_id: "ord_87f0d9",
    item: KONTUR,
    gross: 8900,
    at: "2026-09-07T11:31:52Z",
    settled_at: "2026-09-09T02:00:00Z",
    status: "settled",
    pay: "pay_5Qw8eR2tY",
    corr: "corr_8f6c13",
  }),
  ...sale({
    seller_id: "sel_kontur",
    order_id: "ord_86b2e5",
    item: KONTUR,
    gross: 8900,
    at: "2026-09-03T08:05:27Z",
    settled_at: "2026-09-05T02:00:00Z",
    status: "settled",
    pay: "pay_2Xc4vB7nM",
    corr: "corr_9a7d24",
  }),
  payout({
    seller_id: "sel_kontur",
    at: "2026-09-08T07:45:00Z",
    settled_at: null,
    status: "pending",
    amount: 15022,
    currency: "EUR",
    id: "pyt_4Tg6hJ8kL",
    corr: "corr_1b8e35",
    note: "Withdrawal in EUR on the seller's rail. Pending at the provider, no diagnosis from two days of waiting.",
  }),

  // Onda Sounds, BR, platform only
  ...sale({
    seller_id: "sel_onda",
    order_id: "ord_7f3a9c",
    item: DRUMS,
    gross: 6000,
    at: "2026-09-08T14:32:10Z",
    settled_at: null,
    status: "settling",
    pay: "pay_4Qm8zL2vT",
    corr: "corr_2c9f46",
    transfer: {
      id: "tsf_9hK3pW1nR",
      status: "pending",
      settled_at: null,
      note: "Released by the sweep after the hold. Provider has not confirmed it yet.",
    },
  }),
  ...sale({
    seller_id: "sel_onda",
    order_id: "ord_7e91b2",
    item: STREET,
    gross: 1200,
    at: "2026-09-07T09:15:44Z",
    settled_at: "2026-09-09T02:00:00Z",
    status: "settled",
    pay: "pay_2Vd7cN8xQ",
    corr: "corr_3d0a57",
    transfer: { id: "tsf_5rT2bM4kJ", status: "settled", settled_at: "2026-09-07T09:15:45Z" },
  }),
  ...sale({
    seller_id: "sel_onda",
    order_id: "ord_7d40e8",
    item: DRUMS,
    gross: 6000,
    at: "2026-09-06T19:48:02Z",
    settled_at: "2026-09-08T02:00:00Z",
    status: "settled",
    pay: "pay_8Ff1sD6yA",
    corr: "corr_4e1b68",
    transfer: { id: "tsf_3wQ9nX7pL", status: "settled", settled_at: "2026-09-06T19:48:03Z" },
  }),
  ...sale({
    seller_id: "sel_onda",
    order_id: "ord_7c2f14",
    item: STREET,
    gross: 1200,
    at: "2026-09-05T08:02:19Z",
    settled_at: null,
    status: "held",
    pay: "pay_6Jj4hR0tC",
    corr: "corr_5f2c79",
    note: "Held until the dispute resolves. No transfer is released while held.",
  }),
  ...sale({
    seller_id: "sel_onda",
    order_id: "ord_7a88d0",
    item: DRUMS,
    gross: 6000,
    at: "2026-09-01T10:44:07Z",
    settled_at: "2026-09-03T02:00:00Z",
    status: "settled",
    pay: "pay_1Aa9kE3zP",
    corr: "corr_6a3d80",
    transfer: {
      id: "tsf_0Zn6qV5dH",
      status: "settled",
      settled_at: "2026-09-01T10:44:08Z",
      note: "Internal balance movement. The later refund does not reverse it automatically.",
    },
  }),
  refund({
    seller_id: "sel_onda",
    order_id: "ord_7a88d0",
    item: DRUMS,
    gross: 6000,
    at: "2026-09-03T13:27:50Z",
    id: "rfd_1b6c02",
    corr: "corr_7b4e91",
    note: "Full refund. Whether the fee returns is read from both ledgers, never assumed.",
  }),
  payout({
    seller_id: "sel_onda",
    at: "2026-09-02T16:11:38Z",
    settled_at: "2026-09-04T11:02:56Z",
    status: "paid_out",
    amount: 5902,
    currency: "BRL",
    id: "pyt_7Yc2vB9mS",
    corr: "corr_8c5f02",
    note: "Withdrawal in BRL. External payout, separate resource from the transfers above.",
  }),

  // Form Studio, CA, onboarding not started
  ...sale({
    seller_id: "sel_form",
    order_id: "ord_85a7c1",
    item: LAYOUTS,
    gross: 14900,
    at: "2026-09-04T17:26:03Z",
    settled_at: null,
    status: "failed",
    pay: "pay_0Nn5mC3xW",
    corr: "corr_9d6a13",
    note: "Provider refused the charge. The seller's onboarding is incomplete, so no fee and no transfer.",
  }),

  // Pixelfern, KR, direct
  ...sale({
    seller_id: "sel_pixelfern",
    order_id: "ord_84d3f8",
    item: BOTANICALS,
    gross: 3500,
    at: "2026-09-07T03:58:41Z",
    settled_at: "2026-09-09T02:00:00Z",
    status: "settled",
    pay: "pay_8Pl2kD6vB",
    corr: "corr_0e7b24",
  }),
  ...sale({
    seller_id: "sel_pixelfern",
    order_id: "ord_83c9a4",
    item: BOTANICALS,
    gross: 3500,
    at: "2026-08-30T12:14:55Z",
    settled_at: "2026-09-01T02:00:00Z",
    status: "settled",
    pay: "pay_6Rt4jF1nC",
    corr: "corr_1f8c35",
  }),
  payout({
    seller_id: "sel_pixelfern",
    at: "2026-09-05T09:30:00Z",
    settled_at: null,
    status: "failed",
    amount: 6440,
    currency: "USD",
    id: "pyt_2Wq7xZ4bV",
    corr: "corr_2a9d46",
    note: "Bank rejected the payout. Funds returned to the seller's balance. No replacement payout without authority.",
  }),

  // Acme Studio, PT, platform only
  ...sale({
    seller_id: "sel_acme",
    order_id: "ord_82b5e0",
    item: NOTION,
    gross: 2900,
    at: "2026-09-08T06:40:18Z",
    settled_at: null,
    status: "settling",
    pay: "pay_3Gh9wS5mK",
    corr: "corr_3b0e57",
    transfer: { id: "tsf_7Vb2nM8qD", status: "pending", settled_at: null },
  }),
  ...sale({
    seller_id: "sel_acme",
    order_id: "ord_81a1d6",
    item: NOTION,
    gross: 2900,
    at: "2026-09-03T15:09:33Z",
    settled_at: "2026-09-05T02:00:00Z",
    status: "settled",
    pay: "pay_9Kd4rT6yH",
    corr: "corr_4c1f68",
    transfer: { id: "tsf_2Mc8pL3wS", status: "settled", settled_at: "2026-09-03T15:09:34Z" },
  }),

  // Juno Hale, CA, direct
  ...sale({
    seller_id: "sel_juno",
    order_id: "ord_80f8b2",
    item: LETTERING,
    gross: 1800,
    at: "2026-09-06T22:51:07Z",
    settled_at: "2026-09-08T02:00:00Z",
    status: "settled",
    pay: "pay_1Lz7cV9tR",
    corr: "corr_5d2a79",
  }),
  ...sale({
    seller_id: "sel_juno",
    order_id: "ord_80e2c9",
    item: LETTERING,
    gross: 1800,
    at: "2026-09-05T19:13:48Z",
    settled_at: null,
    status: "failed",
    pay: "pay_4Fj3nB2kQ",
    corr: "corr_6e3b80",
    note: "Card declined at the provider. Nothing to settle, no fee row.",
  }),
].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

/** The whole platform ledger fixture, newest first. Every row is MOCK. */
export const MOCK_LEDGER: LedgerPage = {
  rows: ROWS,
  summary: summarize(ROWS),
  next_cursor: null,
  provenance: "mock",
};

export function mockLedgerRow(id: string): LedgerRow | null {
  return ROWS.find((row) => row.id === id) ?? null;
}

/* ---------- issues, one credible case per kind, MOCK ---------- */

const rowByResource = (resource: string) =>
  ROWS.find((r) => r.provider_resource_id === resource) ?? null;

const ondaIssueSeller = { id: "sel_onda", name: "Onda Sounds", whop_account_id: null };
const AGE = 8 * 3600;

/**
 * The three kinds the resolution center distinguishes, in the contract's Issue JSON.
 * Candidate cases from a recorded reconciliation run, not claims of live incidents.
 * The missing payment is the deliberately injected demo fault and says so.
 */
export const MOCK_ISSUES: Issue[] = [
  {
    id: "iss_9f2a1c",
    kind: "missing_local_payment",
    seller: ondaIssueSeller,
    subject: { provider_resource_id: "pay_9Kx2mQ4rT" },
    impact:
      "A buyer paid 12.00 USD on Sep 07 and Onda Sounds has not been credited. No receipt, no transfer.",
    amounts: { provider: money(1200) },
    detected_at: "2026-09-08T10:14:26Z",
    age_seconds: AGE,
    status: "detected",
    next_safe_action: {
      id: "refetch",
      label: "Refetch from provider",
      reason: "Re-pull the provider record to confirm the discrepancy still exists.",
      available: true,
      provenance: "mock",
    },
    history: [
      {
        at: "2026-09-08T10:14:26Z",
        actor: "reconciliation run rec_0b31",
        action: "demo fault injected",
        outcome: "Provider lists pay_9Kx2mQ4rT as paid. No ledger row, no inbox delivery.",
        provenance: "mock",
      },
    ],
    provenance: "mock",
    simulated: true,
  },
  {
    id: "iss_7c4d88",
    kind: "unconfirmed_transfer",
    seller: ondaIssueSeller,
    subject: {
      order_id: "ord_7f3a9c",
      transfer_id: "tsf_9hK3pW1nR",
      provider_resource_id: "tsf_9hK3pW1nR",
    },
    impact:
      "Onda Sounds' share of order ord_7f3a9c, 55.20 USD, may or may not have moved. The seller cannot see it yet.",
    amounts: { local: money(5520) },
    detected_at: "2026-09-08T10:14:26Z",
    age_seconds: AGE,
    status: "investigating",
    next_safe_action: {
      id: "recheck",
      label: "Recheck",
      reason: "Re-run reconciliation to see whether the discrepancy has cleared.",
      available: true,
      provenance: "mock",
    },
    history: [
      {
        at: "2026-09-08T10:14:26Z",
        actor: "reconciliation run rec_0b31",
        action: "detected",
        outcome: "Local transfer pending. Provider returns no transfer for its idempotency key.",
        provenance: "mock",
      },
      {
        at: "2026-09-08T10:21:03Z",
        actor: "operator demo",
        action: "refetch",
        outcome:
          "Provider still returns nothing for tsf_9hK3pW1nR. Outcome unknown. No retry sent.",
        provenance: "mock",
        evidence_ref: `ledger ${rowByResource("tsf_9hK3pW1nR")?.id ?? "unknown"}`,
      },
    ],
    provenance: "mock",
    simulated: false,
  },
  {
    id: "iss_3e8b52",
    kind: "amount_mismatch",
    seller: ondaIssueSeller,
    subject: {
      order_id: "ord_7d40e8",
      transfer_id: "tsf_3wQ9nX7pL",
      provider_resource_id: "tsf_3wQ9nX7pL",
    },
    impact:
      "Onda Sounds' share of order ord_7d40e8 is 55.20 USD locally and 55.00 USD at the provider. 0.20 USD is unexplained.",
    amounts: { local: money(5520), provider: money(5500), difference: money(-20) },
    detected_at: "2026-09-08T10:14:26Z",
    age_seconds: AGE,
    status: "action_pending",
    next_safe_action: {
      id: "escalate",
      label: "Escalate",
      reason: "Hand this issue to a person for manual review.",
      available: true,
      provenance: "mock",
    },
    history: [
      {
        at: "2026-09-08T10:14:26Z",
        actor: "reconciliation run rec_0b31",
        action: "detected",
        outcome: "Local 55.20 USD, provider 55.00 USD. Difference recorded, not fixed.",
        provenance: "mock",
      },
    ],
    provenance: "mock",
    simulated: false,
  },
];

export const MOCK_ISSUES_PAGE: IssuesPage = { issues: MOCK_ISSUES, next_cursor: null };

export function mockIssue(id: string): Issue | null {
  return MOCK_ISSUES.find((issue) => issue.id === id) ?? null;
}

/** What POST /api/reconcile/{sellerId} would record. Kept for the ledger's reconcile control. */
export const MOCK_RECONCILIATION: ReconciliationRun = {
  id: "rec_0b31",
  seller_id: "sel_onda",
  recorded_at: "2026-09-08T10:14:26Z",
  provenance: "mock",
  issue_ids: MOCK_ISSUES.map((issue) => issue.id),
};
