"use client";

import Link from "next/link";
import { ProvenanceBadge } from "@/components/provenance-badge";
import {
  CopyId,
  Inspector,
  InspectorBlock,
  InspectorLine,
  InspectorLinks,
  InspectorNote,
  InspectorWho,
  Money as MoneyCell,
  StatusChip,
} from "@/components/table";
import { issueActionPath } from "@/lib/operator/api";
import { longDate, POLICY_LABEL, stamp } from "@/lib/operator/format";
import {
  ACTION_LABEL,
  ACTION_SENTENCE,
  issueRef,
  issueStatusTone,
  KIND_ACTIONS,
  KIND_EXPLANATION,
  KIND_LABEL,
  STATUS_LABEL,
} from "@/lib/operator/issues";
import type { Issue, IssueActionKind, OperatorSeller, Provenance } from "@/lib/operator/types";
import { BusinessMark } from "./business";
import { ISSUE_INSPECTOR_ID } from "./issues-table";
import type { ActionRun } from "./issues-view";
import { RouteState } from "./route-state";
import { useTourAttr } from "./tour";

const asProvenance = (value: string): Provenance =>
  value === "sandbox" || value === "live" ? value : "mock";

/**
 * One issue, end to end, in the shared Inspector: who, what happened in plain words,
 * both amounts where they differ, the actions the contract allows for the kind with
 * the API's next one first, and the audit trail. Resolved is never a button.
 */
export function IssueInspector({
  issue,
  seller,
  run,
  onAct,
  onClose,
}: {
  issue: Issue;
  seller: OperatorSeller | null;
  run: ActionRun | null;
  onAct: (issue: Issue, action: IssueActionKind) => void;
  onClose: () => void;
}) {
  useTourAttr(ISSUE_INSPECTOR_ID, "admin.issues.detail", true);
  const next = issue.next_safe_action;
  const closed = issue.status === "resolved" || issue.status === "escalated";
  const secondary = KIND_ACTIONS[issue.kind].filter((action) => action !== next.id);
  const name = seller?.name ?? issue.seller?.name ?? "Unknown business";
  const { local, provider, difference } = issue.amounts;
  const ref = issueRef(issue);
  return (
    <Inspector
      key={issue.id}
      id={ISSUE_INSPECTOR_ID}
      open
      onClose={onClose}
      label="Issue"
      title={KIND_LABEL[issue.kind]}
      status={
        <>
          <StatusChip tone={issueStatusTone(issue.status)}>{STATUS_LABEL[issue.status]}</StatusChip>
          {issue.simulated && <span className="chip line op-sim">simulated</span>}
          <ProvenanceBadge provenance={asProvenance(issue.provenance)} />
          {issue.assigned_to && <span>assigned to {issue.assigned_to}</span>}
        </>
      }
    >
      <InspectorBlock title="Business">
        <InspectorWho
          mark={<BusinessMark seller={{ name, avatar: seller?.avatar ?? null }} size="md" />}
          name={name}
          sub={
            seller
              ? `${POLICY_LABEL[seller.sale_policy]}, ${seller.city}, ${seller.country}`
              : issue.seller
                ? undefined
                : "No seller on this issue"
          }
        />
        {issue.seller && (
          <InspectorLine
            k="Whop account"
            v={
              issue.seller.whop_account_id ? (
                <CopyId value={issue.seller.whop_account_id} />
              ) : (
                "not created"
              )
            }
            quiet={!issue.seller.whop_account_id}
          />
        )}
      </InspectorBlock>

      <InspectorBlock title="What happened">
        <p className="op-explain">{KIND_EXPLANATION[issue.kind]}</p>
        <p className="op-impact-line">
          <b>Impact.</b> {issue.impact}
        </p>
      </InspectorBlock>

      <InspectorBlock title="Amounts">
        <div className="op-amounts-lg">
          <div>
            <span className="op-amt-k">Local ledger</span>
            <b className="op-amt-v">
              {local ? <MoneyCell value={local} /> : <span className="op-muted">no row</span>}
            </b>
          </div>
          <div>
            <span className="op-amt-k">Provider</span>
            <b className="op-amt-v">
              {provider ? (
                <MoneyCell value={provider} />
              ) : (
                <span className="op-muted">not returned</span>
              )}
            </b>
          </div>
          {difference && (
            <div className={difference.amountMinor === 0 ? "" : "is-gap"}>
              <span className="op-amt-k">Difference</span>
              <b className="op-amt-v">
                <MoneyCell value={difference} />
              </b>
            </div>
          )}
        </div>
      </InspectorBlock>

      <InspectorBlock title="Record">
        {issue.subject.provider_resource_id && (
          <InspectorLine k="Provider" v={<CopyId value={issue.subject.provider_resource_id} />} />
        )}
        {issue.subject.transfer_id && (
          <InspectorLine k="Transfer" v={<CopyId value={issue.subject.transfer_id} />} />
        )}
        <InspectorLine
          k="Order"
          v={issue.subject.order_id ? <CopyId value={issue.subject.order_id} /> : "none"}
          quiet={!issue.subject.order_id}
        />
        <InspectorLine
          k="Detected"
          v={<span className="op-mono">{stamp(issue.detected_at)}</span>}
        />
      </InspectorBlock>

      <InspectorBlock title="Safe actions">
        {issue.status === "resolved" ? (
          <p className="op-explain">
            Resolved after a recheck found the discrepancy gone. No further action.
          </p>
        ) : (
          <div className="op-actions-list">
            {next.id && (
              <ActionRow
                issue={issue}
                action={next.id}
                primary
                available={next.available}
                provenance={next.provenance}
                reason={next.reason}
                run={run}
                onAct={onAct}
              />
            )}
            {!next.id && <p className="op-explain">{next.reason}</p>}
            {secondary.map((action) => (
              <ActionRow
                key={action}
                issue={issue}
                action={action}
                primary={false}
                available={!closed}
                provenance={next.provenance}
                reason={closed ? "This issue is closed." : "Also allowed for this kind."}
                run={run}
                onAct={onAct}
              />
            ))}
          </div>
        )}
        {run?.state === "pending" && (
          <RouteState kind="pending" method="POST" path={issueActionPath(issue.id, run.action)} />
        )}
        {run?.state === "done" && run.result && !run.result.ok && (
          <RouteState kind="miss" miss={run.result} />
        )}
        {run?.state === "done" && run.result?.ok && (
          <RouteState
            kind="ok"
            method="POST"
            path={issueActionPath(issue.id, run.action)}
            status={run.result.status}
            summary={outcomeSummary(run.result.data)}
          />
        )}
      </InspectorBlock>

      <InspectorBlock title="History">
        <ol className="op-history" data-tour="admin.issues.history">
          {issue.history.length === 0 && (
            <li>
              <span className="op-muted">No actions recorded yet.</span>
            </li>
          )}
          {issue.history.map((step) => (
            <li key={`${step.at}-${step.action}-${step.actor}`}>
              <span className="op-mono">{longDate(step.at)}</span>
              <span>
                <b>{step.action}</b> by {step.actor}
                {asProvenance(step.provenance) !== "mock" && (
                  <span className={`prov ${asProvenance(step.provenance)}`}>
                    {step.provenance.toUpperCase()}
                  </span>
                )}
              </span>
              <span className="op-ink-2">{step.outcome}</span>
              {step.evidence_ref && (
                <span className="op-mono op-muted">evidence {step.evidence_ref}</span>
              )}
            </li>
          ))}
        </ol>
      </InspectorBlock>

      {issue.status === "resolved" && (
        <InspectorNote>
          The ledger is unchanged by resolution itself; only import posted an effect.
        </InspectorNote>
      )}

      <InspectorLinks>
        <Link className="pill ghost sm" href={`/admin/ledger?q=${encodeURIComponent(ref)}`}>
          Open in ledger
        </Link>
        {issue.seller && (
          <Link className="pill ghost sm" href={`/admin/sellers#${issue.seller.id}`}>
            Open seller
          </Link>
        )}
      </InspectorLinks>
    </Inspector>
  );
}

/** "Recorded. recheck failed (invalid_request). Status is now rechecking." from the returned issue. */
function outcomeSummary(issue: Issue): string {
  const last = issue.history[issue.history.length - 1];
  const status = STATUS_LABEL[issue.status].toLowerCase();
  if (!last) return `Recorded. Status is now ${status}.`;
  const outcome =
    last.outcome === "succeeded"
      ? "succeeded"
      : `${last.outcome}${last.evidence_ref ? ` (${last.evidence_ref})` : ""}`;
  return `Recorded. ${last.action} ${outcome}. Status is now ${status}.`;
}

function ActionRow({
  issue,
  action,
  primary,
  available,
  provenance,
  reason,
  run,
  onAct,
}: {
  issue: Issue;
  action: IssueActionKind;
  primary: boolean;
  available: boolean;
  provenance: string;
  reason: string;
  run: ActionRun | null;
  onAct: (issue: Issue, action: IssueActionKind) => void;
}) {
  const running = run?.state === "pending";
  return (
    <div className={`op-action-item${primary ? " is-primary" : ""}`}>
      <div className="op-action-row">
        <button
          type="button"
          className={`pill sm ${primary && available ? "ink" : "ghost"}`}
          data-tour={`admin.issues.guided.${action}`}
          disabled={!available || running}
          onClick={() => onAct(issue, action)}
        >
          {ACTION_LABEL[action]}
        </button>
        {asProvenance(provenance) !== "mock" && (
          <span
            className={`prov ${asProvenance(provenance)}`}
            title={`Action provenance: ${provenance}`}
          >
            {provenance.toUpperCase()}
          </span>
        )}
      </div>
      <p className="op-fine">
        {ACTION_SENTENCE[action]} {reason}
      </p>
    </div>
  );
}
