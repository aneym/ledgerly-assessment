"use client";

import { useState } from "react";
import { PillButton } from "@/components/pill";
import {
  type ApiFailure,
  apiRequest,
  isJsonObject,
  isNotLive,
  pickCorrelationId,
} from "@/lib/buyer/api";
import { NotLive } from "./NotLive";

type Phase =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "failed"; failure: ApiFailure }
  | { kind: "sent" };

/**
 * Refund request for platform-charge sellers. The click posts to the app API
 * and shows exactly what came back; while that route is not live the buyer
 * sees the method, path and status rather than a pretend confirmation.
 */
export function RefundRequest({
  orderId,
  correlationId,
}: {
  orderId: string;
  correlationId: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const path = `/api/orders/${encodeURIComponent(orderId)}/refund-request`;

  async function request() {
    if (phase.kind !== "idle") return;
    setPhase({ kind: "pending" });
    // A refund request is only "sent" when the route answers a JSON object for it.
    const result = await apiRequest<unknown>(path, {
      method: "POST",
      body: {},
      correlationId: pickCorrelationId(correlationId),
      expect: isJsonObject,
    });
    setPhase(result.ok ? { kind: "sent" } : { kind: "failed", failure: result });
  }

  const label =
    phase.kind === "sent"
      ? "Refund requested"
      : phase.kind === "pending"
        ? "Sending request"
        : "Request a refund";

  return (
    <>
      <PillButton
        tone="ghost"
        onClick={request}
        disabled={phase.kind !== "idle"}
        data-tour="receipt.refund"
      >
        {label}
      </PillButton>
      {phase.kind === "failed" ? (
        <div className="by-refund-result">
          <NotLive
            failure={phase.failure}
            title={
              isNotLive(phase.failure) ? "Refund API is not live yet" : "Refund request failed"
            }
            inline
          />
        </div>
      ) : null}
    </>
  );
}
