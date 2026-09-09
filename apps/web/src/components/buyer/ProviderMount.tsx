"use client";

import { useEffect, useState } from "react";
import { WhopMark } from "@/components/brand/WhopMark";
import { PillButton, PillLink } from "@/components/pill";
import { apiRequest, type OrderView, toOrderView } from "@/lib/buyer/api";
import { chooseSurface } from "@/lib/buyer/checkout-embed-state";
import { EmbeddedCheckout, type EmbedEnvironment } from "./EmbeddedCheckout";
import { ArrowIcon, ExternalPill } from "./primitives";

function LocalPayment({ order, correlationId }: { order: OrderView; correlationId: string }) {
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<"ready" | "pending" | "paid" | "error">("ready");
  useEffect(() => {
    let active = true;
    void apiRequest<{ local_test?: boolean }>("/api/local-runtime/health", { correlationId }).then(
      (result) => {
        if (active) setAvailable(result.ok && result.data.local_test === true);
      },
    );
    return () => {
      active = false;
    };
  }, [correlationId]);
  if (!available) return null;
  async function complete() {
    setPhase("pending");
    const result = await apiRequest<{ status?: string; provenance?: string }>(
      "/api/local-runtime/checkout",
      {
        method: "POST",
        body: { orderId: order.id },
        correlationId,
      },
    );
    if (!result.ok || result.data.status !== "paid" || result.data.provenance !== "mock") {
      setPhase("error");
      return;
    }
    const confirmed = await apiRequest<unknown>(`/api/orders/${encodeURIComponent(order.id)}`, {
      correlationId,
    });
    const view = confirmed.ok ? toOrderView(confirmed.data) : null;
    setPhase(view?.status === "paid" && view.paymentId ? "paid" : "error");
  }
  return phase === "paid" ? (
    <div role="status">
      <p>Simulated payment recorded. No money was charged.</p>
      <PillLink
        href={`/receipt/${encodeURIComponent(order.id)}?correlationId=${encodeURIComponent(correlationId)}`}
        tone="buy"
      >
        View mock receipt
      </PillLink>
    </div>
  ) : (
    <div>
      <PillButton
        data-tour="checkout.simulation.complete"
        tone="buy"
        disabled={phase === "pending"}
        onClick={() => void complete()}
      >
        {phase === "pending" ? "Recording mock payment…" : "Complete mock payment"}
      </PillButton>
      {phase === "error" ? (
        <p role="alert">The mock payment is not confirmed. Retry to check this order.</p>
      ) : null}
    </div>
  );
}

/**
 * Where the Whop checkout mounts. A provider-issued checkout configuration mounts Whop's
 * official embedded checkout inside the app shell; a mock-provenance order gets a labelled
 * simulation that never pretends to be the provider; an order with no configuration yet
 * says so. The hosted page is offered only as an explicit fallback from inside the embed
 * surface, never as a silent redirect.
 */
export function ProviderMount({
  order,
  environment,
  returnUrl,
  correlationId,
}: {
  order: OrderView;
  environment: EmbedEnvironment;
  returnUrl: string;
  correlationId: string;
}) {
  const surface = chooseSurface(order);
  const mountClass =
    surface === "embed"
      ? "by-mount by-mount-live"
      : surface === "unavailable" && order.purchaseUrl
        ? "by-mount by-mount-ready"
        : "by-mount";
  return (
    <section className="card by-mount-card" aria-label="Payment">
      <div
        className={mountClass}
        data-tour="checkout.provider"
        data-surface={surface}
        data-purchase-url={order.purchaseUrl ?? undefined}
      >
        {surface === "embed" ? (
          <EmbeddedCheckout
            order={order}
            environment={environment}
            returnUrl={returnUrl}
            correlationId={correlationId}
          />
        ) : surface === "simulation" ? (
          <div className="by-embed-sim" data-tour="checkout.simulation">
            <span className="cap">Simulated checkout</span>
            <p className="why">
              This order was created against the local provider simulation, so there is no Whop
              checkout to mount and no card form. Nothing is charged here; the real embedded
              checkout appears for orders the sandbox issued.
            </p>
            {order.purchaseUrl ? <p className="why by-mono">{order.purchaseUrl}</p> : null}
            <LocalPayment order={order} correlationId={correlationId} />
          </div>
        ) : (
          <>
            <span className="cap">Pay with Whop</span>
            {order.purchaseUrl ? null : (
              <p className="why">
                The provider has not issued a checkout configuration for this order yet, so there is
                nothing to mount and nothing to charge.
              </p>
            )}
            {order.purchaseUrl ? (
              <ExternalPill href={order.purchaseUrl} tone="buy" size="lg">
                Open Whop checkout
                <ArrowIcon />
              </ExternalPill>
            ) : null}
          </>
        )}
      </div>
      <div className="by-mount-foot">
        <span>Card details never touch Ledgerly</span>
        <i aria-hidden="true" />
        <span>
          Payments by <WhopMark />
        </span>
      </div>
    </section>
  );
}
