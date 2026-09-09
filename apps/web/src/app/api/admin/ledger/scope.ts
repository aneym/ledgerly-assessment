import type {
  AdminLedgerPage,
  AdminLedgerQuery,
  AdminLedgerRow,
  AdminLedgerSummary,
} from "@ledgerly/core";
import { getServer } from "@/lib/server";

export type LedgerScopeDeps = {
  getRowScope?: (row: AdminLedgerRow) => Promise<{
    runId: string;
    sellerRunId: string;
    orderRunId: string | null;
  } | null>;
};

export async function ledgerRowInScope(deps: LedgerScopeDeps, runId: string, row: AdminLedgerRow) {
  const record = await deps.getRowScope?.(row);
  return (
    record?.runId === runId &&
    record.sellerRunId === runId &&
    (row.orderId === null || record.orderRunId === runId)
  );
}

// Ledger rows and orders each have their own run_id. Check both, not just the seller.
export const getRowScope: NonNullable<LedgerScopeDeps["getRowScope"]> = async (row) => {
  if (!/^\d+$/.test(row.id)) return null;
  const db = getServer().db;
  const record = await db.query.ledgerEntries.findFirst({
    columns: { runId: true, sellerId: true },
    where: (entry, { eq }) => eq(entry.id, Number(row.id)),
  });
  if (!record?.sellerId || record.sellerId !== row.seller.id) return null;
  const seller = await db.query.sellers.findFirst({
    columns: { runId: true },
    where: (seller, { eq }) => eq(seller.id, record.sellerId as string),
  });
  if (!seller) return null;
  const order = row.orderId
    ? await db.query.orders.findFirst({
        columns: { runId: true, sellerId: true },
        where: (order, { eq }) => eq(order.id, row.orderId as string),
      })
    : null;
  if (order && order.sellerId !== record.sellerId) return null;
  return { runId: record.runId, sellerRunId: seller.runId, orderRunId: order?.runId ?? null };
};

// The existing repo has no run filter. Scan its bounded pages before calculating totals
// or paging the scoped result, so neither totals nor cursors describe another run.
export async function scopedLedgerPage(
  deps: LedgerScopeDeps & { listLedger: (query: AdminLedgerQuery) => Promise<AdminLedgerPage> },
  runId: string,
  query: AdminLedgerQuery,
): Promise<AdminLedgerPage | null> {
  if (query.cursor && !/^demo:\d+$/.test(query.cursor)) return null;
  const offset = query.cursor ? Number(query.cursor.slice(5)) : 0;
  if (!Number.isSafeInteger(offset)) return null;
  const rows: AdminLedgerRow[] = [];
  const summary: AdminLedgerSummary = {};
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await deps.listLedger({ ...query, cursor, limit: 200 });
    for (const row of page.rows) {
      if (!(await ledgerRowInScope(deps, runId, row))) continue;
      rows.push(row);
      const totals = summary[row.currency] ?? { gross: 0, fee: 0, net: 0 };
      totals.gross += row.gross?.amountMinor ?? 0;
      totals.fee += row.fee?.amountMinor ?? 0;
      totals.net += row.net?.amountMinor ?? 0;
      summary[row.currency] = totals;
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("Ledger pagination did not advance");
    if (cursor) seen.add(cursor);
  } while (cursor);
  const limit = Math.min(query.limit ?? 50, 200);
  return {
    rows: rows.slice(offset, offset + limit),
    summary,
    nextCursor: offset + limit < rows.length ? `demo:${offset + limit}` : null,
  };
}
