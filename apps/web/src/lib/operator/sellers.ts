import { displaySeller } from "@/lib/catalog/display-name";
import type { ApiMiss } from "./api";
import type { Capabilities, OperatorSeller, Provenance, SalePolicy } from "./types";

/** GET /api/sellers, architecture's list route. The operator session reads it server-side. */
export const SELLERS_PATH = "/api/sellers";

/** What a page learned about the seller list: the live rows, or why the fixture stands in. */
export type SellersRead =
  | { kind: "live"; sellers: OperatorSeller[]; provenance: Provenance }
  | { kind: "miss"; miss: ApiMiss };

const COUNTRY_NAME: Record<string, string> = {
  US: "United States",
  DE: "Germany",
  BR: "Brazil",
  CA: "Canada",
  KR: "South Korea",
  PT: "Portugal",
};

const PROVENANCE = new Set<Provenance>(["mock", "sandbox", "live"]);
const POLICY = new Set<SalePolicy>(["direct", "platform_only"]);
const CAPABILITY = new Set(["active", "inactive", "pending"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function capabilities(value: unknown): Capabilities {
  const raw = (value ?? {}) as Record<string, unknown>;
  const gate = (key: string) => {
    const state = raw[key];
    return typeof state === "string" && CAPABILITY.has(state)
      ? (state as Capabilities["payments"])
      : "inactive";
  };
  return { payments: gate("payments"), transfers: gate("transfers"), payouts: gate("payouts") };
}

/**
 * One list row to the seller shape the operator screens use. The contract fields are
 * id, name or display_name, country, sale_policy, whop_account_id and provenance; the
 * display extras the fixture carries (handle, city, avatar) are filled from what the row
 * has and left plain otherwise. A row without an id or a known sale policy is dropped,
 * not guessed.
 */
export function toOperatorSeller(value: unknown, fallback: Provenance): OperatorSeller | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const nested = (raw.seller ?? {}) as Record<string, unknown>;
  const id = text(raw.id) ?? text(nested.id);
  const policy = text(raw.sale_policy) ?? text(raw.salePolicy);
  if (!id || !policy || !POLICY.has(policy as SalePolicy)) return null;
  const externalId = text(raw.external_id) ?? text(nested.externalId) ?? id;
  const name =
    text(raw.display_name) ??
    text(raw.name) ??
    text(nested.displayName) ??
    text(raw.displayName) ??
    externalId;
  const country = text(raw.country) ?? text(nested.country) ?? "";
  // What a person sees: the record's own name unless it is a placeholder, else the
  // canonical demo identity (fixtures/demo/display-names.json). Ids stay as they are.
  const shown = displaySeller({
    id,
    external_id: externalId,
    display_name: text(raw.display_name) ?? text(nested.displayName),
    name,
    country,
    avatar: text(raw.avatar),
  });
  const provenance = text(raw.provenance);
  const verification = text(raw.verification);
  const status = text(raw.status);
  return {
    id,
    name: shown.name,
    country,
    sale_policy: policy as SalePolicy,
    whop_account_id: text(raw.whop_account_id) ?? text(nested.whopAccountId) ?? null,
    verification:
      verification === "verified" || verification === "pending" ? verification : "not_started",
    required_actions: Array.isArray(raw.required_actions)
      ? raw.required_actions.filter((a): a is string => typeof a === "string")
      : [],
    capabilities: capabilities(raw.capabilities),
    provenance:
      provenance && PROVENANCE.has(provenance as Provenance)
        ? (provenance as Provenance)
        : fallback,
    // No handle from the route means none; the external id is shown as an id, not a handle.
    handle: text(raw.handle) ?? "",
    kind: shown.kind,
    city: text(raw.city) ?? "",
    country_name: text(raw.country_name) ?? COUNTRY_NAME[country] ?? country,
    avatar: shown.avatar,
    external_id: externalId,
    created_at: text(raw.created_at) ?? text(raw.createdAt) ?? "",
    status: status === "suspended" ? "suspended" : "active",
  };
}

/** The list body: a bare array, or an object with `sellers` or `items` and a top-level provenance. */
export function parseSellerList(body: unknown): {
  sellers: OperatorSeller[];
  provenance: Provenance;
} {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const top = text(record.provenance);
  // A list without a provenance of its own is labelled MOCK, the most cautious reading.
  const fallback: Provenance =
    top && PROVENANCE.has(top as Provenance) ? (top as Provenance) : "mock";
  const list = Array.isArray(body)
    ? body
    : Array.isArray(record.sellers)
      ? record.sellers
      : Array.isArray(record.items)
        ? record.items
        : [];
  const sellers = list
    .map((row) => toOperatorSeller(row, fallback))
    .filter((row): row is OperatorSeller => row !== null);
  const seen = new Set(sellers.map((s) => s.provenance));
  const provenance: Provenance = seen.size === 1 ? (sellers[0]?.provenance ?? fallback) : fallback;
  return { sellers, provenance };
}
