"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PillButton } from "@/components/pill";
import { ProvenanceBadge } from "@/components/provenance-badge";
import {
  type ApiFail,
  type ApiSeller,
  type Capability,
  onboardingUrlOf,
  sellerApi,
} from "@/lib/seller/api";
import { provenanceOf } from "@/lib/seller/ledger";
import { nextPollDelay } from "@/lib/seller/poll";
import { NotLive, Reading } from "./ApiState";
import { Dot, StatusChip } from "./StatusChip";

type ReadState =
  | { kind: "reading" }
  | { kind: "ok"; seller: ApiSeller; at: Date }
  | { kind: "failed"; fail: ApiFail };

type LinkState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "opened"; url: string }
  | { kind: "failed"; fail: ApiFail };

type CapTone = "ok" | "warn" | "bad";
type CapRow = {
  key: "payments" | "transfers" | "payouts";
  label: string;
  tone: CapTone;
  text: string;
};

const CAP_KEYS: Record<CapRow["key"], string[]> = {
  payments: ["payments", "accept_card_payments", "card_payments", "charges"],
  transfers: ["transfers", "transfer"],
  payouts: ["payouts", "standard_payout", "payout"],
};

function capabilityText(value: Capability | undefined): { tone: CapTone; text: string } {
  if (value === undefined || value === null) return { tone: "warn", text: "Not reported" };
  if (typeof value === "boolean")
    return value ? { tone: "ok", text: "Active" } : { tone: "bad", text: "Inactive" };
  const status =
    typeof value === "string" ? value : (value.status ?? (value.active ? "active" : "inactive"));
  const s = status.toLowerCase();
  if (s === "active" || s === "enabled") return { tone: "ok", text: "Active" };
  if (s === "pending" || s === "requested" || s === "in_review")
    return { tone: "warn", text: s === "in_review" ? "In review" : "Pending" };
  return { tone: "bad", text: s === "inactive" ? "Inactive" : status };
}

function capabilityRows(seller: ApiSeller): CapRow[] {
  const caps = seller.capabilities ?? {};
  const lookup = (keys: string[]) => keys.map((k) => caps[k]).find((v) => v !== undefined);
  return [
    { key: "payments", label: "Payments", ...capabilityText(lookup(CAP_KEYS.payments)) },
    { key: "transfers", label: "Transfers", ...capabilityText(lookup(CAP_KEYS.transfers)) },
    { key: "payouts", label: "Payouts", ...capabilityText(lookup(CAP_KEYS.payouts)) },
  ];
}

/**
 * Identity verification as the API states it. The seller row's own `status` (active or
 * suspended) is a different flag and never stands in for it: a route that carries no
 * verification field reports as not reported, not as verified.
 */
function verificationOf(seller: ApiSeller): {
  label: string;
  tone: "ok" | "warn" | "bad" | "plain";
} {
  const raw = seller.verification;
  const value = typeof raw === "string" ? raw : (raw?.status ?? raw?.state ?? null);
  if (value === null) return { label: "Not reported by the API", tone: "plain" };
  const s = value.toLowerCase();
  if (s === "verified" || s === "complete" || s === "completed" || s === "active")
    return { label: "Verified", tone: "ok" };
  if (s === "pending" || s === "in_review" || s === "submitted")
    return { label: "In review", tone: "warn" };
  if (s === "rejected" || s === "blocked" || s === "suspended")
    return { label: value, tone: "bad" };
  if (s === "unknown" || s === "not_started") return { label: "Not started", tone: "plain" };
  return { label: value.replace(/_/g, " "), tone: "plain" };
}

/** Null when the API carries no seller status; the row is then left out rather than filled in. */
function sellerStatusOf(seller: ApiSeller): { label: string; tone: "ok" | "bad" | "plain" } | null {
  const s = (seller.status ?? "").toLowerCase();
  if (!s) return null;
  if (s === "active") return { label: "Active", tone: "ok" };
  if (s === "suspended") return { label: "Suspended", tone: "bad" };
  return { label: s.replace(/_/g, " "), tone: "plain" };
}

/** Null when the API carries no sale policy; the row is then left out rather than filled in. */
function policyLabel(seller: ApiSeller): string | null {
  const policy = seller.salePolicy ?? seller.sale_policy;
  if (!policy) return null;
  if (policy === "direct" || policy === "direct_charge") return "Direct charge";
  if (policy === "platform_only" || policy === "platform_charge_transfer")
    return "Platform charge, then transfer";
  return policy.replace(/_/g, " ");
}

function requiredActions(
  seller: ApiSeller,
): Array<{ code: string; text: string; deadline?: string }> {
  const list = seller.required_actions ?? seller.requiredActions ?? [];
  return list.map((item) => {
    if (typeof item === "string") return { code: item, text: item.replace(/[._]/g, " ") };
    const code = item.code ?? "action";
    const entry: { code: string; text: string; deadline?: string } = {
      code,
      text: item.description ?? code.replace(/[._]/g, " "),
    };
    if (item.deadline) entry.deadline = item.deadline;
    return entry;
  });
}

/** Still waiting on Whop: verification pending, or any capability the API reports as pending. */
export function isPending(seller: ApiSeller): boolean {
  const raw = seller.verification;
  const verification = (typeof raw === "string" ? raw : (raw?.status ?? raw?.state ?? "")) ?? "";
  if (verification.toLowerCase() === "pending") return true;
  const caps = seller.capabilities ?? {};
  return Object.values(caps).some((value) => {
    const status =
      typeof value === "string"
        ? value
        : typeof value === "boolean"
          ? ""
          : (value?.status ?? (value?.requested ? "requested" : ""));
    const s = status.toLowerCase();
    return s === "pending" || s === "requested" || s === "in_review";
  });
}

function timeLabel(at: Date): string {
  return at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function OnboardingStatus({
  sellerId,
  correlationId,
  arrival = null,
  guided = false,
}: {
  sellerId: string;
  guided?: boolean;
  correlationId: string | null;
  /** Why the page loaded: back from Whop hosted onboarding, or Whop asked for a fresh link. */
  arrival?: "returned" | "refresh" | null;
}) {
  const [journeyActive, setJourneyActive] = useState(false);
  useEffect(() => {
    try {
      setJourneyActive(Boolean(sessionStorage.getItem("ledgerly.demo.journey")));
    } catch {
      /* unavailable storage */
    }
  }, []);
  const guidedLink = guided || journeyActive;
  const [read, setRead] = useState<ReadState>({ kind: "reading" });
  const [link, setLink] = useState<LinkState>({ kind: "idle" });
  const [nextIn, setNextIn] = useState<number | null>(null);
  const path = `/api/sellers/${encodeURIComponent(sellerId)}`;

  // Polling: one read on mount, then while the readback is still pending and the last
  // answer was 2xx, another read after 2 s, 4 s, 8 s, 16 s, 30 s. A failed read (404, 401,
  // 403, network) stops the cycle; only Refresh or a fresh page load starts it again.
  // `gen` invalidates in-flight reads and timers from a previous cycle or a strict-mode
  // double mount, so at most one timer is ever armed.
  const gen = useRef(0);
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const refresh = useCallback(
    async (mode: "manual" | "poll" = "manual") => {
      clearTimer();
      const mine = ++gen.current;
      if (mode === "manual") {
        attempt.current = 0;
        setRead({ kind: "reading" });
        setNextIn(null);
      }
      const result = await sellerApi.read(sellerId, correlationId);
      if (mine !== gen.current) return;
      if (!result.ok) {
        setRead({ kind: "failed", fail: result });
        setNextIn(null);
        return;
      }
      setRead({ kind: "ok", seller: result.data, at: new Date() });
      if (!isPending(result.data)) {
        setNextIn(null);
        return;
      }
      const delay = nextPollDelay(attempt.current);
      attempt.current += 1;
      setNextIn(delay);
      timer.current = setTimeout(() => void refresh("poll"), delay);
    },
    [sellerId, correlationId, clearTimer],
  );

  useEffect(() => {
    void refresh("manual");
    return () => {
      gen.current += 1;
      clearTimer();
    };
  }, [refresh, clearTimer]);

  async function openOnboarding() {
    if (link.kind === "requesting") return;
    setLink({ kind: "requesting" });
    // Open the tab on the click so the browser does not block it after the await.
    const tab = guidedLink ? null : window.open("about:blank", "_blank");
    const result = await sellerApi.onboardingLink(sellerId, correlationId);
    if (!result.ok) {
      tab?.close();
      setLink({ kind: "failed", fail: result });
      return;
    }
    const url = onboardingUrlOf(result.data);
    if (!url) {
      tab?.close();
      setLink({
        kind: "failed",
        fail: {
          ok: false,
          kind: "unexpected",
          status: result.status,
          path: `${path}/onboarding-link`,
          method: "POST",
          correlationId: result.correlationId,
          reason: "unexpected response: no url",
        },
      });
      return;
    }
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else if (!guidedLink) {
      window.open(url, "_blank", "noopener");
    }
    setLink({ kind: "opened", url });
  }

  const seller = read.kind === "ok" ? read.seller : null;
  // The badge is set from the response, never assumed: no provenance field, no badge.
  const provenance = seller ? provenanceOf(seller.provenance ?? seller.source) : null;
  const verification = seller ? verificationOf(seller) : null;
  const sellerStatus = seller ? sellerStatusOf(seller) : null;
  const policy = seller ? policyLabel(seller) : null;
  const actions = seller ? requiredActions(seller) : [];
  const readback =
    seller?.accountId !== undefined
      ? seller.accountId
        ? "Whop account confirmed."
        : seller.accountError
          ? `Whop account readback failed: ${seller.accountError}.`
          : "No Whop account to read back yet."
      : null;

  return (
    <div className="flex flex-col gap-6">
      <section
        className="sl-paper raised p-6 md:p-8"
        data-tour="sell.onboarding.status"
        aria-labelledby="onboarding-status-title"
        aria-busy={read.kind === "reading" ? "true" : undefined}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2
              id="onboarding-status-title"
              className="font-serif text-[22px] leading-[1.2] font-medium text-ink"
              style={{ fontVariationSettings: "'opsz' 24" }}
            >
              Whop account status
            </h2>
            {seller && (seller.email || seller.country) ? (
              <p className="mt-1 text-[12.5px] text-muted">
                {[seller.email, seller.country].filter(Boolean).join(", ")}
              </p>
            ) : null}
          </div>
          {provenance ? <ProvenanceBadge provenance={provenance} /> : null}
        </div>

        {arrival ? (
          <p className="mt-4 rounded-in bg-plate/60 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
            {arrival === "returned"
              ? "Back from Whop onboarding. The status below is current."
              : "The Whop onboarding link expired. Request a new link to continue."}
          </p>
        ) : null}

        <div className="mt-6">
          {read.kind === "reading" ? (
            <Reading method="GET" path={path} label="Checking Whop account status" />
          ) : null}
          {read.kind === "failed" ? (
            <NotLive fail={read.fail}>Create a seller on the start page first, or retry.</NotLive>
          ) : null}
          {seller && verification ? (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col border-y border-line">
                <div className="flex items-center justify-between gap-4 py-3">
                  <span className="text-[13px] text-muted">Identity verification</span>
                  <StatusChip tone={verification.tone}>{verification.label}</StatusChip>
                </div>
                {sellerStatus ? (
                  <div className="flex items-center justify-between gap-4 border-t border-line py-3">
                    <span className="text-[13px] text-muted">Seller status</span>
                    <StatusChip tone={sellerStatus.tone}>{sellerStatus.label}</StatusChip>
                  </div>
                ) : null}
                {policy ? (
                  <div className="flex items-center justify-between gap-4 border-t border-line py-3">
                    <span className="text-[13px] text-muted">Sale policy</span>
                    <span className="text-[13px] text-ink-2">{policy}</span>
                  </div>
                ) : null}
              </div>
              {readback ? <p className="text-[13px] text-ink-2">{readback}</p> : null}

              <ul className="flex flex-col" aria-label="Capabilities">
                {capabilityRows(seller).map((row) => (
                  <li
                    key={row.key}
                    className="flex items-center gap-3 border-b border-line py-3 text-[14px] first:border-t"
                  >
                    <Dot tone={row.tone} />
                    <span className="font-medium text-ink">{row.label}</span>
                    <span className="ml-auto text-[13px] text-ink-2">{row.text}</span>
                  </li>
                ))}
              </ul>

              <div data-tour="sell.onboarding.required-actions">
                <h3 className="text-[13px] font-medium text-ink">Required actions</h3>
                {actions.length === 0 ? (
                  <p className="mt-1 text-[13.5px] text-muted">
                    {seller.required_actions || seller.requiredActions
                      ? "Whop reports nothing outstanding for this account."
                      : "None listed."}
                  </p>
                ) : (
                  <ol className="mt-2 flex flex-col gap-2">
                    {actions.map((action, index) => (
                      <li
                        key={action.code}
                        className="flex items-baseline gap-3 rounded-in bg-plate/60 px-3 py-2 text-[13.5px] text-ink"
                      >
                        <span className="font-mono text-[11px] text-muted">{index + 1}</span>
                        <span className="flex-1">{action.text}</span>
                        {action.deadline ? (
                          <span className="font-mono text-[11px] text-muted">
                            by {action.deadline}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {seller?.onboarding_url && !guidedLink ? (
            <a
              className="pill buy"
              href={seller.onboarding_url}
              target="_blank"
              rel="noopener noreferrer"
              data-tour="sell.onboarding.link"
              onClick={() => setLink({ kind: "opened", url: seller.onboarding_url ?? "" })}
            >
              Continue onboarding on Whop
            </a>
          ) : (
            <PillButton
              tone="buy"
              data-tour="sell.onboarding.link"
              onClick={openOnboarding}
              disabled={link.kind === "requesting"}
              aria-busy={link.kind === "requesting" ? "true" : undefined}
            >
              {link.kind === "requesting" ? "Requesting link" : "Continue onboarding on Whop"}
            </PillButton>
          )}
          <PillButton
            tone="ghost"
            data-tour="sell.onboarding.refresh"
            onClick={() => void refresh("manual")}
            disabled={read.kind === "reading"}
          >
            Refresh status
          </PillButton>
          {read.kind === "ok" ? (
            <span className="text-[12.5px] text-muted" data-next-read-ms={nextIn ?? undefined}>
              Updated {timeLabel(read.at)}
            </span>
          ) : null}
        </div>

        {link.kind === "failed" ? (
          <div className="mt-4">
            <NotLive fail={link.fail} />
          </div>
        ) : null}
        {link.kind === "opened" ? (
          <p className="mt-4 text-[13px] leading-relaxed text-ink-2">
            {guidedLink
              ? "The onboarding link was created. Identity verification remains a hosted step."
              : "Whop onboarding opened in a new tab. Finish it there, then press Refresh status here."}
            Nothing on this page changes until the readback does.
          </p>
        ) : null}
      </section>
    </div>
  );
}
