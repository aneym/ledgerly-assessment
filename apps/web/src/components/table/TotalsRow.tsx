import type { Column, TotalsRow } from "./types";

export type { TotalsRow };

/** Class list for a body or totals cell: the kind plus the money role. */
export function cellClass<Row>(column: Column<Row>, extra?: string): string {
  const kind = column.kind ?? "text";
  const parts = [`c-${kind}`];
  if (kind === "money" && (column.money === "net" || column.money === "fee")) {
    parts.push(`is-${column.money}`);
  }
  if (column.align === "center") parts.push("is-center");
  if (column.align === "right" && kind !== "money") parts.push("is-right");
  if (extra) parts.push(extra);
  return parts.join(" ");
}

export function priorityAttr<Row>(column: Column<Row>): 2 | 3 | undefined {
  return column.priority === 2 || column.priority === 3 ? column.priority : undefined;
}

/**
 * The tfoot. Label in the first cell, the period in the first text column after
 * it, values by column key, nothing spanning. Ink rules above and below come
 * from table.css. One row per currency when a table mixes them.
 */
export function TableTotals<Row>({
  columns,
  totals,
}: {
  columns: Column<Row>[];
  totals: TotalsRow[];
}) {
  const periodKey = columns.find((c, i) => i > 0 && (c.kind ?? "text") === "text")?.key;
  return (
    <tfoot>
      {totals.map((total) => (
        <tr key={total.label}>
          {columns.map((column, index) => {
            const priority = priorityAttr(column);
            if (index === 0) {
              return (
                <th key={column.key} scope="row" data-priority={priority}>
                  {total.label}
                </th>
              );
            }
            const value = total.values[column.key];
            if (column.key === periodKey && value === undefined) {
              return (
                <td key={column.key} className="c-text is-period" data-priority={priority}>
                  {total.period}
                </td>
              );
            }
            return (
              <td key={column.key} className={cellClass(column)} data-priority={priority}>
                {value}
              </td>
            );
          })}
        </tr>
      ))}
    </tfoot>
  );
}
