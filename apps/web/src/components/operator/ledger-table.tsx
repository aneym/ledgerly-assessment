"use client";

import Link from "next/link";
import { useMemo, useRef } from "react";
import {
  type Column,
  CopyId,
  DataTable,
  Money as MoneyCell,
  type RowState,
  type SortState,
  StatusChip,
  TableCard,
  TableScroll,
  type TableState,
  type TotalsRow,
} from "@/components/table";
import type { ApiMiss } from "@/lib/operator/api";
import {
  dayOf,
  relative,
  STATUS_LABEL,
  statusTone,
  TYPE_LABEL,
  timeOf,
} from "@/lib/operator/format";
import { KIND_LABEL } from "@/lib/operator/issues";
import type {
  Issue,
  LedgerEntryStatus,
  LedgerRow,
  LedgerSummary,
  OperatorSeller,
} from "@/lib/operator/types";
import { BusinessCell } from "./business";
import { RouteState } from "./route-state";
import { useRowTour } from "./tour";

export const LEDGER_INSPECTOR_ID = "ledger-inspector";

export type LedgerSource =
  | { kind: "loading" }
  | { kind: "rows"; rows: LedgerRow[] }
  | { kind: "error"; miss: ApiMiss };

const ROW_STATE: Partial<Record<LedgerEntryStatus, RowState>> = {
  settling: "pending",
  pending: "pending",
  held: "held",
  refunded: "refunded",
  failed: "failed",
};

/** Sort on Date, Gross and Net, in the client, whichever source the rows came from. */
export function sortRows(rows: LedgerRow[], sort: SortState | null): LedgerRow[] {
  if (!sort) return rows;
  const dir = sort.dir === "asc" ? 1 : -1;
  const value = (row: LedgerRow): number => {
    if (sort.key === "date") return Date.parse(row.created_at);
    if (sort.key === "gross") return row.gross?.amountMinor ?? Number.NEGATIVE_INFINITY;
    if (sort.key === "net") return row.net?.amountMinor ?? Number.NEGATIVE_INFINITY;
    return 0;
  };
  return [...rows].sort((a, b) => (value(a) - value(b)) * dir);
}

/** "Sep 01 to Sep 08" from the rows, in either order. */
export function periodOf(rows: LedgerRow[]): string | null {
  const stamps = rows.map((r) => r.created_at).sort();
  const first = stamps[0];
  const last = stamps[stamps.length - 1];
  if (!first || !last) return null;
  const a = dayOf(first);
  const b = dayOf(last);
  return a === b ? a : `${a} to ${b}`;
}

/**
 * The platform ledger sheet: TableCard, TableScroll and DataTable from the shared
 * system, with the operator columns from docs/design/tables.md section 7.1.
 */
export function LedgerSheet({
  source,
  summary,
  sellers,
  issues,
  selected,
  onOpen,
  sort,
  onSort,
  emptyText,
  onClear,
  filtered,
  now,
}: {
  source: LedgerSource;
  summary: LedgerSummary[];
  sellers: OperatorSeller[];
  issues: Issue[];
  selected: string | null;
  onOpen: (row: LedgerRow) => void;
  sort: SortState | null;
  onSort: (key: string) => void;
  emptyText: string;
  onClear: (() => void) | null;
  filtered: boolean;
  now: number | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const avatarById = useMemo(
    () => new Map(sellers.map((seller) => [seller.id, seller.avatar])),
    [sellers],
  );
  const issueByRef = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues) {
      if (issue.status === "resolved") continue;
      if (issue.subject.provider_resource_id) map.set(issue.subject.provider_resource_id, issue);
      if (issue.subject.transfer_id) map.set(issue.subject.transfer_id, issue);
    }
    return map;
  }, [issues]);

  const rows = source.kind === "rows" ? source.rows : [];
  const keys = useMemo(() => rows.map((row) => row.id), [rows]);
  useRowTour(ref, "admin.ledger.row", keys);

  const currencies = new Set(rows.map((row) => row.currency));
  const currency: string = currencies.size === 1 ? ([...currencies][0] ?? "USD") : "mixed";
  const mixed = currency === "mixed";

  const columns: Column<LedgerRow>[] = [
    {
      key: "date",
      header: "Date",
      kind: "date",
      width: 112,
      sortable: true,
      render: (row) => (
        <>
          {dayOf(row.created_at)} <span className="t">{timeOf(row.created_at)}</span>
        </>
      ),
      title: (row) =>
        now ? `${row.created_at}, ${relative(row.created_at, now)}` : row.created_at,
    },
    {
      key: "business",
      header: "Business",
      kind: "text",
      render: (row) => (
        <BusinessCell
          seller={{ name: row.seller.name, avatar: avatarById.get(row.seller.id) ?? null }}
        />
      ),
      title: (row) => (row.item ? `${row.seller.name}, ${row.item}` : row.seller.name),
    },
    {
      key: "type",
      header: "Type",
      kind: "text",
      width: 88,
      priority: 3,
      render: (row) => TYPE_LABEL[row.type],
    },
    {
      key: "ref",
      header: "Reference",
      kind: "id",
      width: 168,
      priority: 3,
      render: (row) => {
        const value = row.order_id ?? row.provider_resource_id;
        return value ? <CopyId value={value} /> : <span className="dash">–</span>;
      },
    },
    {
      key: "status",
      header: "Status",
      kind: "status",
      width: 120,
      render: (row) => {
        const issue =
          row.provider_resource_id !== null ? issueByRef.get(row.provider_resource_id) : undefined;
        return (
          <>
            <StatusChip tone={statusTone(row.status)} size="table">
              {STATUS_LABEL[row.status]}
            </StatusChip>
            {issue && (
              <Link
                className="chip line op-issue-chip"
                href={`/admin/issues?issue=${issue.id}`}
                title={KIND_LABEL[issue.kind]}
              >
                <span>issue</span>
              </Link>
            )}
          </>
        );
      },
    },
    {
      key: "gross",
      header: "Gross",
      kind: "money",
      width: 80,
      priority: 2,
      money: "gross",
      sortable: true,
      render: (row) => (row.gross ? <MoneyCell value={row.gross} /> : null),
    },
    {
      key: "fee",
      header: "Fee 8%",
      kind: "money",
      width: 72,
      priority: 2,
      money: "fee",
      render: (row) => (row.fee ? <MoneyCell value={row.fee} /> : null),
    },
    {
      key: "net",
      header: "Net",
      kind: "money",
      width: 104,
      money: "net",
      sortable: true,
      render: (row) => (row.net ? <MoneyCell value={row.net} suffix={mixed} /> : null),
    },
  ];

  const state: TableState =
    source.kind === "loading"
      ? { kind: "loading" }
      : source.kind === "error"
        ? {
            kind: "error",
            body: (
              <>
                <RouteState kind="miss" miss={source.miss} />
                <span>The ledger could not be read. No rows are shown in place of it.</span>
              </>
            ),
          }
        : rows.length === 0
          ? {
              kind: "empty",
              text: emptyText,
              action: onClear ? { label: "Clear filters", onClick: onClear } : undefined,
            }
          : { kind: "rows" };

  const period = periodOf(rows);
  const totals: TotalsRow[] = summary.map((sum) => ({
    label: summary.length > 1 ? `Total, ${sum.currency}` : "Total",
    period: period ?? undefined,
    values: {
      gross: <MoneyCell value={sum.gross} />,
      fee: <MoneyCell value={sum.fee} />,
      net: <MoneyCell value={sum.net} suffix={mixed} />,
    },
  }));
  const count =
    source.kind === "rows"
      ? `${rows.length} ${rows.length === 1 ? "row" : "rows"}${filtered ? " match" : ""}`
      : source.kind === "loading"
        ? "Reading"
        : "Not read";

  return (
    <div ref={ref} data-tour="admin.ledger.table">
      <TableCard
        id="admin-ledger-title"
        title="Entries"
        count={count}
        density="ledger"
        chrome={340}
        foot={period ? { left: `${period} · ${mixed ? "mixed" : currency}` } : undefined}
        note={
          rows.length > 0
            ? "Payments net of refunds. Transfers and payouts move the same money and are not added. Failed rows are not counted."
            : undefined
        }
      >
        <TableScroll bounded={rows.length > 20} labelledBy="admin-ledger-caption">
          <DataTable
            caption={
              period
                ? `Ledger entries, ${period}. Sortable columns have buttons in their headers.`
                : "Ledger entries. Sortable columns have buttons in their headers."
            }
            captionId="admin-ledger-caption"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            rowHeader="business"
            rowName={(row) =>
              `${row.seller.name}, ${TYPE_LABEL[row.type].toLowerCase()}, ${row.id}`
            }
            rowState={(row) => ROW_STATE[row.status]}
            state={state}
            selectedKey={selected}
            onRowOpen={onOpen}
            inspectorId={selected ? LEDGER_INSPECTOR_ID : undefined}
            totals={totals}
            sort={sort}
            onSort={onSort}
            currency={currency}
          />
        </TableScroll>
      </TableCard>
    </div>
  );
}
