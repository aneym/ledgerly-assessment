"use client";

import { type CSSProperties, useMemo, useState } from "react";
import {
  type Column,
  CopyId,
  DashboardShell,
  DataTable,
  Inspector,
  InspectorBlock,
  InspectorLayout,
  InspectorLine,
  InspectorLinks,
  InspectorNote,
  InspectorTimeline,
  InspectorWho,
  Money,
  moneyText,
  PageHeader,
  type RowState,
  type SortState,
  StatusChip,
  TableCard,
  TableScroll,
  type Tone,
} from "@/components/table";

/* ---------- vocabulary ---------- */

type Status = "settling" | "pending" | "settled" | "paid_out" | "held" | "refunded" | "failed";

const STATUS: Record<Status, { label: string; tone: Tone; state?: RowState }> = {
  settling: { label: "Settling", tone: "warn", state: "pending" },
  pending: { label: "Pending", tone: "warn", state: "pending" },
  settled: { label: "Settled", tone: "ok" },
  paid_out: { label: "Paid out", tone: "ok" },
  held: { label: "Held, dispute", tone: "bad", state: "held" },
  refunded: { label: "Refunded", tone: "plain", state: "refunded" },
  failed: { label: "Failed", tone: "bad", state: "failed" },
};

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

function dayOf(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  }).format(new Date(iso));
}
function timeOf(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(iso));
}

function Mark({ text, color, size }: { text: string; color: string; size?: "md" }) {
  return (
    <span
      className={size === "md" ? "tbl-mark md" : "tbl-mark"}
      style={{ "--m": color } as CSSProperties}
      aria-hidden="true"
    >
      {text}
    </span>
  );
}

/* ---------- seller earnings fixture ---------- */

type Earning = {
  id: string;
  date: string;
  item: string;
  buyer: string;
  status: Status;
  gross: number;
  fee: number;
  net: number;
};

const EARNINGS: Earning[] = [
  {
    id: "ord_7f3a9c",
    date: "2026-09-08",
    item: "Onda Drum Library",
    buyer: "Lisbon",
    status: "settling",
    gross: 6000,
    fee: 480,
    net: 5520,
  },
  {
    id: "ord_7e91b2",
    date: "2026-09-07",
    item: "Streetlight Sessions",
    buyer: "Osaka",
    status: "settled",
    gross: 1200,
    fee: 96,
    net: 1104,
  },
  {
    id: "ord_7d40e8",
    date: "2026-09-06",
    item: "Onda Drum Library",
    buyer: "Berlin",
    status: "settled",
    gross: 6000,
    fee: 480,
    net: 5520,
  },
  {
    id: "ord_7c2f14",
    date: "2026-09-05",
    item: "Streetlight Sessions",
    buyer: "Austin",
    status: "held",
    gross: 1200,
    fee: 96,
    net: 1104,
  },
  {
    id: "rfd_1b6c02",
    date: "2026-09-03",
    item: "Onda Drum Library",
    buyer: "Refund of ord_7a88d0",
    status: "refunded",
    gross: -6000,
    fee: -480,
    net: -5520,
  },
  {
    id: "ord_7b1e77",
    date: "2026-09-02",
    item: "Streetlight Sessions",
    buyer: "Toronto",
    status: "paid_out",
    gross: 1200,
    fee: 96,
    net: 1104,
  },
  {
    id: "ord_7a88d0",
    date: "2026-09-01",
    item: "Onda Drum Library",
    buyer: "Seoul",
    status: "settled",
    gross: 6000,
    fee: 480,
    net: 5520,
  },
];

const EARNING_COLUMNS: Column<Earning>[] = [
  { key: "date", header: "Date", kind: "date", width: 80, render: (r) => dayOf(r.date) },
  { key: "item", header: "Item", kind: "text", render: (r) => r.item },
  { key: "order", header: "Order", kind: "id", width: 112, priority: 3, render: (r) => r.id },
  {
    key: "status",
    header: "Status",
    kind: "status",
    width: 120,
    priority: 2,
    render: (r) => (
      <StatusChip tone={STATUS[r.status].tone} size="table">
        {STATUS[r.status].label}
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
    render: (r) => <Money value={usd(r.gross)} />,
  },
  {
    key: "fee",
    header: "Fee 8%",
    kind: "money",
    width: 80,
    priority: 2,
    money: "fee",
    render: (r) => <Money value={usd(r.fee)} />,
  },
  {
    key: "net",
    header: "Net",
    kind: "money",
    width: 104,
    money: "net",
    render: (r) => <Money value={usd(r.net)} />,
  },
];

/* ---------- operator ledger fixture ---------- */

type Biz = { id: string; name: string; mark: string; color: string; city: string; policy: string };
const BIZ: Record<string, Biz> = {
  os: {
    id: "sel_onda",
    name: "Onda Sounds",
    mark: "OS",
    color: "#e6e3dc",
    city: "São Paulo, BR",
    policy: "Platform only",
  },
  sk: {
    id: "sel_kontur",
    name: "Studio Kontur",
    mark: "SK",
    color: "#e3ebe3",
    city: "Berlin, DE",
    policy: "Direct",
  },
  pf: {
    id: "sel_pixelfern",
    name: "Pixelfern",
    mark: "PF",
    color: "#f1ecea",
    city: "Seoul, KR",
    policy: "Direct",
  },
  mo: {
    id: "sel_mara",
    name: "Mara Okonkwo",
    mark: "MO",
    color: "#f2e7d1",
    city: "Austin, US",
    policy: "Direct",
  },
};

type EntryType = "Payment" | "Fee" | "Transfer" | "Refund" | "Payout";
type Entry = {
  id: string;
  at: string;
  biz: Biz;
  type: EntryType;
  ref: string;
  status: Status;
  gross: number | null;
  fee: number | null;
  net: number | null;
  item: string;
};

function entry(
  id: string,
  at: string,
  biz: keyof typeof BIZ,
  type: EntryType,
  ref: string,
  status: Status,
  gross: number | null,
  fee: number | null,
  net: number | null,
  item: string,
): Entry {
  return { id, at, biz: BIZ[biz], type, ref, status, gross, fee, net, item };
}

const LEDGER: Entry[] = [
  entry(
    "led_be847",
    "2026-09-08T14:02:00Z",
    "os",
    "Payment",
    "ord_7f3a9c",
    "pending",
    6000,
    480,
    5520,
    "Onda Drum Library",
  ),
  entry(
    "led_be846",
    "2026-09-08T14:02:00Z",
    "os",
    "Fee",
    "ord_7f3a9c",
    "pending",
    null,
    480,
    null,
    "Onda Drum Library",
  ),
  entry(
    "led_be845",
    "2026-09-08T14:02:00Z",
    "os",
    "Transfer",
    "ord_7f3a9c",
    "pending",
    null,
    null,
    5520,
    "Onda Drum Library",
  ),
  entry(
    "led_be841",
    "2026-09-07T09:15:00Z",
    "os",
    "Payment",
    "ord_7e91b2",
    "settled",
    1200,
    96,
    1104,
    "Streetlight Sessions",
  ),
  entry(
    "led_be840",
    "2026-09-07T09:15:00Z",
    "os",
    "Fee",
    "ord_7e91b2",
    "settled",
    null,
    96,
    null,
    "Streetlight Sessions",
  ),
  entry(
    "led_be83e",
    "2026-09-07T09:15:00Z",
    "os",
    "Transfer",
    "ord_7e91b2",
    "settled",
    null,
    null,
    1104,
    "Streetlight Sessions",
  ),
  entry(
    "led_be838",
    "2026-09-06T19:02:00Z",
    "os",
    "Payment",
    "ord_7d40e8",
    "settled",
    6000,
    480,
    5520,
    "Onda Drum Library",
  ),
  entry(
    "led_be837",
    "2026-09-06T19:02:00Z",
    "os",
    "Fee",
    "ord_7d40e8",
    "settled",
    null,
    480,
    null,
    "Onda Drum Library",
  ),
  entry(
    "led_be836",
    "2026-09-06T19:02:00Z",
    "os",
    "Transfer",
    "ord_7d40e8",
    "settled",
    null,
    null,
    5520,
    "Onda Drum Library",
  ),
  entry(
    "led_be831",
    "2026-09-06T11:48:00Z",
    "sk",
    "Payment",
    "ord_7d1a44",
    "settled",
    2500,
    200,
    2300,
    "Kontur Grid Kit",
  ),
  entry(
    "led_be830",
    "2026-09-06T11:48:00Z",
    "sk",
    "Fee",
    "ord_7d1a44",
    "settled",
    null,
    200,
    null,
    "Kontur Grid Kit",
  ),
  entry(
    "led_be829",
    "2026-09-05T16:30:00Z",
    "os",
    "Payment",
    "ord_7c2f14",
    "held",
    1200,
    96,
    1104,
    "Streetlight Sessions",
  ),
  entry(
    "led_be828",
    "2026-09-05T16:30:00Z",
    "os",
    "Fee",
    "ord_7c2f14",
    "held",
    null,
    96,
    null,
    "Streetlight Sessions",
  ),
  entry(
    "led_be822",
    "2026-09-04T08:12:00Z",
    "pf",
    "Payout",
    "pyt_2Wq7xZ4",
    "settled",
    null,
    null,
    4000,
    "Weekly payout",
  ),
  entry(
    "led_be819",
    "2026-09-03T10:05:00Z",
    "os",
    "Refund",
    "rfd_1b6c02",
    "refunded",
    -6000,
    -480,
    -5520,
    "Onda Drum Library",
  ),
  entry(
    "led_be814",
    "2026-09-02T13:40:00Z",
    "sk",
    "Payment",
    "ord_7b9e10",
    "failed",
    2500,
    200,
    2300,
    "Kontur Grid Kit",
  ),
  entry(
    "led_be811",
    "2026-09-02T09:00:00Z",
    "os",
    "Payment",
    "ord_7b1e77",
    "settled",
    1200,
    96,
    1104,
    "Streetlight Sessions",
  ),
  entry(
    "led_be810",
    "2026-09-02T09:00:00Z",
    "os",
    "Fee",
    "ord_7b1e77",
    "settled",
    null,
    96,
    null,
    "Streetlight Sessions",
  ),
  entry(
    "led_be809",
    "2026-09-02T09:00:00Z",
    "os",
    "Transfer",
    "ord_7b1e77",
    "settled",
    null,
    null,
    1104,
    "Streetlight Sessions",
  ),
  entry(
    "led_be803",
    "2026-09-01T10:40:00Z",
    "os",
    "Payment",
    "ord_7a88d0",
    "settled",
    6000,
    480,
    5520,
    "Onda Drum Library",
  ),
  entry(
    "led_be802",
    "2026-09-01T10:40:00Z",
    "os",
    "Fee",
    "ord_7a88d0",
    "settled",
    null,
    480,
    null,
    "Onda Drum Library",
  ),
  entry(
    "led_be801",
    "2026-09-01T10:40:00Z",
    "os",
    "Transfer",
    "ord_7a88d0",
    "settled",
    null,
    null,
    5520,
    "Onda Drum Library",
  ),
  entry(
    "led_be798",
    "2026-08-31T17:22:00Z",
    "mo",
    "Payment",
    "ord_79f0c3",
    "settled",
    1800,
    144,
    1656,
    "Field Notes, vol. 2",
  ),
  entry(
    "led_be797",
    "2026-08-31T17:22:00Z",
    "mo",
    "Fee",
    "ord_79f0c3",
    "settled",
    null,
    144,
    null,
    "Field Notes, vol. 2",
  ),
];

const money = (v: number | null) => (v === null ? null : <Money value={usd(v)} />);

const LEDGER_COLUMNS: Column<Entry>[] = [
  {
    key: "date",
    header: "Date",
    kind: "date",
    width: 112,
    sortable: true,
    render: (r) => (
      <>
        {dayOf(r.at)} <span className="t">{timeOf(r.at)}</span>
      </>
    ),
    title: (r) => r.at,
  },
  {
    key: "business",
    header: "Business",
    kind: "text",
    render: (r) => (
      <>
        <Mark text={r.biz.mark} color={r.biz.color} />
        <span>{r.biz.name}</span>
      </>
    ),
  },
  { key: "type", header: "Type", kind: "text", width: 76, priority: 3, render: (r) => r.type },
  {
    key: "ref",
    header: "Reference",
    kind: "id",
    width: 120,
    priority: 3,
    render: (r) => <CopyId value={r.ref} />,
  },
  {
    key: "status",
    header: "Status",
    kind: "status",
    width: 120,
    render: (r) => (
      <StatusChip tone={STATUS[r.status].tone} size="table">
        {STATUS[r.status].label}
      </StatusChip>
    ),
  },
  {
    key: "gross",
    header: "Gross",
    kind: "money",
    width: 80,
    priority: 2,
    money: "gross",
    sortable: true,
    render: (r) => money(r.gross),
  },
  {
    key: "fee",
    header: "Fee 8%",
    kind: "money",
    width: 72,
    priority: 2,
    money: "fee",
    render: (r) => money(r.fee),
  },
  {
    key: "net",
    header: "Net",
    kind: "money",
    width: 104,
    money: "net",
    sortable: true,
    render: (r) => money(r.net),
  },
];

const LEDGER_TOTAL = { gross: 19900, fee: 1592, net: 18308 };

/* ---------- operator sellers fixture ---------- */

type Seller = {
  id: string;
  name: string;
  handle: string;
  mark: string;
  color: string;
  country: string;
  policy: string;
  verification: "not_started" | "pending" | "verified";
  whop: string | null;
  status: "active" | "suspended";
};

const SELLERS: Seller[] = [
  {
    id: "sel_mara",
    name: "Mara Okonkwo",
    handle: "@mara",
    mark: "MO",
    color: "#f2e7d1",
    country: "United States",
    policy: "Direct",
    verification: "pending",
    whop: null,
    status: "active",
  },
  {
    id: "sel_kontur",
    name: "Studio Kontur",
    handle: "@kontur",
    mark: "SK",
    color: "#e3ebe3",
    country: "Germany",
    policy: "Direct",
    verification: "pending",
    whop: null,
    status: "active",
  },
  {
    id: "sel_onda",
    name: "Onda Sounds",
    handle: "@onda",
    mark: "OS",
    color: "#e6e3dc",
    country: "Brazil",
    policy: "Platform only",
    verification: "verified",
    whop: "biz_4k2Qm9",
    status: "active",
  },
  {
    id: "sel_form",
    name: "Form Studio",
    handle: "@form",
    mark: "FS",
    color: "#f1ecea",
    country: "Canada",
    policy: "Direct",
    verification: "not_started",
    whop: null,
    status: "active",
  },
  {
    id: "sel_pixelfern",
    name: "Pixelfern",
    handle: "@pixelfern",
    mark: "PF",
    color: "#f1ecea",
    country: "South Korea",
    policy: "Direct",
    verification: "not_started",
    whop: null,
    status: "suspended",
  },
  {
    id: "sel_acme",
    name: "Acme Studio",
    handle: "@acme",
    mark: "AS",
    color: "#e6e3dc",
    country: "Portugal",
    policy: "Platform only",
    verification: "not_started",
    whop: null,
    status: "active",
  },
  {
    id: "sel_juno",
    name: "Juno Hale",
    handle: "@juno",
    mark: "JH",
    color: "#e3ebe3",
    country: "Canada",
    policy: "Direct",
    verification: "not_started",
    whop: null,
    status: "active",
  },
];

const VERIFICATION: Record<Seller["verification"], { label: string; tone: Tone }> = {
  not_started: { label: "Not started", tone: "plain" },
  pending: { label: "Pending", tone: "warn" },
  verified: { label: "Verified", tone: "ok" },
};

const SELLER_COLUMNS: Column<Seller>[] = [
  {
    key: "seller",
    header: "Seller",
    kind: "text",
    render: (r) => (
      <>
        <Mark text={r.mark} color={r.color} />
        <span>{r.name}</span>
      </>
    ),
  },
  { key: "handle", header: "Handle", kind: "id", width: 120, priority: 3, render: (r) => r.handle },
  {
    key: "country",
    header: "Country",
    kind: "text",
    width: 120,
    priority: 2,
    render: (r) => r.country,
  },
  { key: "policy", header: "Sale policy", kind: "text", width: 128, render: (r) => r.policy },
  {
    key: "verification",
    header: "Verification",
    kind: "status",
    width: 128,
    render: (r) => (
      <StatusChip tone={VERIFICATION[r.verification].tone} size="table">
        {VERIFICATION[r.verification].label}
      </StatusChip>
    ),
  },
  {
    key: "whop",
    header: "Whop account",
    kind: "id",
    width: 140,
    priority: 3,
    render: (r) => (r.whop ? <CopyId value={r.whop} /> : <span className="dash">–</span>),
  },
  {
    key: "status",
    header: "Status",
    kind: "status",
    width: 100,
    render: (r) => (
      <StatusChip tone={r.status === "active" ? "ok" : "bad"} size="table">
        {r.status === "active" ? "Active" : "Suspended"}
      </StatusChip>
    ),
  },
];

/* ---------- the page ---------- */

const EARNINGS_INSPECTOR = "earnings-inspector";
const LEDGER_INSPECTOR = "entry-inspector";

export function TablePreview() {
  const [earningId, setEarningId] = useState<string | null>(null);
  const [entryId, setEntryId] = useState<string | null>("led_be83e");
  const [sort, setSort] = useState<SortState>({ key: "date", dir: "desc" });

  const earning = EARNINGS.find((r) => r.id === earningId) ?? null;
  const current = LEDGER.find((r) => r.id === entryId) ?? null;

  const sortedLedger = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const rows = [...LEDGER];
    rows.sort((a, b) => {
      if (sort.key === "date") return a.at.localeCompare(b.at) * dir;
      const av = (sort.key === "gross" ? a.gross : a.net) ?? Number.NEGATIVE_INFINITY;
      const bv = (sort.key === "gross" ? b.gross : b.net) ?? Number.NEGATIVE_INFINITY;
      return (av - bv) * dir;
    });
    return rows;
  }, [sort]);

  function onSort(key: string) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" },
    );
  }

  return (
    <DashboardShell>
      <PageHeader
        title="Table preview"
        lede="Every state of the shared table system with fixture rows: seller earnings at ledger density, the operator ledger at compact density with a bounded region and an inspector, a table without row buttons, then loading, empty, error and the row states."
        aside={<span>Fixture rows, nothing live</span>}
      />

      {/* 1. Seller earnings: ledger density, 7 rows, document scroll, pane on open. */}
      <InspectorLayout
        inspector={
          earning && (
            <Inspector
              id={EARNINGS_INSPECTOR}
              open
              onClose={() => setEarningId(null)}
              label="Transaction"
              idValue={earning.id}
              title={earning.item}
              amount={{ text: moneyText(usd(Math.abs(earning.net))), negative: earning.net < 0 }}
              status={
                <>
                  <StatusChip tone={STATUS[earning.status].tone}>
                    {STATUS[earning.status].label}
                  </StatusChip>
                  <span>
                    {earning.status === "refunded" ? earning.buyer : `Buyer in ${earning.buyer}`}
                  </span>
                </>
              }
              media={
                <>
                  <div
                    aria-hidden="true"
                    style={{
                      width: 64,
                      height: 80,
                      borderRadius: 6,
                      flex: "none",
                      background:
                        "#0a0908 radial-gradient(circle at 50% 36%, #f3a63a, #c25e1c 30%, transparent 65%)",
                      boxShadow: "inset 0 0 0 1px rgba(0,0,0,.08)",
                    }}
                  />
                  <div>
                    <b style={{ display: "block", fontWeight: 500, fontSize: 14 }}>
                      {earning.item}
                    </b>
                    <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
                      Digital download, one seat
                    </span>
                  </div>
                </>
              }
            >
              <InspectorBlock title="Order">
                <InspectorLine k="Order" v={<CopyId value={earning.id} />} />
                <InspectorLine k="Date" v={dayOf(earning.date)} />
                <InspectorLine
                  k="Buyer"
                  v={earning.status === "refunded" ? earning.buyer : `Buyer in ${earning.buyer}`}
                />
              </InspectorBlock>
              <InspectorBlock title="Money">
                <InspectorLine k="Gross" v={<Money value={usd(earning.gross)} />} num />
                <InspectorLine k="Fee 8%" v={<Money value={usd(earning.fee)} />} num />
                <InspectorLine k="Net" v={<Money value={usd(earning.net)} />} num />
              </InspectorBlock>
              <InspectorBlock title="Timeline, UTC">
                <InspectorTimeline
                  items={[
                    { label: "Paid", when: `${dayOf(earning.date)} 10:40` },
                    {
                      label: "Settled",
                      when: `${dayOf(earning.date)} 10:41`,
                      open: earning.status === "settling",
                    },
                  ]}
                />
              </InspectorBlock>
              <InspectorLinks>
                <a className="pill ghost sm" href="#earnings">
                  Open receipt
                </a>
              </InspectorLinks>
            </Inspector>
          )
        }
      >
        <div id="earnings">
          <TableCard
            id="earnings-title"
            title="Transactions"
            count="7 rows"
            period="Sep 01 to Sep 08, 2026 · USD"
            foot={{ left: "7 rows, last 30 days", right: "Viewing 1 to 7 of 7" }}
            note="Available, pending and held above plus the $11.04 already paid out add up to this net. The fee is always 8% of gross, rounded to the cent. A refund returns the fee too."
          >
            <TableScroll labelledBy="earnings-caption">
              <DataTable
                caption="Transactions, Sep 01 to Sep 08, 2026"
                captionId="earnings-caption"
                columns={EARNING_COLUMNS}
                rows={EARNINGS}
                rowKey={(r) => r.id}
                rowHeader="item"
                rowName={(r) =>
                  `${r.item}, ${STATUS[r.status].label.toLowerCase()}, ${moneyText(usd(r.net))}`
                }
                rowState={(r) => STATUS[r.status].state}
                state={{ kind: "rows" }}
                selectedKey={earningId}
                onRowOpen={(r) => setEarningId((id) => (id === r.id ? null : r.id))}
                inspectorId={earning ? EARNINGS_INSPECTOR : undefined}
                currency="USD"
                totals={[
                  {
                    label: "Total",
                    period: "Sep 01 to Sep 08",
                    values: {
                      gross: <Money value={usd(15600)} />,
                      fee: <Money value={usd(1248)} />,
                      net: <Money value={usd(14352)} />,
                    },
                  },
                ]}
              />
            </TableScroll>
          </TableCard>
        </div>
      </InspectorLayout>

      {/* 2. Operator ledger: compact, 24 rows, sortable, bounded region, inspector open. */}
      <a className="pill ghost sm tbl-skip" href="#after-ledger">
        Skip to after the ledger
      </a>
      <InspectorLayout
        inspector={
          current && (
            <Inspector
              id={LEDGER_INSPECTOR}
              open
              onClose={() => setEntryId(null)}
              label="Ledger entry"
              idValue={current.id}
              title={current.type}
              amount={{
                text: moneyText(usd(Math.abs(current.net ?? current.fee ?? current.gross ?? 0))),
                negative: (current.net ?? current.fee ?? current.gross ?? 0) < 0,
                struck: current.status === "failed",
              }}
              status={
                <>
                  <StatusChip tone={STATUS[current.status].tone}>
                    {STATUS[current.status].label}
                  </StatusChip>
                  <span>{current.item}</span>
                </>
              }
            >
              <InspectorBlock title="Business">
                <InspectorWho
                  mark={<Mark text={current.biz.mark} color={current.biz.color} size="md" />}
                  name={current.biz.name}
                  sub={current.biz.city}
                />
                <InspectorLine k="Seller id" v={<CopyId value={current.biz.id} />} />
                <InspectorLine k="Whop account" v="not created" quiet />
                <InspectorLine k="Sale policy" v={current.biz.policy} />
              </InspectorBlock>
              <InspectorBlock title="Money">
                <InspectorLine
                  k="Gross"
                  v={
                    current.gross === null ? (
                      "not on this row"
                    ) : (
                      <Money value={usd(current.gross)} />
                    )
                  }
                  quiet={current.gross === null}
                  num={current.gross !== null}
                />
                <InspectorLine
                  k="Fee 8%"
                  v={current.fee === null ? "not on this row" : <Money value={usd(current.fee)} />}
                  quiet={current.fee === null}
                  num={current.fee !== null}
                />
                <InspectorLine
                  k="Net"
                  v={current.net === null ? "not on this row" : <Money value={usd(current.net)} />}
                  quiet={current.net === null}
                  num={current.net !== null}
                />
                <InspectorLine k="Currency" v="USD" />
                <InspectorLine
                  k="Charge model"
                  v={
                    current.biz.policy === "Direct"
                      ? "Direct charge"
                      : "Platform charge and transfer"
                  }
                />
              </InspectorBlock>
              <InspectorBlock title="Provider">
                <InspectorLine k="Resource" v={<CopyId value="tsf_5rT2bM4kJ" />} />
                <InspectorLine k="Order" v={<CopyId value={current.ref} />} />
                <InspectorLine k="Correlation" v={<CopyId value="corr_3d0a57" />} />
              </InspectorBlock>
              <InspectorBlock title="Timeline, UTC">
                <InspectorTimeline
                  items={[
                    { label: "Created", when: `${dayOf(current.at)} ${timeOf(current.at)}` },
                    { label: "Updated", when: `${dayOf(current.at)} ${timeOf(current.at)}` },
                    {
                      label: current.status === "settled" ? "Settled" : "Settles",
                      when:
                        current.status === "settled"
                          ? `${dayOf(current.at)} ${timeOf(current.at)}`
                          : "pending",
                      open: current.status !== "settled",
                    },
                  ]}
                />
              </InspectorBlock>
              <InspectorNote>
                {current.type === "Transfer"
                  ? "Internal balance movement to the seller. Not a payout."
                  : current.type === "Payout"
                    ? "Money leaving to the seller's bank. Not a transfer."
                    : "Recorded from the provider event. Whop's ledger is the balance truth."}
              </InspectorNote>
              <InspectorLinks>
                <a className="pill ghost sm" href="#sellers">
                  Open seller
                </a>
                <a className="pill ghost sm" href="#ledger">
                  Open order
                </a>
              </InspectorLinks>
            </Inspector>
          )
        }
      >
        <div id="ledger">
          <TableCard
            id="ledger-title"
            title="Entries"
            count="24 rows match"
            period="Aug 31 to Sep 08 · USD"
            density="compact"
            chrome={340}
            foot={{ left: "24 rows match, Aug 31 to Sep 08", right: "Viewing 1 to 24 of 24" }}
            note="Payments net of refunds. Failed rows are not counted. Pending rows are counted and will move when they settle."
          >
            <TableScroll bounded={LEDGER.length > 20} labelledBy="ledger-caption">
              <DataTable
                caption="Ledger entries, Aug 31 to Sep 08, 2026. Sortable columns have buttons in their headers."
                captionId="ledger-caption"
                columns={LEDGER_COLUMNS}
                rows={sortedLedger}
                rowKey={(r) => r.id}
                rowHeader="business"
                rowName={(r) =>
                  `${r.biz.name}, ${r.type.toLowerCase()}, ${moneyText(usd(r.net ?? r.fee ?? r.gross ?? 0))}`
                }
                rowState={(r) => STATUS[r.status].state}
                state={{ kind: "rows" }}
                selectedKey={entryId}
                onRowOpen={(r) => setEntryId((id) => (id === r.id ? null : r.id))}
                inspectorId={current ? LEDGER_INSPECTOR : undefined}
                sort={sort}
                onSort={onSort}
                currency="USD"
                totals={[
                  {
                    label: "Total, USD",
                    period: "Payments net of refunds",
                    values: {
                      gross: <Money value={usd(LEDGER_TOTAL.gross)} />,
                      fee: <Money value={usd(LEDGER_TOTAL.fee)} />,
                      net: <Money value={usd(LEDGER_TOTAL.net)} />,
                    },
                  },
                ]}
              />
            </TableScroll>
          </TableCard>
        </div>
      </InspectorLayout>
      <div id="after-ledger" />

      {/* 3. Operator sellers: compact, no row buttons, pagination pills. */}
      <div id="sellers">
        <TableCard
          id="sellers-title"
          title="Sellers"
          count="7 sellers"
          density="compact"
          foot={{
            left: "7 sellers",
            right: (
              <>
                Viewing 1 to 7 of 7
                <span className="pages">
                  <button type="button" className="pill ghost sm" disabled>
                    Previous
                  </button>
                  <button type="button" className="pill ghost sm" disabled>
                    Next
                  </button>
                </span>
              </>
            ),
          }}
          note="Rows without a row button: no hover, no pressed state. Handle and Whop account fold under an 800px card, Country under 560."
        >
          <TableScroll labelledBy="sellers-caption">
            <DataTable
              caption="Sellers, all seven"
              captionId="sellers-caption"
              columns={SELLER_COLUMNS}
              rows={SELLERS}
              rowKey={(r) => r.id}
              rowHeader="seller"
              state={{ kind: "rows" }}
            />
          </TableScroll>
        </TableCard>
      </div>

      {/* 4. States: loading, empty, error. Same head, one row of a different kind, no totals. */}
      <div id="states" className="tbl-shell">
        <TableCard
          id="loading-title"
          title="Entries"
          count="Reading"
          period="Aug 31 to Sep 08 · USD"
          density="compact"
          foot={{ left: "Reading the ledger", right: "GET /api/admin/ledger" }}
        >
          <TableScroll labelledBy="loading-caption">
            <DataTable
              caption="Ledger entries, loading"
              captionId="loading-caption"
              columns={LEDGER_COLUMNS}
              rows={[]}
              rowKey={(r) => r.id}
              rowHeader="business"
              state={{ kind: "loading" }}
              currency="USD"
            />
          </TableScroll>
        </TableCard>

        <TableCard
          id="empty-title"
          title="Entries"
          count="0 rows match"
          period="Aug 31 to Sep 08 · EUR"
          density="compact"
          foot={{ left: "0 rows", right: "Viewing 0 of 0" }}
        >
          <TableScroll labelledBy="empty-caption">
            <DataTable
              caption="Ledger entries, no rows match"
              captionId="empty-caption"
              columns={LEDGER_COLUMNS}
              rows={[]}
              rowKey={(r) => r.id}
              rowHeader="business"
              state={{
                kind: "empty",
                text: "No settled rows in EUR for Onda Sounds between Aug 31 and Sep 08.",
                action: { label: "Clear filters", onClick: () => {} },
              }}
              currency="EUR"
            />
          </TableScroll>
        </TableCard>

        <TableCard
          id="error-title"
          title="Entries"
          count="Not read"
          period="Aug 31 to Sep 08 · USD"
          density="compact"
          foot={{ left: "Not read", right: "503 from the app API" }}
        >
          <TableScroll labelledBy="error-caption">
            <DataTable
              caption="Ledger entries, could not be read"
              captionId="error-caption"
              columns={LEDGER_COLUMNS}
              rows={[]}
              rowKey={(r) => r.id}
              rowHeader="business"
              state={{
                kind: "error",
                body: (
                  <>
                    <span className="route">
                      GET /api/admin/ledger?status=settled <b>503</b>
                    </span>
                    <span>The ledger could not be read. No rows are shown in place of it.</span>
                  </>
                ),
              }}
              currency="USD"
            />
          </TableScroll>
        </TableCard>
      </div>

      {/* 5. Row states specimen: rest, selected, then the four money states. */}
      <div id="rows">
        <TableCard
          id="rows-title"
          title="Row states"
          count="specimen"
          period="compact"
          density="compact"
          note="Rest, selected, then pending, held, refunded and failed. Ink only; hover and focus are live on the tables above."
        >
          <TableScroll labelledBy="rows-caption">
            <DataTable
              caption="Row state specimen"
              captionId="rows-caption"
              columns={LEDGER_COLUMNS}
              rows={[LEDGER[3], LEDGER[5], LEDGER[0], LEDGER[11], LEDGER[14], LEDGER[15]]}
              rowKey={(r) => r.id}
              rowHeader="business"
              rowState={(r) => STATUS[r.status].state}
              state={{ kind: "rows" }}
              selectedKey="led_be83e"
              currency="USD"
            />
          </TableScroll>
        </TableCard>
      </div>
    </DashboardShell>
  );
}
