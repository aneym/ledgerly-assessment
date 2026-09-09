"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PillButton } from "@/components/pill";
import { ProvenanceBadge } from "@/components/provenance-badge";
import { InspectorLayout, PageHeader, useAnnounce, useTableParams } from "@/components/table";
import {
  type ApiMiss,
  type ApiResult,
  DEMO_FAULT_PATH,
  getIssues,
  injectDemoFault,
  runIssueAction,
} from "@/lib/operator/api";
import { displayIssue } from "@/lib/operator/display";
import {
  applyIssueFilters,
  EMPTY_ISSUE_FILTERS,
  type IssueFilters,
  KIND_LABEL,
  parseIssueFilters,
  STATUS_LABEL,
  toIssueQuery,
} from "@/lib/operator/issues";
import {
  ISSUE_KINDS,
  ISSUE_STATUSES,
  type Issue,
  type IssueActionKind,
  type IssuesPage,
  type OperatorSeller,
  type Provenance,
} from "@/lib/operator/types";
import { useAssistantSelection } from "./assistant/assistant-provider";
import { IssueInspector } from "./issue-inspector";
import { IssuesSheet, type IssuesSource } from "./issues-table";
import { RouteState } from "./route-state";

type Source =
  | { kind: "loading" }
  | { kind: "live"; page: IssuesPage }
  | { kind: "fixture"; miss: ApiMiss }
  | { kind: "error"; miss: ApiMiss };

export type ActionRun = {
  action: IssueActionKind;
  state: "pending" | "done";
  result?: ApiResult<Issue>;
};

type Demo = {
  open: boolean;
  seller_id: string;
  payment_id: string;
  state: "idle" | "pending" | "done";
  result?: ApiResult<Issue>;
};

const FILTER_KEYS: Array<Exclude<keyof IssueFilters, "issue">> = ["status", "kind", "seller_id"];

export function IssuesView({
  sellers,
  fixture,
  demoMode,
}: {
  sellers: OperatorSeller[];
  fixture: IssuesPage;
  demoMode: boolean;
}) {
  const params = useTableParams();
  const announce = useAnnounce();
  const filters = useMemo(() => {
    const search = new URLSearchParams();
    for (const key of [...FILTER_KEYS, "issue"] as const) {
      const value = params.get(key);
      if (value) search.set(key, value);
    }
    return parseIssueFilters(search);
  }, [params]);
  const query = toIssueQuery(filters);
  const guidedSellerId =
    demoMode && params.get("tour") === "C06" ? params.get("seller_id")?.trim() || null : null;

  const [source, setSource] = useState<Source>({ kind: "loading" });
  const [overrides, setOverrides] = useState<Record<string, Issue>>({});
  const [added, setAdded] = useState<Issue[]>([]);
  const [run, setRun] = useState<Record<string, ActionRun>>({});
  const [demo, setDemo] = useState<Demo>({
    open: false,
    seller_id: "",
    payment_id: "",
    state: "idle",
  });

  // One read per query, and again after an action or an injected fault changes the list.
  const load = useCallback(() => {
    let cancelled = false;
    setSource({ kind: "loading" });
    announce("Reading issues");
    getIssues(query).then((result) => {
      if (cancelled) return;
      if (result.ok)
        setSource({
          kind: "live",
          page: { ...result.data, issues: result.data.issues.map(displayIssue) },
        });
      else if (result.status === 404) setSource({ kind: "fixture", miss: result });
      else setSource({ kind: "error", miss: result });
    });
    return () => {
      cancelled = true;
    };
  }, [query, announce]);
  useEffect(load, [load]);

  const base: Issue[] =
    source.kind === "live"
      ? source.page.issues
      : source.kind === "fixture"
        ? applyIssueFilters(fixture.issues, filters)
        : [];
  // A live action result replaces the row it came back for; an injected fault joins the list.
  const issues = [...added.filter((issue) => !base.some((b) => b.id === issue.id)), ...base].map(
    (issue) => overrides[issue.id] ?? issue,
  );
  const sheet: IssuesSource =
    source.kind === "loading"
      ? { kind: "loading" }
      : source.kind === "error"
        ? { kind: "error", miss: source.miss }
        : { kind: "rows", rows: issues };
  const provenance: Provenance | null =
    source.kind === "live"
      ? (pageProvenance(issues) ?? null)
      : source.kind === "fixture"
        ? "mock"
        : null;

  const filtered = Boolean(filters.status || filters.kind || filters.seller_id);
  const readable = source.kind === "live" || source.kind === "fixture";
  useEffect(() => {
    if (!readable) return;
    announce(
      `${issues.length} ${issues.length === 1 ? "issue" : "issues"}${filtered ? " match" : ""}`,
    );
  }, [readable, issues.length, filtered, announce]);

  const selected = filters.issue || null;
  const current = selected ? (issues.find((issue) => issue.id === selected) ?? null) : null;
  const currentSeller = current?.seller
    ? (sellers.find((s) => s.id === current.seller?.id) ?? null)
    : null;

  useAssistantSelection(
    current
      ? {
          kind: "issue",
          id: current.id,
          label: `${currentSeller?.name ?? current.seller?.name ?? "Unknown business"}, ${KIND_LABEL[current.kind].toLowerCase()}`,
          href: `/admin/issues?issue=${current.id}`,
        }
      : null,
  );

  function update(next: IssueFilters) {
    const patch: Record<string, string | null> = { issue: next.issue || null };
    for (const key of FILTER_KEYS) patch[key] = next[key] || null;
    params.set(patch, next.seller_id !== filters.seller_id ? "push" : "replace");
    if (!next.status && !next.kind && !next.seller_id && filtered) announce("Filters cleared");
  }

  function select(id: string | null) {
    params.set({ issue: id });
  }

  async function act(issue: Issue, action: IssueActionKind) {
    if (run[issue.id]?.state === "pending") return;
    setRun((all) => ({ ...all, [issue.id]: { action, state: "pending" } }));
    const result = await runIssueAction(issue.id, action);
    setRun((all) => ({ ...all, [issue.id]: { action, state: "done", result } }));
    if (result.ok) setOverrides((all) => ({ ...all, [issue.id]: displayIssue(result.data) }));
  }

  async function inject(guided = false) {
    const sellerId = guided ? guidedSellerId : demo.seller_id.trim();
    if (demo.state === "pending" || !sellerId || (!guided && !demo.payment_id.trim())) return;
    setDemo((d) => ({ ...d, state: "pending", result: undefined }));
    const result = await injectDemoFault({
      kind: "missing_local_payment",
      seller_id: sellerId,
      ...(guided ? { fresh: true } : { payment_id: demo.payment_id.trim() }),
    });
    setDemo((d) => ({ ...d, state: "done", result, open: !result.ok }));
    if (result.ok) {
      setAdded((list) => [displayIssue(result.data), ...list]);
      load();
      select(result.data.id);
    }
  }

  const sellerOptions = useMemo(() => {
    const seen = new Map(sellers.map((s) => [s.id, { id: s.id, name: s.name }]));
    for (const issue of issues) {
      if (issue.seller && !seen.has(issue.seller.id))
        seen.set(issue.seller.id, { id: issue.seller.id, name: issue.seller.name });
    }
    return [...seen.values()];
  }, [sellers, issues]);
  const business = sellerOptions.find((s) => s.id === filters.seller_id) ?? null;
  const emptyText = filtered
    ? `No ${filters.status ? `${STATUS_LABEL[filters.status].toLowerCase()} ` : ""}${filters.kind ? `${KIND_LABEL[filters.kind].toLowerCase()} ` : ""}issues${business ? ` for ${business.name}` : ""}.`
    : "No open issues. Every payment and transfer matches the provider.";

  return (
    <>
      <PageHeader
        title="Issues"
        lede="Reconciliation exceptions, one per record, each with its next safe action."
        aside={provenance ? <ProvenanceBadge provenance={provenance} /> : undefined}
      />

      <form
        className="op-filters"
        action="/admin/issues"
        method="get"
        onSubmit={(event) => event.preventDefault()}
      >
        <label className="op-filter">
          <span className="op-sr">Status</span>
          <select
            name="status"
            value={filters.status}
            onChange={(e) =>
              update({ ...filters, status: e.target.value as IssueFilters["status"] })
            }
          >
            <option value="">All statuses</option>
            {ISSUE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="op-filter">
          <span className="op-sr">Kind</span>
          <select
            name="kind"
            value={filters.kind}
            onChange={(e) => update({ ...filters, kind: e.target.value as IssueFilters["kind"] })}
          >
            <option value="">All kinds</option>
            {ISSUE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="op-filter">
          <span className="op-sr">Business</span>
          <select
            name="seller_id"
            value={filters.seller_id}
            onChange={(e) => update({ ...filters, seller_id: e.target.value })}
          >
            <option value="">All businesses</option>
            {sellerOptions.map((seller) => (
              <option key={seller.id} value={seller.id}>
                {seller.name}
              </option>
            ))}
          </select>
        </label>
        {filtered && (
          <button
            type="button"
            className="op-clear"
            onClick={() => update({ ...EMPTY_ISSUE_FILTERS, issue: filters.issue })}
          >
            Clear
          </button>
        )}
        {demoMode && (
          <div className="op-demo">
            <PillButton
              tone="ghost"
              size="sm"
              onClick={() => setDemo((d) => ({ ...d, open: !d.open }))}
              aria-expanded={demo.open}
              title="Seeds one simulated case, labelled as simulated, for the guided tour."
              data-tour="admin.issues.inject-open"
            >
              Inject demo fault
            </PillButton>
          </div>
        )}
      </form>

      {guidedSellerId && (
        <fieldset className="op-demo-form">
          <legend>Prepare a simulated issue</legend>
          <p className="op-fine">
            Creates a fresh simulated payment for this tour's business, then opens its missing local
            payment case. No real payment is charged.
          </p>
          <PillButton
            tone="ink"
            size="sm"
            onClick={() => inject(true)}
            disabled={demo.state === "pending" || (demo.state === "done" && demo.result?.ok)}
            data-tour="admin.issues.inject"
          >
            Prepare simulated fault
          </PillButton>
        </fieldset>
      )}

      {demoMode && demo.open && (
        <fieldset className="op-demo-form">
          <legend>Inject a simulated missing local payment</legend>
          <p className="op-fine">
            Opens one simulated case for a payment the provider already confirms. Nothing is
            deleted.
          </p>
          <div className="op-action-row">
            <label className="op-demo-field">
              <span className="op-sr">Seller id</span>
              <input
                type="text"
                value={demo.seller_id}
                onChange={(e) => setDemo((d) => ({ ...d, seller_id: e.target.value }))}
                placeholder="seller id from the ledger"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="op-demo-field">
              <span className="op-sr">Confirmed payment id</span>
              <input
                type="text"
                value={demo.payment_id}
                onChange={(e) => setDemo((d) => ({ ...d, payment_id: e.target.value }))}
                placeholder="pay_… from the ledger"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <PillButton
              tone="ink"
              size="sm"
              onClick={() => inject()}
              disabled={
                demo.state === "pending" || !demo.seller_id.trim() || !demo.payment_id.trim()
              }
              data-tour={guidedSellerId ? undefined : "admin.issues.inject"}
            >
              Inject
            </PillButton>
          </div>
        </fieldset>
      )}

      {demo.state === "pending" && (
        <div className="op-source">
          <RouteState
            kind="pending"
            method="POST"
            path={`${DEMO_FAULT_PATH}?kind=missing_local_payment`}
          />
        </div>
      )}
      {demo.state === "done" && demo.result && !demo.result.ok && (
        <div className="op-source">
          <RouteState kind="miss" miss={demo.result} />
          <span>
            {demo.result.status === 422
              ? "The seller is not connected or the payment is not confirmed at the provider."
              : demo.result.status === 400
                ? "The route wants a business and a confirmed payment id."
                : null}
          </span>
        </div>
      )}
      {demo.state === "done" && demo.result?.ok && (
        <div className="op-source">
          <RouteState
            kind="ok"
            method="POST"
            path={`${DEMO_FAULT_PATH}?kind=missing_local_payment`}
            status={demo.result.status}
            summary="Simulated case opened."
          />
        </div>
      )}

      {source.kind === "fixture" && (
        <div className="op-source">
          <RouteState kind="miss" miss={source.miss} />
          <span>
            Showing the fixture in its place. Actions post to the routes and report what comes back.
          </span>
        </div>
      )}

      <InspectorLayout
        inspector={
          current ? (
            <IssueInspector
              issue={current}
              seller={currentSeller}
              run={run[current.id] ?? null}
              onAct={act}
              onClose={() => select(null)}
            />
          ) : undefined
        }
      >
        <IssuesSheet
          source={sheet}
          sellers={sellers}
          selected={current ? current.id : null}
          onOpen={(issue) => select(selected === issue.id ? null : issue.id)}
          emptyText={emptyText}
          onClear={filtered ? () => update({ ...EMPTY_ISSUE_FILTERS, issue: "" }) : null}
          filtered={filtered}
          onAct={act}
          runs={run}
        />
      </InspectorLayout>
    </>
  );
}

/** The page badge shows the provenance the issues agree on, or nothing when they differ. */
function pageProvenance(issues: Issue[]): Provenance | undefined {
  const set = new Set(issues.map((issue) => issue.provenance));
  if (set.size !== 1) return undefined;
  const only = [...set][0];
  return only === "sandbox" || only === "live" ? only : only === "mock" ? "mock" : undefined;
}
