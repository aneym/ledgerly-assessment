// New read-only queries the assistant's tools need that no existing repo exposes: a
// ledger entry by its bigserial id, a filtered/bounded ledger listing, and a webhook inbox
// summary. packages/db/src/repos/orders.ts's createLedgerReader only exposes `forSeller`
// (all that the earnings route needed), so this adds what the assistant needs directly
// against the db handle, the same way apps/web/src/lib/commerce.ts builds its own repos
// against getServer().db rather than requiring a packages/db change.
//
// These use the Drizzle relational query API (`db.query.<table>.findMany`), whose operator
// functions arrive as callback arguments, rather than importing eq/and/desc from
// `drizzle-orm` directly: drizzle-orm is a dependency of @ledgerly/db, not of @ledgerly/web,
// and this lane's dependency additions are scoped to `ai` and `zod`. If a future round wants
// eq/and-style query builders here, that dependency needs to be added deliberately, not as a
// side effect of this file.
import type { ApplicationDatabase } from "@ledgerly/db";

export type AssistantDb = ApplicationDatabase;

export type LedgerEntryRow = Awaited<
  ReturnType<AssistantDb["query"]["ledgerEntries"]["findMany"]>
>[number];

export async function getLedgerEntryById(
  db: AssistantDb,
  id: number,
): Promise<LedgerEntryRow | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await db.query.ledgerEntries.findFirst({
    where: (le, { eq }) => eq(le.id, id),
  });
  return row ?? null;
}

export type ListLedgerFilters = {
  sellerId?: string;
  kind?: string;
  currency?: "USD" | "EUR" | "BRL";
  limit: number;
};

export async function listLedgerEntries(
  db: AssistantDb,
  filters: ListLedgerFilters,
): Promise<LedgerEntryRow[]> {
  return db.query.ledgerEntries.findMany({
    where: (le, { and, eq }) => {
      const conditions = [
        filters.sellerId ? eq(le.sellerId, filters.sellerId) : undefined,
        filters.kind ? eq(le.kind, filters.kind) : undefined,
        filters.currency ? eq(le.currency, filters.currency) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);
      return conditions.length > 0 ? and(...conditions) : undefined;
    },
    orderBy: (le, { desc }) => [desc(le.id)],
    limit: filters.limit,
  });
}

export type WebhookInboxSummary = {
  countsByStatus: Record<string, number>;
  lastReceivedAt: Date | null;
};

const INBOX_STATUSES = ["received", "processed", "failed", "quarantined"] as const;

// Bounded by construction: exactly four statuses, so this is four small indexed counts,
// not a table scan. Fine for an admin health check at this app's scale; if the inbox grows
// large enough for this to matter, the fix is a single grouped aggregate query, which needs
// drizzle-orm's `count()`/`sql` helpers and so the same dependency call-out as above.
export async function getWebhookInboxSummary(db: AssistantDb): Promise<WebhookInboxSummary> {
  const countsByStatus: Record<string, number> = {};
  for (const status of INBOX_STATUSES) {
    const rows = await db.query.webhookInbox.findMany({
      where: (wi, { eq }) => eq(wi.status, status),
      columns: { deliveryId: true },
    });
    countsByStatus[status] = rows.length;
  }
  const last = await db.query.webhookInbox.findFirst({
    orderBy: (wi, { desc }) => [desc(wi.receivedAt)],
    columns: { receivedAt: true },
  });
  return { countsByStatus, lastReceivedAt: last?.receivedAt ?? null };
}
