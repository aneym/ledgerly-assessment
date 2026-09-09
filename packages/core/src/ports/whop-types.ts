import type { WhopAccountId, WhopPaymentId, WhopTransferId } from "../ids";
import type { Money } from "../money";
export type WhopError = {
  kind:
    | "http"
    | "decode"
    | "network"
    | "not_found"
    | "nested_account"
    | "insufficient_balance"
    | "invalid_request"
    | "idempotency_conflict"
    | "capability_inactive"
    | "credential_missing";
  status?: number;
  body?: unknown;
  requestId?: string;
};
export type WhopAccount = {
  id: WhopAccountId;
  raw: unknown;
  country?: string;
  parentAccountId?: WhopAccountId | null;
  // Unknown means this adapter has not seen the ID before, not proof of creation.
  disposition?: "fetched" | "unknown";
};
export type WhopLink = { url: string; raw: unknown };
export type WhopCheckout = {
  id: string;
  raw: unknown;
  purchaseUrl?: string;
  applicationFee?: Money | null;
};
export type WhopPayment = { id: WhopPaymentId; raw: unknown };
export type WhopPaymentFee = { amount: Money; raw: unknown };
export type WhopRefund = { id: string; raw: unknown };
export type WhopTransfer = { id: WhopTransferId; raw: unknown };
export type WhopAccessToken = { token: string; raw: unknown };

export type WhopPage<T> = { items: T[]; nextCursor: string | null };
export type WhopPaymentRecord = {
  id: WhopPaymentId;
  status: string;
  amount: Money | null;
  currency: Money["currency"];
  createdAt: string;
  accountId: WhopAccountId | null;
};
export type WhopTransferRecord = {
  id: WhopTransferId;
  status: string;
  amount: Money;
  currency: Money["currency"];
  createdAt: string;
  origin: { id: string; type: "Company" | "User" };
  destination: { id: string; type: "Company" | "User" };
};
