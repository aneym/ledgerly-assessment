import type { DeliveryId, EffectKey, RunId, SellerId, WhopAccountId } from "../ids";
import type { Money } from "../money";
import type { WhopPort as AccountPort, WhopResult } from "../ports/whop";
import type { WhopAccount } from "../ports/whop-types";
import type { Country } from "../seller";

export interface Clock {
  now(): Date;
}
export interface IdGenerator {
  seller(): SellerId;
}
export type Seller = {
  id: SellerId;
  runId: RunId;
  externalId: string;
  email: string;
  country: Country;
  whopAccountId: WhopAccountId | null;
};
export type OnboardInput = Pick<Seller, "runId" | "externalId" | "email" | "country">;
export type AccountRequest = Parameters<AccountPort["createOrFetchAccount"]>[0];
export type Operation = {
  key: string;
  request: AccountRequest;
  apiVersionDate: string;
  status: "pending" | "unknown" | "succeeded" | "failed";
  providerResourceId: WhopAccountId | null;
};
export interface SellerRepo {
  createOrFetch(input: OnboardInput, id: SellerId): Promise<Seller>;
  get(id: SellerId): Promise<Seller | null>;
  byAccount(id: string): Promise<Seller | null>;
  attach(id: SellerId, accountId: WhopAccountId): Promise<void>;
  list(limit: number, offset?: number): Promise<Seller[]>;
  count(): Promise<number>;
}
export interface OperationRepo {
  createOrFetch(operation: Operation): Promise<{ operation: Operation; created: boolean }>;
  get(key: string): Promise<Operation>;
  finish(
    key: string,
    status: Operation["status"],
    accountId: WhopAccountId | null,
    now: Date,
  ): Promise<void>;
}
export type Envelope = {
  accountId: string;
  originalAccountField: "account_id" | "company_id";
  eventType: string;
  apiVersionDate: string;
  rawBody: string;
  raw: { type: string; timestamp: string | number; data?: unknown };
};
export type InboxRow = {
  deliveryId: DeliveryId;
  envelope: Envelope;
  receivedAt: Date;
  status: "received" | "processed" | "failed" | "quarantined";
};
export interface InboxRepo {
  insert(
    row: InboxRow,
    headers: Record<string, string>,
  ): Promise<{ row: InboxRow; duplicate: boolean }>;
  pending(limit: number): Promise<InboxRow[]>;
  get(id: DeliveryId): Promise<InboxRow>;
  mark(id: DeliveryId, status: InboxRow["status"], now: Date, error?: string): Promise<void>;
}
export type Effect = {
  key: EffectKey;
  deliveryId: DeliveryId;
  resourceType: string;
  resourceId: string;
  transition: string;
  // Small, value-free notes about how the effect was derived — currently just
  // `{ unmatched_order: true }` when a payment/refund could not be linked to an order.
  detail?: Record<string, unknown>;
};
export interface EffectRepo {
  insert(effect: Effect, now: Date): Promise<boolean>;
}
export type LedgerEntry = {
  runId: RunId;
  sellerId: SellerId;
  accountSide: "platform" | "seller";
  amount: Money;
  kind: string;
  resourceType: string;
  resourceId: string;
  effectKey: EffectKey;
  occurredAt: Date;
  // Which provider produced the fact behind this row. Omitted rows keep the column default.
  provenance?: "sandbox" | "mock";
};
export type OrderAllocation = { gross: Money; fee: Money };
// Allocation lookup reports whether an order matched, independently of any state write.
export type OrderSettlement = { allocation: OrderAllocation | null; matched: boolean };
export interface LedgerRepo {
  // Exact payment rows, including provenance, for provider-read confirmation and dedupe.
  forPaymentConfirmation?(paymentId: string): Promise<LedgerEntry[]>;
  append(entries: LedgerEntry[]): Promise<void>;
  forSeller(id: SellerId): Promise<LedgerEntry[]>;
  // Locks matching orders for this transaction without changing them. If no order matches,
  // reconstructs the allocation from the original payment entries when available.
  resolveOrder(
    seller: Seller,
    input: { paymentId?: string; checkoutId?: string; orderId?: string },
    // An early platform refund may identify an order before its payment credit is accepted.
    options?: { requirePostedPayment: boolean },
  ): Promise<OrderSettlement>;
  // Apply an accepted transition in the same transaction as its effect and ledger entries.
  // Refunded orders cannot return to paid. Legacy import callers also use this guard.
  settleOrder(
    seller: Seller,
    input: { paymentId?: string; checkoutId?: string; orderId?: string },
    update: { paymentId?: string; status: "paid" | "refunded"; provenance: "sandbox" | "mock" },
  ): Promise<OrderSettlement>;
}
export type InboxOrder = {
  id: string;
  sellerId: SellerId;
  runId: RunId;
  flow: "direct" | "platform_transfer";
  paymentId: string | null;
  checkoutConfigurationId: string | null;
};
export interface InboxOrdersRepo {
  // Full snapshot under FOR UPDATE. Optional for legacy inbox-only port implementations.
  forPaymentConfirmation?(id: string): Promise<import("./orders").Order | null>;
  byCheckoutConfigurationId(id: string): Promise<InboxOrder | null>;
  byId(id: string): Promise<InboxOrder | null>;
  // Absence can use legacy seller routing; ambiguity must fail closed before any fallback.
  byPaymentId(id: string): Promise<InboxOrder | { kind: "ambiguous" } | null>;
}
export interface Repositories {
  orders: InboxOrdersRepo;
  sellers: SellerRepo;
  operations: OperationRepo;
  inbox: InboxRepo;
  effects: EffectRepo;
  ledger: LedgerRepo;
  lock(key: string): Promise<void>;
}
export interface UnitOfWork {
  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
  exclusive<T>(key: string, fn: (work: Pick<UnitOfWork, "run">) => Promise<T>): Promise<T>;
}
export type ProviderRecord = {
  id: string;
  accountId: WhopAccountId;
  amount: Money;
  status: "succeeded" | "completed" | "pending" | "reserve" | "failed";
};
export type ProviderPage = { data: ProviderRecord[]; nextCursor: string | null };
export type ListInput = { accountId: WhopAccountId; cursor?: string; limit: number };
export type { WhopPort } from "../ports/whop";
export interface ReconciliationProvider {
  listPayments(input: ListInput): WhopResult<ProviderPage>;
  listTransfers(input: ListInput): WhopResult<ProviderPage>;
}
// Recovery must find an existing account without creating one. Absence must be authoritative.
export interface AccountLookup {
  findAccount(input: AccountRequest, key: string): WhopResult<WhopAccount | null>;
}
