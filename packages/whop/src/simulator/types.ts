import type { Currency, WhopAccountId } from "@ledgerly/core";

// Selected via metadata.simulate on a createTransfer call. See adapter.ts's createTransfer for
// the exact behavior of each flag, and docs/lanes/architecture/platform-simulation.md for the
// prose version.
export type TransferSimulateFlag =
  | "insufficient_balance"
  | "timeout"
  | "unknown_outcome"
  | "fail_then_succeed";

export type SimulatedTransferStatus = "pending" | "completed" | "failed";

// The shape carried in a createTransfer response's `raw` field (WhopTransfer only guarantees
// {id, raw} at the WhopPort level) and in the simulator's own bookkeeping. Money fields are
// decimal strings, mirroring how the real Whop API represents a transfer resource.
export type SimulatedTransfer = {
  id: string;
  status: SimulatedTransferStatus;
  amount: string;
  currency: Currency;
  origin_id: WhopAccountId;
  destination_id: WhopAccountId;
  metadata: Record<string, string>;
};

// The full payout resource status enum as the real Whop API documents it. Only a subset
// (requested/processing/completed) is reachable through the simulator's own deterministic
// schedule; the rest exist so a test or future flag can set a payout down one of the other
// paths without widening this type later.
export type SimulatedPayoutStatus =
  | "requested"
  | "in_review"
  | "processing"
  | "completed"
  | "reversed"
  | "canceled"
  | "failed"
  | "denied";

export type SimulatedPayout = {
  id: string;
  status: SimulatedPayoutStatus;
  amount: string;
  currency: Currency;
  account_id: WhopAccountId;
  metadata: Record<string, string>;
};

export type WebhookDelivery = {
  rawBody: string;
  headers: { "webhook-id": string; "webhook-timestamp": string; "webhook-signature": string };
};

// Delivers in-process to whatever consumes real webhooks (apps/web/src/lib/server.ts wires this
// to inbox.receiveWebhook), never over the network.
export type DeliverWebhook = (delivery: WebhookDelivery) => void | Promise<void>;
