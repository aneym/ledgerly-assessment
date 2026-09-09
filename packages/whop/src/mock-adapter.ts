import { createHash } from "node:crypto";
import {
  add,
  type Currency,
  err,
  type Money,
  money,
  ok,
  type Result,
  subtract,
  toDecimalString,
  type WhopAccount,
  type WhopAccountId,
  type WhopApiKeyPermission,
  type WhopCheckout,
  type WhopDisputeRecord,
  type WhopError,
  type WhopFeeMarkup,
  type WhopLedgerLine,
  type WhopPayment,
  type WhopPaymentId,
  type WhopPaymentRecord,
  type WhopPayoutMethod,
  type WhopPayoutRecord,
  type WhopPort,
  type WhopRefundRecord,
  type WhopSupportedPayoutMethod,
  type WhopTransferRecipient,
  type WhopTransferRecord,
  type WhopWebhook,
  type WhopWebhookDelivery,
  whopAccountId,
  whopPaymentId,
  whopTransferId,
} from "@ledgerly/core";
import { counter, restoreCollections } from "./simulator/snapshot";
import { validCheckout, validToken } from "./validation";
import { type KeyEncoding, signStandardWebhook } from "./webhooks";
export function createMockAdapter(
  options: {
    accountKind?: "platform" | "connected";
    accounts?: readonly WhopAccount[];
    parentAccountId?: WhopAccountId;
    webhookSecret?: string;
    apiVersionDate?: string;
    keyEncoding?: KeyEncoding;
    now?: () => Date;
    // Empty sandbox collections can be populated for offline success-path tests.
    disputes?: readonly { accountId: WhopAccountId; record: WhopDisputeRecord }[];
    payoutMethods?: readonly { accountId: WhopAccountId; record: WhopPayoutMethod }[];
    supportedPayoutMethods?: readonly {
      accountId: WhopAccountId;
      record: WhopSupportedPayoutMethod;
    }[];
    transferRecipients?: readonly { originId: WhopAccountId; record: WhopTransferRecipient }[];
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const accounts = new Map<WhopAccountId, WhopAccount>();
  const externalIds = new Map<string, WhopAccount>();
  const emails = new Map<string, WhopAccountId>();
  const transfers: WhopTransferRecord[] = [];
  const paymentRecords: WhopPaymentRecord[] = [];
  const checkouts = new Map<string, WhopCheckout>();
  const refunds: WhopRefundRecord[] = [];
  const disputes = structuredClone([...(options.disputes ?? [])]);
  const payoutMethods = structuredClone([...(options.payoutMethods ?? [])]);
  const supportedPayoutMethods = structuredClone([...(options.supportedPayoutMethods ?? [])]);
  const recipients = structuredClone([...(options.transferRecipients ?? [])]);
  const payouts: { accountId: WhopAccountId; record: WhopPayoutRecord }[] = [];
  const markups = new Map<string, WhopFeeMarkup>();
  const webhooks = new Map<string, WhopWebhook>();
  const deliveries = new Map<string, WhopWebhookDelivery[]>();
  const ledgerLines: { accountId: WhopAccountId; record: WhopLedgerLine }[] = [];
  const webhookOwnerId =
    options.parentAccountId ?? options.accounts?.[0]?.id ?? "biz_mock_platform";
  // Representative entries from list-api-key-permissions.json, including its non-grantable action.
  const permissionDefinitions: [string, boolean, WhopApiKeyPermission["grantedToSystemRoles"]][] = [
    ["payment:basic:read", true, ["owner", "admin", "sales_manager"]],
    ["developer:manage_api_key", false, ["owner"]],
  ];
  const permissions: WhopApiKeyPermission[] = permissionDefinitions.map(
    ([action, allowed, roles]) => {
      const raw = {
        action,
        name: action,
        description: "",
        category: null,
        allowed_on_user: allowed,
        allowed_on_app: allowed,
        allowed_on_api_key: allowed,
        granted_to_system_roles: roles,
      };
      return {
        action: raw.action,
        name: raw.name,
        allowedOnApiKey: raw.allowed_on_api_key,
        grantedToSystemRoles: raw.granted_to_system_roles,
        raw,
      };
    },
  );
  for (const account of options.accounts ?? []) {
    accounts.set(account.id, structuredClone(account));
    const raw = account.raw as { email?: string; metadata?: { external_id?: string } };
    if (raw.email) emails.set(raw.email, account.id);
    if (raw.metadata?.external_id)
      externalIds.set(raw.metadata.external_id, structuredClone(account));
  }
  const balances = new Map<string, Money>();
  const payments = new Map<
    WhopPaymentId,
    { payment: WhopPayment; amount: Money; refunded: Money }
  >();
  const operations = new Map<string, { fingerprint: string; value: unknown }>();
  let accountSequence = 0;
  let resourceSequence = 0;
  let paymentSequence = 0;
  let deliverySequence = 0;
  function once<T>(
    kind: string,
    input: unknown,
    key: string,
    work: () => Result<T, WhopError>,
  ): Result<T, WhopError> {
    if (!key.trim()) return err({ kind: "invalid_request" });
    const fingerprint = JSON.stringify({ kind, input });
    const prior = operations.get(key);
    if (prior)
      return prior.fingerprint === fingerprint
        ? ok(structuredClone(prior.value) as T)
        : err({ kind: "idempotency_conflict" });
    const result = work();
    if (result.ok) operations.set(key, { fingerprint, value: structuredClone(result.value) });
    return result;
  }
  function balance(accountId: WhopAccountId, currency: Currency): Money {
    return balances.get(`${accountId}:${currency}`) ?? { amountMinor: 0, currency };
  }
  function page<T extends { id: string }>(
    items: T[],
    cursor?: string,
    limit = 50,
  ): Result<{ items: T[]; nextCursor: string | null }, WhopError> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return err({ kind: "invalid_request" });
    const index = cursor === undefined ? -1 : items.findIndex((item) => item.id === cursor);
    if (cursor !== undefined && index === -1) return err({ kind: "invalid_request" });
    const selected = items.slice(index + 1, index + 1 + limit);
    return ok({
      items: structuredClone(selected),
      nextCursor: index + 1 + limit < items.length ? (selected.at(-1)?.id ?? null) : null,
    });
  }
  function lookup<T>(value: T | undefined): Result<T, WhopError> {
    return value === undefined ? err({ kind: "not_found" }) : ok(structuredClone(value));
  }
  function providerMoney(amount: Money) {
    return {
      amount: toDecimalString(amount),
      currency: amount.currency.toLowerCase(),
      decimals: 2,
      display_decimals: 2,
    };
  }
  function recordActivity(
    accountId: WhopAccountId,
    amount: Money,
    lineType: string,
    source: { type: string; id: string },
    paymentId: WhopPaymentId | null = null,
  ) {
    const id = `line_mock_${++resourceSequence}`;
    const postedAt = now().toISOString();
    const raw = {
      object: "ledger_activity",
      id,
      line_type: lineType,
      amount: String(BigInt(amount.amountMinor) * 1000000n),
      // Offline-only valuation: every supported currency uses a fixed 1:1 USD rate.
      usd_amount: toDecimalString(amount),
      currency: { code: amount.currency.toLowerCase(), precision: "100000000" },
      posted_at: postedAt,
      available_at: null,
      payment_id: paymentId,
      resource: null,
      source: { object: source.type, id: source.id },
    };
    ledgerLines.unshift({
      accountId,
      record: {
        id,
        lineType,
        amount: { ...amount },
        usdAmount: raw.usd_amount,
        postedAt,
        availableAt: null,
        paymentId,
        source: { ...source },
        raw,
      },
    });
  }
  function webhookRead(hook: WhopWebhook): WhopWebhook {
    return structuredClone({
      ...hook,
      webhookSecret: null,
      raw: { ...(hook.raw as Record<string, unknown>), webhook_secret: null },
    });
  }
  function probe(
    webhookId: string,
    event: string | null,
    original?: WhopWebhookDelivery,
    regenerateId = false,
  ) {
    const sentAt = now().toISOString();
    const originalBody = original?.raw as { request_body: Record<string, unknown> } | undefined;
    const requestBody = originalBody
      ? structuredClone(originalBody.request_body)
      : {
          id: `msg_mock_${++deliverySequence}`,
          type: event,
          data: {},
          account_id: webhookOwnerId,
          api_version: "v1",
          api_version_date: webhooks.get(webhookId)?.apiVersionDate,
          timestamp: sentAt,
        };
    if (original && regenerateId) requestBody.id = `msg_mock_${++deliverySequence}`;
    const responseBody = {
      received: true,
      duplicate: !!original && !regenerateId,
      ...(original ? {} : { decoded: false }),
    };
    const id = `whdel_mock_${++resourceSequence}`;
    const raw = {
      id,
      event,
      replayed_from: original?.id ?? null,
      request_body: requestBody,
      resource_id: original?.resourceId ?? webhookOwnerId,
      response_body: responseBody,
      response_code: 200,
      sent_at: sentAt,
      success: true,
      total_time: 0,
    };
    const record: WhopWebhookDelivery = {
      id,
      event,
      replayedFrom: raw.replayed_from,
      resourceId: raw.resource_id,
      responseCode: 200,
      sentAt,
      raw,
    };
    const rows = deliveries.get(webhookId) ?? [];
    rows.unshift(record);
    deliveries.set(webhookId, rows);
    const response = { status: 200, body: JSON.stringify(responseBody), success: true };
    return ok({ ...response, raw: response });
  }
  const adapter: WhopPort = {
    async createAccount(input, key) {
      return adapter.createOrFetchAccount(input, key);
    },
    async createOrFetchAccount(input, key) {
      const prior = externalIds.get(input.externalId)?.id ?? emails.get(input.email);
      const result = once("account", input, key, () => {
        const existing = prior ? accounts.get(prior) : undefined;
        // Duplicate email lookup precedes the connected-parent restriction in the observed sandbox.
        if (existing) return ok(structuredClone(existing));
        if (options.accountKind === "connected") return err({ kind: "nested_account" });
        do {
          accountSequence++;
        } while (accounts.has(`biz_mock_${accountSequence}` as WhopAccountId));
        const id = whopAccountId(`biz_mock_${accountSequence}`);
        if (!id.ok) throw new Error("Invalid mock account ID");
        const account = {
          id: id.value,
          country: input.country.toUpperCase(),
          ...(options.parentAccountId ? { parentAccountId: options.parentAccountId } : {}),
          raw: {
            id: id.value,
            email: input.email,
            status: "active",
            status_reason: null,
            country: input.country.toUpperCase(),
            ...(options.parentAccountId
              ? {
                  parent_account: {
                    id: options.parentAccountId,
                    title: null,
                    route: null,
                    logo_url: null,
                  },
                }
              : {}),
            title: input.title,
            metadata: {
              external_id: input.externalId,
              ...(input.runId === undefined ? {} : { run_id: input.runId }),
            },
          },
        };
        accounts.set(id.value, structuredClone(account));
        externalIds.set(input.externalId, structuredClone(account));
        emails.set(input.email, id.value);
        return ok(account);
      });
      if (!result.ok) return result;
      const account = accounts.get(result.value.id) ?? result.value;
      externalIds.set(input.externalId, structuredClone(account));
      return ok({
        ...structuredClone(account),
        disposition: prior || input.priorAccountId === account.id ? "fetched" : "unknown",
      });
    },
    async updateAccount(id, input, key) {
      return once("update-account", { id, input }, key, () => {
        const account = accounts.get(id);
        if (!account) return err({ kind: "not_found" });
        const raw = { ...(account.raw as Record<string, unknown>), ...input };
        const updated = {
          ...account,
          raw,
          ...(input.country === undefined ? {} : { country: input.country.toUpperCase() }),
        };
        accounts.set(id, structuredClone(updated));
        return ok(updated);
      });
    },
    async listPayments(input) {
      return page(
        paymentRecords.filter((item) => item.accountId === input.accountId),
        input.cursor,
      );
    },
    async listTransfers(input) {
      return page(
        transfers.filter(
          (item) => item.origin.id === input.accountId || item.destination.id === input.accountId,
        ),
        input.cursor,
      );
    },
    async getAccount(id, _key) {
      const account = accounts.get(id);
      return account ? ok(structuredClone(account)) : err({ kind: "not_found" });
    },
    async createOnboardingLink(input, key) {
      return once("onboarding", input, key, () =>
        accounts.has(input.accountId)
          ? ok({
              url: `https://mock.invalid/onboarding/${input.accountId}`,
              raw: { use_case: "account_onboarding" },
            })
          : err({ kind: "not_found" }),
      );
    },
    async createPayoutPortalLink(input, key) {
      return once("portal", input, key, () =>
        accounts.has(input.accountId)
          ? ok({
              url: `https://mock.invalid/payouts/${input.accountId}`,
              raw: { use_case: "payouts_portal" },
            })
          : err({ kind: "not_found" }),
      );
    },
    async createCheckoutConfiguration(input, key) {
      return once("checkout", input, key, () => {
        if (!validCheckout(input)) return err({ kind: "invalid_request" });
        if (input.accountId && !accounts.has(input.accountId)) return err({ kind: "not_found" });
        const id = `ch_mock_${++resourceSequence}`;
        const timestamp = now().toISOString();
        const raw = {
          id,
          created_at: timestamp,
          updated_at: timestamp,
          account_id: input.accountId ?? options.parentAccountId ?? null,
          mode: "payment",
          currency: null,
          plan: {
            id: `plan_mock_${++resourceSequence}`,
            visibility: "visible",
            plan_type: "one_time",
            release_method: "buy_now",
            currency: input.price.currency.toLowerCase(),
            billing_period: null,
            expiration_days: null,
            initial_price: Number(toDecimalString(input.price)),
            renewal_price: 0,
            trial_period_days: null,
            three_ds_level: null,
            adaptive_pricing_enabled: true,
          },
          affiliate_code: null,
          metadata: {},
          redirect_url: input.redirectUrl,
          purchase_url: `https://mock.invalid/checkout/${id}`,
          three_ds_level: null,
          payment_method_configuration: null,
          effective_payment_method_configuration: {
            enabled: ["card"],
            disabled: [],
            include_platform_defaults: false,
          },
        };
        const checkout = { id, purchaseUrl: raw.purchase_url, raw };
        checkouts.set(id, structuredClone(checkout));
        return ok(checkout);
      });
    },
    async getPayment(id, _key) {
      const entry = payments.get(id);
      return entry ? ok(structuredClone(entry.payment)) : err({ kind: "not_found" });
    },
    async listPaymentFees(id, _key) {
      return payments.has(id) ? ok([]) : err({ kind: "not_found" });
    },
    async refundPayment(id, key, partial) {
      return once("refund", { id, partial }, key, () => {
        const entry = payments.get(id);
        if (!entry) return err({ kind: "not_found" });
        const remaining = subtract(entry.amount, entry.refunded);
        if (!remaining.ok) throw new Error("Invalid mock refund state");
        const amount = partial ?? remaining.value;
        if (
          !money(amount.amountMinor, amount.currency).ok ||
          amount.currency !== entry.amount.currency ||
          amount.amountMinor <= 0 ||
          amount.amountMinor > remaining.value.amountMinor
        )
          return err({ kind: "invalid_request" });
        const refunded = add(entry.refunded, amount);
        if (!refunded.ok) throw new Error("Invalid mock refund total");
        entry.refunded = refunded.value;
        const refundId = `rf_mock_${++resourceSequence}`;
        const createdAt = now().toISOString();
        const accountId = paymentRecords.find((row) => row.id === id)?.accountId ?? null;
        const raw = {
          id: refundId,
          payment_id: id,
          account_id: accountId,
          status: "succeeded",
          amount: providerMoney(amount),
          original_amount: providerMoney(amount),
          created_at: createdAt,
        };
        refunds.unshift({
          id: refundId,
          paymentId: id,
          status: raw.status,
          amount: { ...amount },
          createdAt,
          raw: structuredClone(raw),
        });
        if (accountId)
          recordActivity(
            accountId,
            { ...amount, amountMinor: -amount.amountMinor },
            "payment_refund",
            { type: "refund", id: refundId },
            id,
          );
        return ok({ id: refundId, raw });
      });
    },
    async createTransfer(input, key) {
      return once("transfer", input, key, () => {
        if (
          !money(input.amount.amountMinor, input.amount.currency).ok ||
          input.amount.amountMinor <= 0 ||
          input.originId === input.destinationId
        )
          return err({ kind: "invalid_request" });
        if (!accounts.has(input.originId) || !accounts.has(input.destinationId))
          return err({ kind: "not_found" });
        const origin = balance(input.originId, input.amount.currency);
        if (origin.amountMinor < input.amount.amountMinor)
          return err({ kind: "insufficient_balance" });
        const debit = subtract(origin, input.amount);
        const credit = add(balance(input.destinationId, input.amount.currency), input.amount);
        if (!debit.ok || !credit.ok) return err({ kind: "invalid_request" });
        const id = whopTransferId(`tsf_mock_${++resourceSequence}`);
        if (!id.ok) throw new Error("Invalid mock transfer ID");
        balances.set(`${input.originId}:${input.amount.currency}`, debit.value);
        balances.set(`${input.destinationId}:${input.amount.currency}`, credit.value);
        transfers.unshift({
          id: id.value,
          status: "succeeded",
          amount: { ...input.amount },
          currency: input.amount.currency,
          createdAt: now().toISOString(),
          origin: { id: input.originId, type: "Company" },
          destination: { id: input.destinationId, type: "Company" },
        });
        recordActivity(
          input.originId,
          { ...input.amount, amountMinor: -input.amount.amountMinor },
          "platform_balance_transfer_outgoing",
          { type: "transfer", id: id.value },
        );
        recordActivity(input.destinationId, input.amount, "platform_balance_transfer_incoming", {
          type: "transfer",
          id: id.value,
        });
        const record = transfers[0];
        if (!record) throw new Error("Missing mock transfer record");
        return ok({
          id: id.value,
          raw: {
            id: id.value,
            status: record.status,
            amount: Number(toDecimalString(input.amount)),
            currency: input.amount.currency.toLowerCase(),
            created_at: record.createdAt,
            origin: { id: input.originId, typename: "Company" },
            destination: { id: input.destinationId, typename: "Company" },
            metadata: structuredClone(input.metadata),
          },
        });
      });
    },
    async suspendAccount(id, key) {
      return once("suspend-account", { id }, key, () => {
        const account = accounts.get(id);
        if (!account) return err({ kind: "not_found" });
        const raw = {
          ...(account.raw as Record<string, unknown>),
          status: "suspended" as const,
          status_reason: "Suspended by the platform account",
          capabilities: null,
          required_actions: null,
        };
        accounts.set(id, structuredClone({ ...account, raw }));
        return ok({ id, status: raw.status, statusReason: raw.status_reason, raw });
      });
    },
    async getCheckoutConfiguration(id, _key) {
      return lookup(checkouts.get(id));
    },
    async listRefunds(input) {
      return page(
        refunds.filter((row) =>
          "paymentId" in input
            ? row.paymentId === input.paymentId
            : paymentRecords.some(
                (payment) => payment.id === row.paymentId && payment.accountId === input.accountId,
              ),
        ),
        input.cursor,
      );
    },
    async getRefund(id, _key) {
      return lookup(refunds.find((row) => row.id === id));
    },
    async listDisputes(input) {
      return page(
        disputes
          .filter(
            (row) =>
              row.accountId === input.accountId &&
              (!input.status?.length || input.status.includes(row.record.status)),
          )
          .map((row) => row.record),
        input.cursor,
      );
    },
    async getDispute(id, _key) {
      return lookup(disputes.find((row) => row.record.id === id)?.record);
    },
    async getTransfer(id, _key) {
      const record = transfers.find((row) => row.id === id);
      if (!record) return err({ kind: "not_found" });
      return ok(
        structuredClone({
          ...record,
          raw: {
            id,
            status: record.status,
            amount: Number(toDecimalString(record.amount)),
            currency: record.currency.toLowerCase(),
            created_at: record.createdAt,
            origin: { id: record.origin.id, typename: record.origin.type },
            destination: { id: record.destination.id, typename: record.destination.type },
          },
        }),
      );
    },
    async listTransferRecipients(input) {
      if (!accounts.has(input.originId)) return err({ kind: "not_found" });
      // Child accounts are not recipients in the observed endpoint.
      return page(
        recipients.filter((row) => row.originId === input.originId).map((row) => row.record),
        input.cursor,
      );
    },
    async listPayouts(input) {
      return page(
        payouts
          .filter(
            (row) =>
              row.accountId === input.accountId &&
              (!input.status || row.record.status === input.status),
          )
          .map((row) => row.record),
        input.cursor,
      );
    },
    async getPayout(input, _key) {
      return lookup(
        payouts.find((row) => row.accountId === input.accountId && row.record.id === input.payoutId)
          ?.record,
      );
    },
    async createPayout(input, key) {
      return once("payout", input, key, () => {
        if (!accounts.has(input.accountId)) return err({ kind: "not_found" });
        if (
          !money(input.amount.amountMinor, input.amount.currency).ok ||
          input.amount.amountMinor <= 0
        )
          return err({ kind: "invalid_request" });
        const method = payoutMethods.find(
          (row) => row.accountId === input.accountId && row.record.id === input.payoutMethodId,
        )?.record;
        if (!method) return err({ kind: "not_found" });
        if (method.currency && method.currency.toUpperCase() !== input.amount.currency)
          return err({ kind: "invalid_request" });
        const available = balance(input.accountId, input.amount.currency);
        if (available.amountMinor < input.amount.amountMinor)
          return err({ kind: "insufficient_balance" });
        const debit = subtract(available, input.amount);
        if (!debit.ok) return err({ kind: "invalid_request" });
        const id = `wdrl_mock_${++resourceSequence}`;
        const createdAt = now().toISOString();
        // Success is modeled from the pinned payout schema; sandbox only returned errors.
        const raw = {
          id,
          status: "requested" as const,
          amount: toDecimalString(input.amount),
          currency: input.amount.currency.toLowerCase(),
          fee_amount: "0.00",
          net_amount: toDecimalString(input.amount),
          speed: input.speed ?? "standard",
          payout_method: structuredClone(method.raw),
          payout_method_id: method.id,
          account_id: input.accountId,
          created_at: createdAt,
          statement_descriptor: input.statementDescriptor ?? null,
          notes: input.notes ?? null,
          metadata: structuredClone(input.metadata ?? {}),
        };
        const record: WhopPayoutRecord = {
          id,
          status: raw.status,
          amount: { ...input.amount },
          feeAmount: { amountMinor: 0, currency: input.amount.currency },
          netAmount: { ...input.amount },
          speed: raw.speed,
          payoutMethodId: method.id,
          createdAt,
          raw,
        };
        balances.set(`${input.accountId}:${input.amount.currency}`, debit.value);
        payouts.unshift({ accountId: input.accountId, record: structuredClone(record) });
        recordActivity(
          input.accountId,
          { ...input.amount, amountMinor: -input.amount.amountMinor },
          "withdrawal",
          { type: "payout", id },
        );
        return ok(record);
      });
    },
    async listPayoutMethods(input) {
      if (!accounts.has(input.accountId)) return err({ kind: "not_found" });
      return page(
        payoutMethods.filter((row) => row.accountId === input.accountId).map((row) => row.record),
        input.cursor,
      );
    },
    async listSupportedPayoutMethods(input) {
      if (!accounts.has(input.accountId)) return err({ kind: "not_found" });
      if (
        input.amount &&
        (!money(input.amount.amountMinor, input.amount.currency).ok ||
          input.amount.amountMinor <= 0)
      )
        return err({ kind: "invalid_request" });
      return page(
        supportedPayoutMethods
          .filter((row) => row.accountId === input.accountId)
          .map((row) => row.record),
        input.cursor,
      );
    },
    async listFeeMarkups(input) {
      return page(
        [...markups.entries()]
          .filter(([key]) => key.startsWith(`${input.accountId}:`))
          .map(([, record]) => record),
        input.cursor,
      );
    },
    async createFeeMarkup(input, key) {
      return once("fee-markup", input, key, () => {
        if (!accounts.has(input.accountId)) return err({ kind: "not_found" });
        if (
          [input.percentageFee, input.fixedFeeUsd].some(
            (value) => value != null && (!Number.isFinite(value) || value < 0),
          )
        )
          return err({ kind: "invalid_request" });
        const markupKey = `${input.accountId}:${input.feeType}`;
        const prior = markups.get(markupKey);
        const timestamp = now().toISOString();
        const raw = {
          id: prior?.id ?? `lafm_mock_${++resourceSequence}`,
          fee_type: input.feeType,
          percentage_fee:
            input.percentageFee === undefined
              ? (prior?.percentageFee ?? null)
              : input.percentageFee,
          fixed_fee_usd:
            input.fixedFeeUsd === undefined ? (prior?.fixedFeeUsd ?? null) : input.fixedFeeUsd,
          notes: input.notes ?? (prior?.raw as { notes?: string } | undefined)?.notes ?? null,
          created_at: (prior?.raw as { created_at: string } | undefined)?.created_at ?? timestamp,
          updated_at: timestamp,
        };
        const record: WhopFeeMarkup = {
          id: raw.id,
          feeType: raw.fee_type,
          percentageFee: raw.percentage_fee,
          fixedFeeUsd: raw.fixed_fee_usd,
          raw,
        };
        markups.set(markupKey, structuredClone(record));
        return ok(record);
      });
    },
    async createTopup(input, key) {
      return once("topup", input, key, () => {
        if (!accounts.has(input.accountId)) return err({ kind: "not_found" });
        if (
          !input.paymentMethodId.trim() ||
          !money(input.amount.amountMinor, input.amount.currency).ok ||
          input.amount.amountMinor <= 0
        )
          return err({ kind: "invalid_request" });
        const credit = add(balance(input.accountId, input.amount.currency), input.amount);
        if (!credit.ok) return err({ kind: "invalid_request" });
        const id = whopPaymentId(`pay_mock_${++paymentSequence}`);
        if (!id.ok) throw new Error("Invalid mock topup payment ID");
        const timestamp = now().toISOString();
        // No topup fixture exists. The pinned Topup schema is a Payment with a numeric total.
        const raw = {
          id: id.value,
          status: "paid",
          created_at: timestamp,
          paid_at: timestamp,
          currency: input.amount.currency.toLowerCase(),
          total: Number(toDecimalString(input.amount)),
          failure_message: null,
        };
        payments.set(id.value, {
          payment: { id: id.value, raw: structuredClone(raw) },
          amount: { ...input.amount },
          refunded: { amountMinor: 0, currency: input.amount.currency },
        });
        paymentRecords.unshift({
          id: id.value,
          status: raw.status,
          amount: { ...input.amount },
          currency: input.amount.currency,
          createdAt: timestamp,
          accountId: input.accountId,
        });
        balances.set(`${input.accountId}:${input.amount.currency}`, credit.value);
        recordActivity(
          input.accountId,
          input.amount,
          "topup",
          { type: "payment", id: id.value },
          id.value,
        );
        return ok({ id: id.value, status: raw.status, raw });
      });
    },
    async listWebhooks(input) {
      const rows = input.accountId === webhookOwnerId ? [...webhooks.values()] : [];
      return page(
        rows.map((hook) => {
          const read = webhookRead(hook);
          const { testable_events: _events, ...raw } = read.raw as Record<string, unknown>;
          return { ...read, resourceId: webhookOwnerId, raw };
        }),
        input.cursor,
      );
    },
    async getWebhook(id, _key) {
      const hook = webhooks.get(id);
      return hook ? ok(webhookRead(hook)) : err({ kind: "not_found" });
    },
    async createWebhook(input, key) {
      return once("webhook", input, key, () => {
        if (
          !URL.canParse(input.url) ||
          !["https:", "http:"].includes(new URL(input.url).protocol) ||
          !input.events.length ||
          input.events.some((event) => !event.trim())
        )
          return err({ kind: "invalid_request" });
        const id = `hook_mock_${++resourceSequence}`;
        const raw = {
          id,
          url: input.url,
          enabled: input.enabled ?? true,
          events: [...input.events],
          api_version: "v1",
          api_version_date: input.apiVersionDate ?? options.apiVersionDate ?? "2026-09-06",
          created_at: now().toISOString(),
          child_resource_events: input.childResourceEvents ?? false,
          webhook_secret: `ws_mock_${id}`,
          resource_id: webhookOwnerId,
          consecutive_failures: 0,
          failing_since: null,
          last_failure_at: null,
          disabled_at: null,
          disabled_reason: null,
          testable_events: [...input.events],
        };
        const hook: WhopWebhook = {
          id,
          url: raw.url,
          enabled: raw.enabled,
          events: [...raw.events],
          apiVersionDate: raw.api_version_date,
          childResourceEvents: raw.child_resource_events,
          consecutiveFailures: 0,
          disabledAt: null,
          webhookSecret: raw.webhook_secret,
          raw,
        };
        webhooks.set(id, webhookRead(hook));
        return ok(hook);
      });
    },
    async updateWebhook(id, input, key) {
      return once("update-webhook", { id, input }, key, () => {
        const hook = webhooks.get(id);
        if (!hook) return err({ kind: "not_found" });
        if (
          (input.url !== undefined &&
            (!URL.canParse(input.url) ||
              !["http:", "https:"].includes(new URL(input.url).protocol))) ||
          (input.events !== undefined &&
            (!input.events.length || input.events.some((event) => !event.trim())))
        )
          return err({ kind: "invalid_request" });
        const updated = webhookRead({
          ...hook,
          ...input,
          raw: { ...(hook.raw as Record<string, unknown>), ...input },
        });
        webhooks.set(id, structuredClone(updated));
        return ok(updated);
      });
    },
    async sendWebhookTest(input, key) {
      return once("webhook-test", input, key, () => {
        if (!webhooks.has(input.webhookId)) return err({ kind: "not_found" });
        if (!input.event.trim()) return err({ kind: "invalid_request" });
        return probe(input.webhookId, input.event);
      });
    },
    async listWebhookDeliveries(input) {
      if (!webhooks.has(input.webhookId)) return err({ kind: "not_found" });
      return page(deliveries.get(input.webhookId) ?? [], input.cursor, input.first);
    },
    async replayWebhookDelivery(input, key) {
      return once("replay-webhook", input, key, () => {
        const original = deliveries
          .get(input.webhookId)
          ?.find((row) => row.id === input.deliveryId);
        if (!original) return err({ kind: "not_found" });
        return probe(input.webhookId, original.event, original, input.regenerateId);
      });
    },
    async createApiKey(input, key) {
      return once("api-key", input, key, () => {
        if (!accounts.has(input.accountId)) return err({ kind: "not_found" });
        if (
          !input.name.trim() ||
          (input.expiresAt &&
            (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= now()))
        )
          return err({ kind: "invalid_request" });
        if (
          "statements" in input.permissions &&
          (!input.permissions.statements.length ||
            input.permissions.statements.some(
              (statement) =>
                !statement.actions.length || statement.actions.some((action) => !action.trim()),
            ))
        )
          return err({ kind: "invalid_request" });
        const id = `apik_mock_${++resourceSequence}`;
        const raw = {
          id,
          name: input.name,
          resource_id: input.accountId,
          resource_type: "account",
          secret_key: `${id}_mock_only_not_a_real_key`,
          obfuscated_secret_key: `${id}....mock`,
          created_at: now().toISOString(),
          updated_at: now().toISOString(),
          api_version_date: options.apiVersionDate ?? "2026-09-06",
          is_default_for_resource: false,
          ip_allowlist: null,
          system_role: "systemRole" in input.permissions ? input.permissions.systemRole : null,
          grants:
            "systemRole" in input.permissions
              ? [
                  {
                    resource_id: input.accountId,
                    resource_type: "account",
                    actions: permissions.map((permission) => ({
                      action: permission.action,
                      granted:
                        permission.allowedOnApiKey &&
                        "systemRole" in input.permissions &&
                        permission.grantedToSystemRoles.includes(input.permissions.systemRole),
                    })),
                  },
                ]
              : input.permissions.statements.flatMap((statement) =>
                  (statement.resources ?? [input.accountId]).map((resourceId) => ({
                    resource_id: resourceId,
                    resource_type: "account",
                    actions: statement.actions.map((action) => ({
                      action,
                      granted: statement.grant,
                    })),
                  })),
                ),
          expires_at: input.expiresAt?.toISOString() ?? null,
          permissions:
            "systemRole" in input.permissions
              ? { system_role: input.permissions.systemRole }
              : { statements: structuredClone(input.permissions.statements) },
        };
        return ok({ id, secretKey: raw.secret_key, raw });
      });
    },
    async listApiKeyPermissions(input) {
      // This catalog uses actions as cursors; do not expose a synthetic id on decoded rows.
      const result = page(
        permissions.map((row) => ({ ...row, id: row.action })),
        input.cursor,
      );
      return result.ok
        ? ok({ ...result.value, items: result.value.items.map(({ id: _id, ...row }) => row) })
        : result;
    },
    async listFinancialActivity(input) {
      if (
        [input.postedAfter, input.postedBefore].some(
          (date) => date !== undefined && !Number.isFinite(date.getTime()),
        )
      )
        return err({ kind: "invalid_request" });
      const rows = ledgerLines
        .filter(
          ({ accountId, record }) =>
            accountId === input.accountId &&
            (!input.lineTypes?.length || input.lineTypes.includes(record.lineType)) &&
            (!input.direction ||
              (input.direction === "money_in"
                ? (record.amount?.amountMinor ?? 0) > 0
                : (record.amount?.amountMinor ?? 0) < 0)) &&
            (!input.postedAfter || new Date(record.postedAt) > input.postedAfter) &&
            (!input.postedBefore || new Date(record.postedAt) < input.postedBefore),
        )
        .map(({ record }) => record);
      return page(rows, input.cursor, input.limit);
    },
    async getLedgerAccount(accountId, _key) {
      const account = accounts.get(accountId);
      if (!account) return err({ kind: "not_found" });
      const currencies: Currency[] = ["USD", "EUR", "BRL"];
      const rows = currencies.filter((currency) => balances.has(`${accountId}:${currency}`));
      if (!rows.length) rows.push("USD");
      const decoded = rows.map((currency) => ({
        currency,
        available: { ...balance(accountId, currency) },
        pending: { currency, amountMinor: 0 },
        reserve: { currency, amountMinor: 0 },
      }));
      const id = `ldgr_mock_${accountId.slice(4)}`;
      const raw = {
        id,
        settlement_time_at: null,
        balances: decoded.map((row) => ({
          balance: Number(toDecimalString(row.available)),
          currency: row.currency.toLowerCase(),
          pending_balance: 0,
          reserve_balance: 0,
        })),
        treasury_balance: null,
        transfer_fee: 0,
        payout_account_details: null,
        payments_approval_status: null,
        ledger_type: "primary",
        payout_quote_required: false,
        owner: {
          typename: "Company",
          id: accountId,
          route: null,
          title: (account.raw as { title?: string }).title ?? null,
        },
      };
      return ok({
        id,
        ownerId: accountId,
        balances: decoded,
        settlementTimeAt: null,
        payoutQuoteRequired: false,
        raw,
      });
    },
    async createAccessToken(input, key) {
      return once("token", input, key, () => {
        if (!accounts.has(input.accountId)) return err({ kind: "not_found" });
        if (!validToken(input, now())) return err({ kind: "invalid_request" });
        return ok({
          token: `mock_token_${++resourceSequence}`,
          raw: {
            account_id: input.accountId,
            scoped_actions: input.scopedActions,
            expires_at: input.expiresAt.toISOString(),
          },
        });
      });
    },
  };
  const collections = {
    accounts,
    externalIds,
    emails,
    transfers,
    paymentRecords,
    checkouts,
    refunds,
    disputes,
    payoutMethods,
    supportedPayoutMethods,
    recipients,
    payouts,
    markups,
    webhooks,
    deliveries,
    ledgerLines,
    balances,
    payments,
    operations,
  };
  function snapshotState() {
    return structuredClone({
      version: 1,
      collections,
      accountSequence,
      resourceSequence,
      paymentSequence,
      deliverySequence,
    });
  }
  function restoreState(raw: unknown) {
    if (!raw || typeof raw !== "object" || (raw as { version?: unknown }).version !== 1)
      throw new Error("Invalid mock snapshot version");
    const saved = raw as ReturnType<typeof snapshotState>;
    accountSequence = counter(saved.accountSequence);
    resourceSequence = counter(saved.resourceSequence);
    paymentSequence = counter(saved.paymentSequence);
    deliverySequence = counter(saved.deliverySequence);
    restoreCollections(collections, saved.collections);
  }
  let demoAdapter: WhopPort | undefined;
  return Object.assign(adapter, {
    snapshotState,
    restoreState,
    // Isolated simulation state. Ordinary mock balances and sequence IDs stay unchanged.
    forDemoFallback(): WhopPort {
      demoAdapter ??= createDemoFallbackMock(adapter);
      return demoAdapter;
    },
    seedBalance(accountId: WhopAccountId, amount: Money): Result<true, WhopError> {
      if (!accounts.has(accountId)) return err({ kind: "not_found" });
      if (!money(amount.amountMinor, amount.currency).ok || amount.amountMinor < 0)
        return err({ kind: "invalid_request" });
      balances.set(`${accountId}:${amount.currency}`, { ...amount });
      return ok(true);
    },
    getBalance(accountId: WhopAccountId, currency: Currency): Money {
      return { ...balance(accountId, currency) };
    },
    seedDemoPayment(accountId: WhopAccountId, key: string): Result<WhopPayment, WhopError> {
      return this.seedPayment({ amountMinor: 2500, currency: "USD" }, accountId, key);
    },
    seedPayment(
      amount: Money,
      accountId: WhopAccountId | null = null,
      key?: string,
    ): Result<WhopPayment, WhopError> {
      if (!money(amount.amountMinor, amount.currency).ok || amount.amountMinor <= 0)
        return err({ kind: "invalid_request" });
      const id = whopPaymentId(
        key === undefined
          ? `pay_mock_${++paymentSequence}`
          : `pay_mock_demo_${createHash("sha256")
              .update(JSON.stringify([accountId, key]))
              .digest("hex")}`,
      );

      if (!id.ok) throw new Error("Invalid mock payment ID");
      const existing = payments.get(id.value);
      if (existing) return ok(structuredClone(existing.payment));
      const payment = { id: id.value, raw: { id: id.value, amount: { ...amount } } };
      paymentRecords.unshift({
        id: id.value,
        status: "paid",
        amount: { ...amount },
        currency: amount.currency,
        createdAt: now().toISOString(),
        accountId,
      });
      payments.set(id.value, {
        payment: structuredClone(payment),
        amount: { ...amount },
        refunded: { amountMinor: 0, currency: amount.currency },
      });
      if (accountId)
        recordActivity(
          accountId,
          amount,
          "payment_gross",
          { type: "payment", id: id.value },
          id.value,
        );
      return ok(payment);
    },
    emitWebhook(
      type: string,
      data: unknown,
      accountId: WhopAccountId | string = "biz_mock_platform",
    ) {
      const date = now();
      const timestamp = String(Math.floor(date.getTime() / 1000));
      const id = `msg_mock_${++deliverySequence}`;
      const apiVersionDate = options.apiVersionDate ?? "2026-08-21";
      const rawBody = JSON.stringify({
        id,
        type,
        api_version: "v1",
        api_version_date: apiVersionDate,
        timestamp: date.toISOString(),
        [apiVersionDate >= "2026-08-14" ? "account_id" : "company_id"]: accountId,
        data,
      });
      return {
        rawBody,
        headers: {
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": signStandardWebhook({
            rawBody,
            id,
            timestamp,
            secret: options.webhookSecret ?? "ws_mock_only",
            keyEncoding: options.keyEncoding ?? "raw",
          }),
        },
      };
    },
  });
}
export type MockWhopAdapter = ReturnType<typeof createMockAdapter>;

// Only the hybrid adapter's classified response gates use this adapter. It accepts
// real resource references without pretending they exist in the ordinary mock store.
function createDemoFallbackMock(base: WhopPort): WhopPort {
  const timestamp = "2026-09-08T00:00:00.000Z";
  const results = new Map<string, { fingerprint: string; value: unknown }>();
  function id(prefix: string, operation: string, key: string): string {
    return `${prefix}_mock_demo_${createHash("sha256")
      .update(JSON.stringify([operation, key]))
      .digest("hex")
      .slice(0, 32)}`;
  }
  function once<T>(
    operation: string,
    key: string,
    input: unknown,
    work: () => Result<T, WhopError>,
  ): Result<T, WhopError> {
    if (!key.trim()) return err({ kind: "invalid_request" });
    const cacheKey = JSON.stringify([operation, key]);
    const fingerprint = JSON.stringify(input);
    const prior = results.get(cacheKey);
    if (prior)
      return prior.fingerprint === fingerprint
        ? ok(structuredClone(prior.value) as T)
        : err({ kind: "idempotency_conflict" });
    const result = work();
    if (result.ok) results.set(cacheKey, { fingerprint, value: structuredClone(result.value) });
    return result;
  }
  function validAmount(amount: Money) {
    return money(amount.amountMinor, amount.currency).ok && amount.amountMinor > 0;
  }
  return {
    ...base,
    async getAccount(accountId, key) {
      return once("getAccount", key, accountId, () => {
        const account = whopAccountId(id("biz", "getAccount", key));
        if (!account.ok) throw new Error("Invalid demo account ID");
        return ok({
          id: account.value,
          raw: {
            id: account.value,
            source_account_id: accountId,
            verification: "verified",
            simulated: true,
          },
        });
      });
    },
    async refundPayment(paymentId, key, partial) {
      return once("refundPayment", key, { paymentId, partial }, () => {
        if (partial && !validAmount(partial)) return err({ kind: "invalid_request" });
        const refundId = id("rf", "refundPayment", key);
        return ok({
          id: refundId,
          raw: {
            id: refundId,
            payment_id: paymentId,
            status: "succeeded",
            amount: partial ?? null,
            created_at: timestamp,
            simulated: true,
          },
        });
      });
    },
    async createTransfer(input, key) {
      return once("createTransfer", key, input, () => {
        if (!validAmount(input.amount) || input.originId === input.destinationId)
          return err({ kind: "invalid_request" });
        const transferId = whopTransferId(id("tsf", "createTransfer", key));
        if (!transferId.ok) throw new Error("Invalid demo transfer ID");
        return ok({
          id: transferId.value,
          raw: {
            id: transferId.value,
            status: "succeeded",
            amount: toDecimalString(input.amount),
            currency: input.amount.currency.toLowerCase(),
            origin: { id: input.originId, typename: "Company" },
            destination: { id: input.destinationId, typename: "Company" },
            metadata: structuredClone(input.metadata),
            created_at: timestamp,
            simulated: true,
          },
        });
      });
    },
    async createPayout(input, key) {
      return once("createPayout", key, input, () => {
        if (!validAmount(input.amount) || !input.payoutMethodId.trim())
          return err({ kind: "invalid_request" });
        const payoutId = id("wdrl", "createPayout", key);
        const raw = {
          id: payoutId,
          account_id: input.accountId,
          payout_method_id: input.payoutMethodId,
          status: "completed" as const,
          amount: toDecimalString(input.amount),
          currency: input.amount.currency.toLowerCase(),
          fee_amount: "0.00",
          net_amount: toDecimalString(input.amount),
          speed: input.speed ?? "standard",
          metadata: structuredClone(input.metadata ?? {}),
          created_at: timestamp,
          simulated: true,
        };
        return ok({
          id: payoutId,
          status: raw.status,
          amount: { ...input.amount },
          feeAmount: { amountMinor: 0, currency: input.amount.currency },
          netAmount: { ...input.amount },
          speed: raw.speed,
          payoutMethodId: input.payoutMethodId,
          createdAt: timestamp,
          raw,
        });
      });
    },
    async listPayoutMethods(input) {
      const methodId = id("potk", "listPayoutMethods", input.accountId);
      if (input.cursor && input.cursor !== methodId) return err({ kind: "invalid_request" });
      return ok({
        items: input.cursor
          ? []
          : [
              {
                id: methodId,
                currency: null,
                isDefault: true,
                raw: { id: methodId, account_id: input.accountId, simulated: true },
              },
            ],
        nextCursor: null,
      });
    },
    async listSupportedPayoutMethods(input) {
      const methodId = id("spm", "listSupportedPayoutMethods", input.accountId);
      if (input.amount && !validAmount(input.amount)) return err({ kind: "invalid_request" });
      if (input.cursor && input.cursor !== methodId) return err({ kind: "invalid_request" });
      return ok({
        items: input.cursor
          ? []
          : [
              {
                id: methodId,
                name: "Simulated bank payout",
                deliveryType: "bank",
                supportsInstantDelivery: false,
                supportsStandardDelivery: true,
                raw: { id: methodId, account_id: input.accountId, simulated: true },
              },
            ],
        nextCursor: null,
      });
    },
    async createPayoutPortalLink(input, key) {
      return once("createPayoutPortalLink", key, input, () =>
        ok({
          url: `https://mock.invalid/payouts/${id("portal", "createPayoutPortalLink", key)}`,
          raw: { account_id: input.accountId, simulated: true },
        }),
      );
    },
  };
}
