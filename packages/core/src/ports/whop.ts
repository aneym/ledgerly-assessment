import type { WhopAccountId, WhopPaymentId, WhopTransferId } from "../ids";
import type { Money } from "../money";
import type { Result } from "../result";
import type { Country } from "../seller";
import type {
  WhopAccessToken,
  WhopAccount,
  WhopCheckout,
  WhopError,
  WhopLink,
  WhopPage,
  WhopPayment,
  WhopPaymentFee,
  WhopPaymentRecord,
  WhopRefund,
  WhopTransfer,
  WhopTransferRecord,
} from "./whop-types";
export type WhopResult<T> = Promise<Result<T, WhopError>>;

// Result types for the operations frozen from sandbox run-2026-09-08d
// (docs/lanes/architecture/sandbox-matrix.md). Each decoded type carries only the fields
// Ledgerly reads; the full provider body stays on `raw`, as WhopAccount does. Enums are the
// documented ones; where a value was observed live the fixture path is named in the matrix.
export type WhopAccountStatus = "active" | "suspended";
// POST /accounts/:id/suspend returns the Account object with status/status_reason set and
// capabilities/required_actions null; GET /accounts/:id after it shows the flipped capabilities.
export type WhopAccountSuspension = {
  id: WhopAccountId;
  status: WhopAccountStatus | null;
  statusReason: string | null;
  raw: unknown;
};
export type WhopRefundRecord = {
  id: string;
  paymentId: WhopPaymentId | null;
  status: string;
  amount: Money | null;
  createdAt: string;
  raw: unknown;
};
export type WhopTransferDetail = WhopTransferRecord & { raw: unknown };
export type WhopTransferRecipient = {
  id: string;
  type: "user" | "account";
  name: string | null;
  raw: unknown;
};
export type WhopPayoutStatus =
  | "requested"
  | "in_review"
  | "processing"
  | "completed"
  | "reversed"
  | "canceled"
  | "failed"
  | "denied";
export type WhopPayoutSpeed = "standard" | "instant";
export type WhopPayoutRecord = {
  id: string;
  status: WhopPayoutStatus;
  amount: Money | null;
  feeAmount: Money | null;
  netAmount: Money | null;
  speed: WhopPayoutSpeed | null;
  payoutMethodId: string | null;
  createdAt: string;
  raw: unknown;
};
export type WhopPayoutMethod = {
  id: string;
  currency: string | null;
  isDefault: boolean;
  raw: unknown;
};
export type WhopSupportedPayoutMethod = {
  id: string;
  name: string;
  deliveryType: string;
  supportsInstantDelivery: boolean;
  supportsStandardDelivery: boolean;
  raw: unknown;
};
export type WhopFeeMarkupType =
  | "crypto_withdrawal_markup"
  | "rtp_withdrawal_markup"
  | "next_day_bank_withdrawal_markup"
  | "bank_wire_withdrawal_markup"
  | "digital_wallet_withdrawal_markup"
  | "crypto_deposit_markup"
  | "bank_deposit_markup";
export type WhopFeeMarkup = {
  id: string;
  feeType: WhopFeeMarkupType;
  percentageFee: number | null;
  fixedFeeUsd: number | null;
  raw: unknown;
};
export type WhopTopup = { id: string; status: string | null; raw: unknown };
export type WhopWebhook = {
  id: string;
  url: string;
  enabled: boolean;
  events: string[];
  apiVersionDate: string;
  childResourceEvents: boolean;
  consecutiveFailures: number;
  disabledAt: string | null;
  // Only the create response carries the secret; every read returns null.
  webhookSecret: string | null;
  raw: unknown;
};
// Shared by POST /webhooks/:id/test and the delivery replay: the endpoint's HTTP status and
// raw body as the provider saw them.
export type WhopWebhookProbe = { status: number; body: string; success: boolean; raw: unknown };
export type WhopWebhookDelivery = {
  id: string;
  event: string | null;
  replayedFrom: string | null;
  resourceId: string;
  responseCode: number;
  sentAt: string;
  raw: unknown;
};
export type WhopApiKeySystemRole = "owner" | "admin" | "moderator" | "sales_manager" | "advertiser";
export type WhopApiKeyPermissions =
  | { systemRole: WhopApiKeySystemRole }
  | { statements: Array<{ actions: string[]; grant: boolean; resources?: string[] }> };
export type WhopApiKey = {
  id: string;
  // Returned once on create, never on a read.
  secretKey: string | null;
  raw: unknown;
};
export type WhopApiKeyPermission = {
  action: string;
  name: string;
  allowedOnApiKey: boolean;
  grantedToSystemRoles: WhopApiKeySystemRole[];
  raw: unknown;
};
// GET /financial-activity row. `amount` is the provider's signed value in the row currency
// converted to minor units; null when it does not divide into minor units. `usdAmount` is
// the provider's signed decimal string, kept verbatim for reconciliation.
export type WhopLedgerLine = {
  id: string;
  lineType: string;
  amount: Money | null;
  usdAmount: string;
  postedAt: string;
  availableAt: string | null;
  paymentId: WhopPaymentId | null;
  source: { type: string; id: string } | null;
  raw: unknown;
};
export type WhopLedgerBalance = {
  currency: Money["currency"];
  available: Money;
  pending: Money;
  reserve: Money;
};
export type WhopLedgerAccount = {
  id: string;
  ownerId: WhopAccountId;
  balances: WhopLedgerBalance[];
  settlementTimeAt: string | null;
  payoutQuoteRequired: boolean;
  raw: unknown;
};
export type WhopDisputeStatus = "needs_response" | "under_review" | "won" | "lost" | "closed";
export type WhopDisputeRecord = {
  id: string;
  paymentId: WhopPaymentId | null;
  status: WhopDisputeStatus;
  amount: Money | null;
  evidenceDueAt: string | null;
  createdAt: string;
  raw: unknown;
};
export interface WhopPort {
  createAccount(
    input: {
      externalId: string;
      runId: string;
      email: string;
      country: Country;
      title: string;
      priorAccountId?: WhopAccountId;
    },
    idempotencyKey: string,
  ): WhopResult<WhopAccount>;
  updateAccount(
    accountId: WhopAccountId,
    input: { country?: Country; title?: string; metadata?: Record<string, string> },
    idempotencyKey: string,
  ): WhopResult<WhopAccount>;
  listPayments(input: {
    accountId: WhopAccountId;
    cursor?: string;
  }): WhopResult<WhopPage<WhopPaymentRecord>>;
  listTransfers(input: {
    accountId: WhopAccountId;
    cursor?: string;
    // GET /transfers requires origin_id or destination_id (run-2026-09-08d,
    // list-transfers-unfiltered.json: 400 without one). Default "origin".
    direction?: "origin" | "destination";
  }): WhopResult<WhopPage<WhopTransferRecord>>;
  createOrFetchAccount(
    input: {
      externalId: string;
      email: string;
      country: Country;
      title: string;
      runId?: string;
      priorAccountId?: WhopAccountId;
    },
    idempotencyKey: string,
  ): WhopResult<WhopAccount>;
  createOnboardingLink(
    input: { accountId: WhopAccountId; returnUrl: string; refreshUrl: string },
    idempotencyKey: string,
  ): WhopResult<WhopLink>;
  createCheckoutConfiguration(
    input: {
      accountId: WhopAccountId | null;
      productTitle: string;
      productExternalId?: string;
      price: Money;
      applicationFee: Money | null;
      redirectUrl: string;
    },
    idempotencyKey: string,
  ): WhopResult<WhopCheckout>;
  getAccount(accountId: WhopAccountId, idempotencyKey: string): WhopResult<WhopAccount>;
  getPayment(paymentId: WhopPaymentId, idempotencyKey: string): WhopResult<WhopPayment>;
  listPaymentFees(paymentId: WhopPaymentId, idempotencyKey: string): WhopResult<WhopPaymentFee[]>;
  refundPayment(
    paymentId: WhopPaymentId,
    idempotencyKey: string,
    partial?: Money,
  ): WhopResult<WhopRefund>;
  createTransfer(
    input: {
      originId: WhopAccountId;
      destinationId: WhopAccountId;
      amount: Money;
      metadata: Record<string, string>;
    },
    idempotencyKey: string,
  ): WhopResult<WhopTransfer>;
  createAccessToken(
    input: { accountId: WhopAccountId; scopedActions: string[]; expiresAt: Date },
    idempotencyKey: string,
  ): WhopResult<WhopAccessToken>;
  createPayoutPortalLink(
    input: { accountId: WhopAccountId; returnUrl: string },
    idempotencyKey: string,
  ): WhopResult<WhopLink>;

  // Frozen from sandbox run-2026-09-08d. Paths live in WHOP_OPERATION_ROUTES
  // (packages/whop/src/sandbox-adapter.ts); sandbox status per operation is in
  // docs/lanes/architecture/sandbox-matrix.md. Reads that take an idempotencyKey follow
  // getAccount's style; list reads take none, like listPayments.

  // Accounts
  // Idempotent server-side: a repeat on an already suspended account returns 200.
  suspendAccount(
    accountId: WhopAccountId,
    idempotencyKey: string,
  ): WhopResult<WhopAccountSuspension>;

  // Checkout
  // The response never echoes application_fee_amount; the fee is only visible on
  // listPaymentFees after a purchase.
  getCheckoutConfiguration(
    checkoutConfigurationId: string,
    idempotencyKey: string,
  ): WhopResult<WhopCheckout>;

  // Refunds and disputes
  // The provider requires exactly one of payment_id or company_id.
  listRefunds(
    input:
      | { paymentId: WhopPaymentId; cursor?: string }
      | { accountId: WhopAccountId; cursor?: string },
  ): WhopResult<WhopPage<WhopRefundRecord>>;
  getRefund(refundId: string, idempotencyKey: string): WhopResult<WhopRefundRecord>;
  // company_id is required by the live sandbox even though the docs mark it optional.
  listDisputes(input: {
    accountId: WhopAccountId;
    status?: WhopDisputeStatus[];
    cursor?: string;
  }): WhopResult<WhopPage<WhopDisputeRecord>>;
  getDispute(disputeId: string, idempotencyKey: string): WhopResult<WhopDisputeRecord>;

  // Transfers
  getTransfer(transferId: WhopTransferId, idempotencyKey: string): WhopResult<WhopTransferDetail>;
  // Lists users the origin can send to. Connected child accounts are not returned.
  listTransferRecipients(input: {
    originId: WhopAccountId;
    cursor?: string;
  }): WhopResult<WhopPage<WhopTransferRecipient>>;

  // Payouts
  listPayouts(input: {
    accountId: WhopAccountId;
    status?: WhopPayoutStatus;
    cursor?: string;
  }): WhopResult<WhopPage<WhopPayoutRecord>>;
  // GET /payouts/:id requires account_id (or user_id) as a query parameter.
  getPayout(
    input: { payoutId: string; accountId: WhopAccountId },
    idempotencyKey: string,
  ): WhopResult<WhopPayoutRecord>;
  createPayout(
    input: {
      accountId: WhopAccountId;
      amount: Money;
      payoutMethodId: string;
      speed?: WhopPayoutSpeed;
      statementDescriptor?: string;
      notes?: string;
      // Required when the ledger account reports payout_quote_required.
      quoteToken?: string;
      metadata?: Record<string, string>;
    },
    idempotencyKey: string,
  ): WhopResult<WhopPayoutRecord>;
  listPayoutMethods(input: {
    accountId: WhopAccountId;
    cursor?: string;
  }): WhopResult<WhopPage<WhopPayoutMethod>>;
  listSupportedPayoutMethods(input: {
    accountId: WhopAccountId;
    country?: Country;
    amount?: Money;
    cursor?: string;
  }): WhopResult<WhopPage<WhopSupportedPayoutMethod>>;

  // Fee markups. Create is an upsert on (account_id, fee_type); there is no retrieve by id.
  listFeeMarkups(input: {
    accountId: WhopAccountId;
    cursor?: string;
  }): WhopResult<WhopPage<WhopFeeMarkup>>;
  createFeeMarkup(
    input: {
      accountId: WhopAccountId;
      feeType: WhopFeeMarkupType;
      percentageFee?: number | null;
      fixedFeeUsd?: number | null;
      notes?: string;
    },
    idempotencyKey: string,
  ): WhopResult<WhopFeeMarkup>;

  // Topups charge a stored payment method. Spending gate: Alex approves each call.
  createTopup(
    input: { accountId: WhopAccountId; amount: Money; paymentMethodId: string },
    idempotencyKey: string,
  ): WhopResult<WhopTopup>;

  // Webhooks. accountId maps to the company_id query parameter on the list.
  listWebhooks(input: {
    accountId: WhopAccountId;
    cursor?: string;
  }): WhopResult<WhopPage<WhopWebhook>>;
  getWebhook(webhookId: string, idempotencyKey: string): WhopResult<WhopWebhook>;
  createWebhook(
    input: {
      url: string;
      events: string[];
      enabled?: boolean;
      childResourceEvents?: boolean;
      apiVersionDate?: string;
    },
    idempotencyKey: string,
  ): WhopResult<WhopWebhook>;
  updateWebhook(
    webhookId: string,
    input: { url?: string; events?: string[]; enabled?: boolean },
    idempotencyKey: string,
  ): WhopResult<WhopWebhook>;
  sendWebhookTest(
    input: { webhookId: string; event: string },
    idempotencyKey: string,
  ): WhopResult<WhopWebhookProbe>;
  listWebhookDeliveries(input: {
    webhookId: string;
    first?: number;
    cursor?: string;
  }): WhopResult<WhopPage<WhopWebhookDelivery>>;
  // regenerateId false keeps the original webhook-id, so a receiver with dedupe answers
  // duplicate; true mints a fresh id and produces a new inbox row.
  replayWebhookDelivery(
    input: { webhookId: string; deliveryId: string; regenerateId?: boolean },
    idempotencyKey: string,
  ): WhopResult<WhopWebhookProbe>;

  // API keys. The sandbox refuses createApiKey for every Company API key (403,
  // developer:manage_api_key is never grantable to a key); declared so the mock can stand in.
  createApiKey(
    input: {
      accountId: WhopAccountId;
      name: string;
      permissions: WhopApiKeyPermissions;
      expiresAt?: Date;
    },
    idempotencyKey: string,
  ): WhopResult<WhopApiKey>;
  listApiKeyPermissions(input: { cursor?: string }): WhopResult<WhopPage<WhopApiKeyPermission>>;

  // Ledger. Platform fee income is only visible with lineTypes ["application_fee_payout"];
  // the default category set hides it.
  listFinancialActivity(input: {
    accountId: WhopAccountId;
    cursor?: string;
    limit?: number;
    direction?: "money_in" | "money_out";
    lineTypes?: string[];
    postedAfter?: Date;
    postedBefore?: Date;
    includeResource?: boolean;
  }): WhopResult<WhopPage<WhopLedgerLine>>;
  // Replaces the balances read: GET /accounts/:id/balances does not exist (404).
  getLedgerAccount(accountId: WhopAccountId, idempotencyKey: string): WhopResult<WhopLedgerAccount>;
}
