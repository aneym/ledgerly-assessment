"use client";

import Script from "next/script";
import { useEffect, useId, useRef, useState } from "react";
import {
  type EmbeddedPayoutSession,
  mountPayoutElements,
  PAYOUT_SDK_INTEGRITY,
  PAYOUT_SDK_SRC,
  requestPayoutSession,
  type WhopElementsSdk,
} from "@/lib/seller/payout-session";

declare global {
  interface Window {
    WhopElements?: WhopElementsSdk;
  }
}

export function PayoutsEmbed({ sellerId }: { sellerId: string }) {
  const rootId = `payouts-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [data, setData] = useState<EmbeddedPayoutSession | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [hostedUrl, setHostedUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const openRequest = useRef<AbortController | null>(null);
  useEffect(() => () => openRequest.current?.abort(), []);

  useEffect(() => {
    if (!data || sdkReady) return;
    const timeout = setTimeout(() => {
      setMessage("Whop's payout script did not load. Use the hosted alternative or try again.");
      setData(null);
      setLoading(false);
    }, 30_000);
    return () => clearTimeout(timeout);
  }, [data, sdkReady]);

  useEffect(() => {
    if (!sdkReady || !data) return;
    if (!window.WhopElements) {
      setMessage(
        "Whop's payout script did not expose its component loader. Use the hosted alternative.",
      );
      setData(null);
      setLoading(false);
      return;
    }
    let active = true;
    const failed = () => {
      if (!active) return;
      setMessage(
        "Whop's balance component could not load or refresh. Reopen it or use the hosted portal.",
      );
      setData(null);
      setReady(false);
      setLoading(false);
    };
    let session: ReturnType<typeof mountPayoutElements> | undefined;
    try {
      session = mountPayoutElements(
        window.WhopElements,
        data,
        async (signal) => {
          const refreshed = await requestPayoutSession(sellerId, "embedded", signal);
          if (refreshed.kind !== "embedded") throw new Error("Payout session changed");
          return refreshed;
        },
        rootId,
        () => {
          if (active) {
            setReady(true);
            setLoading(false);
          }
        },
        failed,
      );
    } catch {
      failed();
    }
    return () => {
      active = false;
      session?.destroy();
    };
  }, [data, sdkReady, sellerId, rootId]);

  async function open(view: "embedded" | "hosted") {
    openRequest.current?.abort();
    const request = new AbortController();
    openRequest.current = request;
    setLoading(true);
    setMessage(null);
    if (view === "embedded") {
      setData(null);
      setReady(false);
    }
    if (view === "hosted") setHostedUrl(null);
    try {
      const result = await requestPayoutSession(sellerId, view, request.signal);
      if (request.signal.aborted) return;
      if (result.kind === "embedded") setData(result);
      else {
        setHostedUrl(result.url);
        setLoading(false);
      }
    } catch (error) {
      if (request.signal.aborted) return;
      setMessage(
        error instanceof Error ? error.message : "Payouts could not open. Please try again.",
      );
      setLoading(false);
    }
  }

  return (
    <section
      data-tour="sell.payouts.embedded"
      aria-label="Whop payouts component"
      className="flex flex-col gap-4"
    >
      <p className="text-[13px] text-ink-2">
        View your sandbox balance in Whop. Embedded withdrawals are not available here yet. Use the
        hosted portal for payout options supported by your account.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="pill ink"
          disabled={loading}
          onClick={() => void open("embedded")}
        >
          {data ? "Reconnect balance" : "Open embedded balance"}
        </button>
        <button
          type="button"
          className="pill"
          disabled={loading}
          onClick={() => void open("hosted")}
          data-tour="sell.payouts.hosted-link"
        >
          Open hosted alternative
        </button>
      </div>
      {loading && (
        <p role="status" className="text-[13px] text-ink-2">
          Opening your secure payout session…
        </p>
      )}
      {message && (
        <p role="alert" className="rounded-in bg-[var(--warn-soft)] p-4 text-[13px] text-warn">
          {message}
        </p>
      )}
      {hostedUrl && (
        <a
          className="pill ink self-start"
          href={hostedUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Continue to Whop payouts portal
        </a>
      )}
      {data && (
        <>
          <Script
            src={PAYOUT_SDK_SRC}
            integrity={PAYOUT_SDK_INTEGRITY}
            crossOrigin="anonymous"
            strategy="afterInteractive"
            onReady={() => setSdkReady(true)}
            onError={() => {
              setMessage(
                "Whop's payout component could not load. Use the hosted alternative or try again.",
              );
              setData(null);
              setLoading(false);
            }}
          />
          <p className="text-[12px] text-muted">
            Sandbox balance only. This component cannot move funds or edit bank details.
          </p>
          <div aria-busy={!ready} className="flex min-h-40 flex-col gap-4">
            <div id={`${rootId}-balance`} />
          </div>
        </>
      )}
    </section>
  );
}
