"use client";

import Link from "next/link";
import {
  CopyId,
  Inspector,
  InspectorBlock,
  InspectorLine,
  InspectorLinks,
  InspectorNote,
  InspectorTimeline,
  InspectorWho,
  Money as MoneyCell,
  moneyText,
  StatusChip,
} from "@/components/table";
import type { ApiMiss } from "@/lib/operator/api";
import { POLICY_LABEL, STATUS_LABEL, stamp, statusTone, TYPE_LABEL } from "@/lib/operator/format";
import { KIND_LABEL } from "@/lib/operator/issues";
import type { Issue, LedgerRow, OperatorSeller } from "@/lib/operator/types";
import { BusinessMark } from "./business";
import { LEDGER_INSPECTOR_ID } from "./ledger-table";
import { RouteState } from "./route-state";
import { useTourAttr } from "./tour";

export type DetailRead =
  | { kind: "row" }
  | { kind: "pending"; path: string }
  | { kind: "live"; path: string; status: number }
  | { kind: "miss"; miss: ApiMiss };

/**
 * The selected ledger row in the shared Inspector: business first, then money,
 * provider, timeline, and links out to the seller, the order and any issue.
 * When GET /api/admin/ledger/{id} is live its record wins; otherwise the row is shown.
 */
export function EntryInspector({
  entry,
  seller,
  issue,
  read,
  onClose,
}: {
  entry: LedgerRow;
  seller: OperatorSeller | null;
  issue: Issue | null;
  read: DetailRead;
  onClose: () => void;
}) {
  useTourAttr(LEDGER_INSPECTOR_ID, "admin.ledger.detail", true);
  const headline = entry.net ?? entry.fee ?? entry.gross;
  return (
    <Inspector
      id={LEDGER_INSPECTOR_ID}
      open
      onClose={onClose}
      label="Ledger entry"
      idValue={entry.id}
      title={TYPE_LABEL[entry.type]}
      amount={
        headline
          ? {
              text: moneyText({ ...headline, amountMinor: Math.abs(headline.amountMinor) }),
              negative: headline.amountMinor < 0,
              struck: entry.status === "failed",
            }
          : undefined
      }
      status={
        <>
          <StatusChip tone={statusTone(entry.status)}>{STATUS_LABEL[entry.status]}</StatusChip>
          {entry.item && <span>{entry.item}</span>}
        </>
      }
    >
      {read.kind === "pending" && <RouteState kind="pending" method="GET" path={read.path} />}
      {read.kind === "miss" && read.miss.status !== 404 && (
        <RouteState kind="miss" miss={read.miss} />
      )}
      {issue && (
        <Link className="op-issue-link" href={`/admin/issues?issue=${issue.id}`}>
          <span className="chip bad">{KIND_LABEL[issue.kind]}</span>
          <span>Open the issue</span>
        </Link>
      )}

      <InspectorBlock title="Business">
        <InspectorWho
          mark={
            <BusinessMark
              seller={{ name: entry.seller.name, avatar: seller?.avatar ?? null }}
              size="md"
            />
          }
          name={entry.seller.name}
          sub={seller ? `${seller.city}, ${seller.country}` : undefined}
        />
        <InspectorLine
          k="Seller id"
          v={
            <span className="op-wrap">
              <CopyId value={entry.seller.id} />
            </span>
          }
        />
        <InspectorLine
          k="Whop account"
          v={
            entry.seller.whop_account_id ? (
              <CopyId value={entry.seller.whop_account_id} />
            ) : (
              "not created"
            )
          }
          quiet={!entry.seller.whop_account_id}
        />
        <InspectorLine k="Sale policy" v={POLICY_LABEL[entry.seller.sale_policy]} />
      </InspectorBlock>

      <InspectorBlock title="Money">
        <InspectorLine
          k="Gross"
          v={entry.gross ? <MoneyCell value={entry.gross} /> : "not on this row"}
          quiet={!entry.gross}
          num={Boolean(entry.gross)}
        />
        <InspectorLine
          k="Fee 8%"
          v={entry.fee ? <MoneyCell value={entry.fee} /> : "not on this row"}
          quiet={!entry.fee}
          num={Boolean(entry.fee)}
        />
        <InspectorLine
          k="Net"
          v={entry.net ? <MoneyCell value={entry.net} /> : "not on this row"}
          quiet={!entry.net}
          num={Boolean(entry.net)}
        />
        <InspectorLine k="Currency" v={entry.currency} />
        {entry.charge_model && (
          <InspectorLine
            k="Charge model"
            v={entry.charge_model === "direct" ? "Direct charge" : "Platform charge and transfer"}
          />
        )}
      </InspectorBlock>

      <InspectorBlock title="Provider">
        <InspectorLine
          k="Resource"
          v={entry.provider_resource_id ? <CopyId value={entry.provider_resource_id} /> : "none"}
          quiet={!entry.provider_resource_id}
        />
        <InspectorLine
          k="Order"
          v={entry.order_id ? <CopyId value={entry.order_id} /> : "none"}
          quiet={!entry.order_id}
        />
      </InspectorBlock>

      <InspectorBlock title="Timeline, UTC">
        <InspectorTimeline
          items={[
            { label: "Created", when: stamp(entry.created_at) },
            { label: "Updated", when: stamp(entry.updated_at) },
            {
              label: entry.settled_at ? "Settled" : "Settles",
              when: entry.settled_at ? stamp(entry.settled_at) : "not yet",
              open: !entry.settled_at,
            },
          ]}
        />
      </InspectorBlock>

      {entry.note && <InspectorNote>{entry.note}</InspectorNote>}

      <InspectorLinks>
        <Link className="pill ghost sm" href={`/admin/sellers#${entry.seller.id}`}>
          Open seller
        </Link>
        {entry.order_id && (
          <Link className="pill ghost sm" href={`/receipt/${entry.order_id}`}>
            Open order
          </Link>
        )}
      </InspectorLinks>
    </Inspector>
  );
}
