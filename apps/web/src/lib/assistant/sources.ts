import type { SourceKind } from "./types";

// In-app hrefs the sidebar can link straight to. "issue", "ledger_entry" and "seller" are
// exactly the three context kinds and hrefs the marketplace lane's contract specifies.
// "order" is this lane's own extension: getOrder is one of the eight required tools, but
// there is no admin orders page in the codebase yet and "order" is not a context kind the
// sidebar ever sends. /admin/orders/{id} is a forward-compatible guess, documented in
// docs/lanes/architecture/operator-assistant-contract.md; the link will 404 until that page
// exists.
const HREF_BUILDERS: Record<SourceKind, (id: string) => string> = {
  issue: (id) => `/admin/issues/${id}`,
  ledger_entry: (id) => `/admin/ledger/${id}`,
  seller: (id) => `/admin/sellers/${id}`,
  order: (id) => `/admin/ledger?q=${encodeURIComponent(id)}`,
};

export function sourceHref(kind: SourceKind, id: string): string {
  return HREF_BUILDERS[kind](id);
}
