"use client";

import { useMemo, useRef } from "react";
import {
  type Column,
  DataTable,
  StatusChip,
  TableCard,
  TableScroll,
  type TableState,
} from "@/components/table";
import type { ApiMiss } from "@/lib/operator/api";
import {
  ACTION_LABEL,
  ageLabel,
  issueRef,
  issueStatusTone,
  KIND_LABEL,
  STATUS_LABEL,
} from "@/lib/operator/issues";
import type { Issue, IssueActionKind, OperatorSeller } from "@/lib/operator/types";
import { BusinessCell } from "./business";
import type { ActionRun } from "./issues-view";
import { RouteState } from "./route-state";
import { useRowTour } from "./tour";

export const ISSUE_INSPECTOR_ID = "issue-inspector";

export type IssuesSource =
  | { kind: "loading" }
  | { kind: "rows"; rows: Issue[] }
  | { kind: "error"; miss: ApiMiss };

/** Issue rows: who, what kind, what it means, how old, where it stands, what is safe next. */
export function IssuesSheet({
  source,
  sellers,
  selected,
  onOpen,
  emptyText,
  onClear,
  filtered,
  onAct,
  runs,
}: {
  source: IssuesSource;
  sellers: OperatorSeller[];
  selected: string | null;
  onOpen: (issue: Issue) => void;
  emptyText: string;
  onClear: (() => void) | null;
  filtered: boolean;
  onAct: (issue: Issue, action: IssueActionKind) => void;
  runs: Record<string, ActionRun>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(sellers.map((seller) => [seller.id, seller])), [sellers]);
  const nameOf = (issue: Issue) =>
    byId.get(issue.seller?.id ?? "")?.name ?? issue.seller?.name ?? "Unknown business";

  const rows = source.kind === "rows" ? source.rows : [];
  const keys = useMemo(() => rows.map((issue) => issue.id), [rows]);
  useRowTour(ref, "admin.issues.item", keys);

  const columns: Column<Issue>[] = [
    {
      key: "business",
      header: "Business",
      kind: "text",
      render: (issue) => (
        <BusinessCell
          seller={{ name: nameOf(issue), avatar: byId.get(issue.seller?.id ?? "")?.avatar ?? null }}
        />
      ),
      title: (issue) => (issue.simulated ? `${nameOf(issue)}, simulated case` : nameOf(issue)),
    },
    {
      key: "kind",
      header: "Issue",
      kind: "text",
      width: 168,
      render: (issue) => (
        <span>
          {issue.simulated ? `${KIND_LABEL[issue.kind]} (simulated)` : KIND_LABEL[issue.kind]}
        </span>
      ),
      title: (issue) => `${KIND_LABEL[issue.kind]}, ${issueRef(issue)}`,
    },
    {
      key: "impact",
      header: "Impact",
      kind: "text",
      width: 220,
      priority: 2,
      render: (issue) => <span>{issue.impact}</span>,
      title: (issue) => issue.impact,
    },
    {
      key: "age",
      header: "Age",
      kind: "date",
      width: 72,
      priority: 3,
      render: (issue) => ageLabel(issue.age_seconds),
      title: (issue) => issue.detected_at,
    },
    {
      key: "status",
      header: "Status",
      kind: "status",
      width: 120,
      render: (issue) => (
        <StatusChip tone={issueStatusTone(issue.status)} size="table">
          {STATUS_LABEL[issue.status]}
        </StatusChip>
      ),
    },
    {
      key: "next",
      header: "Next safe action",
      kind: "text",
      width: 176,
      priority: 2,
      render: (issue) => {
        const next = issue.next_safe_action;
        if (!next.id) return <span className="dash">none</span>;
        const id = next.id;
        const running = runs[issue.id]?.state === "pending";
        return (
          <button
            type="button"
            className="pill ghost sm"
            data-tour="admin.issues.action"
            disabled={!next.available || running}
            title={`${next.reason} Provenance ${next.provenance}.`}
            onClick={() => onAct(issue, id)}
          >
            {ACTION_LABEL[id]}
          </button>
        );
      },
      title: (issue) => issue.next_safe_action.reason,
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
                <span>Issues could not be read. No rows are shown in place of them.</span>
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
  const count =
    source.kind === "rows"
      ? `${rows.length} ${rows.length === 1 ? "issue" : "issues"}${filtered ? " match" : ""}`
      : source.kind === "loading"
        ? "Reading"
        : "Not read";

  return (
    <div ref={ref} data-tour="admin.issues.list">
      <TableCard id="admin-issues-title" title="Issues" count={count} density="ledger" chrome={300}>
        <TableScroll bounded={rows.length > 20} labelledBy="admin-issues-caption">
          <DataTable
            caption="Reconciliation issues, one per record."
            captionId="admin-issues-caption"
            columns={columns}
            rows={rows}
            rowKey={(issue) => issue.id}
            rowHeader="business"
            rowName={(issue) =>
              `${nameOf(issue)}, ${KIND_LABEL[issue.kind].toLowerCase()}, ${issue.id}`
            }
            state={state}
            selectedKey={selected}
            onRowOpen={onOpen}
            inspectorId={selected ? ISSUE_INSPECTOR_ID : undefined}
          />
        </TableScroll>
      </TableCard>
    </div>
  );
}
