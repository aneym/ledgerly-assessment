import {
  err,
  fromDecimalString,
  type Money,
  money,
  ok,
  toDecimalString,
  type WhopAccountId,
  type WhopPort,
  whopAccountId,
  whopPaymentId,
  whopTransferId,
} from "@ledgerly/core";
import { z } from "zod";
import type { WhopClient } from "./client";

// Static METHOD/path per operation, matching the literal client.request() calls this
// adapter makes below. Exported so a caller that never reaches this adapter's real
// request — a mock-routed call, or a gated/credential-missing short-circuit in
// packages/whop/src/hybrid-adapter.ts — can label its synthetic instrumentation frame
// with the same method and path a sandbox call would have used. Dynamic id segments are
// written as :paramName placeholders, since a synthetic frame has no real request to read
// them from.
export const WHOP_OPERATION_ROUTES: Readonly<
  Record<keyof WhopPort, { method: string; path: string }>
> = {
  createAccount: { method: "POST", path: "/accounts" },
  createOrFetchAccount: { method: "POST", path: "/accounts" },
  updateAccount: { method: "PATCH", path: "/accounts/:accountId" },
  getAccount: { method: "GET", path: "/accounts/:accountId" },
  createOnboardingLink: { method: "POST", path: "/account_links" },
  createCheckoutConfiguration: { method: "POST", path: "/checkout_configurations" },
  getPayment: { method: "GET", path: "/payments/:paymentId" },
  listPaymentFees: { method: "GET", path: "/payments/:paymentId/fees" },
  refundPayment: { method: "POST", path: "/payments/:paymentId/refund" },
  listPayments: { method: "GET", path: "/payments" },
  listTransfers: { method: "GET", path: "/transfers" },
  createTransfer: { method: "POST", path: "/transfers" },
  createAccessToken: { method: "POST", path: "/access_tokens" },
  createPayoutPortalLink: { method: "POST", path: "/account_links" },
  // Frozen from sandbox run-2026-09-08d; see docs/lanes/architecture/sandbox-matrix.md.
  suspendAccount: { method: "POST", path: "/accounts/:accountId/suspend" },
  getCheckoutConfiguration: {
    method: "GET",
    path: "/checkout_configurations/:checkoutConfigurationId",
  },
  listRefunds: { method: "GET", path: "/refunds" },
  getRefund: { method: "GET", path: "/refunds/:refundId" },
  listDisputes: { method: "GET", path: "/disputes" },
  getDispute: { method: "GET", path: "/disputes/:disputeId" },
  getTransfer: { method: "GET", path: "/transfers/:transferId" },
  listTransferRecipients: { method: "GET", path: "/transfers/recipients" },
  listPayouts: { method: "GET", path: "/payouts" },
  getPayout: { method: "GET", path: "/payouts/:payoutId" },
  createPayout: { method: "POST", path: "/payouts" },
  listPayoutMethods: { method: "GET", path: "/payout_methods" },
  listSupportedPayoutMethods: { method: "GET", path: "/payouts/supported_methods" },
  listFeeMarkups: { method: "GET", path: "/fee_markups" },
  createFeeMarkup: { method: "POST", path: "/fee_markups" },
  createTopup: { method: "POST", path: "/topups" },
  listWebhooks: { method: "GET", path: "/webhooks" },
  getWebhook: { method: "GET", path: "/webhooks/:webhookId" },
  createWebhook: { method: "POST", path: "/webhooks" },
  updateWebhook: { method: "PATCH", path: "/webhooks/:webhookId" },
  sendWebhookTest: { method: "POST", path: "/webhooks/:webhookId/test" },
  listWebhookDeliveries: { method: "GET", path: "/webhooks/:webhookId/deliveries" },
  replayWebhookDelivery: {
    method: "POST",
    path: "/webhooks/:webhookId/deliveries/:deliveryId/replay",
  },
  createApiKey: { method: "POST", path: "/api_keys" },
  listApiKeyPermissions: { method: "GET", path: "/api_keys/permissions" },
  listFinancialActivity: { method: "GET", path: "/financial-activity" },
  getLedgerAccount: { method: "GET", path: "/ledger_accounts/:ledgerAccountId" },
};

import { validCheckout, validToken } from "./validation";

const accountSchema = z.looseObject({
  id: z.string().regex(/^biz_.+/),
  country: z
    .string()
    .regex(/^[a-zA-Z]{2}$/)
    .optional(),
  parent_account: z
    .looseObject({
      id: z.string().regex(/^biz_.+/),
      title: z.string().nullable().optional(),
      route: z.string().nullable().optional(),
      logo_url: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
function accountResult(raw: z.infer<typeof accountSchema>) {
  const id = whopAccountId(raw.id);
  if (!id.ok) throw new Error("Validated account ID is invalid");
  const parent = raw.parent_account ? whopAccountId(raw.parent_account.id) : null;
  if (parent && !parent.ok) throw new Error("Validated parent ID is invalid");
  return {
    id: id.value,
    raw,
    ...(raw.country === undefined ? {} : { country: raw.country.toUpperCase() }),
    ...(raw.parent_account === undefined ? {} : { parentAccountId: parent?.value ?? null }),
  };
}
const checkoutSchema = z.looseObject({
  id: z.string().min(1),
  purchase_url: z.string().min(1).optional(),
  plan: z
    .looseObject({
      currency: z.enum(["usd", "eur", "brl", "USD", "EUR", "BRL"]).optional(),
      application_fee_amount: z.union([z.string(), z.number()]).nullable().optional(),
    })
    .nullable()
    .optional(),
});
const paymentSchema = z.looseObject({ id: z.string().regex(/^pay_.+/) });
const resourceSchema = z.looseObject({ id: z.string().min(1) });
const linkSchema = z.looseObject({ url: z.url() });
const tokenSchema = z.looseObject({ token: z.string().min(1) });
const feeSchema = z.looseObject({
  amount: z.looseObject({
    amount: z.string(),
    currency: z.enum(["usd", "eur", "brl", "USD", "EUR", "BRL"]),
  }),
});
const currencySchema = z.enum(["usd", "eur", "brl", "USD", "EUR", "BRL"]);
const paymentRecordSchema = z.object({
  id: z.string().regex(/^pay_.+/),
  status: z.string().min(1),
  total: z.object({ amount: z.string(), currency: currencySchema }).nullable(),
  currency: currencySchema,
  created_at: z.iso.datetime({ offset: true }),
  account_id: z
    .string()
    .regex(/^biz_.+/)
    .nullable(),
});
const pageInfoSchema = z
  .object({ end_cursor: z.string().min(1).nullable(), has_next_page: z.boolean() })
  .refine((value) => !value.has_next_page || value.end_cursor !== null);
// Run-d fixtures pin the live envelopes. Empty/error-only fixtures use the
// corresponding docs/sources/whop API snapshot for the success fields below.
const nonempty = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
function decodedMoney(value: string | number, currency: string, ctx: z.RefinementCtx): Money {
  // Extra trailing zeroes do not change precision (e.g. provider "1.0000").
  const text = String(value)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  const result = fromDecimalString(text, currency.toUpperCase() as Money["currency"]);
  if (result.ok) return result.value;
  ctx.addIssue({ code: "custom", message: "Invalid or unrepresentable money" });
  return z.NEVER;
}
function decodedId<T>(result: { ok: true; value: T } | { ok: false }, ctx: z.RefinementCtx): T {
  if (result.ok) return result.value;
  ctx.addIssue({ code: "custom", message: "Invalid provider identifier" });
  return z.NEVER;
}
const providerMoneySchema = z.looseObject({ amount: decimal, currency: currencySchema });
const refundRecordSchema = z
  .looseObject({
    id: nonempty,
    payment_id: nonempty.nullable(),
    status: nonempty,
    amount: providerMoneySchema.nullable(),
    created_at: timestamp,
  })
  .transform((raw, ctx) => ({
    id: raw.id,
    paymentId: raw.payment_id === null ? null : decodedId(whopPaymentId(raw.payment_id), ctx),
    status: raw.status,
    amount: raw.amount === null ? null : decodedMoney(raw.amount.amount, raw.amount.currency, ctx),
    createdAt: raw.created_at,
    raw,
  }));
const disputeRecordSchema = z
  .looseObject({
    id: nonempty,
    payment: z.looseObject({ id: nonempty }).nullable(),
    status: z.enum(["needs_response", "under_review", "won", "lost", "closed"]),
    amount: z.number(),
    currency: currencySchema,
    evidence_due_at: timestamp.nullable(),
    created_at: timestamp,
  })
  .transform((raw, ctx) => ({
    id: raw.id,
    paymentId: raw.payment === null ? null : decodedId(whopPaymentId(raw.payment.id), ctx),
    status: raw.status,
    amount: decodedMoney(raw.amount, raw.currency, ctx),
    evidenceDueAt: raw.evidence_due_at,
    createdAt: raw.created_at,
    raw,
  }));
const transferPartySchema = z.looseObject({ id: nonempty, typename: z.enum(["Company", "User"]) });
const transferDetailSchema = z
  .looseObject({
    id: nonempty,
    status: nonempty,
    amount: z.number(),
    currency: currencySchema,
    created_at: timestamp,
    origin: transferPartySchema,
    destination: transferPartySchema,
  })
  .transform((raw, ctx) => {
    const amount = decodedMoney(raw.amount, raw.currency, ctx);
    return {
      id: decodedId(whopTransferId(raw.id), ctx),
      status: raw.status,
      amount,
      currency: amount.currency,
      createdAt: raw.created_at,
      origin: { id: raw.origin.id, type: raw.origin.typename },
      destination: { id: raw.destination.id, type: raw.destination.typename },
      raw,
    };
  });
const recipientSchema = z
  .looseObject({
    id: nonempty,
    object: z.enum(["user", "account"]),
    name: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
  })
  .transform((raw) => ({ id: raw.id, type: raw.object, name: raw.name ?? raw.title ?? null, raw }));
const payoutSchema = z
  .looseObject({
    id: nonempty,
    status: z.enum([
      "requested",
      "in_review",
      "processing",
      "completed",
      "reversed",
      "canceled",
      "failed",
      "denied",
    ]),
    amount: decimal.nullable(),
    fee_amount: decimal.nullable(),
    net_amount: decimal.nullable(),
    currency: currencySchema,
    speed: z.enum(["standard", "instant"]).nullable(),
    payout_method_id: nonempty.nullable().optional(),
    created_at: timestamp,
  })
  .transform((raw, ctx) => ({
    id: raw.id,
    status: raw.status,
    amount: raw.amount === null ? null : decodedMoney(raw.amount, raw.currency, ctx),
    feeAmount: raw.fee_amount === null ? null : decodedMoney(raw.fee_amount, raw.currency, ctx),
    netAmount: raw.net_amount === null ? null : decodedMoney(raw.net_amount, raw.currency, ctx),
    speed: raw.speed,
    payoutMethodId: raw.payout_method_id ?? null,
    createdAt: raw.created_at,
    raw,
  }));
const payoutMethodSchema = z
  .looseObject({
    id: nonempty,
    currency: nonempty.nullable(),
    is_default: z.boolean(),
  })
  .transform((raw) => ({ id: raw.id, currency: raw.currency, isDefault: raw.is_default, raw }));
const supportedPayoutMethodSchema = z
  .looseObject({
    id: nonempty,
    name: z.string().nullable(),
    delivery_type: nonempty,
    supports_instant_delivery: z.boolean(),
    supports_standard_delivery: z.boolean(),
  })
  .transform((raw) => ({
    id: raw.id,
    name: raw.name ?? raw.id,
    deliveryType: raw.delivery_type,
    supportsInstantDelivery: raw.supports_instant_delivery,
    supportsStandardDelivery: raw.supports_standard_delivery,
    raw,
  }));
const feeMarkupSchema = z
  .looseObject({
    id: nonempty,
    fee_type: z.enum([
      "crypto_withdrawal_markup",
      "rtp_withdrawal_markup",
      "next_day_bank_withdrawal_markup",
      "bank_wire_withdrawal_markup",
      "digital_wallet_withdrawal_markup",
      "crypto_deposit_markup",
      "bank_deposit_markup",
    ]),
    percentage_fee: z.number().nullable(),
    fixed_fee_usd: z.number().nullable(),
  })
  .transform((raw) => ({
    id: raw.id,
    feeType: raw.fee_type,
    percentageFee: raw.percentage_fee,
    fixedFeeUsd: raw.fixed_fee_usd,
    raw,
  }));
const webhookSchema = z
  .looseObject({
    id: nonempty,
    resource_id: nonempty,
    url: z.url(),
    enabled: z.boolean(),
    events: z.array(nonempty),
    api_version_date: nonempty,
    child_resource_events: z.boolean(),
    consecutive_failures: z.number().int().nonnegative(),
    disabled_at: timestamp.nullable(),
    webhook_secret: z.string().nullable(),
  })
  .transform((raw) => ({
    id: raw.id,
    resourceId: raw.resource_id,
    url: raw.url,
    enabled: raw.enabled,
    events: raw.events,
    apiVersionDate: raw.api_version_date,
    childResourceEvents: raw.child_resource_events,
    consecutiveFailures: raw.consecutive_failures,
    disabledAt: raw.disabled_at,
    webhookSecret: raw.webhook_secret,
    raw,
  }));
const webhookProbeSchema = z
  .looseObject({ status: z.number().int(), body: z.string(), success: z.boolean() })
  .transform((raw) => ({ status: raw.status, body: raw.body, success: raw.success, raw }));
const webhookDeliverySchema = z
  .looseObject({
    id: nonempty,
    event: nonempty.nullable(),
    replayed_from: nonempty.nullable(),
    resource_id: nonempty,
    response_code: z.number().int(),
    sent_at: timestamp,
  })
  .transform((raw) => ({
    id: raw.id,
    event: raw.event,
    replayedFrom: raw.replayed_from,
    resourceId: raw.resource_id,
    responseCode: raw.response_code,
    sentAt: raw.sent_at,
    raw,
  }));
const apiKeySchema = z
  .looseObject({ id: nonempty, secret_key: nonempty.nullable() })
  .transform((raw) => ({ id: raw.id, secretKey: raw.secret_key, raw }));
const apiKeyPermissionSchema = z
  .looseObject({
    action: nonempty,
    name: z.string(),
    allowed_on_api_key: z.boolean(),
    granted_to_system_roles: z.array(
      z.enum(["owner", "admin", "moderator", "sales_manager", "advertiser"]),
    ),
  })
  .transform((raw) => ({
    action: raw.action,
    name: raw.name,
    allowedOnApiKey: raw.allowed_on_api_key,
    grantedToSystemRoles: raw.granted_to_system_roles,
    raw,
  }));
const ledgerLineSchema = z
  .looseObject({
    id: nonempty,
    line_type: nonempty,
    amount: z.string().regex(/^-?\d+$/),
    usd_amount: decimal,
    currency: z.looseObject({ code: currencySchema, precision: z.string().regex(/^[1-9]\d*$/) }),
    posted_at: timestamp,
    available_at: timestamp.nullable(),
    payment_id: nonempty.nullable(),
    source: z.looseObject({ object: nonempty, id: nonempty }).nullable(),
  })
  .transform((raw, ctx) => {
    // Ledger activity uses integer strings scaled by currency.precision, not major units.
    const scaled = BigInt(raw.amount) * 100n;
    const precision = BigInt(raw.currency.precision);
    const minor = scaled / precision;
    const currency = raw.currency.code.toUpperCase() as Money["currency"];
    let amount: Money | null = null;
    if (scaled % precision === 0n) {
      const result = money(Number(minor), currency);
      if (!result.ok) {
        ctx.addIssue({ code: "custom", message: "Ledger amount overflow" });
        return z.NEVER;
      }
      amount = result.value;
    }
    return {
      id: raw.id,
      lineType: raw.line_type,
      amount,
      usdAmount: raw.usd_amount,
      postedAt: raw.posted_at,
      availableAt: raw.available_at,
      paymentId: raw.payment_id === null ? null : decodedId(whopPaymentId(raw.payment_id), ctx),
      source: raw.source === null ? null : { type: raw.source.object, id: raw.source.id },
      raw,
    };
  });
const ledgerAccountSchema = z
  .looseObject({
    id: nonempty,
    owner: z.looseObject({ id: nonempty }),
    settlement_time_at: timestamp.nullable(),
    payout_quote_required: z.boolean(),
    balances: z.array(
      z.looseObject({
        currency: currencySchema,
        balance: z.number(),
        pending_balance: z.number(),
        reserve_balance: z.number(),
      }),
    ),
  })
  .transform((raw, ctx) => ({
    id: raw.id,
    ownerId: decodedId(whopAccountId(raw.owner.id), ctx),
    balances: raw.balances.map((row) => ({
      currency: row.currency.toUpperCase() as Money["currency"],
      available: decodedMoney(row.balance, row.currency, ctx),
      pending: decodedMoney(row.pending_balance, row.currency, ctx),
      reserve: decodedMoney(row.reserve_balance, row.currency, ctx),
    })),
    settlementTimeAt: raw.settlement_time_at,
    payoutQuoteRequired: raw.payout_quote_required,
    raw,
  }));
function pageSchema<T>(item: z.ZodType<T>) {
  return z.looseObject({ data: z.array(item), page_info: pageInfoSchema }).transform((page) => ({
    items: page.data,
    nextCursor: page.page_info.has_next_page ? page.page_info.end_cursor : null,
  }));
}
function queryPath(
  path: string,
  values: Record<string, string | number | boolean | string[] | undefined>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) for (const item of value) query.append(key, item);
    else if (value !== undefined) query.set(key, String(value));
  }
  return query.size ? `${path}?${query}` : path;
}
function validPositiveMoney(value: Money) {
  return money(value.amountMinor, value.currency).ok && value.amountMinor > 0;
}

export function createSandboxAdapter(options: {
  client: WhopClient;
  parentAccountId: WhopAccountId;
  now?: () => Date;
}): WhopPort {
  const { client } = options;
  const knownIds = new Set<string>();
  const originLedgerIds = new Map<WhopAccountId, ReturnType<typeof resolveOriginLedger>>();
  function resolveOriginLedger(accountId: WhopAccountId) {
    return client.request("GET", `/ledger_accounts/${encodeURIComponent(accountId)}`, {
      schema: z.object({ id: z.string().regex(/^ldgr_.+$/) }),
    });
  }
  const adapter: WhopPort = {
    async suspendAccount(accountId, idempotencyKey) {
      return client.request("POST", `/accounts/${encodeURIComponent(accountId)}/suspend`, {
        idempotencyKey,
        schema: accountSchema
          .extend({
            status: z.enum(["active", "suspended"]).nullable(),
            status_reason: z.string().nullable(),
          })
          .transform((raw, ctx) => ({
            id: decodedId(whopAccountId(raw.id), ctx),
            status: raw.status,
            statusReason: raw.status_reason,
            raw,
          })),
      });
    },
    async getCheckoutConfiguration(checkoutConfigurationId, idempotencyKey) {
      return client.request(
        "GET",
        `/checkout_configurations/${encodeURIComponent(checkoutConfigurationId)}`,
        {
          idempotencyKey,
          schema: checkoutSchema.transform((raw, ctx) => ({
            id: raw.id,
            raw,
            ...(raw.purchase_url === undefined ? {} : { purchaseUrl: raw.purchase_url }),
            ...(raw.plan?.application_fee_amount === undefined
              ? {}
              : {
                  applicationFee:
                    raw.plan.application_fee_amount === null
                      ? null
                      : decodedMoney(raw.plan.application_fee_amount, raw.plan.currency ?? "", ctx),
                }),
          })),
        },
      );
    },
    async listRefunds(input) {
      return client.request(
        "GET",
        queryPath("/refunds", {
          payment_id: "paymentId" in input ? input.paymentId : undefined,
          company_id: "accountId" in input ? input.accountId : undefined,
          after: input.cursor,
        }),
        { schema: pageSchema(refundRecordSchema) },
      );
    },
    async getRefund(refundId, idempotencyKey) {
      return client.request("GET", `/refunds/${encodeURIComponent(refundId)}`, {
        idempotencyKey,
        schema: refundRecordSchema,
      });
    },
    async listDisputes(input) {
      return client.request(
        "GET",
        queryPath("/disputes", {
          company_id: input.accountId,
          status: input.status,
          after: input.cursor,
        }),
        { schema: pageSchema(disputeRecordSchema) },
      );
    },
    async getDispute(disputeId, idempotencyKey) {
      return client.request("GET", `/disputes/${encodeURIComponent(disputeId)}`, {
        idempotencyKey,
        schema: disputeRecordSchema,
      });
    },
    async getTransfer(transferId, idempotencyKey) {
      return client.request("GET", `/transfers/${encodeURIComponent(transferId)}`, {
        idempotencyKey,
        schema: transferDetailSchema,
      });
    },
    async listTransferRecipients(input) {
      return client.request(
        "GET",
        queryPath("/transfers/recipients", { origin_id: input.originId, after: input.cursor }),
        { schema: pageSchema(recipientSchema) },
      );
    },
    async listPayouts(input) {
      return client.request(
        "GET",
        queryPath("/payouts", {
          account_id: input.accountId,
          status: input.status,
          after: input.cursor,
        }),
        { schema: pageSchema(payoutSchema) },
      );
    },
    async getPayout(input, idempotencyKey) {
      return client.request(
        "GET",
        queryPath(`/payouts/${encodeURIComponent(input.payoutId)}`, {
          account_id: input.accountId,
        }),
        { idempotencyKey, schema: payoutSchema },
      );
    },
    async createPayout(input, idempotencyKey) {
      if (!validPositiveMoney(input.amount)) return err({ kind: "invalid_request" });
      return client.request("POST", "/payouts", {
        body: {
          account_id: input.accountId,
          amount: Number(toDecimalString(input.amount)),
          currency: input.amount.currency.toLowerCase(),
          payout_method_id: input.payoutMethodId,
          speed: input.speed,
          statement_descriptor: input.statementDescriptor,
          notes: input.notes,
          quote_token: input.quoteToken,
          metadata: input.metadata,
        },
        idempotencyKey,
        schema: payoutSchema,
      });
    },
    async listPayoutMethods(input) {
      return client.request(
        "GET",
        queryPath("/payout_methods", { account_id: input.accountId, after: input.cursor }),
        { schema: pageSchema(payoutMethodSchema) },
      );
    },
    async listSupportedPayoutMethods(input) {
      if (input.amount !== undefined && !validPositiveMoney(input.amount))
        return err({ kind: "invalid_request" });
      return client.request(
        "GET",
        queryPath("/payouts/supported_methods", {
          account_id: input.accountId,
          country: input.country?.toLowerCase(),
          after: input.cursor,
          amount: input.amount === undefined ? undefined : toDecimalString(input.amount),
          currency: input.amount?.currency.toLowerCase(),
        }),
        { schema: pageSchema(supportedPayoutMethodSchema) },
      );
    },
    async listFeeMarkups(input) {
      return client.request(
        "GET",
        queryPath("/fee_markups", { account_id: input.accountId, after: input.cursor }),
        { schema: pageSchema(feeMarkupSchema) },
      );
    },
    async createFeeMarkup(input, idempotencyKey) {
      return client.request("POST", "/fee_markups", {
        body: {
          account_id: input.accountId,
          fee_type: input.feeType,
          percentage_fee: input.percentageFee,
          fixed_fee_usd: input.fixedFeeUsd,
          notes: input.notes,
        },
        idempotencyKey,
        schema: feeMarkupSchema,
      });
    },
    async createTopup(input, idempotencyKey) {
      if (!validPositiveMoney(input.amount)) return err({ kind: "invalid_request" });
      return client.request("POST", "/topups", {
        body: {
          account_id: input.accountId,
          amount: Number(toDecimalString(input.amount)),
          currency: input.amount.currency.toLowerCase(),
          payment_method_id: input.paymentMethodId,
        },
        idempotencyKey,
        schema: z
          .looseObject({ id: nonempty, status: nonempty.nullable() })
          .transform((raw) => ({ id: raw.id, status: raw.status, raw })),
      });
    },
    async listWebhooks(input) {
      return client.request(
        "GET",
        queryPath("/webhooks", { company_id: input.accountId, after: input.cursor }),
        { schema: pageSchema(webhookSchema) },
      );
    },
    async getWebhook(webhookId, idempotencyKey) {
      return client.request("GET", `/webhooks/${encodeURIComponent(webhookId)}`, {
        idempotencyKey,
        schema: webhookSchema,
      });
    },
    async createWebhook(input, idempotencyKey) {
      return client.request("POST", "/webhooks", {
        body: {
          url: input.url,
          events: input.events,
          enabled: input.enabled,
          child_resource_events: input.childResourceEvents,
          api_version_date: input.apiVersionDate,
        },
        idempotencyKey,
        schema: webhookSchema,
      });
    },
    async updateWebhook(webhookId, input, idempotencyKey) {
      return client.request("PATCH", `/webhooks/${encodeURIComponent(webhookId)}`, {
        body: { url: input.url, events: input.events, enabled: input.enabled },
        idempotencyKey,
        schema: webhookSchema,
      });
    },
    async sendWebhookTest(input, idempotencyKey) {
      return client.request("POST", `/webhooks/${encodeURIComponent(input.webhookId)}/test`, {
        body: { event: input.event },
        idempotencyKey,
        schema: webhookProbeSchema,
      });
    },
    async listWebhookDeliveries(input) {
      return client.request(
        "GET",
        queryPath(`/webhooks/${encodeURIComponent(input.webhookId)}/deliveries`, {
          first: input.first,
          after: input.cursor,
        }),
        { schema: pageSchema(webhookDeliverySchema) },
      );
    },
    async replayWebhookDelivery(input, idempotencyKey) {
      return client.request(
        "POST",
        `/webhooks/${encodeURIComponent(input.webhookId)}/deliveries/${encodeURIComponent(input.deliveryId)}/replay`,
        {
          body: { regenerate_id: input.regenerateId },
          idempotencyKey,
          schema: webhookProbeSchema,
        },
      );
    },
    async createApiKey(input, idempotencyKey) {
      if (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt.getTime()))
        return err({ kind: "invalid_request" });
      return client.request("POST", "/api_keys", {
        body: {
          resource_id: input.accountId,
          resource_type: "account",
          name: input.name,
          permissions:
            "systemRole" in input.permissions
              ? { system_role: input.permissions.systemRole }
              : { statements: input.permissions.statements },
          expires_at: input.expiresAt?.toISOString(),
        },
        idempotencyKey,
        schema: apiKeySchema,
      });
    },
    async listApiKeyPermissions(input) {
      return client.request("GET", queryPath("/api_keys/permissions", { after: input.cursor }), {
        schema: pageSchema(apiKeyPermissionSchema),
      });
    },
    async listFinancialActivity(input) {
      if (
        [input.postedAfter, input.postedBefore].some(
          (date) => date !== undefined && !Number.isFinite(date.getTime()),
        )
      )
        return err({ kind: "invalid_request" });
      return client.request(
        "GET",
        queryPath("/financial-activity", {
          account_id: input.accountId,
          cursor: input.cursor,
          limit: input.limit ?? 100,
          direction: input.direction,
          "line_types[]": input.lineTypes,
          posted_after: input.postedAfter?.toISOString(),
          posted_before: input.postedBefore?.toISOString(),
          include_resource: input.includeResource,
        }),
        { schema: pageSchema(ledgerLineSchema) },
      );
    },
    async getLedgerAccount(accountId, idempotencyKey) {
      return client.request("GET", `/ledger_accounts/${encodeURIComponent(accountId)}`, {
        idempotencyKey,
        schema: ledgerAccountSchema,
      });
    },
    async createAccount(input, key) {
      return adapter.createOrFetchAccount(input, key);
    },
    async createOrFetchAccount(input, idempotencyKey) {
      const response = await client.request("POST", "/accounts", {
        body: {
          parent_company_id: options.parentAccountId,
          email: input.email,
          title: input.title,
          country: input.country.toUpperCase(),
          metadata: {
            external_id: input.externalId,
            ...(input.runId === undefined ? {} : { run_id: input.runId }),
          },
        },
        idempotencyKey,
        schema: accountSchema,
      });
      if (!response.ok) return response;
      const account = accountResult(response.value);
      // Sandbox returns 201 for existing emails, even with a fresh key or connected parent.
      // Only a known ID proves a fetch; HTTP 201 alone does not prove creation.
      const disposition =
        knownIds.has(account.id) || input.priorAccountId === account.id ? "fetched" : "unknown";
      knownIds.add(account.id);
      return ok({ ...account, disposition });
    },
    async createOnboardingLink(input, idempotencyKey) {
      const response = await client.request("POST", "/account_links", {
        body: {
          account_id: input.accountId,
          use_case: "account_onboarding",
          return_url: input.returnUrl,
          refresh_url: input.refreshUrl,
        },
        idempotencyKey,
        schema: linkSchema,
      });
      return response.ok ? ok({ url: response.value.url, raw: response.value }) : response;
    },
    async createCheckoutConfiguration(input, idempotencyKey) {
      if (!validCheckout(input)) return err({ kind: "invalid_request" });
      const response = await client.request("POST", "/checkout_configurations", {
        body: {
          ...(input.accountId ? { account_id: input.accountId } : {}),
          plan: {
            product: { title: input.productTitle, external_identifier: input.productExternalId },
            plan_type: "one_time",
            initial_price: toDecimalString(input.price),
            currency: input.price.currency.toLowerCase(),
            ...(input.applicationFee
              ? { application_fee_amount: toDecimalString(input.applicationFee) }
              : {}),
          },
          redirect_url: input.redirectUrl,
        },
        idempotencyKey,
        schema: checkoutSchema,
      });
      if (!response.ok) return response;
      const raw = response.value;
      const fee = raw.plan?.application_fee_amount;
      // The snapshot omits the fee in its response schema. Never infer an echo from the request.
      const applicationFee =
        fee == null
          ? null
          : fromDecimalString(
              String(fee),
              raw.plan?.currency?.toUpperCase() as "USD" | "EUR" | "BRL",
            );
      if (applicationFee && !applicationFee.ok) return err({ kind: "decode", body: raw });
      return ok({
        id: raw.id,
        raw,
        ...(raw.purchase_url === undefined ? {} : { purchaseUrl: raw.purchase_url }),
        ...(fee === undefined ? {} : { applicationFee: applicationFee?.value ?? null }),
      });
    },
    async getAccount(accountId, idempotencyKey) {
      const response = await client.request("GET", `/accounts/${encodeURIComponent(accountId)}`, {
        idempotencyKey,
        schema: accountSchema,
      });
      if (!response.ok) return response;
      const account = accountResult(response.value);
      knownIds.add(account.id);
      return ok(account);
    },
    async updateAccount(accountId, input, idempotencyKey) {
      const response = await client.request("PATCH", `/accounts/${encodeURIComponent(accountId)}`, {
        body: {
          ...input,
          ...(input.country === undefined ? {} : { country: input.country.toUpperCase() }),
        },
        idempotencyKey,
        schema: accountSchema,
      });
      if (!response.ok) return response;
      const account = accountResult(response.value);
      knownIds.add(account.id);
      return ok(account);
    },
    async listPayments(input) {
      const query = new URLSearchParams({ account_id: input.accountId });
      if (input.cursor !== undefined) query.set("after", input.cursor);
      const response = await client.request("GET", `/payments?${query}`, {
        schema: z.object({ data: z.array(paymentRecordSchema), page_info: pageInfoSchema }),
      });
      if (!response.ok) return response;
      const items = [];
      for (const row of response.value.data) {
        const id = whopPaymentId(row.id);
        const accountId = row.account_id === null ? null : whopAccountId(row.account_id);
        const currency = row.currency.toUpperCase() as "USD" | "EUR" | "BRL";
        const amount = row.total === null ? null : fromDecimalString(row.total.amount, currency);
        if (
          !id.ok ||
          (accountId && !accountId.ok) ||
          (amount && !amount.ok) ||
          (row.total && row.total.currency.toUpperCase() !== currency) ||
          (row.account_id !== null && row.account_id !== input.accountId)
        )
          return err({ kind: "decode", body: response.value });
        items.push({
          id: id.value,
          status: row.status,
          amount: amount?.value ?? null,
          currency,
          createdAt: row.created_at,
          accountId: accountId?.value ?? null,
        });
      }
      return ok({
        items,
        nextCursor: response.value.page_info.has_next_page
          ? response.value.page_info.end_cursor
          : null,
      });
    },
    async listTransfers(input) {
      // Run-d captures establish the filters and empty envelope. The documented
      // list omits parties, so retrieve each detail instead of inventing owners
      // from the filter. Documentation-shaped populated tests are not live proof.
      const direction = input.direction ?? "origin";
      const summarySchema = z
        .looseObject({
          id: nonempty,
          object: z.literal("transfer"),
          amount: z.number().nonnegative(),
          currency: currencySchema,
          status: z.enum(["processing", "succeeded", "failed"]),
          created_at: timestamp,
          origin_ledger_account_id: nonempty,
          destination_ledger_account_id: nonempty,
        })
        .superRefine((row, ctx) => {
          decodedMoney(row.amount, row.currency, ctx);
        });
      const response = await client.request(
        "GET",
        queryPath("/transfers", {
          [direction === "origin" ? "origin_id" : "destination_id"]: input.accountId,
          after: input.cursor,
        }),
        {
          // The documented maximum is 50. Bound detail reads even on a bad response.
          schema: z.object({ data: z.array(summarySchema).max(50), page_info: pageInfoSchema }),
        },
      );
      if (!response.ok) return response;
      const items = [];
      for (const summary of response.value.data) {
        const detail = await client.request("GET", `/transfers/${encodeURIComponent(summary.id)}`, {
          schema: transferDetailSchema,
        });
        if (!detail.ok) return detail;
        const row = detail.value;
        const party = row[direction];
        if (
          party.type !== "Company" ||
          party.id !== input.accountId ||
          row.id !== summary.id ||
          row.status !== summary.status ||
          row.raw.amount !== summary.amount ||
          row.raw.currency !== summary.currency ||
          row.createdAt !== summary.created_at ||
          row.raw.origin_ledger_account_id !== summary.origin_ledger_account_id ||
          row.raw.destination_ledger_account_id !== summary.destination_ledger_account_id
        )
          return err({ kind: "decode" });
        const { raw: _raw, ...record } = row;
        items.push(record);
      }
      return ok({
        items,
        nextCursor: response.value.page_info.has_next_page
          ? response.value.page_info.end_cursor
          : null,
      });
    },
    async getPayment(paymentId, idempotencyKey) {
      const response = await client.request("GET", `/payments/${encodeURIComponent(paymentId)}`, {
        idempotencyKey,
        schema: paymentSchema,
      });
      if (!response.ok) return response;
      const id = whopPaymentId(response.value.id);
      if (!id.ok) throw new Error("Validated payment ID is invalid");
      return ok({ id: id.value, raw: response.value });
    },
    async listPaymentFees(paymentId, idempotencyKey) {
      const response = await client.request(
        "GET",
        `/payments/${encodeURIComponent(paymentId)}/fees`,
        { idempotencyKey, schema: z.looseObject({ data: z.array(feeSchema) }) },
      );
      if (!response.ok) return response;
      const fees = [];
      for (const fee of response.value.data) {
        const currency = fee.amount.currency.toUpperCase() as "USD" | "EUR" | "BRL";
        const amount = fromDecimalString(fee.amount.amount, currency);
        if (!amount.ok) return err({ kind: "decode", body: response.value });
        fees.push({ amount: amount.value, raw: fee });
      }
      return ok(fees);
    },
    async refundPayment(paymentId, idempotencyKey, partial) {
      if (partial && (!money(partial.amountMinor, partial.currency).ok || partial.amountMinor <= 0))
        return err({ kind: "invalid_request" });
      const response = await client.request(
        "POST",
        `/payments/${encodeURIComponent(paymentId)}/refund`,
        {
          body: partial ? { partial_amount: toDecimalString(partial) } : {},
          idempotencyKey,
          schema: resourceSchema,
        },
      );
      return response.ok ? ok({ id: response.value.id, raw: response.value }) : response;
    },
    async createTransfer(input, idempotencyKey) {
      if (
        !money(input.amount.amountMinor, input.amount.currency).ok ||
        input.amount.amountMinor <= 0 ||
        input.originId === input.destinationId ||
        // A simulator-issued id (see packages/whop/src/simulator) escaping into a real
        // sandbox call would mean routing was wrong somewhere upstream; reject loudly
        // instead of sending a fabricated account id to the live API.
        input.originId.startsWith("sim_") ||
        input.destinationId.startsWith("sim_")
      )
        return err({ kind: "invalid_request" });
      // Cache the lookup, including concurrent calls, but let failed reads retry.
      let lookup = originLedgerIds.get(input.originId);
      if (!lookup) {
        lookup = resolveOriginLedger(input.originId);
        originLedgerIds.set(input.originId, lookup);
      }
      const origin = await lookup;
      if (!origin.ok) {
        originLedgerIds.delete(input.originId);
        return origin;
      }
      const response = await client.request("POST", "/transfers", {
        body: {
          amount: toDecimalString(input.amount),
          currency: input.amount.currency.toLowerCase(),
          origin_id: origin.value.id,
          type: "ledger",
          destination_id: input.destinationId,
          metadata: input.metadata,
        },
        idempotencyKey,
        schema: resourceSchema,
      });
      if (!response.ok) return response;
      const id = whopTransferId(response.value.id);
      if (!id.ok) throw new Error("Validated transfer ID is invalid");
      return ok({ id: id.value, raw: response.value });
    },
    async createAccessToken(input, idempotencyKey) {
      if (!validToken(input, (options.now ?? (() => new Date()))()))
        return err({ kind: "invalid_request" });
      const response = await client.request("POST", "/access_tokens", {
        body: {
          account_id: input.accountId,
          scoped_actions: input.scopedActions,
          expires_at: input.expiresAt.toISOString(),
        },
        idempotencyKey,
        schema: tokenSchema,
      });
      return response.ok ? ok({ token: response.value.token, raw: response.value }) : response;
    },
    async createPayoutPortalLink(input, idempotencyKey) {
      const response = await client.request("POST", "/account_links", {
        body: {
          account_id: input.accountId,
          use_case: "payouts_portal",
          return_url: input.returnUrl,
          refresh_url: input.returnUrl,
        },
        idempotencyKey,
        schema: linkSchema,
      });
      return response.ok ? ok({ url: response.value.url, raw: response.value }) : response;
    },
  };
  return adapter;
}
