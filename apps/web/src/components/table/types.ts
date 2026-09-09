import type { ReactNode } from "react";

export type Density = "ledger" | "compact";
export type Priority = 1 | 2 | 3;
export type CellKind = "text" | "id" | "date" | "money" | "status";
export type MoneyRole = "gross" | "fee" | "net";
export type RowState = "pending" | "held" | "refunded" | "failed";
export type Tone = "ok" | "warn" | "bad" | "plain" | "line";
export type Align = "left" | "right" | "center";
export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir };

export interface Column<Row> {
  key: string;
  /** Sentence case in the source; CSS uppercases. */
  header: ReactNode;
  /** Default "text". Sets .c-text, .c-id, .c-date, .c-money, .c-status. */
  kind?: CellKind;
  /** Default follows the kind: money is right, everything else left. */
  align?: Align;
  /** is-net and is-fee on the cell; is-neg comes from the value. */
  money?: MoneyRole;
  /** Border-box px on the th. Omit on exactly one column; it takes the slack. */
  width?: number;
  /** 1 never folds, 2 folds under a 560px card, 3 under 800px. Default 1. */
  priority?: Priority;
  /** Operator tables only. Needs onSort on the table. */
  sortable?: boolean;
  /** Cell content. A plain string in the row header column is wrapped so it truncates. */
  render: (row: Row) => ReactNode;
  /** Hover title: relative time, full name. */
  title?: (row: Row) => string | undefined;
}

export interface TotalsRow {
  /** "Total" or "Total, USD". */
  label: string;
  /** Rendered in the first text column after the label, muted. */
  period?: string;
  /** By column key; missing keys render empty. */
  values: Record<string, ReactNode>;
}

export type TableState =
  | { kind: "loading" }
  | { kind: "rows" }
  | {
      kind: "empty";
      text: string;
      action?: { label: string; onClick?: () => void; href?: string };
    }
  | { kind: "error"; body: ReactNode };

export interface DataTableProps<Row> {
  /** Visually hidden caption; names the table and the region. */
  caption: string;
  captionId: string;
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Key of the column rendered as th scope="row"; holds the row button. */
  rowHeader: string;
  /** Accessible name of the row button; default is the cell text. */
  rowName?: (row: Row) => string;
  rowState?: (row: Row) => RowState | undefined;
  state: TableState;
  selectedKey?: string | null;
  /** Absent: rows are not interactive, no hover, no button. */
  onRowOpen?: (row: Row) => void;
  /** aria-controls on the row button. Pass it while the inspector is mounted. */
  inspectorId?: string;
  /** One per currency; absent in loading, empty and error. */
  totals?: TotalsRow[];
  sort?: SortState | null;
  onSort?: (key: string) => void;
  /** Uniform: named in the net head. Mixed: mono suffix per cell. */
  currency?: string | "mixed";
  /** Default 6. */
  skeletonRows?: number;
}
