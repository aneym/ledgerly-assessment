import type { CSSProperties, ReactNode } from "react";
import { cellClass, priorityAttr, TableTotals } from "./TotalsRow";
import type { Column, DataTableProps, TableState } from "./types";
import "./table.css";

/**
 * The sheet's table. Owns the hidden caption, head buttons and aria-sort, the row
 * button and its overlay, data-selected, skeleton, empty and error rows, the tfoot
 * from `totals`, the currency suffix, aria-busy, data-priority and widths on cells.
 * It never fetches, filters or writes the URL.
 *
 * No hooks and no directive: it renders on the server when no callbacks are given,
 * and joins the caller's client island when they are.
 */
export function DataTable<Row>({
  caption,
  captionId,
  columns,
  rows,
  rowKey,
  rowHeader,
  rowName,
  rowState,
  state,
  selectedKey,
  onRowOpen,
  inspectorId,
  totals,
  sort,
  onSort,
  currency,
  skeletonRows = 6,
}: DataTableProps<Row>) {
  const interactive = typeof onRowOpen === "function";
  const showTotals =
    state.kind === "rows" && rows.length > 0 && totals !== undefined && totals.length > 0;

  return (
    <table
      className="tbl-table"
      aria-busy={state.kind === "loading" || undefined}
      data-currency={currency === "mixed" ? "mixed" : undefined}
    >
      <caption id={captionId} className="tbl-sr">
        {caption}
      </caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <HeadCell
              key={column.key}
              column={column}
              sort={sort ?? null}
              onSort={onSort}
              currency={currency}
            />
          ))}
        </tr>
      </thead>
      <tbody>
        {state.kind === "loading" && <Skeleton columns={columns} count={skeletonRows} />}
        {(state.kind === "empty" || state.kind === "error") && (
          <Message columns={columns} state={state} />
        )}
        {state.kind === "rows" &&
          rows.map((row) => {
            const key = rowKey(row);
            const selected = selectedKey != null && selectedKey === key;
            const rs = rowState?.(row);
            return (
              <tr
                key={key}
                className={rs ? `is-${rs}` : undefined}
                data-selected={selected ? "true" : undefined}
              >
                {columns.map((column) => {
                  const priority = priorityAttr(column);
                  const title = column.title?.(row);
                  const content = column.render(row);
                  if (column.key === rowHeader) {
                    const inner = typeof content === "string" ? <span>{content}</span> : content;
                    return (
                      <th
                        key={column.key}
                        scope="row"
                        className={cellClass(column)}
                        data-priority={priority}
                        title={title}
                      >
                        {interactive ? (
                          <button
                            type="button"
                            className="tbl-rowbtn"
                            aria-pressed={selected}
                            aria-controls={inspectorId}
                            aria-label={rowName?.(row)}
                            onClick={() => onRowOpen(row)}
                          >
                            {inner}
                          </button>
                        ) : (
                          <span className="tbl-rowbtn-static">{inner}</span>
                        )}
                      </th>
                    );
                  }
                  return (
                    <td
                      key={column.key}
                      className={cellClass(column)}
                      data-priority={priority}
                      title={title}
                    >
                      {content}
                    </td>
                  );
                })}
              </tr>
            );
          })}
      </tbody>
      {showTotals && <TableTotals columns={columns} totals={totals} />}
    </table>
  );
}

function widthStyle<Row>(column: Column<Row>): CSSProperties | undefined {
  if (column.width === undefined) return undefined;
  const kind = column.kind ?? "text";
  if (kind === "status") {
    // The status head reads --tbl-status-w so the 420px fold can shrink it to the dot.
    return { width: `min(var(--tbl-status-w), ${column.width}px)` };
  }
  if (kind === "date") {
    // The date head reads --tbl-date-w so the 420px fold, which hides the time, can narrow it.
    return { width: `min(var(--tbl-date-w), ${column.width}px)` };
  }
  return { width: column.width };
}

function HeadCell<Row>({
  column,
  sort,
  onSort,
  currency,
}: {
  column: Column<Row>;
  sort: { key: string; dir: "asc" | "desc" } | null;
  onSort?: (key: string) => void;
  currency?: string;
}) {
  const sorted = sort !== null && sort.key === column.key;
  const named =
    column.money === "net" && currency && currency !== "mixed" && typeof column.header === "string"
      ? `${column.header}, ${currency}`
      : column.header;
  const sortable = column.sortable === true && typeof onSort === "function";
  return (
    <th
      scope="col"
      className={cellClass(column)}
      style={widthStyle(column)}
      data-priority={priorityAttr(column)}
      aria-sort={sorted ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      {sortable ? (
        <button type="button" className="tbl-sort" onClick={() => onSort(column.key)}>
          {named}
          <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <path d="M5 2.2 8.4 7.4H1.6Z" fill="currentColor" />
          </svg>
        </button>
      ) : (
        named
      )}
    </th>
  );
}

const TEXT_BONES = [96, 120, 108, 96, 120, 104];
const MONEY_BONES = [52, 36, 48];

function bone<Row>(column: Column<Row>, index: number): ReactNode {
  switch (column.kind ?? "text") {
    case "date":
      return <span className="tbl-bone" style={{ width: 56 }} />;
    case "id":
      return <span className="tbl-bone" style={{ width: 80 }} />;
    case "status":
      return <span className="tbl-bone is-chip" />;
    case "money":
      return (
        <span
          className="tbl-bone"
          style={{ width: MONEY_BONES[(index + column.key.length) % 3] }}
        />
      );
    default:
      return <span className="tbl-bone" style={{ width: TEXT_BONES[index % TEXT_BONES.length] }} />;
  }
}

function Skeleton<Row>({ columns, count }: { columns: Column<Row>[]; count: number }) {
  return Array.from({ length: count }, (_, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
    <tr key={index}>
      {columns.map((column) => (
        <td key={column.key} className={cellClass(column)} data-priority={priorityAttr(column)}>
          {bone(column, index)}
        </td>
      ))}
    </tr>
  ));
}

function Message<Row>({
  columns,
  state,
}: {
  columns: Column<Row>[];
  state: Extract<TableState, { kind: "empty" | "error" }>;
}) {
  return (
    <tr className="is-message">
      <td colSpan={columns.length}>
        <span className="tbl-msg">
          {state.kind === "error" ? (
            state.body
          ) : (
            <>
              <span>{state.text}</span>
              {state.action &&
                (state.action.href ? (
                  <a className="pill ghost sm" href={state.action.href}>
                    {state.action.label}
                  </a>
                ) : (
                  <button type="button" className="pill ghost sm" onClick={state.action.onClick}>
                    {state.action.label}
                  </button>
                ))}
            </>
          )}
        </span>
      </td>
    </tr>
  );
}
