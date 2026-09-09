"use client";

import type { Money } from "@ledgerly/core";
import { useEffect, useState } from "react";
import { PillLink } from "@/components/pill";
import { ProvenanceBadge } from "@/components/provenance-badge";
import {
  type Column,
  DataTable,
  Money as MoneyCell,
  type RowState,
  StatusChip,
  TableCard,
  TableScroll,
  type TableState,
  type TotalsRow,
} from "@/components/table";
import { formatMoney } from "@/lib/catalog/money";
import { type ApiFail, sellerApi } from "@/lib/seller/api";
import { chargeModelSentence } from "@/lib/seller/identity";
import {
  type LedgerRow,
  type LedgerStatus,
  type LedgerSummary,
  ledgerFromApi,
  STATUS_LABEL,
  STATUS_TONE,
} from "@/lib/seller/ledger";
import { NotLive, Reading } from "./ApiState";
import { PageHead } from "./PageHead";

type Source =
  | { kind: "reading" }
  | { kind: "api"; ledger: LedgerSummary }
  | { kind: "unavailable"; fail: ApiFail };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const month = MONTHS[Number(match[2]) - 1] ?? match[2];
  return `${month} ${match[3]}`;
}

/** Signed money with a true minus sign, for the balances band. */
function signed(value: Money): string {
  if (value.amountMinor < 0) {
    return `−${formatMoney({ amountMinor: -value.amountMinor, currency: value.currency })}`;
  }
  return formatMoney(value);
}

function count(rows: LedgerRow[], status: LedgerRow["status"]): number {
  return rows.filter((r) => r.status === status).length;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Sep 01 to Sep 08" from the rows' dates, in either order. */
function periodOf(rows: LedgerRow[]): string | null {
  const dates = rows
    .map((r) => r.date)
    .filter(Boolean)
    .sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return null;
  return first === last ? shortDate(first) : `${shortDate(first)} to ${shortDate(last)}`;
}

/** Row states the sheet paints: money goes ink-2 while settling, struck when failed. */
const ROW_STATE: Partial<Record<LedgerStatus, RowState>> = {
  settling: "pending",
  held: "held",
  refunded: "refunded",
  failed: "failed",
};

const EMPTY_TEXT = "No transactions yet. The first sale shows up here once Whop confirms payment.";

/**
 * Seven columns per docs/design/tables.md section 9. Date, Item and Net never fold;
 * Status, Gross and Fee fold under a 560px card; Order under 800px. The item cell
 * carries the product name over the buyer city; the cover stays off the row.
 */
const COLUMNS: Column<LedgerRow>[] = [
  {
    key: "date",
    header: "Date",
    kind: "date",
    width: 80,
    render: (r) => shortDate(r.date),
    title: (r) => r.date,
  },
  {
    key: "item",
    header: "Item",
    kind: "text",
    render: (r) => (
      <span className="sl-tx-item">
        <b>{r.item}</b>
        <span>
          {/* Visible only while the status column is folded, so a held or refunded row still says
              so. It leads the line so the city, not the status, is what truncates. */}
          <i className="sl-tx-st">
            {STATUS_LABEL[r.status]}
            {r.note ? " · " : ""}
          </i>
          {r.note}
        </span>
      </span>
    ),
    title: (r) => (r.note ? `${r.item}, ${r.note}` : r.item),
  },
  { key: "order", header: "Order", kind: "id", width: 112, priority: 3, render: (r) => r.order },
  {
    key: "status",
    header: "Status",
    kind: "status",
    width: 120,
    priority: 2,
    render: (r) => (
      <StatusChip tone={STATUS_TONE[r.status]} size="table">
        {STATUS_LABEL[r.status]}
      </StatusChip>
    ),
  },
  {
    key: "gross",
    header: "Gross",
    kind: "money",
    width: 88,
    priority: 2,
    money: "gross",
    render: (r) => (r.partial ? null : <MoneyCell value={r.gross} />),
  },
  {
    key: "fee",
    header: "Fee 8%",
    kind: "money",
    width: 80,
    priority: 2,
    money: "fee",
    render: (r) => (r.partial ? null : <MoneyCell value={r.fee} />),
  },
  {
    key: "net",
    header: "Net",
    kind: "money",
    width: 104,
    money: "net",
    render: (r) => <MoneyCell value={r.net} />,
  },
];

type EarningsProps = {
  sellerId: string;
  sellerName: string;
  /** False only for an explicit fixture seller; no API read is made. */
  readable: boolean;
  correlationId: string | null;
  /** Used only in explicit fixture mode, never while an API read is pending or failed. */
  initial: LedgerSummary | null;
  chargeModel: string;
  withdrawHref: string;
};

export function EarningsView(props: EarningsProps) {
  if (!props.readable && props.initial) {
    return <EarningsLedger {...props} ledger={props.initial} source="fixture" />;
  }
  // Remount before rendering a new identity or request context. An effect-only reset
  // would let the previous seller's ledger appear in the first committed render.
  return (
    <EarningsReader
      key={JSON.stringify([props.sellerId, props.correlationId, props.readable])}
      {...props}
    />
  );
}

function EarningsReader(props: EarningsProps) {
  const { sellerId, sellerName, correlationId, readable } = props;
  const [source, setSource] = useState<Source>({ kind: "reading" });
  const path = `/api/sellers/${encodeURIComponent(sellerId)}/earnings`;

  useEffect(() => {
    if (!readable) return;
    let cancelled = false;
    void sellerApi.earnings(sellerId, correlationId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setSource({ kind: "api", ledger: ledgerFromApi(result.data) });
      } else {
        setSource({ kind: "unavailable", fail: result });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sellerId, correlationId, readable]);

  if (source.kind === "api") {
    return <EarningsLedger {...props} ledger={source.ledger} source="api" />;
  }
  return (
    <div className="flex flex-col gap-8">
      <PageHead title="Earnings" sub={`Earnings for ${sellerName}`} />
      {source.kind === "unavailable" ? (
        <NotLive fail={source.fail}>
          Earnings for {sellerName} are unavailable. No balances or transactions have been
          confirmed.
        </NotLive>
      ) : readable ? (
        <Reading method="GET" path={path} label="Reading your earnings" />
      ) : (
        <p role="status">Earnings are unavailable. No seller ledger is configured.</p>
      )}
    </div>
  );
}

function EarningsLedger({
  ledger,
  source,
  chargeModel,
  withdrawHref,
}: EarningsProps & { ledger: LedgerSummary; source: "api" | "fixture" }) {
  const { rows, totals } = ledger;
  const partial = rows.some((r) => r.partial);
  const settling = count(rows, "settling");
  const held = count(rows, "held");
  const paidOut = rows.filter((r) => r.status === "paid_out");
  const paidOutTotal: Money = paidOut.reduce<Money>(
    (acc, r) => ({ amountMinor: acc.amountMinor + r.net.amountMinor, currency: acc.currency }),
    { amountMinor: 0, currency: totals.net.currency },
  );
  const currency = totals.net.currency;
  const period = periodOf(rows);
  // The API's charge_model wins over the fixture policy once a readback exists.
  const chargeLine =
    ledger.chargeModel === "direct"
      ? chargeModelSentence("direct_charge")
      : ledger.chargeModel === "platform_transfer"
        ? chargeModelSentence("platform_charge_transfer")
        : chargeModel;

  const tableState: TableState =
    rows.length === 0 ? { kind: "empty", text: EMPTY_TEXT } : { kind: "rows" };
  const totalsRow: TotalsRow = {
    label: "Total",
    period: period ?? undefined,
    values: {
      gross: partial ? null : <MoneyCell value={totals.gross} />,
      fee: partial ? null : <MoneyCell value={totals.fee} />,
      net: <MoneyCell value={totals.net} />,
    },
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHead
        title="Earnings"
        sub={
          <>
            <b className="font-medium text-ink">{chargeLine}</b> Net is your share before Whop
            processing fees.
          </>
        }
        aside={
          <span className="flex items-center gap-3 text-[13px] text-muted">
            {source === "api" ? <span>Read from the app API</span> : null}
            <span data-tour="sell.earnings.provenance" className="inline-flex">
              {ledger.provenance ? <ProvenanceBadge provenance={ledger.provenance} /> : null}
            </span>
          </span>
        }
      />

      {source === "fixture" ? (
        <p className="text-[13px] leading-relaxed text-muted" role="status">
          Sample earnings for Onda Sounds. These fixture balances and transactions are not an
          account readback.
        </p>
      ) : null}
      {source === "api" && ledger.totalsOnly ? (
        <p className="text-[13px] leading-relaxed text-muted" role="status">
          Whop reports one total; gross and fee per sale are not available yet.
        </p>
      ) : null}

      <section className="sl-paper sl-band sl-rise" aria-label="Balances">
        <div
          className="flex min-w-0 flex-col gap-1.5 px-6 py-6 md:px-8"
          data-tour="sell.earnings.available"
        >
          <span className="font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase">
            Available
          </span>
          <span className="mt-1 text-[36px] leading-[1.1] font-medium tracking-[-0.015em] text-ink">
            {signed(ledger.available)}
          </span>
          <span className="text-[12.5px] leading-[1.45] text-muted">
            Available after settlement, before Whop processing fees.
          </span>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <PillLink href={withdrawHref} tone="ink" data-tour="sell.earnings.withdraw">
              Withdraw {signed(ledger.available)}
            </PillLink>
            <span className="text-[12.5px] text-muted">
              A payout, not a transfer. 1 to 2 business days.
            </span>
          </div>
        </div>
        <div
          className="flex min-w-0 flex-col gap-1.5 px-6 py-6 md:px-8"
          data-tour="sell.earnings.pending"
        >
          <span className="font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase">
            Pending
          </span>
          <span className="mt-1 text-[36px] leading-[1.1] font-medium tracking-[-0.015em] text-ink">
            {signed(ledger.pending)}
          </span>
          <span className="text-[12.5px] leading-[1.45] text-muted">
            {settling === 0
              ? "Nothing settling."
              : `${plural(settling, "sale", "sales")} settling.`}
          </span>
        </div>
        <div
          className="flex min-w-0 flex-col gap-1.5 px-6 py-6 md:px-8"
          data-tour="sell.earnings.held"
        >
          <span className="flex items-center gap-2 font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase">
            Held
            {held > 0 ? <StatusChip tone="bad">Dispute</StatusChip> : null}
          </span>
          <span className="mt-1 text-[36px] leading-[1.1] font-medium tracking-[-0.015em] text-ink">
            {signed(ledger.held)}
          </span>
          <span className="text-[12.5px] leading-[1.45] text-muted">
            {held === 0
              ? "No orders on hold."
              : `${plural(held, "order", "orders")} held until the dispute resolves.`}
          </span>
        </div>
      </section>

      {/* The sheet. The card clips; the head sticks to the viewport top and the totals row to
          its foot while the table is under the reader. No nested scroller at seven rows. */}
      <div className="sl-rise flex flex-col gap-4" data-delay="1" data-tour="sell.earnings.table">
        <TableCard
          id="sell-earnings-title"
          title="Transactions"
          density="compact"
          className="sl-earnings"
          count={plural(rows.length, "row", "rows")}
          period={period ? `${period} · ${currency}` : `Last 30 days · ${currency}`}
          note={
            rows.length > 0 ? (
              <>
                Available, pending and held above
                {paidOut.length > 0 ? ` plus the ${signed(paidOutTotal)} already paid out` : ""} add
                up to this net. The fee is always 8% of gross, rounded to the cent. A refund returns
                the fee too.
              </>
            ) : undefined
          }
        >
          <TableScroll labelledBy="sell-earnings-caption">
            <DataTable
              caption={period ? `Transactions, ${period}` : "Transactions, last 30 days"}
              captionId="sell-earnings-caption"
              columns={COLUMNS}
              rows={rows}
              rowKey={(r) => r.id}
              rowHeader="item"
              rowState={(r) => ROW_STATE[r.status]}
              state={tableState}
              currency={currency}
              totals={[totalsRow]}
            />
          </TableScroll>
        </TableCard>
      </div>
    </div>
  );
}
