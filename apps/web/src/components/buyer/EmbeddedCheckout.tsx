"use client";

import { WhopCheckoutEmbed } from "@whop/checkout/react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { PillLink } from "@/components/pill";
import { type ApiResult, apiRequest, type OrderView, toOrderView } from "@/lib/buyer/api";
import {
  CONFIRM_POLL_LIMIT,
  CONFIRM_POLL_MS,
  type EmbedPhase,
  MOUNT_TIMEOUT_MS,
  offersHostedFallback,
  reduce,
} from "@/lib/buyer/checkout-embed-state";
import { ArrowIcon, ExternalPill } from "./primitives";

export type EmbedEnvironment = "sandbox" | "production";

/**
 * Whop's official embedded checkout (`@whop/checkout/react`, docs.whop.com/payments/
 * checkout-embed) mounted for the order's server-issued checkout configuration. The
 * configuration already carries the price, the platform fee and the seller account
 * routing, so nothing about money is asserted here and no card field ever renders in
 * Ledgerly's DOM: the iframe is Whop's. Completion is only a hint: the page polls the
 * order and shows "paid" once the webhook path has written it.
 */
export function EmbeddedCheckout({
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
  const [phase, dispatch] = useReducer(reduce, { kind: "loading" } as EmbedPhase);
  const sessionId = order.checkoutConfigurationId ?? "";
  const polls = useRef(0);

  // Fallback gating: the hosted link is offered only when the embed never reported ready.
  useEffect(() => {
    const timer = setTimeout(() => dispatch({ type: "timeout" }), MOUNT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  // After the embed reports completion, read the order until the server says paid. The
  // read is the existing GET /api/orders/{id}; nothing here writes.
  useEffect(() => {
    if (phase.kind !== "completed") return;
    let active = true;
    const tick = async () => {
      if (!active || polls.current >= CONFIRM_POLL_LIMIT) return;
      polls.current += 1;
      const result: ApiResult<unknown> = await apiRequest<unknown>(
        `/api/orders/${encodeURIComponent(order.id)}`,
        { method: "GET", correlationId },
      );
      if (!active) return;
      const view = result.ok ? toOrderView(result.data) : null;
      if (view) dispatch({ type: "order_read", status: view.status });
    };
    void tick();
    const timer = setInterval(() => void tick(), CONFIRM_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [phase.kind, order.id, correlationId]);

  const onComplete = useCallback((_planId: string, receiptId?: string) => {
    dispatch({ type: "complete", receiptId: receiptId ?? null });
  }, []);

  const receiptHref = `/receipt/${encodeURIComponent(order.id)}`;
  const fallback = offersHostedFallback(phase);

  return (
    <div
      className="by-embed"
      data-tour="checkout.embed"
      data-phase={phase.kind}
      data-environment={environment}
      data-session-id={sessionId || undefined}
    >
      {phase.kind === "confirmed" ? (
        <div className="by-embed-done" role="status" data-tour="checkout.embed-confirmed">
          <span className="cap">Payment confirmed</span>
          <p className="why">
            Whop confirmed the payment and the order is marked paid. Your receipt is ready.
          </p>
          <PillLink href={receiptHref} tone="buy" size="lg">
            View receipt
            <ArrowIcon />
          </PillLink>
        </div>
      ) : (
        <>
          {phase.kind === "completed" ? (
            <output className="by-embed-note ok" aria-live="polite">
              Payment received{phase.receiptId ? ` (receipt ${phase.receiptId})` : ""}. Waiting for
              Whop's confirmation before the order is marked paid.
            </output>
          ) : null}
          {phase.kind === "payment_error" ? (
            <output className="by-embed-note bad" aria-live="assertive">
              Payment failed: {phase.message}
              {phase.code ? ` (${phase.code})` : ""}. Nothing was charged; you can try again below.
            </output>
          ) : null}
          {fallback ? (
            <div className="by-embed-fallback" role="alert" data-tour="checkout.embed-fallback">
              <span className="cap">Embedded checkout did not load</span>
              <p className="why">
                {phase.kind === "mount_failed" && phase.reason !== "timeout"
                  ? `Whop's checkout reported: ${phase.reason}.`
                  : "Whop's checkout did not report ready within 20 seconds."}{" "}
                {order.purchaseUrl
                  ? "You can open the same checkout on Whop's hosted page instead."
                  : "This order has no hosted checkout link to fall back to."}
              </p>
              {order.purchaseUrl ? (
                <ExternalPill href={order.purchaseUrl} tone="buy" size="lg">
                  Open Whop checkout
                  <ArrowIcon />
                </ExternalPill>
              ) : null}
            </div>
          ) : null}
          <div className="by-embed-frame" hidden={fallback}>
            <WhopCheckoutEmbed
              sessionId={sessionId}
              environment={environment}
              returnUrl={returnUrl}
              theme="light"
              themeOptions={{
                backgroundColor: "#faf8f4",
                accentColor: "#1b1b1b",
                borderRadius: 10,
              }}
              styles={{ container: { paddingX: 8, paddingY: 8 } }}
              onComplete={onComplete}
              onStateChange={(state) => dispatch({ type: "state", state })}
              onPaymentError={(error) =>
                dispatch({
                  type: "payment_error",
                  message: error.message,
                  code: error.code ?? null,
                })
              }
              fallback={
                <div className="by-embed-loading" aria-busy="true">
                  <span className="cap">Loading Whop checkout</span>
                </div>
              }
            />
          </div>
        </>
      )}
    </div>
  );
}
