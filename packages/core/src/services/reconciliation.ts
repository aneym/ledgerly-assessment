import type { SellerId } from "../ids";
import { add, type Money, money } from "../money";
import type { WhopLedgerLine, WhopPort } from "../ports/whop";
import { err, ok } from "../result";
import { getProviderEarnings, type ProviderEarningsResult } from "./earnings";
import type { ProviderSource } from "./orders";
import type { ListInput, ProviderRecord, ReconciliationProvider, UnitOfWork } from "./ports";

export type ReconciliationItem = {
  resourceType: "payment" | "transfer";
  resourceId: string;
  amount: Money;
};
export type ReconciliationComparison = {
  resourceType: "payment" | "transfer";
  resourceId: string;
  local: Money | null;
  provider: Money | null;
  providerStatus: ProviderRecord["status"] | null;
  matches: boolean;
};
export type ReconciliationReport = {
  // Both sides come from this reconciliation's ledger/provider snapshot. Consumers must
  // require a confirmed provider status as well as equality before treating it as settled.
  comparisons?: ReconciliationComparison[];
  financialActivity?: ProviderEarningsResult & {
    lines: Omit<WhopLedgerLine, "raw">[];
    comparisons: { resourceId: string; provider: Money; local: Money | null; matches: boolean }[];
  };
  missingLocally: ReconciliationItem[];
  missingAtProvider: ReconciliationItem[];
  amountMismatch: { local: ReconciliationItem; provider: ReconciliationItem }[];
  pendingOrReserve: (ReconciliationItem & { status: string })[];
  // A gated or rejected transfer read leaves payment comparison available.
  // Local transfers are not reported missing when the provider cannot list them.
  transfersUnavailable?: "invalid_request" | "capability_inactive";
};
export function createReconciliationService(
  uow: UnitOfWork,
  defaultProvenance: ProviderSource | null = null,
) {
  return async function reconcileSeller({
    sellerId,
    provider,
    maxPages = 100,
  }: {
    sellerId: SellerId;
    provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> &
      Partial<Pick<WhopPort, "listFinancialActivity">>;
    maxPages?: number;
  }) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000)
      throw new Error("Invalid reconciliation page bound");
    const snapshot = await uow.run(async (r) => ({
      seller: await r.sellers.get(sellerId),
      entries: await r.ledger.forSeller(sellerId),
    }));
    const accountId = snapshot.seller?.whopAccountId;
    if (!accountId) return err({ kind: "seller_not_connected" as const });
    const records: (ProviderRecord & { resourceType: "payment" | "transfer" })[] = [];
    let transfersUnavailable: ReconciliationReport["transfersUnavailable"];
    for (const resourceType of ["payment", "transfer"] as const) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; ; page++) {
        if (page >= maxPages) return err({ kind: "page_limit" as const });
        const input: ListInput = { accountId, limit: 100, ...(cursor ? { cursor } : {}) };
        const transferInput = { ...input, direction: "destination" as const };
        const result = await (resourceType === "payment"
          ? provider.listPayments(input)
          : provider.listTransfers(transferInput));
        if (!result.ok) {
          const kind = (result.error as { kind: string }).kind;
          if (
            resourceType === "transfer" &&
            (kind === "invalid_request" || kind === "capability_inactive")
          ) {
            transfersUnavailable = kind;
            break;
          }
          return result;
        }
        for (const record of result.value.data) {
          if (record.accountId !== accountId)
            return err({ kind: "provider_seller_mismatch" as const });
          if (
            !record.id ||
            !money(record.amount.amountMinor, record.amount.currency).ok ||
            record.amount.amountMinor < 0
          )
            return err({ kind: "invalid_provider_record" as const });
          records.push({ ...record, resourceType });
        }
        if (result.value.nextCursor === null) break;
        cursor = result.value.nextCursor;
        if (!cursor || seen.has(cursor)) return err({ kind: "pagination_cycle" as const });
        seen.add(cursor);
      }
    }
    // Keep financial lines separate from payment/transfer records: adding them to
    // those records would count the same provider activity twice. No writes occur.
    let financialActivity: ReconciliationReport["financialActivity"];
    const listFinancialActivity = provider.listFinancialActivity?.bind(provider);
    if (listFinancialActivity) {
      let lines: Omit<WhopLedgerLine, "raw">[] = [];
      const summary = await getProviderEarnings(
        {
          async listFinancialActivity(input) {
            const result = await listFinancialActivity(input);
            if (result.ok) lines = result.value.items.map(({ raw: _raw, ...line }) => line);
            return result;
          },
        },
        accountId,
        defaultProvenance,
      );
      if (!summary.provider) lines = [];
      const activityTotals = new Map<string, { resourceId: string; amount: Money }>();
      for (const line of lines) {
        const resourceId = line.paymentId ?? line.source?.id;
        if (!resourceId || !line.amount) continue;
        const key = JSON.stringify([resourceId, line.amount.currency]);
        const prior = activityTotals.get(key);
        const total = prior ? add(prior.amount, line.amount) : ok(line.amount);
        if (!total.ok) return err({ kind: "invalid_provider_record" as const });
        activityTotals.set(key, { resourceId, amount: total.value });
      }
      const comparisons = [...activityTotals.values()].map(({ resourceId, amount }) => {
        let local: Money | null = null;
        for (const entry of snapshot.entries) {
          if (
            entry.accountSide !== "seller" ||
            entry.resourceId !== resourceId ||
            entry.amount.currency !== amount.currency
          )
            continue;
          const total: ReturnType<typeof add> = local ? add(local, entry.amount) : ok(entry.amount);
          if (!total.ok) throw new Error("Ledger aggregation overflow");
          local = total.value;
        }
        return {
          resourceId,
          provider: amount,
          local,
          matches: local?.amountMinor === amount.amountMinor,
        };
      });
      financialActivity = { ...summary, lines, comparisons };
    }
    const comparisons: ReconciliationComparison[] = [];
    const report: ReconciliationReport = {
      comparisons,
      ...(financialActivity ? { financialActivity } : {}),
      missingLocally: [],
      missingAtProvider: [],
      amountMismatch: [],
      pendingOrReserve: [],
      ...(transfersUnavailable === undefined ? {} : { transfersUnavailable }),
    };
    const key = (row: ReconciliationItem) =>
      JSON.stringify([row.resourceType, row.resourceId, row.amount.currency]);
    const local = new Map<string, ReconciliationItem>();
    for (const entry of snapshot.entries) {
      if (entry.resourceType !== "payment" && entry.resourceType !== "transfer") continue;
      if (entry.resourceType === "transfer" && entry.accountSide !== "seller") continue;
      // Without a provider transfer list there is nothing to compare local transfers
      // against, so they are neither confirmed nor reported missing.
      if (entry.resourceType === "transfer" && transfersUnavailable !== undefined) continue;
      const item: ReconciliationItem = {
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        amount: entry.amount,
      };
      const prior = local.get(key(item));
      if (prior) {
        const sum = add(prior.amount, item.amount);
        if (!sum.ok) throw new Error("Ledger aggregation overflow");
        item.amount = sum.value;
      }
      local.set(key(item), item);
    }
    const providerSeen = new Map<string, ProviderRecord>();
    for (const record of records) {
      const item: ReconciliationItem = {
        resourceType: record.resourceType,
        resourceId: record.id,
        amount: record.amount,
      };
      const identity = key(item);
      const previous = providerSeen.get(identity);
      if (previous) {
        if (
          previous.amount.amountMinor !== record.amount.amountMinor ||
          previous.status !== record.status
        )
          return err({ kind: "provider_snapshot_conflict" as const });
        continue;
      }
      providerSeen.set(identity, record);
      const existing = local.get(identity);
      comparisons.push({
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        local: existing?.amount ?? null,
        provider: record.amount,
        providerStatus: record.status,
        matches: existing?.amount.amountMinor === record.amount.amountMinor,
      });
      if (record.status === "pending" || record.status === "reserve")
        report.pendingOrReserve.push({ ...item, status: record.status });
      else if (record.status !== "failed") {
        if (!existing) report.missingLocally.push(item);
        else if (existing.amount.amountMinor !== record.amount.amountMinor)
          report.amountMismatch.push({ local: existing, provider: item });
      } else if (existing) report.missingAtProvider.push(existing);
      local.delete(identity);
    }
    for (const item of local.values()) {
      comparisons.push({
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        local: item.amount,
        provider: null,
        providerStatus: null,
        matches: false,
      });
    }
    report.missingAtProvider.push(...local.values());
    return ok(report);
  };
}
