/**
 * Filters for the platform ledger. The URL query is the source of truth so a link
 * reproduces the view. The same object drives the GET /api/admin/ledger query and,
 * while that route is not live, the client-side filter over the MOCK fixture.
 * Param names match the route: q, type, status, seller_id, provenance, from, to, currency.
 */
import {
  LEDGER_STATUSES,
  LEDGER_TYPES,
  type LedgerEntryStatus,
  type LedgerEntryType,
  type LedgerRow,
  type LedgerSummary,
  type Money,
  type Provenance,
} from "./types";

export const CURRENCIES = ["USD", "EUR", "BRL"] as const;

export type LedgerFilters = {
  q: string;
  type: LedgerEntryType | "";
  status: LedgerEntryStatus | "";
  seller_id: string;
  provenance: Provenance | "";
  from: string;
  to: string;
  currency: Money["currency"] | "";
};

export const EMPTY_FILTERS: LedgerFilters = {
  q: "",
  type: "",
  status: "",
  seller_id: "",
  provenance: "",
  from: "",
  to: "",
  currency: "",
};

const isType = (v: string): v is LedgerEntryType => (LEDGER_TYPES as readonly string[]).includes(v);
const isStatus = (v: string): v is LedgerEntryStatus =>
  (LEDGER_STATUSES as readonly string[]).includes(v);
export const isCurrency = (v: string): v is Money["currency"] =>
  (CURRENCIES as readonly string[]).includes(v);
export const isProvenance = (v: string): v is Provenance => ["mock", "sandbox", "live"].includes(v);
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export function parseFilters(params: URLSearchParams): LedgerFilters {
  const get = (key: string) => (params.get(key) ?? "").trim();
  const type = get("type");
  const status = get("status");
  const provenance = get("provenance");
  const currency = get("currency");
  const from = get("from");
  const to = get("to");
  return {
    q: get("q").slice(0, 80),
    type: isType(type) ? type : "",
    status: isStatus(status) ? status : "",
    seller_id: get("seller_id").slice(0, 40),
    provenance: isProvenance(provenance) ? provenance : "",
    from: isDate(from) ? from : "",
    to: isDate(to) ? to : "",
    currency: isCurrency(currency) ? currency : "",
  };
}

/** Only set keys go into the URL, in a stable order. */
export function toQuery(filters: LedgerFilters): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(EMPTY_FILTERS) as Array<keyof LedgerFilters>) {
    if (filters[key]) params.set(key, filters[key]);
  }
  return params.toString();
}

export function isFiltered(filters: LedgerFilters): boolean {
  return (Object.keys(EMPTY_FILTERS) as Array<keyof LedgerFilters>).some((key) => filters[key]);
}

export function applyFilters(rows: LedgerRow[], filters: LedgerFilters): LedgerRow[] {
  const q = filters.q.toLowerCase();
  const fromMs = filters.from ? Date.parse(`${filters.from}T00:00:00Z`) : null;
  const toMs = filters.to ? Date.parse(`${filters.to}T23:59:59.999Z`) : null;
  return rows.filter((row) => {
    if (filters.type && row.type !== filters.type) return false;
    if (filters.status && row.status !== filters.status) return false;
    if (filters.seller_id && row.seller.id !== filters.seller_id) return false;
    if (filters.provenance && row.provenance !== filters.provenance) return false;
    if (filters.currency && row.currency !== filters.currency) return false;
    const at = Date.parse(row.created_at);
    if (fromMs !== null && at < fromMs) return false;
    if (toMs !== null && at > toMs) return false;
    if (q) {
      const hay = [
        row.seller.name,
        row.order_id ?? "",
        row.provider_resource_id ?? "",
        row.id,
        row.item ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** A route total is a minor-unit number; the fixture already carries Money. Either becomes Money. */
function asMoney(value: unknown, currency: Money["currency"]): Money | null {
  if (typeof value === "number" && Number.isFinite(value)) return { amountMinor: value, currency };
  if (value && typeof value === "object" && typeof (value as Money).amountMinor === "number")
    return value as Money;
  return null;
}

/**
 * GET /api/admin/ledger sends `summary` as an object keyed by currency with minor-unit
 * numbers, the fixture as a list of Money. Both become the list the table renders.
 */
export function normalizeSummary(value: unknown): LedgerSummary[] {
  if (Array.isArray(value)) return value as LedgerSummary[];
  if (value && typeof value === "object") {
    const out: LedgerSummary[] = [];
    for (const [key, sum] of Object.entries(
      value as Record<string, { currency?: string; gross?: unknown; fee?: unknown; net?: unknown }>,
    )) {
      if (!sum || typeof sum !== "object") continue;
      const currency = (sum.currency ?? key) as Money["currency"];
      const gross = asMoney(sum.gross, currency);
      const fee = asMoney(sum.fee, currency);
      const net = asMoney(sum.net, currency);
      if (gross && fee && net) out.push({ currency, gross, fee, net });
    }
    return out;
  }
  return [];
}

/** Payment and refund rows only, per currency. Failed rows never count. */
export function summarize(rows: LedgerRow[]): LedgerSummary[] {
  const sums = new Map<Money["currency"], LedgerSummary>();
  for (const row of rows) {
    if (row.type !== "payment" && row.type !== "refund") continue;
    if (row.status === "failed") continue;
    const sum = sums.get(row.currency) ?? {
      currency: row.currency,
      gross: { amountMinor: 0, currency: row.currency },
      fee: { amountMinor: 0, currency: row.currency },
      net: { amountMinor: 0, currency: row.currency },
    };
    sums.set(row.currency, {
      currency: row.currency,
      gross: { ...sum.gross, amountMinor: sum.gross.amountMinor + (row.gross?.amountMinor ?? 0) },
      fee: { ...sum.fee, amountMinor: sum.fee.amountMinor + (row.fee?.amountMinor ?? 0) },
      net: { ...sum.net, amountMinor: sum.net.amountMinor + (row.net?.amountMinor ?? 0) },
    });
  }
  return [...sums.values()];
}

const PLURAL: Record<LedgerEntryType, string> = {
  payment: "payments",
  fee: "fee rows",
  transfer: "transfers",
  refund: "refunds",
  payout: "payouts",
};

/** "No refunds for Onda Sounds in this range." */
export function describeEmpty(filters: LedgerFilters, sellerName: string | null): string {
  const what = filters.type ? PLURAL[filters.type] : "entries";
  const parts = [`No ${filters.status ? `${filters.status.replace("_", " ")} ` : ""}${what}`];
  if (filters.currency) parts.push(`in ${filters.currency}`);
  if (sellerName) parts.push(`for ${sellerName}`);
  if (filters.from || filters.to) parts.push("in this range");
  if (filters.q) parts.push(`matching "${filters.q}"`);
  if (filters.provenance) parts.push(`from ${filters.provenance}`);
  return `${parts.join(" ")}.`;
}
