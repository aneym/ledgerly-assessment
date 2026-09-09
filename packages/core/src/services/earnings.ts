import type { SellerId, WhopAccountId } from "../ids";
import { add, type Money, money } from "../money";
import type { WhopLedgerLine, WhopPort } from "../ports/whop";
import type { WhopError } from "../ports/whop-types";
import type { ProviderSource } from "./orders";
import type { LedgerEntry, LedgerRepo } from "./ports";

export type EarningsTotal = { currency: Money["currency"]; total: Money };
export type Earnings = {
  totals: EarningsTotal[];
  recent: LedgerEntry[];
};

// Sums the seller's own share of every ledger entry, grouped by currency,
// and lists the most recent entries. Platform-side entries (the fee) are
// excluded: this is what the seller has earned, not the gross the buyer
// paid. There is no failure mode here worth a Result — a seller with no
// entries just gets an empty report.
export function createEarningsService(deps: { ledger: Pick<LedgerRepo, "forSeller"> }) {
  return async function getEarnings(sellerId: SellerId, recentLimit = 20): Promise<Earnings> {
    const entries = await deps.ledger.forSeller(sellerId);
    const sellerSide = entries.filter((entry) => entry.accountSide === "seller");
    const totalsByCurrency = new Map<Money["currency"], Money>();
    for (const entry of sellerSide) {
      const running = totalsByCurrency.get(entry.amount.currency);
      let base = running;
      if (!base) {
        const zero = money(0, entry.amount.currency);
        if (!zero.ok) throw new Error("Invalid currency on a persisted ledger entry");
        base = zero.value;
      }
      const sum = add(base, entry.amount);
      if (!sum.ok) throw new Error("Ledger total overflowed");
      totalsByCurrency.set(entry.amount.currency, sum.value);
    }
    const totals = [...totalsByCurrency.entries()].map(([currency, total]) => ({
      currency,
      total,
    }));
    const recent = [...sellerSide]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, recentLimit);
    return { totals, recent };
  };
}

// --- API-facing earnings shapes (GET /api/sellers/{id}/earnings) ---
//
// The ledger model (packages/core/src/services/ports.ts) has no order-id linkage and no
// per-entry provenance that any owned writer actually populates (inbox.ts, which appends
// these rows, is out of this lane's ownership and never sets one), so both of those are
// filled in uniformly below rather than read from the entry itself: order_id is always
// null, and provenance is the caller-supplied value for the whole page (see
// apps/web/src/lib/seller-view.ts's provenanceOf).

export type EarningsRowStatus = "pending" | "settled" | "refunded" | "paid_out" | "failed";

export type EarningsRow = {
  date: string;
  order_id: string | null;
  item: string;
  status: EarningsRowStatus;
  gross: Money;
  fee: Money;
  net: Money;
  provider_resource_id: string;
  provenance: ProviderSource;
};

export type EarningsSummary = { available: Money; pending: Money; held: Money };

// Only these ledger kinds are seller-facing line items; "fee" and "refund_fee" are the
// platform-side counterpart of a payment/refund (paired below via effectKey, never a row
// on their own).
const ITEM_BY_KIND: Record<string, string> = {
  payment: "payment",
  refund: "refund",
  transfer: "transfer",
  payout_pending: "payout",
  payout_in_transit: "payout",
  payout_completed: "payout",
  payout_failed: "payout",
  payout_canceled: "payout",
};

const STATUS_BY_KIND: Record<string, EarningsRowStatus> = {
  payment: "settled",
  refund: "refunded",
  transfer: "settled",
  payout_pending: "pending",
  payout_in_transit: "pending",
  payout_completed: "paid_out",
  payout_failed: "failed",
  payout_canceled: "failed",
};

const FEE_COUNTERPART_KINDS = new Set(["fee", "refund_fee"]);

function zeroLike(reference: Money): Money {
  const zero = money(0, reference.currency);
  if (!zero.ok) throw new Error("Invalid currency on a persisted ledger entry");
  return zero.value;
}

// Reconstructs each row's gross/fee split from a seller-side entry (the net the seller was
// credited or debited) and its platform-side fee counterpart, matched by the effectKey both
// entries share (see inbox.ts's entriesFor, which builds both from one shared base). Kinds
// with no fee leg (transfer, payout_*) fall back to gross = net, fee = zero.
export function buildEarningsRows(
  entries: LedgerEntry[],
  provenance: ProviderSource,
  limit = 20,
): EarningsRow[] {
  const feeByEffectKey = new Map<string, Money>();
  for (const entry of entries) {
    if (entry.accountSide === "platform" && FEE_COUNTERPART_KINDS.has(entry.kind)) {
      feeByEffectKey.set(entry.effectKey, entry.amount);
    }
  }
  const rows = entries
    .filter((entry) => entry.accountSide === "seller" && Object.hasOwn(ITEM_BY_KIND, entry.kind))
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, limit)
    .map((entry): EarningsRow => {
      const net = entry.amount;
      const fee = feeByEffectKey.get(entry.effectKey) ?? zeroLike(net);
      const gross = add(net, fee);
      return {
        date: entry.occurredAt.toISOString(),
        order_id: null,
        item: ITEM_BY_KIND[entry.kind] ?? entry.kind,
        status: STATUS_BY_KIND[entry.kind] ?? "settled",
        gross: gross.ok ? gross.value : net,
        fee,
        net,
        provider_resource_id: entry.resourceId,
        provenance,
      };
    });
  return rows;
}

// available/pending/held from the running seller-side balance. The ledger model only ever
// debits a seller's balance when a payout completes (payout_pending/payout_in_transit post
// amountMinor: 0 per inbox.ts), so the signed total already computed by createEarningsService
// IS the current available balance; there is no signal in the ledger for money that is
// pending release or held, since that would require an explicit operator status override on
// a ledger row, a feature this lane does not build. Both are reported as zero of the primary
// currency until such a signal exists.
export function summarize(totals: EarningsTotal[]): EarningsSummary {
  const primary = totals[0];
  if (!primary) {
    const zero = money(0, "USD");
    if (!zero.ok) throw new Error("unreachable: USD is always valid");
    return { available: zero.value, pending: zero.value, held: zero.value };
  }
  const zero = zeroLike(primary.total);
  return { available: primary.total, pending: zero, held: zero };
}

// These are signed activity totals for one page, not an authoritative account balance.
export type ProviderEarnings = {
  available: EarningsTotal[];
  pending: EarningsTotal[];
  reserve: EarningsTotal[];
  line_count: number;
  has_more: boolean;
  basis: "first_page_activity";
  // Null means neither the operation nor its caller supplied a known source.
  provenance: ProviderSource | null;
};
export type ProviderEarningsResult = {
  provider: ProviderEarnings | null;
  provider_error: WhopError["kind"] | "seller_not_connected" | "provider_unavailable" | null;
};

export function summarizeFinancialActivity(
  lines: WhopLedgerLine[],
  hasMore: boolean,
  provenance: ProviderSource | null = null,
  now = new Date(),
): ProviderEarnings | null {
  const buckets = {
    available: new Map<string, Money>(),
    pending: new Map<string, Money>(),
    reserve: new Map<string, Money>(),
  };
  function accumulate(bucket: Map<string, Money>, amount: Money): boolean {
    const sum = add(bucket.get(amount.currency) ?? zeroLike(amount), amount);
    if (!sum.ok) return false;
    bucket.set(amount.currency, sum.value);
    return true;
  }
  for (const line of lines) {
    if (!line.amount || !money(line.amount.amountMinor, line.amount.currency).ok) return null;
    const release = line.availableAt === null ? null : Date.parse(line.availableAt);
    if (release !== null && !Number.isFinite(release)) return null;
    const bucket =
      release !== null && release > now.getTime() ? buckets.pending : buckets.available;
    if (!accumulate(bucket, line.amount)) return null;
    if (
      line.lineType === "balance_reservation" ||
      line.lineType === "balance_reservation_reversal"
    ) {
      const reserved = money(-line.amount.amountMinor, line.amount.currency);
      if (!reserved.ok || !accumulate(buckets.reserve, reserved.value)) return null;
    }
    for (const map of Object.values(buckets)) {
      if (!map.has(line.amount.currency)) map.set(line.amount.currency, zeroLike(line.amount));
    }
  }
  const totals = (map: Map<string, Money>): EarningsTotal[] =>
    [...map.values()].map((total) => ({ currency: total.currency, total }));
  return {
    available: totals(buckets.available),
    pending: totals(buckets.pending),
    reserve: totals(buckets.reserve),
    line_count: lines.length,
    has_more: hasMore,
    basis: "first_page_activity",
    provenance,
  };
}

// Hybrid results carry operation provenance on the value. An unknown source must
// not become sandbox evidence, even when the configured fallback is sandbox.
function activityProvenance(
  value: unknown,
  fallback: ProviderSource | null,
): ProviderSource | null {
  if (typeof value !== "object" || value === null || !("meta" in value)) return fallback;
  const meta = value.meta;
  if (typeof meta !== "object" || meta === null || !("source" in meta)) return fallback;
  return meta.source === "mock" || meta.source === "sandbox" ? meta.source : null;
}

export async function getProviderEarnings(
  provider: Pick<WhopPort, "listFinancialActivity">,
  accountId: WhopAccountId | null,
  defaultProvenance: ProviderSource | null = null,
): Promise<ProviderEarningsResult> {
  if (!accountId) return { provider: null, provider_error: "seller_not_connected" };
  try {
    // No direction filter: include both credits and debits. No line-type filter:
    // use the provider's default seller activity categories, not platform fee income.
    const result = await provider.listFinancialActivity({ accountId, limit: 100 });
    if (!result.ok) return { provider: null, provider_error: result.error.kind };
    const summary = summarizeFinancialActivity(
      result.value.items,
      result.value.nextCursor !== null,
      activityProvenance(result.value, defaultProvenance),
    );
    return { provider: summary, provider_error: summary ? null : "decode" };
  } catch {
    return { provider: null, provider_error: "provider_unavailable" };
  }
}
