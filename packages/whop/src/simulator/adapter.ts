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
  type WhopError,
  type WhopPaymentId,
  type WhopPort,
  type WhopTransferId,
  type WhopTransferRecord,
  whopTransferId,
} from "@ledgerly/core";
import { createMockAdapter } from "../mock-adapter";
import { type KeyEncoding, signStandardWebhook } from "../webhooks";
import { counter, restoreCollections } from "./snapshot";
import type {
  DeliverWebhook,
  SimulatedPayout,
  SimulatedPayoutStatus,
  SimulatedTransfer,
  SimulatedTransferStatus,
  TransferSimulateFlag,
} from "./types";

export type SimulatorOptions = {
  accounts?: readonly WhopAccount[];
  parentAccountId?: WhopAccountId;
  webhookSecret?: string;
  apiVersionDate?: string;
  keyEncoding?: KeyEncoding;
  now?: () => Date;
  // Omit in tests that only care about state, not delivery; defaults to a no-op so
  // createTransfer/originatePayout never throw for lack of a wired inbox.
  deliver?: DeliverWebhook;
};

type Balance = { available: Money; pending: Money };

type InternalTransfer = {
  status: SimulatedTransferStatus;
  amountMinor: number;
  currency: Currency;
  originId: WhopAccountId;
  destinationId: WhopAccountId;
  metadata: Record<string, string>;
  createdAt: Date;
};

type InternalPayout = {
  id: string;
  status: SimulatedPayoutStatus;
  amountMinor: number;
  currency: Currency;
  accountId: WhopAccountId;
  metadata: Record<string, string>;
  ticksElapsed: number;
};

function page<T extends { id: string }>(
  items: T[],
  cursor?: string,
): Result<{ items: T[]; nextCursor: string | null }, WhopError> {
  const index = cursor === undefined ? -1 : items.findIndex((item) => item.id === cursor);
  if (cursor !== undefined && index === -1) return err({ kind: "invalid_request" });
  const selected = items.slice(index + 1, index + 51);
  return ok({
    items: structuredClone(selected),
    nextCursor: index + 51 < items.length ? (selected.at(-1)?.id ?? null) : null,
  });
}

// A stateful, tick-driven WhopPort implementation for the platform-simulation lanes. Account,
// payment, checkout, onboarding-link, and access-token bookkeeping delegate to an internally
// held createMockAdapter() instance (its balance/idempotency handling is already correct and
// tested); this module owns everything specific to simulating deferred, flag-selectable
// transfer and payout outcomes: per-account pending/available balances, sim_-prefixed resource
// ids, and signed webhook delivery for the state transitions those two resources go through.
// See docs/lanes/architecture/platform-simulation.md for the full behavior contract.
export function createSimulatorAdapter(options: SimulatorOptions = {}) {
  const now = options.now ?? (() => new Date());
  const apiVersionDate = options.apiVersionDate ?? "2026-08-21";
  const webhookSecret = options.webhookSecret ?? "ws_sim_only";
  const keyEncoding = options.keyEncoding ?? "raw";
  const deliver: DeliverWebhook = options.deliver ?? (() => {});
  const internal = createMockAdapter({
    ...(options.accounts ? { accounts: options.accounts } : {}),
    ...(options.parentAccountId ? { parentAccountId: options.parentAccountId } : {}),
    webhookSecret,
    apiVersionDate,
    keyEncoding,
    now,
  });

  const balances = new Map<string, Balance>();
  const transfers = new Map<WhopTransferId, InternalTransfer>();
  const transferSuccessCache = new Map<
    string,
    { fingerprint: string; value: { id: WhopTransferId; raw: SimulatedTransfer } }
  >();
  const transferFlagAttempts = new Map<string, number>();
  const payouts = new Map<string, InternalPayout>();
  const payoutSuccessCache = new Map<string, { fingerprint: string; value: SimulatedPayout }>();
  const paymentAccounts = new Map<WhopPaymentId, WhopAccountId>();
  const refundIds = new Map<string, string>();
  let transferSequence = 0;
  let payoutSequence = 0;
  let deliverySequence = 0;

  function simulatedRefundId(id: string): string {
    const simulated = id.replace(/^(?:rf|ref)_mock_/, "sim_ref_");
    if (simulated !== id) refundIds.set(simulated, id);
    return simulated;
  }

  function internalRefundId(id: string): string {
    return refundIds.get(id) ?? id.replace(/^sim_ref_/, "rf_mock_");
  }

  function balanceKey(accountId: WhopAccountId, currency: Currency): string {
    return `${accountId}:${currency}`;
  }
  function balanceFor(accountId: WhopAccountId, currency: Currency): Balance {
    return (
      balances.get(balanceKey(accountId, currency)) ?? {
        available: { amountMinor: 0, currency },
        pending: { amountMinor: 0, currency },
      }
    );
  }
  function setBalance(accountId: WhopAccountId, currency: Currency, balance: Balance): void {
    balances.set(balanceKey(accountId, currency), balance);
  }

  function moneyFields(value: Money): Record<string, string> {
    return apiVersionDate >= "2026-08-21"
      ? { amount_minor: String(value.amountMinor), currency: value.currency }
      : { amount: toDecimalString(value), currency: value.currency };
  }

  async function deliverEvent(
    type: string,
    data: Record<string, unknown>,
    accountId: WhopAccountId,
  ): Promise<void> {
    const date = now();
    const timestamp = String(Math.floor(date.getTime() / 1000));
    const id = `msg_sim_${++deliverySequence}`;
    const rawBody = JSON.stringify({
      id,
      type,
      api_version: "v1",
      api_version_date: apiVersionDate,
      timestamp: date.toISOString(),
      [apiVersionDate >= "2026-08-14" ? "account_id" : "company_id"]: accountId,
      data,
    });
    await deliver({
      rawBody,
      headers: {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": signStandardWebhook({
          rawBody,
          id,
          timestamp,
          secret: webhookSecret,
          keyEncoding,
        }),
      },
    });
  }

  async function completeTransfer(id: WhopTransferId, record: InternalTransfer): Promise<void> {
    const pendingBalance = balanceFor(record.destinationId, record.currency);
    const amount = { amountMinor: record.amountMinor, currency: record.currency };
    const releasedPending = subtract(pendingBalance.pending, amount);
    const creditedAvailable = add(pendingBalance.available, amount);
    if (!releasedPending.ok || !creditedAvailable.ok)
      throw new Error("Invalid simulated transfer completion balance");
    setBalance(record.destinationId, record.currency, {
      available: creditedAvailable.value,
      pending: releasedPending.value,
    });
    record.status = "completed";
    await deliverEvent(
      "transfer.completed",
      {
        id,
        status: "completed",
        origin_id: record.originId,
        destination_id: record.destinationId,
        metadata: record.metadata,
        ...moneyFields(amount),
      },
      record.destinationId,
    );
  }

  async function emitPayoutEvent(
    type: "payout.created" | "payout.updated",
    payout: InternalPayout,
    dataStatus: "pending" | "in_transit" | "completed",
  ): Promise<void> {
    await deliverEvent(
      type,
      {
        id: payout.id,
        status: dataStatus,
        metadata: payout.metadata,
        ...moneyFields({ amountMinor: payout.amountMinor, currency: payout.currency }),
      },
      payout.accountId,
    );
  }

  const adapter: WhopPort = {
    // Accounts, payments, checkouts and webhook resources retain the wrapped adapter's IDs.
    suspendAccount: (id, key) => internal.suspendAccount(id, key),
    getCheckoutConfiguration: (id, key) => internal.getCheckoutConfiguration(id, key),
    async listRefunds(input) {
      const result = await internal.listRefunds({
        ...input,
        ...(input.cursor !== undefined ? { cursor: internalRefundId(input.cursor) } : {}),
      });
      if (!result.ok) return result;
      return ok({
        items: result.value.items.map((record) => ({
          ...record,
          id: simulatedRefundId(record.id),
        })),
        nextCursor:
          result.value.nextCursor === null ? null : simulatedRefundId(result.value.nextCursor),
      });
    },
    async getRefund(id, key) {
      const result = await internal.getRefund(internalRefundId(id), key);
      if (!result.ok) return result;
      return ok({ ...result.value, id: simulatedRefundId(result.value.id) });
    },
    listDisputes: (input) => internal.listDisputes(input),
    getDispute: (id, key) => internal.getDispute(id, key),
    async getTransfer(id, key) {
      const record = transfers.get(id);
      if (!record) return internal.getTransfer(id, key);
      return ok({
        id,
        status: record.status,
        amount: { amountMinor: record.amountMinor, currency: record.currency },
        currency: record.currency,
        createdAt: record.createdAt.toISOString(),
        origin: { id: record.originId, type: "Company" as const },
        destination: { id: record.destinationId, type: "Company" as const },
        raw: {
          id,
          status: record.status,
          amount: toDecimalString({ amountMinor: record.amountMinor, currency: record.currency }),
          currency: record.currency,
          origin_id: record.originId,
          destination_id: record.destinationId,
          metadata: { ...record.metadata },
        },
      });
    },
    listTransferRecipients: (input) => internal.listTransferRecipients(input),
    listPayouts: (input) => internal.listPayouts(input),
    getPayout: (input, key) => internal.getPayout(input, key),
    createPayout: (input, key) => internal.createPayout(input, key),
    listPayoutMethods: (input) => internal.listPayoutMethods(input),
    listSupportedPayoutMethods: (input) => internal.listSupportedPayoutMethods(input),
    listFeeMarkups: (input) => internal.listFeeMarkups(input),
    createFeeMarkup: (input, key) => internal.createFeeMarkup(input, key),
    createTopup: (input, key) => internal.createTopup(input, key),
    listWebhooks: (input) => internal.listWebhooks(input),
    getWebhook: (id, key) => internal.getWebhook(id, key),
    createWebhook: (input, key) => internal.createWebhook(input, key),
    updateWebhook: (id, input, key) => internal.updateWebhook(id, input, key),
    sendWebhookTest: (input, key) => internal.sendWebhookTest(input, key),
    listWebhookDeliveries: (input) => internal.listWebhookDeliveries(input),
    replayWebhookDelivery: (input, key) => internal.replayWebhookDelivery(input, key),
    createApiKey: (input, key) => internal.createApiKey(input, key),
    listApiKeyPermissions: (input) => internal.listApiKeyPermissions(input),
    async listFinancialActivity(input) {
      const result = await internal.listFinancialActivity(input);
      if (!result.ok) return result;
      return ok({
        ...result.value,
        items: result.value.items.map((record) => ({
          ...record,
          source:
            record.source?.type === "refund"
              ? { ...record.source, id: simulatedRefundId(record.source.id) }
              : record.source,
        })),
      });
    },
    getLedgerAccount: (id, key) => internal.getLedgerAccount(id, key),
    createAccount: (input, key) => internal.createAccount(input, key),
    updateAccount: (id, input, key) => internal.updateAccount(id, input, key),
    listPayments: (input) => internal.listPayments(input),
    async listTransfers(input) {
      const items: WhopTransferRecord[] = [...transfers.entries()]
        .filter(([, t]) => t.originId === input.accountId || t.destinationId === input.accountId)
        .sort((a, b) => b[1].createdAt.getTime() - a[1].createdAt.getTime())
        .map(([id, t]) => ({
          id,
          status: t.status,
          amount: { amountMinor: t.amountMinor, currency: t.currency },
          currency: t.currency,
          createdAt: t.createdAt.toISOString(),
          origin: { id: t.originId, type: "Company" as const },
          destination: { id: t.destinationId, type: "Company" as const },
        }));
      return page(items, input.cursor);
    },
    createOrFetchAccount: (input, key) => internal.createOrFetchAccount(input, key),
    createOnboardingLink: (input, key) => internal.createOnboardingLink(input, key),
    createCheckoutConfiguration: (input, key) => internal.createCheckoutConfiguration(input, key),
    getAccount: (id, key) => internal.getAccount(id, key),
    getPayment: (id, key) => internal.getPayment(id, key),
    listPaymentFees: (id, key) => internal.listPaymentFees(id, key),
    async refundPayment(id, key, partial) {
      const result = await internal.refundPayment(id, key, partial);
      if (!result.ok) return result;
      const remapped = {
        id: simulatedRefundId(result.value.id),
        raw: result.value.raw,
      };
      const accountId = paymentAccounts.get(id);
      if (accountId) {
        const refund = await internal.getRefund(result.value.id, key);
        if (!refund.ok || !refund.value.amount) throw new Error("Invalid simulated refund amount");
        await deliverEvent(
          "refund.created",
          { id: remapped.id, payment_id: id, ...moneyFields(refund.value.amount) },
          accountId,
        );
      }
      return ok(remapped);
    },
    async createTransfer(input, idempotencyKey) {
      if (!idempotencyKey.trim()) return err({ kind: "invalid_request" });
      if (
        !money(input.amount.amountMinor, input.amount.currency).ok ||
        input.amount.amountMinor <= 0 ||
        input.originId === input.destinationId
      )
        return err({ kind: "invalid_request" });
      const fingerprint = JSON.stringify(input);
      const cached = transferSuccessCache.get(idempotencyKey);
      if (cached)
        return cached.fingerprint === fingerprint
          ? ok(structuredClone(cached.value))
          : err({ kind: "idempotency_conflict" });

      const simulate = input.metadata?.simulate as TransferSimulateFlag | undefined;
      if (simulate === "timeout") return err({ kind: "network" });
      if (simulate === "insufficient_balance") return err({ kind: "insufficient_balance" });
      if (simulate === "unknown_outcome" || simulate === "fail_then_succeed") {
        const attempts = (transferFlagAttempts.get(idempotencyKey) ?? 0) + 1;
        transferFlagAttempts.set(idempotencyKey, attempts);
        if (attempts === 1)
          return err(
            simulate === "unknown_outcome" ? { kind: "network" } : { kind: "insufficient_balance" },
          );
        // Second call with the same idempotency key: fall through and complete normally, as if
        // the first attempt's outcome had in fact landed.
      }

      const origin = await internal.getAccount(input.originId, idempotencyKey);
      if (!origin.ok) return err({ kind: "not_found" });
      const destination = await internal.getAccount(input.destinationId, idempotencyKey);
      if (!destination.ok) return err({ kind: "not_found" });

      const originBalance = balanceFor(input.originId, input.amount.currency);
      if (originBalance.available.amountMinor < input.amount.amountMinor)
        return err({ kind: "insufficient_balance" });
      const debited = subtract(originBalance.available, input.amount);
      if (!debited.ok) return err({ kind: "invalid_request" });
      setBalance(input.originId, input.amount.currency, {
        ...originBalance,
        available: debited.value,
      });
      const destinationBalance = balanceFor(input.destinationId, input.amount.currency);
      const credited = add(destinationBalance.pending, input.amount);
      if (!credited.ok) return err({ kind: "invalid_request" });
      setBalance(input.destinationId, input.amount.currency, {
        ...destinationBalance,
        pending: credited.value,
      });

      const id = whopTransferId(`sim_tr_${++transferSequence}`);
      if (!id.ok) throw new Error("Invalid simulated transfer ID");
      const metadata = { ...input.metadata };
      transfers.set(id.value, {
        status: "pending",
        amountMinor: input.amount.amountMinor,
        currency: input.amount.currency,
        originId: input.originId,
        destinationId: input.destinationId,
        metadata,
        createdAt: now(),
      });
      const value = {
        id: id.value,
        raw: {
          id: id.value,
          status: "pending" as const,
          amount: toDecimalString(input.amount),
          currency: input.amount.currency,
          origin_id: input.originId,
          destination_id: input.destinationId,
          metadata,
        },
      };
      transferSuccessCache.set(idempotencyKey, { fingerprint, value });
      return ok(value);
    },
    async createAccessToken(input, key) {
      const result = await internal.createAccessToken(input, key);
      if (!result.ok) return result;
      return ok({
        token: result.value.token.replace(/^mock_token_/, "sim_token_"),
        raw: result.value.raw,
      });
    },
    async createPayoutPortalLink(input, key) {
      const result = await internal.createPayoutPortalLink(input, key);
      if (!result.ok) return result;
      return ok({
        url: `https://sandbox.whop.com/simulated/payouts/${input.accountId}`,
        raw: result.value.raw,
      });
    },
  };

  const collections = {
    balances,
    transfers,
    transferSuccessCache,
    transferFlagAttempts,
    payouts,
    payoutSuccessCache,
    paymentAccounts,
    refundIds,
  };
  function snapshotState() {
    return structuredClone({
      version: 1,
      internal: internal.snapshotState(),
      collections,
      transferSequence,
      payoutSequence,
      deliverySequence,
    });
  }
  function restoreState(raw: unknown) {
    if (!raw || typeof raw !== "object" || (raw as { version?: unknown }).version !== 1)
      throw new Error("Invalid simulator snapshot version");
    const saved = raw as ReturnType<typeof snapshotState>;
    transferSequence = counter(saved.transferSequence);
    payoutSequence = counter(saved.payoutSequence);
    deliverySequence = counter(saved.deliverySequence);
    internal.restoreState(saved.internal);
    restoreCollections(collections, saved.collections);
  }
  return Object.assign(adapter, {
    snapshotState,
    restoreState,
    // Advances every pending transfer to "completed" and every payout one step along its
    // requested -> processing -> completed schedule, emitting the corresponding signed webhook
    // for each state change. Called once per sweep tick from apps/web's cron handler.
    async tick(): Promise<void> {
      for (const [id, record] of transfers) {
        if (record.status === "pending") await completeTransfer(id, record);
      }
      for (const payout of payouts.values()) {
        if (payout.status !== "requested" && payout.status !== "processing") continue;
        payout.ticksElapsed++;
        if (payout.ticksElapsed === 1 && payout.status === "requested") {
          payout.status = "processing";
          await emitPayoutEvent("payout.updated", payout, "in_transit");
        } else if (payout.ticksElapsed === 3 && payout.status === "processing") {
          payout.status = "completed";
          await emitPayoutEvent("payout.updated", payout, "completed");
        }
      }
    },
    // Not part of WhopPort: createTransfer moves money between two Whop accounts, but a payout
    // (an account cashing out to its external bank) has no equivalent WhopPort method, so the
    // simulator originates one directly for tests and demo flows that need one.
    async originatePayout(
      input: { accountId: WhopAccountId; amount: Money; metadata?: Record<string, string> },
      idempotencyKey: string,
    ): Promise<Result<SimulatedPayout, WhopError>> {
      if (!idempotencyKey.trim()) return err({ kind: "invalid_request" });
      if (
        !money(input.amount.amountMinor, input.amount.currency).ok ||
        input.amount.amountMinor <= 0
      )
        return err({ kind: "invalid_request" });
      const fingerprint = JSON.stringify(input);
      const cached = payoutSuccessCache.get(idempotencyKey);
      if (cached)
        return cached.fingerprint === fingerprint
          ? ok(structuredClone(cached.value))
          : err({ kind: "idempotency_conflict" });
      const account = await internal.getAccount(input.accountId, idempotencyKey);
      if (!account.ok) return err({ kind: "not_found" });
      const id = `sim_po_${++payoutSequence}`;
      const metadata = { ...(input.metadata ?? {}) };
      const record: InternalPayout = {
        id,
        status: "requested",
        amountMinor: input.amount.amountMinor,
        currency: input.amount.currency,
        accountId: input.accountId,
        metadata,
        ticksElapsed: 0,
      };
      payouts.set(id, record);
      const value: SimulatedPayout = {
        id,
        status: "requested",
        amount: toDecimalString(input.amount),
        currency: input.amount.currency,
        account_id: input.accountId,
        metadata,
      };
      payoutSuccessCache.set(idempotencyKey, { fingerprint, value });
      await emitPayoutEvent("payout.created", record, "pending");
      return ok(value);
    },
    getPayoutStatus(id: string): SimulatedPayoutStatus | null {
      return payouts.get(id)?.status ?? null;
    },
    getBalance(accountId: WhopAccountId, currency: Currency): Balance {
      const balance = balanceFor(accountId, currency);
      return { available: { ...balance.available }, pending: { ...balance.pending } };
    },
    seedBalance(accountId: WhopAccountId, amount: Money): Result<true, WhopError> {
      if (!money(amount.amountMinor, amount.currency).ok || amount.amountMinor < 0)
        return err({ kind: "invalid_request" });
      const balance = balanceFor(accountId, amount.currency);
      setBalance(accountId, amount.currency, { ...balance, available: { ...amount } });
      return ok(true);
    },
    seedPayment(amount: Money, accountId: WhopAccountId | null = null, key?: string) {
      const result = internal.seedPayment(amount, accountId, key);
      if (result.ok && accountId) paymentAccounts.set(result.value.id, accountId);
      return result;
    },
  });
}

export type SimulatorAdapter = ReturnType<typeof createSimulatorAdapter>;
