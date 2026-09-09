// Pure record lookups shared by two callers: tools.ts's zod-wrapped tools (which the model
// invokes during a turn) and route.ts's up-front context lookup (which grounds the system
// prompt with the operator's selected record before the model says anything). Keeping the
// lookup logic here, independent of both the AI SDK `tool()` wrapping and the request
// handler, means the two call sites can never drift on what a "found" ledger entry, seller,
// or order looks like.
import {
  type OrderId,
  orderId,
  type SellerId,
  sellerId,
  type WhopPort,
  whopAccountId,
} from "@ledgerly/core";
import { readPlatformCapabilities } from "@ledgerly/whop";
import { recordProvenance } from "./provenance";
import { type AssistantDb, getLedgerEntryById, type LedgerEntryRow } from "./queries";
import { sourceHref } from "./sources";
import type { SourceData } from "./types";

type SellerRecord = {
  id: string;
  runId: string;
  externalId: string;
  email: string;
  country: string;
  whopAccountId: string | null;
  salePolicy: string;
  status: string;
};
type OrderRecord = {
  id: string;
  runId: string;
  sellerId: string;
  productTitle: string;
  productExternalId: string | null;
  gross: { amountMinor: number; currency: string };
  fee: { amountMinor: number; currency: string };
  flow: string;
  checkoutConfigurationId: string | null;
  purchaseUrl: string | null;
  status: string;
};

export type LookupDeps = {
  db: AssistantDb;
  provider: WhopPort;
  sellers: { get(id: SellerId): Promise<SellerRecord | null> };
  orders: { get(id: OrderId): Promise<OrderRecord | null> };
  whopMode: string | undefined;
};

export function formatLedgerEntry(row: LedgerEntryRow, provenance: string) {
  return {
    id: String(row.id),
    runId: row.runId,
    sellerId: row.sellerId,
    accountSide: row.accountSide,
    kind: row.kind,
    amount: { amountMinor: row.amountMinor, currency: row.currency },
    providerResourceType: row.providerResourceType,
    providerResourceId: row.providerResourceId,
    effectKey: row.effectKey,
    occurredAt: row.occurredAt.toISOString(),
    provenance,
  };
}

export async function lookupLedgerEntry(deps: LookupDeps, rawId: string) {
  const trimmed = rawId.trim();
  if (!/^\d+$/.test(trimmed))
    return { found: false as const, id: rawId, reason: "malformed ledger entry id" };
  const row = await getLedgerEntryById(deps.db, Number(trimmed));
  if (!row) return { found: false as const, id: rawId };
  const provenance = recordProvenance(deps.whopMode);
  const entry = formatLedgerEntry(row, provenance);
  const source: SourceData = {
    kind: "ledger_entry",
    id: entry.id,
    label: `${row.kind} ${row.effectKey}`,
    href: sourceHref("ledger_entry", entry.id),
    provenance,
  };
  return { found: true as const, entry, source };
}

export async function lookupSeller(deps: LookupDeps, rawId: string) {
  const parsed = sellerId(rawId);
  if (!parsed.ok) return { found: false as const, id: rawId, reason: "malformed seller id" };
  const seller = await deps.sellers.get(parsed.value);
  if (!seller) return { found: false as const, id: rawId };
  const provenance = recordProvenance(deps.whopMode);
  let whop: {
    capabilities: Record<string, string>;
    requiredActions: string[];
    readAt: string | null;
  } | null = null;
  if (seller.whopAccountId) {
    const accountId = whopAccountId(seller.whopAccountId);
    if (accountId.ok) {
      const snapshot = await readPlatformCapabilities(deps.provider, accountId.value).read();
      whop = {
        capabilities: snapshot.capabilities,
        requiredActions: snapshot.requiredActions,
        readAt: snapshot.readAt ? snapshot.readAt.toISOString() : null,
      };
    }
  }
  const source: SourceData = {
    kind: "seller",
    id: seller.id,
    label: seller.email,
    href: sourceHref("seller", seller.id),
    provenance,
  };
  return { found: true as const, seller: { ...seller, provenance }, whop, source };
}

export async function lookupOrder(deps: LookupDeps, rawId: string) {
  const parsed = orderId(rawId);
  if (!parsed.ok) return { found: false as const, id: rawId, reason: "malformed order id" };
  const order = await deps.orders.get(parsed.value);
  if (!order) return { found: false as const, id: rawId };
  const provenance = recordProvenance(deps.whopMode);
  const source: SourceData = {
    kind: "order",
    id: order.id,
    label: order.productTitle,
    href: sourceHref("order", order.id),
    provenance,
  };
  return { found: true as const, order: { ...order, provenance }, source };
}
