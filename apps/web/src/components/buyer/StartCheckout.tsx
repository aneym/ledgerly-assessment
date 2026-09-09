"use client";

import { useEffect, useRef, useState } from "react";
import { PillButton, PillLink } from "@/components/pill";
import {
  type ApiFailure,
  type ApiResult,
  apiRequest,
  isNotLive,
  toOrderView,
} from "@/lib/buyer/api";
import { NotLive } from "./NotLive";

/** The body POST /api/checkouts accepts, as the server page resolved it. */
export type CheckoutRequest = {
  seller_id: string;
  product_slug: string;
};

/**
 * The new order's id out of POST /api/checkouts: the contract answers
 * `{ order_id, purchase_url, status, provenance }`; the pre-contract route answered the
 * whole order under `order`.
 */
export function createdOrderId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["order_id", "orderId", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return toOrderView(payload)?.id ?? null;
}

type Phase =
  | { kind: "creating" }
  | { kind: "created"; orderId: string }
  | { kind: "failed"; failure: ApiFailure }
  | { kind: "malformed"; status: number };

const TITLE: Record<number, string> = {
  404: "The seller behind this product is not in the database",
  409: "The seller cannot take this order yet",
  403: "The seller is suspended",
  400: "The checkout request was rejected",
};

function explain(failure: ApiFailure): string {
  switch (failure.apiMessage) {
    case "seller_not_found":
      return "Catalog sellers are fixture rows; an order needs a seller row created through the app API. Create one on the sell page, or pass ?seller=<id> on this address.";
    case "seller_not_onboarded":
      return "A direct-charge seller needs a Whop account before a checkout can be created on it.";
    case "seller_suspended":
      return "Suspended sellers cannot take new orders.";
    default:
      return isNotLive(failure)
        ? "The form posted to the app API and the route answered as shown. No order was created."
        : "The route answered as shown. No order was created and nothing was charged.";
  }
}

/**
 * Creates the order on mount by posting to POST /api/checkouts, then moves to the
 * order's checkout screen, where Whop's embedded checkout mounts. One post per mount: the
 * guard survives React's development double-invocation of effects.
 */
export function StartCheckout({
  request,
  correlationId,
  productHref,
}: {
  request: CheckoutRequest;
  correlationId: string;
  productHref: string;
}) {
  // One request per attempt, kept across React's development double-invocation of
  // effects: the second run re-attaches to the first run's promise instead of posting again.
  const runs = useRef(new Map<number, Promise<ApiResult<unknown>>>());
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "creating" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger
  useEffect(() => {
    let active = true;
    let run = runs.current.get(attempt);
    if (!run) {
      run = apiRequest<unknown>("/api/checkouts", {
        method: "POST",
        body: { seller_id: request.seller_id, product_slug: request.product_slug },
        correlationId,
        expect: (data) => createdOrderId(data) !== null,
      });
      runs.current.set(attempt, run);
    }
    void run.then((result) => {
      if (!active) return;
      if (!result.ok) {
        setPhase({ kind: "failed", failure: result });
        return;
      }
      const orderId = createdOrderId(result.data);
      if (!orderId) {
        setPhase({ kind: "malformed", status: result.status });
        return;
      }
      setPhase({ kind: "created", orderId });
      // The order's checkout page mounts Whop's embedded checkout inside the app shell; the
      // hosted purchase_url stays on that page as an explicit fallback, never an auto-redirect.
      window.location.replace(
        `/checkout/${encodeURIComponent(orderId)}?correlationId=${encodeURIComponent(correlationId)}`,
      );
    });
    return () => {
      active = false;
    };
  }, [attempt]);

  if (phase.kind === "creating" || phase.kind === "created") {
    return (
      <output className="by-notlive by-inline" aria-live="polite">
        {phase.kind === "creating" ? "Creating your order" : "Order created, opening checkout"}
      </output>
    );
  }

  if (phase.kind === "malformed") {
    return (
      <div className="by-notlive">
        <h2 className="by-h3">The order payload is missing fields</h2>
        <p>
          <span className="by-mono">POST /api/checkouts</span> answered {phase.status} but without
          an order id, so there is no order to open.
        </p>
      </div>
    );
  }

  return (
    <NotLive
      failure={phase.failure}
      title={
        phase.failure.kind === "network"
          ? "Could not reach the app API"
          : phase.failure.kind === "unexpected"
            ? "The checkout route answered with an unexpected response"
            : (TITLE[phase.failure.status ?? 0] ?? "Could not create the order")
      }
      tone={isNotLive(phase.failure) ? undefined : "bad"}
      actions={
        <>
          <PillButton
            tone="buy"
            onClick={() => {
              setPhase({ kind: "creating" });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </PillButton>
          <PillLink href={productHref} tone="ghost">
            Back to the product
          </PillLink>
        </>
      }
    >
      <p>{explain(phase.failure)}</p>
    </NotLive>
  );
}
