"use client";

import { fromDecimalString, type Money } from "@ledgerly/core/money";
import { useEffect, useRef, useState } from "react";
import { ProvenanceBadge } from "@/components/provenance-badge";
import { formatMoney } from "@/lib/catalog/money";
import {
  type ApiFail,
  type ApiPayoutRow,
  type ApiPayouts,
  type ApiSeller,
  sellerApi,
} from "@/lib/seller/api";
import { provenanceOf } from "@/lib/seller/ledger";
import { nextPollDelay } from "@/lib/seller/poll";
import { NotLive, Reading } from "./ApiState";
import { SectionTitle } from "./PageHead";
import { PayoutsEmbed } from "./PayoutsEmbed";
import { PayoutsSimulation } from "./PayoutsSimulation";
import { StatusChip } from "./StatusChip";

type Read<T> = { kind: "reading" } | { kind: "ok"; data: T } | { kind: "failed"; fail: ApiFail };

type PayoutRow = { id: string; date: string; amount: Money | null; status: string; rail: string };

function payoutCapability(seller: ApiSeller): "active" | "inactive" | "pending" | "unknown" {
  const caps = seller.capabilities ?? {};
  const raw = caps.payouts ?? caps.standard_payout ?? caps.payout;
  if (raw === undefined || raw === null) return "unknown";
  if (typeof raw === "boolean") return raw ? "active" : "inactive";
  const status =
    typeof raw === "string" ? raw : (raw.status ?? (raw.active ? "active" : "inactive"));
  const s = status.toLowerCase();
  if (s === "active") return "active";
  if (s === "pending" || s === "requested" || s === "in_review") return "pending";
  return "inactive";
}

function toAmount(value: ApiPayoutRow["amount"]): Money | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return { amountMinor: value, currency: "USD" };
  if (typeof value === "string") {
    const parsed = fromDecimalString(value, "USD");
    return parsed.ok ? parsed.value : null;
  }
  const currency = (value.currency as Money["currency"] | undefined) ?? "USD";
  const minor = value.amountMinor ?? value.amount_minor;
  if (typeof minor === "number") return { amountMinor: minor, currency };
  if (typeof value.amount === "string") {
    const parsed = fromDecimalString(value.amount, currency);
    return parsed.ok ? parsed.value : null;
  }
  return null;
}

function toRows(data: ApiPayouts): PayoutRow[] {
  const list = data.history ?? data.payouts ?? [];
  return list.map((row, index) => ({
    id: row.id ?? `payout_${index}`,
    date: row.date ?? row.at ?? "",
    amount: toAmount(row.amount),
    status: row.status ?? "unknown",
    rail: row.rail ?? row.method ?? "",
  }));
}

function statusTone(status: string): "ok" | "warn" | "bad" | "plain" {
  const s = status.toLowerCase();
  if (s === "paid_out" || s === "paid" || s === "completed" || s === "arrived") return "ok";
  if (["requested", "pending", "in_review", "in_transit", "processing"].includes(s)) return "warn";
  if (["failed", "canceled", "cancelled", "returned", "denied", "reversed"].includes(s))
    return "bad";
  return "plain";
}

export function PayoutsPanel({
  sellerId,
  correlationId,
  simulationEnabled = false,
}: {
  sellerId: string;
  correlationId: string | null;
  simulationEnabled?: boolean;
}) {
  const [account, setAccount] = useState<Read<ApiSeller>>({ kind: "reading" });
  const [payouts, setPayouts] = useState<Read<ApiPayouts>>({ kind: "reading" });
  const accountPath = `/api/sellers/${encodeURIComponent(sellerId)}`;
  const payoutsPath = `${accountPath}/payouts`;

  // The seller read repeats with backoff (2 s, 4 s, 8 s, 16 s, 30 s) only while the payouts
  // capability is pending and the last answer was 2xx; any failure stops it. The payouts
  // list is read once. `gen` drops results and timers from a superseded cycle.
  const gen = useRef(0);
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const mine = ++gen.current;
    attempt.current = 0;
    const clearTimer = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    const readSeller = async () => {
      const result = await sellerApi.read(sellerId, correlationId);
      if (mine !== gen.current) return;
      if (!result.ok) {
        setAccount({ kind: "failed", fail: result });
        return;
      }
      setAccount({ kind: "ok", data: result.data });
      if (payoutCapability(result.data) !== "pending") return;
      const delay = nextPollDelay(attempt.current);
      attempt.current += 1;
      timer.current = setTimeout(() => void readSeller(), delay);
    };
    void readSeller();
    void sellerApi.payouts(sellerId, correlationId).then((result) => {
      if (mine !== gen.current) return;
      setPayouts(result.ok ? { kind: "ok", data: result.data } : { kind: "failed", fail: result });
    });
    return () => {
      gen.current += 1;
      clearTimer();
    };
  }, [sellerId, correlationId]);

  const seller = account.kind === "ok" ? account.data : null;
  const capability = seller ? payoutCapability(seller) : "unknown";
  const payoutData = payouts.kind === "ok" ? payouts.data : null;
  const rows = payoutData ? toRows(payoutData) : [];
  // Set from the responses, never assumed: no provenance field in either, no badge.
  const provenance = provenanceOf(
    payoutData?.provenance ?? payoutData?.source ?? seller?.provenance ?? seller?.source,
  );

  return (
    <div className="flex flex-col gap-8">
      <section className="sl-paper raised p-6 md:p-8" aria-labelledby="payouts-mount-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2
              id="payouts-mount-title"
              className="font-serif text-[22px] leading-[1.2] font-medium text-ink"
              style={{ fontVariationSettings: "'opsz' 24" }}
            >
              Withdraw to your bank
            </h2>
            <p className="mt-1 max-w-[56ch] text-[13.5px] leading-relaxed text-ink-2">
              Whop handles withdrawals and bank details.
            </p>
          </div>
          {provenance ? <ProvenanceBadge provenance={provenance} /> : null}
        </div>

        <div className="mt-6 flex flex-col gap-4">
          {account.kind === "reading" ? <Reading method="GET" path={accountPath} /> : null}
          {account.kind === "failed" ? <NotLive fail={account.fail} /> : null}
          {capability === "inactive" ? (
            <div className="rounded-in bg-[var(--warn-soft)] px-4 py-3 text-[13px] leading-relaxed text-warn">
              Payouts are not active on this account yet.
            </div>
          ) : null}
          {capability === "active" ? (
            <div className="rounded-in bg-[var(--ok-soft)] px-4 py-3 text-[13px] leading-relaxed text-ok">
              Payouts are active on this account.
            </div>
          ) : null}
          {capability === "pending" ? (
            <div className="rounded-in bg-plate/60 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
              Payouts are pending on Whop. This page checks again until that changes.
            </div>
          ) : null}

          <PayoutsEmbed key={sellerId} sellerId={sellerId} />
        </div>
      </section>

      {simulationEnabled && <PayoutsSimulation key={sellerId} sellerId={sellerId} />}

      <section className="flex flex-col gap-4" aria-labelledby="payout-history-title">
        <SectionTitle>
          <span id="payout-history-title">Payout history</span>
        </SectionTitle>
        {payouts.kind === "reading" ? (
          <Reading method="GET" path={payoutsPath} label="Reading your payouts" />
        ) : null}
        {payouts.kind === "failed" ? <NotLive fail={payouts.fail} /> : null}
        <div className="sl-tx-wrap" data-tour="sell.payouts.history">
          {payouts.kind !== "ok" ? null : rows.length === 0 ? (
            <div className="rounded-in border border-dashed border-line-strong px-6 py-10 text-center text-[13.5px] text-muted">
              No payouts yet. The first one appears here after you withdraw an available balance.
            </div>
          ) : (
            <table className="sl-tx">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Payout</th>
                  <th scope="col">Rail</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    AMOUNT
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-tour-item={row.id}>
                    <td className="whitespace-nowrap text-[13px] text-muted">{row.date}</td>
                    <td className="font-mono text-[12px] text-muted">{row.id}</td>
                    <td className="text-[13px] text-ink-2">{row.rail || "Bank"}</td>
                    <td>
                      <StatusChip tone={statusTone(row.status)}>{row.status}</StatusChip>
                    </td>
                    <td className="num">{row.amount ? formatMoney(row.amount) : "Unavailable"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
