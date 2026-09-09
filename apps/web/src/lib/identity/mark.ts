import { displaySeller, initialsOf } from "@/lib/catalog/display-name";
import sellersJson from "../../../../../fixtures/demo/sellers.json";

/**
 * The one place that decides which picture stands for a person or a business. Every
 * surface (buyer bylines, the account card, the seller rail, operator rows) resolves
 * through here, so a seller keeps the same portrait wherever the app shows it.
 *
 * Server-safe and client-safe: static JSON imports only, no disk reads.
 *
 * Resolution order:
 *   1. an avatar the record itself carries;
 *   2. the catalog seller with the same id, handle, or name (case-insensitive);
 *   3. the demo display mapping (fixtures/demo/display-names.json) by id or external id;
 *   4. the catalog seller named by the email's plus tag (`+ledgerly-onda@` names `onda`),
 *      which is how the demo profile accounts are addressed;
 *   5. no picture: the caller draws initials.
 */

export type MarkInput = {
  /** A user id or a seller id; matched against catalog seller ids. */
  id?: string | null;
  /** The seller this identity owns or is, when known separately from `id`. */
  sellerId?: string | null;
  externalId?: string | null;
  handle?: string | null;
  name?: string | null;
  email?: string | null;
  avatar?: string | null;
};

export type IdentityMark = {
  name: string;
  initials: string;
  avatar: string | null;
};

type CatalogSeller = { id: string; handle: string; name: string; avatar: string };

const CATALOG: CatalogSeller[] = (
  sellersJson as { sellers: Array<{ id: string; handle: string; name: string; avatar: string }> }
).sellers.map((s) => ({
  id: s.id,
  handle: s.handle,
  name: s.name,
  avatar: `/demo/${s.avatar.split("/").at(-1) ?? ""}`,
}));

function text(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function same(a: string | null, b: string): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}

/** `a.b+ledgerly-onda@x` and `a.b+onda@x` both name `onda`. */
function emailTag(email: string | null): string | null {
  if (!email) return null;
  const local = email.split("@")[0] ?? "";
  const plus = local.indexOf("+");
  if (plus < 0) return null;
  const tag = local.slice(plus + 1).toLowerCase();
  return tag.replace(/^ledgerly-/, "") || null;
}

function catalogFor(input: MarkInput): CatalogSeller | null {
  const ids = [text(input.sellerId), text(input.id)].filter((v): v is string => v !== null);
  const handle = text(input.handle);
  const name = text(input.name);
  const tag = emailTag(text(input.email));
  return (
    CATALOG.find((s) => ids.some((id) => id === s.id)) ??
    CATALOG.find((s) => same(handle, s.handle)) ??
    CATALOG.find((s) => same(name, s.name)) ??
    CATALOG.find((s) => tag !== null && (tag === s.handle || `sel_${tag}` === s.id)) ??
    null
  );
}

export function resolveMark(input: MarkInput): IdentityMark {
  const own = text(input.avatar);
  const name = text(input.name);
  const catalog = catalogFor(input);
  if (own) {
    const shown = name ?? catalog?.name ?? "";
    return { name: shown, initials: initialsOf(shown), avatar: own };
  }
  if (catalog) {
    const shown = name ?? catalog.name;
    return { name: shown, initials: initialsOf(shown), avatar: catalog.avatar };
  }
  const id = text(input.sellerId) ?? text(input.id);
  if (id) {
    const mapped = displaySeller({ id, external_id: text(input.externalId), name });
    if (mapped.avatar) {
      const shown = name ?? mapped.name;
      return { name: shown, initials: initialsOf(shown), avatar: mapped.avatar };
    }
  }
  const shown = name ?? id ?? "";
  return { name: shown, initials: initialsOf(shown), avatar: null };
}

export { initialsOf };
