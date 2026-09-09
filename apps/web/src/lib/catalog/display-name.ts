import mapping from "../../../../../fixtures/demo/display-names.json";

/**
 * Display identities for demo accounts (docs/lanes/demo-business-names.md). The mapping
 * in fixtures/demo/display-names.json decides what a person sees; ids, countries and
 * data are never changed by it. Server-safe and client-safe: a static JSON import.
 *
 * Resolution order for a seller: its own display_name or name when present and not a
 * placeholder; then by_seller_id; then by_external_id_prefix; then a deterministic pick
 * from the country pool keyed on a stable hash of the id, so the same seller always
 * gets the same brand.
 */

export type SellerKind = "person" | "studio";

export type SellerInput = {
  id: string;
  external_id?: string | null;
  display_name?: string | null;
  name?: string | null;
  country?: string | null;
  avatar?: string | null;
};

export type SellerDisplay = {
  name: string;
  initials: string;
  avatar: string | null;
  kind: SellerKind;
  /** True when the name came from the mapping rather than the record. */
  derived: boolean;
};

export type BuyerInput = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BuyerDisplay = {
  name: string;
  initials: string;
  derived: boolean;
};

type Entry = { name: string; avatar?: string; kind?: string };

const SELLER_PLACEHOLDERS = mapping.placeholder_patterns.map((p) => new RegExp(p, "i"));
const BUYER_PLACEHOLDERS = mapping.buyers.placeholder_patterns.map((p) => new RegExp(p, "i"));
const BY_SELLER_ID = mapping.by_seller_id as Record<string, Entry>;
const BY_PREFIX = mapping.by_external_id_prefix as Record<string, Entry>;
const BY_COUNTRY = mapping.by_country as Record<string, string[]>;
const BUYER_POOL = mapping.buyers.pool;

const STUDIO_WORDS =
  /\b(studio|editions|press|audio|sound|sounds|type|co\.|werkstatt|fabrik|casa|estúdio|estudio|harbor|labs?|foundry)\b|&/i;

function text(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** FNV-1a, 32 bit. Stable across runtimes so a seller keeps its brand. */
export function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, 2)
    .map((word) => [...word][0]?.toUpperCase() ?? "")
    .join("");
}

function isPlaceholder(value: string | null, patterns: RegExp[]): boolean {
  return value !== null && patterns.some((pattern) => pattern.test(value));
}

/**
 * A record whose name is its external id (the routes fall back to it when no display
 * name is set) reads like one: lowercase, no spaces, with a digit or a hyphen in it.
 * Such a name is never shown; it goes through the same resolution as a placeholder.
 */
function looksLikeId(value: string | null): boolean {
  return value !== null && /^[a-z0-9][a-z0-9._+-]*$/.test(value) && /[0-9-]/.test(value);
}

function kindOf(name: string, hint?: string): SellerKind {
  if (hint === "person" || hint === "studio") return hint;
  return STUDIO_WORDS.test(name) ? "studio" : "person";
}

function pick(pool: string[], key: string): string {
  const list = pool.length > 0 ? pool : BY_COUNTRY.default;
  return list[stableHash(key) % list.length] ?? "Northline Studio";
}

export function displaySeller(input: SellerInput): SellerDisplay {
  const own = text(input.display_name) ?? text(input.name);
  const externalId = text(input.external_id);
  const recordAvatar = text(input.avatar);

  const ownIsId =
    own !== null &&
    (isPlaceholder(own, SELLER_PLACEHOLDERS) ||
      looksLikeId(own) ||
      (externalId !== null && own.toLowerCase() === externalId.toLowerCase()));

  if (own && !ownIsId) {
    return {
      name: own,
      initials: initialsOf(own),
      avatar: recordAvatar ?? BY_SELLER_ID[input.id]?.avatar ?? null,
      kind: kindOf(own, BY_SELLER_ID[input.id]?.kind),
      derived: false,
    };
  }

  const byId = BY_SELLER_ID[input.id];
  if (byId) {
    return {
      name: byId.name,
      initials: initialsOf(byId.name),
      avatar: byId.avatar ?? recordAvatar ?? null,
      kind: kindOf(byId.name, byId.kind),
      derived: true,
    };
  }

  // The record's own name is usually the external id when it is a placeholder, so both
  // are checked against the prefixes.
  const candidates = [externalId, own].filter((c): c is string => c !== null);
  for (const [prefix, entry] of Object.entries(BY_PREFIX)) {
    if (candidates.some((c) => c.toLowerCase().startsWith(prefix.toLowerCase()))) {
      return {
        name: entry.name,
        initials: initialsOf(entry.name),
        avatar: entry.avatar ?? recordAvatar ?? null,
        kind: kindOf(entry.name, entry.kind),
        derived: true,
      };
    }
  }

  const country = text(input.country)?.toUpperCase() ?? "";
  const name = pick(BY_COUNTRY[country] ?? BY_COUNTRY.default, input.id);
  return {
    name,
    initials: initialsOf(name),
    avatar: recordAvatar,
    kind: kindOf(name),
    derived: true,
  };
}

/** A buyer's display name. The email is never the name; a placeholder name is replaced from the pool. */
export function displayBuyer(input: BuyerInput): BuyerDisplay {
  const own = text(input.name);
  const email = text(input.email);
  const local = email ? (email.split("@")[0] ?? email) : null;
  if (own && !isPlaceholder(own, BUYER_PLACEHOLDERS) && !own.includes("@")) {
    return { name: own, initials: initialsOf(own), derived: false };
  }
  const name = pick(BUYER_POOL, text(input.id) ?? local ?? "buyer");
  return { name, initials: initialsOf(name), derived: true };
}
