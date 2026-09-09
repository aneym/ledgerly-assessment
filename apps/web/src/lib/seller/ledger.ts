import { computePlatformFee } from "@ledgerly/core/fee";
import { fromDecimalString, type Money } from "@ledgerly/core/money";
import type { ApiAmount, ApiEarnings, ApiLedgerEntry, ApiLedgerRow } from "./api";

/**
 * Seller ledger view model. Available, pending and held are distinct balances
 * (financial-invariants.md, 4 and 10): available is settled and eligible to transfer,
 * pending is settling, held is frozen by a dispute. A transfer is not a payout.
 */
export type LedgerStatus = "settling" | "settled" | "held" | "refunded" | "paid_out" | "failed";

export type LedgerRow = {
  id: string;
  /** ISO date. */
  date: string;
  item: string;
  /** Secondary line under the item: buyer city or the refunded order. */
  note: string;
  /** Order or refund id, rendered in mono. */
  order: string;
  status: LedgerStatus;
  /** Signed: negative for a refund. */
  gross: Money;
  fee: Money;
  net: Money;
  /** Catalog product id when known, for the thumbnail. */
  productId?: string;
  /**
   * True when the API entry carried only the seller's share: gross and fee are not known
   * for the row and render as absent, never as a number computed here.
   */
  partial?: boolean;
};

export type LedgerSummary = {
  available: Money;
  pending: Money;
  held: Money;
  rows: LedgerRow[];
  totals: { gross: Money; fee: Money; net: Money };
  /** Null when the API response carried no provenance; the screen then shows no badge. */
  provenance: "mock" | "sandbox" | "live" | null;
  /** From the API's charge_model; absent on the fixture. */
  chargeModel?: "direct" | "platform_transfer";
  /**
   * True when the API answered one total per currency instead of available, pending and
   * held: the whole total is shown as available and the other two are not reported.
   */
  totalsOnly?: boolean;
};

export const STATUS_LABEL: Record<LedgerStatus, string> = {
  settling: "Settling",
  settled: "Settled",
  held: "Held, dispute",
  refunded: "Refunded",
  paid_out: "Paid out",
  failed: "Failed",
};

export const STATUS_TONE: Record<LedgerStatus, "ok" | "warn" | "bad" | "plain"> = {
  settling: "warn",
  settled: "ok",
  held: "bad",
  refunded: "plain",
  paid_out: "ok",
  failed: "bad",
};

const USD = "USD" as const;
const zero: Money = { amountMinor: 0, currency: USD };

function sum(rows: LedgerRow[], pick: (row: LedgerRow) => Money): Money {
  return rows.reduce<Money>(
    (acc, row) => ({
      amountMinor: acc.amountMinor + pick(row).amountMinor,
      currency: acc.currency,
    }),
    zero,
  );
}

/** Fee and net from a signed gross, always through computePlatformFee. */
export function splitGross(gross: Money): { fee: Money; net: Money } {
  const sign = gross.amountMinor < 0 ? -1 : 1;
  const magnitude: Money = { amountMinor: Math.abs(gross.amountMinor), currency: gross.currency };
  const result = computePlatformFee(magnitude);
  if (!result.ok) return { fee: { amountMinor: 0, currency: gross.currency }, net: gross };
  return {
    fee: { amountMinor: sign * result.value.fee.amountMinor, currency: gross.currency },
    net: { amountMinor: sign * result.value.sellerShare.amountMinor, currency: gross.currency },
  };
}

function summarize(rows: LedgerRow[], provenance: LedgerSummary["provenance"]): LedgerSummary {
  const settled = rows.filter((r) => r.status === "settled" || r.status === "refunded");
  return {
    available: sum(settled, (r) => r.net),
    pending: sum(
      rows.filter((r) => r.status === "settling"),
      (r) => r.net,
    ),
    held: sum(
      rows.filter((r) => r.status === "held"),
      (r) => r.net,
    ),
    rows,
    totals: {
      gross: sum(rows, (r) => r.gross),
      fee: sum(rows, (r) => r.fee),
      net: sum(rows, (r) => r.net),
    },
    provenance,
  };
}

type Seed = Omit<LedgerRow, "fee" | "net" | "gross"> & { grossMinor: number };

function seedRow(seed: Seed): LedgerRow {
  const { grossMinor, ...rest } = seed;
  const gross: Money = { amountMinor: grossMinor, currency: USD };
  return { ...rest, gross, ...splitGross(gross) };
}

const ONDA_DRUMS = { productId: "prd_onda_drums", item: "Onda Drum Library" };
const STREETLIGHT = { productId: "prd_streetlight", item: "Streetlight Sessions" };

/**
 * Fixture ledger for Onda Sounds, labelled MOCK wherever it renders.
 * Seven rows: two settled drum sales, a settled EP, one settling, one held, one paid out,
 * and a refund of the first drum sale. Fee on every row comes from computePlatformFee.
 */
export function ondaFixtureLedger(): LedgerSummary {
  const rows: LedgerRow[] = [
    seedRow({
      id: "tx_08",
      date: "2026-09-08",
      ...ONDA_DRUMS,
      note: "Buyer in Lisbon",
      order: "ord_7f3a9c",
      status: "settling",
      grossMinor: 6000,
    }),
    seedRow({
      id: "tx_07",
      date: "2026-09-07",
      ...STREETLIGHT,
      note: "Buyer in Osaka",
      order: "ord_7e91b2",
      status: "settled",
      grossMinor: 1200,
    }),
    seedRow({
      id: "tx_06",
      date: "2026-09-06",
      ...ONDA_DRUMS,
      note: "Buyer in Berlin",
      order: "ord_7d40e8",
      status: "settled",
      grossMinor: 6000,
    }),
    seedRow({
      id: "tx_05",
      date: "2026-09-05",
      ...STREETLIGHT,
      note: "Buyer in Austin",
      order: "ord_7c2f14",
      status: "held",
      grossMinor: 1200,
    }),
    seedRow({
      id: "tx_03",
      date: "2026-09-03",
      ...ONDA_DRUMS,
      note: "Refund of ord_7a88d0",
      order: "rfd_1b6c02",
      status: "refunded",
      grossMinor: -6000,
    }),
    seedRow({
      id: "tx_02",
      date: "2026-09-02",
      ...STREETLIGHT,
      note: "Buyer in Toronto",
      order: "ord_7b1e77",
      status: "paid_out",
      grossMinor: 1200,
    }),
    seedRow({
      id: "tx_01",
      date: "2026-09-01",
      ...ONDA_DRUMS,
      note: "Buyer in Seoul",
      order: "ord_7a88d0",
      status: "settled",
      grossMinor: 6000,
    }),
  ];
  return summarize(rows, "mock");
}

// ---- Normalizing the API payload -------------------------------------------

function toMoney(value: ApiAmount | undefined, currency: Money["currency"]): Money | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? { amountMinor: value, currency } : null;
  if (typeof value === "string") {
    const parsed = fromDecimalString(value, currency);
    return parsed.ok ? parsed.value : null;
  }
  const cur = (value.currency as Money["currency"] | undefined) ?? currency;
  const minor = value.amountMinor ?? value.amount_minor;
  if (typeof minor === "number") return { amountMinor: minor, currency: cur };
  if (typeof value.amount === "string") {
    const parsed = fromDecimalString(value.amount, cur);
    return parsed.ok ? parsed.value : null;
  }
  if (typeof value.amount === "number")
    return { amountMinor: Math.round(value.amount * 100), currency: cur };
  return null;
}

function toStatus(raw: string | undefined): LedgerStatus {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("refund")) return "refunded";
  if (s.includes("held") || s.includes("dispute") || s.includes("hold")) return "held";
  if (s.includes("fail") || s.includes("cancel")) return "failed";
  if (s.includes("paid") || s.includes("payout")) return "paid_out";
  if (s.includes("pending") || s.includes("settling")) return "settling";
  return "settled";
}

function toRow(raw: ApiLedgerRow, index: number, currency: Money["currency"]): LedgerRow | null {
  const gross = toMoney(raw.gross, currency);
  if (!gross) return null;
  const split = splitGross(gross);
  const fee = toMoney(raw.fee, currency) ?? split.fee;
  const net = toMoney(raw.net, currency) ?? split.net;
  const product = typeof raw.product === "string" ? raw.product : raw.product?.title;
  return {
    id: raw.id ?? `row_${index}`,
    date: raw.date ?? raw.at ?? "",
    item: raw.item ?? raw.title ?? product ?? "Sale",
    note: raw.note ?? "",
    // Contract rows carry order_id null and the provider resource (payment id) instead.
    order: raw.order ?? raw.orderId ?? raw.order_id ?? raw.provider_resource_id ?? raw.id ?? "",
    status: toStatus(raw.status),
    gross,
    fee,
    net,
  };
}

/** The provenance an API response states, or null when it states none. Never assumed. */
export function provenanceOf(value: string | undefined): "mock" | "sandbox" | "live" | null {
  const s = (value ?? "").toLowerCase();
  if (s === "sandbox") return "sandbox";
  if (s === "live") return "live";
  if (s === "mock") return "mock";
  return null;
}

function humanKind(kind: string | undefined): string {
  if (!kind) return "Ledger entry";
  const text = kind.replace(/[._-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A `recent` entry from the earnings route: the seller's share of one event, no gross or fee. */
function entryToRow(
  raw: ApiLedgerEntry,
  index: number,
  currency: Money["currency"],
): LedgerRow | null {
  const net = toMoney(raw.amount, currency);
  if (!net) return null;
  const resource = raw.resourceId ?? raw.resource_id ?? "";
  const resourceType = raw.resourceType ?? raw.resource_type;
  const zero: Money = { amountMinor: 0, currency: net.currency };
  return {
    id: raw.effectKey ?? raw.effect_key ?? `${resourceType ?? "entry"}:${resource || index}`,
    date: raw.occurredAt ?? raw.occurred_at ?? "",
    item: humanKind(raw.kind),
    note: resourceType ? `${resourceType.replace(/_/g, " ")}` : "",
    order: resource,
    status: toStatus(raw.kind),
    gross: zero,
    fee: zero,
    net,
    partial: true,
  };
}

/** Reads the earnings payload defensively; balances come from the API, never recomputed. */
export function ledgerFromApi(data: ApiEarnings): LedgerSummary {
  const firstTotal = data.totals?.[0];
  const currency = ((data.currency as Money["currency"] | undefined) ??
    (firstTotal?.currency as Money["currency"] | undefined) ??
    USD) as Money["currency"];
  const rows: LedgerRow[] =
    data.rows || data.transactions
      ? (data.rows ?? data.transactions ?? [])
          .map((r, i) => toRow(r, i, currency))
          .filter((r): r is LedgerRow => r !== null)
      : (data.recent ?? [])
          .map((r, i) => entryToRow(r, i, currency))
          .filter((r): r is LedgerRow => r !== null);
  // The contract puts provenance on each row rather than at the top level.
  const rowProvenance = (data.rows ?? data.transactions ?? []).find(
    (r) => r.provenance,
  )?.provenance;
  const fromRows = summarize(rows, provenanceOf(data.provenance ?? data.source ?? rowProvenance));
  const totalsOnly =
    data.available === undefined &&
    data.pending === undefined &&
    data.held === undefined &&
    firstTotal !== undefined;
  const summary: LedgerSummary = {
    ...fromRows,
    available:
      toMoney(data.available, currency) ??
      (totalsOnly ? toMoney(firstTotal?.total, currency) : null) ??
      fromRows.available,
    pending: toMoney(data.pending, currency) ?? fromRows.pending,
    held: toMoney(data.held, currency) ?? fromRows.held,
  };
  if (totalsOnly) summary.totalsOnly = true;
  // Contract key is charge_model; the routes answer camelCase until the contract-shaped push.
  const chargeModel = data.charge_model ?? data.chargeModel;
  if (chargeModel === "direct" || chargeModel === "platform_transfer") {
    summary.chargeModel = chargeModel;
  }
  return summary;
}
