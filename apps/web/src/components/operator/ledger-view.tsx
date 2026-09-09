"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PillButton } from "@/components/pill";
import {
  InspectorLayout,
  PageHeader,
  type SortState,
  useAnnounce,
  useTableParams,
} from "@/components/table";
import {
  ADMIN_LEDGER_PATH,
  type ApiMiss,
  type ApiResult,
  describeMiss,
  getAdminLedger,
  getLedgerEntry,
  reconcileSeller,
} from "@/lib/operator/api";
import { displayRow } from "@/lib/operator/display";
import { isOpen, KIND_LABEL } from "@/lib/operator/issues";
import {
  applyFilters,
  describeEmpty,
  EMPTY_FILTERS,
  isFiltered,
  type LedgerFilters,
  normalizeSummary,
  parseFilters,
  summarize,
  toQuery,
} from "@/lib/operator/ledger-filters";
import type {
  Issue,
  LedgerPage,
  LedgerRow,
  OperatorSeller,
  ReconciliationRun,
} from "@/lib/operator/types";
import { useAssistantSelection } from "./assistant/assistant-provider";
import { type DetailRead, EntryInspector } from "./entry-inspector";
import { LedgerFilterBar } from "./ledger-filters";
import { LedgerSheet, type LedgerSource, sortRows } from "./ledger-table";
import { RouteState } from "./route-state";

type Source =
  | { kind: "loading" }
  | { kind: "live"; page: LedgerPage }
  | { kind: "fixture"; miss: ApiMiss }
  | { kind: "error"; miss: ApiMiss };

type Reconcile =
  | { state: "idle" }
  | { state: "pending" }
  | { state: "done"; result: ApiResult<ReconciliationRun> };

type Detail = { id: string; read: DetailRead; row: LedgerRow | null };

/** The filter keys the URL carries, so a selection or sort change keeps them. */
const FILTER_KEYS: Array<keyof LedgerFilters> = [
  "q",
  "type",
  "status",
  "seller_id",
  "provenance",
  "from",
  "to",
  "currency",
];

export function LedgerView({
  sellers,
  fixture,
  sellersRead,
  issues,
}: {
  sellers: OperatorSeller[];
  /** Whether `sellers` came from GET /api/sellers or is the fixture list standing in. */
  sellersRead: { live: true } | { live: false; miss: ApiMiss };
  fixture: LedgerPage;
  issues: Issue[];
}) {
  const params = useTableParams();
  const announce = useAnnounce();
  const filters = useMemo(() => {
    const search = new URLSearchParams();
    for (const key of FILTER_KEYS) {
      const value = params.get(key);
      if (value) search.set(key, value);
    }
    return parseFilters(search);
  }, [params]);
  const query = toQuery(filters);
  const filtered = isFiltered(filters);
  const selected = params.entry;
  const sort = params.sort;

  const [source, setSource] = useState<Source>({ kind: "loading" });
  const [detail, setDetail] = useState<Detail>({ id: "", read: { kind: "row" }, row: null });
  const [reconcile, setReconcile] = useState<Reconcile>({ state: "idle" });
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);

  // One read per query. A 404 means the route is not live: say so and show the MOCK fixture.
  // Any other failure is an error state with no rows in its place.
  useEffect(() => {
    let cancelled = false;
    setSource({ kind: "loading" });
    announce("Reading the ledger");
    getAdminLedger(query).then((result) => {
      if (cancelled) return;
      // The route's ledger ids are numeric; the URL and the row key are strings.
      if (result.ok) {
        setSource({
          kind: "live",
          page: {
            ...result.data,
            rows: result.data.rows.map((r) => displayRow({ ...r, id: String(r.id) })),
          },
        });
      } else if (result.status === 404) setSource({ kind: "fixture", miss: result });
      else setSource({ kind: "error", miss: result });
    });
    return () => {
      cancelled = true;
    };
  }, [query, announce]);

  const live = source.kind === "live";
  const rows: LedgerRow[] = useMemo(
    () =>
      sortRows(
        source.kind === "live"
          ? source.page.rows
          : source.kind === "fixture"
            ? applyFilters(fixture.rows, filters)
            : [],
        sort,
      ),
    [source, fixture, filters, sort],
  );
  const summary = source.kind === "live" ? normalizeSummary(source.page.summary) : summarize(rows);
  const sheet: LedgerSource =
    source.kind === "loading"
      ? { kind: "loading" }
      : source.kind === "error"
        ? { kind: "error", miss: source.miss }
        : { kind: "rows", rows };

  const readable = source.kind === "live" || source.kind === "fixture";
  useEffect(() => {
    if (!readable) return;
    announce(`${rows.length} ${rows.length === 1 ? "row" : "rows"}${filtered ? " match" : ""}`);
  }, [readable, rows.length, filtered, announce]);

  // The selected row from the list, whichever source it came from.
  const listed = useMemo(
    () => (selected ? (rows.find((r) => r.id === selected) ?? null) : null),
    [rows, selected],
  );

  // The detail reads GET /api/admin/ledger/{id} only when the list is live. The effect
  // depends on the selection and the source, never on the row array, so a filter or sort
  // change does not restart the read.
  useEffect(() => {
    if (!selected || !live) return;
    let cancelled = false;
    const path = `${ADMIN_LEDGER_PATH}/${selected}`;
    setDetail({ id: selected, read: { kind: "pending", path }, row: null });
    getLedgerEntry(selected).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setDetail({
          id: selected,
          read: { kind: "live", path, status: result.status },
          row: displayRow({ ...result.data.row, id: String(result.data.row.id) }),
        });
      } else {
        setDetail({ id: selected, read: { kind: "miss", miss: result }, row: null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selected, live]);

  const liveDetail = live && selected && detail.id === selected ? detail : null;
  const current = liveDetail?.row ?? listed;
  const read: DetailRead = liveDetail
    ? liveDetail.read
    : live && selected
      ? { kind: "pending", path: `${ADMIN_LEDGER_PATH}/${selected}` }
      : { kind: "row" };
  const currentSeller = current ? (sellers.find((s) => s.id === current.seller.id) ?? null) : null;
  const currentIssue = current
    ? (issues.find(
        (issue) =>
          current.provider_resource_id !== null &&
          (issue.subject.provider_resource_id === current.provider_resource_id ||
            issue.subject.transfer_id === current.provider_resource_id),
      ) ?? null)
    : null;

  useAssistantSelection(
    current
      ? {
          kind: "ledger_entry",
          id: current.id,
          label: `${current.seller.name}, ${current.type}`,
          href: `/admin/ledger?q=${encodeURIComponent(current.id)}`,
        }
      : null,
  );

  // Business picker groups, real ids first: the seller list when GET /api/sellers is live,
  // then any business the live ledger rows name that the list did not, and the fixture
  // sellers, labelled MOCK, only while the seller route is not live.
  const sellerGroups = useMemo(() => {
    const listed = sellers.map((s) => ({ id: s.id, name: s.name }));
    const known = new Set(sellersRead.live ? listed.map((s) => s.id) : []);
    const fromRows = new Map<string, { id: string; name: string }>();
    if (live)
      for (const row of rows)
        if (!known.has(row.seller.id) && !fromRows.has(row.seller.id))
          fromRows.set(row.seller.id, { id: row.seller.id, name: row.seller.name });
    return [
      { label: "Sellers", mock: false, sellers: sellersRead.live ? listed : [] },
      { label: "Businesses in the ledger", mock: false, sellers: [...fromRows.values()] },
      { label: "Fixture sellers", mock: true, sellers: sellersRead.live ? [] : listed },
    ];
  }, [sellers, sellersRead.live, live, rows]);
  const business =
    sellerGroups.flatMap((group) => group.sellers).find((s) => s.id === filters.seller_id) ??
    sellers.find((seller) => seller.id === filters.seller_id) ??
    rows.find((row) => row.seller.id === filters.seller_id)?.seller ??
    null;
  const openIssues = issues.filter(
    (issue) => isOpen(issue) && (!business || issue.seller?.id === business.id),
  );
  const byKind = new Map<Issue["kind"], number>();
  for (const issue of openIssues) byKind.set(issue.kind, (byKind.get(issue.kind) ?? 0) + 1);
  const issuesHref = business ? `/admin/issues?seller_id=${business.id}` : "/admin/issues";

  function update(next: LedgerFilters) {
    setReconcile({ state: "idle" });
    const patch: Record<string, string | null> = { entry: null };
    for (const key of FILTER_KEYS) patch[key] = next[key] || null;
    const jump = next.seller_id !== filters.seller_id || next.currency !== filters.currency;
    params.set(patch, jump ? "push" : "replace");
    if (!isFiltered(next)) announce("Filters cleared");
  }

  function open(row: LedgerRow) {
    params.set({ entry: selected === row.id ? null : row.id });
  }

  function onSort(key: string) {
    const dir: SortState["dir"] = sort?.key === key && sort.dir === "desc" ? "asc" : "desc";
    params.set({ sort: key, dir });
  }

  async function runReconcile() {
    if (!business || reconcile.state === "pending") return;
    setReconcile({ state: "pending" });
    const result = await reconcileSeller(business.id);
    setReconcile({ state: "done", result });
  }

  return (
    <>
      <PageHeader
        title="Ledger"
        lede="Ledgerly's liability record across every business. Whop's ledger is the balance truth. Each row says who, what, how much and when."
      />

      <LedgerFilterBar filters={filters} sellers={sellerGroups} onChange={update} />

      {!sellersRead.live && (
        <div className="op-source">
          <RouteState kind="miss" miss={sellersRead.miss} />
          <span>The business picker lists the fixture sellers until that route is live.</span>
        </div>
      )}

      {source.kind === "fixture" && (
        <div className="op-source">
          <RouteState kind="miss" miss={source.miss} />
          <span>Showing the fixture in its place. Filters run on the fixture.</span>
        </div>
      )}

      <InspectorLayout
        inspector={
          current ? (
            <EntryInspector
              entry={current}
              seller={currentSeller}
              issue={currentIssue}
              read={read}
              onClose={() => params.set({ entry: null })}
            />
          ) : undefined
        }
      >
        <LedgerSheet
          source={sheet}
          summary={summary}
          sellers={sellers}
          issues={issues}
          selected={current ? current.id : null}
          onOpen={open}
          sort={sort}
          onSort={onSort}
          emptyText={describeEmpty(filters, business?.name ?? null)}
          onClear={filtered ? () => update(EMPTY_FILTERS) : null}
          filtered={filtered}
          now={now}
        />
      </InspectorLayout>

      <section
        className="op-card op-diff"
        data-tour="admin.ledger.diff"
        aria-label="Reconciliation"
      >
        <div className="op-diff-head">
          <div>
            <h2>Reconciliation</h2>
            <p className="op-what">
              {business
                ? `Compares ${business.name}'s payments and transfers at Whop with the local ledger. Differences become issues, never repairs.`
                : "Runs per business. Pick a business in the filters to reconcile it. Differences become issues, never repairs."}
            </p>
          </div>
          <div className="op-meta">
            <PillButton
              tone="ink"
              size="sm"
              data-tour="admin.ledger.reconcile"
              onClick={runReconcile}
              disabled={!business || reconcile.state === "pending"}
            >
              {business ? `Reconcile ${business.name}` : "Reconcile"}
            </PillButton>
          </div>
        </div>
        {reconcile.state === "pending" && (
          <div className="op-diff-route" role="status">
            <span>Reconciling{business ? ` ${business.name}` : ""}. Waiting for the app.</span>
          </div>
        )}
        {reconcile.state === "done" && !reconcile.result.ok && (
          <div className="op-diff-route" role="status">
            <span title={reconcile.result.detail}>
              Reconcile failed. {describeMiss(reconcile.result)}
            </span>
          </div>
        )}
        {reconcile.state === "done" && reconcile.result.ok && (
          <div className="op-diff-route">
            <ReconcileResult run={reconcile.result.data} name={business?.name ?? null} />
          </div>
        )}
        <div className="op-issues-strip">
          {openIssues.length === 0 ? (
            <span className="op-muted">
              No open issues{business ? ` for ${business.name}` : ""}. Payments and transfers match
              the provider.
            </span>
          ) : (
            <>
              <span>
                <b>
                  {openIssues.length === 1 ? "1 open issue" : `${openIssues.length} open issues`}
                </b>
                {business ? ` for ${business.name}` : " across all businesses"}
              </span>
              {[...byKind.entries()].map(([kind, n]) => (
                <span key={kind} className="chip line">
                  {n} {KIND_LABEL[kind].toLowerCase()}
                </span>
              ))}
            </>
          )}
          <Link className="pill ghost sm" href={issuesHref}>
            Open issues
          </Link>
        </div>
        <div className="op-invariant">
          <span className="op-k">No automatic repair.</span>
          <i className="op-lead" aria-hidden="true" />
          <span className="op-v">Differences are recorded as issues, not fixed.</span>
        </div>
      </section>
    </>
  );
}

/** The recorded run: how many issues it opened or touched, and the link to them. */
function ReconcileResult({ run, name }: { run: ReconciliationRun; name: string | null }) {
  const href = `/admin/issues?seller_id=${encodeURIComponent(run.seller_id)}`;
  return (
    <div className="op-run" data-tour="admin.ledger.run" title={`Run ${run.id}`}>
      <div className="op-run-line">
        <span>
          {name ? `Reconciled ${name}. ` : "Reconciled. "}
          {run.issue_ids.length === 0
            ? "No issues opened or touched."
            : run.issue_ids.length === 1
              ? "1 issue opened or touched."
              : `${run.issue_ids.length} issues opened or touched.`}
        </span>
        <Link className="pill ghost sm" href={href}>
          {name ? `Issues for ${name}` : "Issues for this seller"}
        </Link>
      </div>
    </div>
  );
}
