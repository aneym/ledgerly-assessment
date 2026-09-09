import { describe, expect, it } from "vitest";
import { orderId, sellerId, whopAccountId } from "../../src/ids";
import type { Result } from "../../src/result";
import {
  type AdminLedgerQuery,
  type AdminLedgerQueryResult,
  type AdminLedgerRepo,
  type AdminLedgerRow,
  type AdminLedgerSeller,
  type AdminLedgerSummary,
  buildAdminLedgerRow,
  deriveAdminLedgerStatus,
  listAdminLedger,
  mapLedgerKindToType,
  type RawAdminLedgerEntry,
  TYPE_TO_KINDS,
} from "../../src/services/admin-ledger";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const seller: AdminLedgerSeller = {
  id: value(sellerId("seller_1")),
  name: "Alice's Shop",
  whopAccountId: value(whopAccountId("biz_alice")),
  salePolicy: "direct",
};

function rawEntry(overrides: Partial<RawAdminLedgerEntry> = {}): RawAdminLedgerEntry {
  return {
    id: "1",
    seller,
    kind: "payment",
    orderId: value(orderId("order_1")),
    providerResourceId: "pay_1",
    storedStatus: null,
    hasResolvedRefund: false,
    amountMinor: 2300,
    currency: "USD",
    orderGrossMinor: 2500,
    orderFeeMinor: 200,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    correlationId: "corr_1",
    provenance: "mock",
    ...overrides,
  };
}

describe("mapLedgerKindToType", () => {
  it("maps every documented kind to its coarser admin type", () => {
    expect(mapLedgerKindToType("payment")).toBe("payment");
    expect(mapLedgerKindToType("fee")).toBe("fee");
    expect(mapLedgerKindToType("refund")).toBe("refund");
    expect(mapLedgerKindToType("refund_fee")).toBe("fee");
    expect(mapLedgerKindToType("transfer")).toBe("transfer");
    expect(mapLedgerKindToType("payout_pending")).toBe("payout");
    expect(mapLedgerKindToType("payout_in_transit")).toBe("payout");
    expect(mapLedgerKindToType("payout_completed")).toBe("payout");
    expect(mapLedgerKindToType("payout_failed")).toBe("payout");
    expect(mapLedgerKindToType("payout_canceled")).toBe("payout");
  });

  it("throws on a kind outside inbox.ts's fully-enumerated vocabulary", () => {
    expect(() => mapLedgerKindToType("bogus")).toThrow(/Unrecognized ledger_entries\.kind/);
  });

  it("builds TYPE_TO_KINDS as the exact reverse of the kind table", () => {
    expect([...TYPE_TO_KINDS.fee].sort()).toEqual(["fee", "refund_fee"]);
    expect([...TYPE_TO_KINDS.payout].sort()).toEqual(
      [
        "payout_canceled",
        "payout_completed",
        "payout_failed",
        "payout_in_transit",
        "payout_pending",
      ].sort(),
    );
    expect(TYPE_TO_KINDS.payment).toEqual(["payment"]);
    expect(TYPE_TO_KINDS.refund).toEqual(["refund"]);
    expect(TYPE_TO_KINDS.transfer).toEqual(["transfer"]);
  });
});

describe("deriveAdminLedgerStatus", () => {
  it("lets a stored status win over any derivation, for any kind", () => {
    expect(
      deriveAdminLedgerStatus({ kind: "payment", storedStatus: "held", hasResolvedRefund: false }),
    ).toBe("held");
    expect(
      deriveAdminLedgerStatus({
        kind: "transfer",
        storedStatus: "pending",
        hasResolvedRefund: false,
      }),
    ).toBe("pending");
  });

  it("throws if a stored status is not one of the recognized values", () => {
    expect(() =>
      deriveAdminLedgerStatus({ kind: "payment", storedStatus: "bogus", hasResolvedRefund: false }),
    ).toThrow(/unrecognized value/);
  });

  it("derives transfer as always settled", () => {
    expect(
      deriveAdminLedgerStatus({ kind: "transfer", storedStatus: null, hasResolvedRefund: false }),
    ).toBe("settled");
  });

  it("derives each payout transition's status from its kind alone", () => {
    expect(
      deriveAdminLedgerStatus({
        kind: "payout_pending",
        storedStatus: null,
        hasResolvedRefund: false,
      }),
    ).toBe("pending");
    expect(
      deriveAdminLedgerStatus({
        kind: "payout_in_transit",
        storedStatus: null,
        hasResolvedRefund: false,
      }),
    ).toBe("settling");
    expect(
      deriveAdminLedgerStatus({
        kind: "payout_completed",
        storedStatus: null,
        hasResolvedRefund: false,
      }),
    ).toBe("paid_out");
    expect(
      deriveAdminLedgerStatus({
        kind: "payout_failed",
        storedStatus: null,
        hasResolvedRefund: false,
      }),
    ).toBe("failed");
    expect(
      deriveAdminLedgerStatus({
        kind: "payout_canceled",
        storedStatus: null,
        hasResolvedRefund: false,
      }),
    ).toBe("failed");
  });

  it("derives refund and refund_fee as always refunded", () => {
    expect(
      deriveAdminLedgerStatus({ kind: "refund", storedStatus: null, hasResolvedRefund: false }),
    ).toBe("refunded");
    expect(
      deriveAdminLedgerStatus({ kind: "refund_fee", storedStatus: null, hasResolvedRefund: false }),
    ).toBe("refunded");
  });

  it("derives payment/fee as refunded when a sibling refund resolved, else settled", () => {
    expect(
      deriveAdminLedgerStatus({ kind: "payment", storedStatus: null, hasResolvedRefund: true }),
    ).toBe("refunded");
    expect(
      deriveAdminLedgerStatus({ kind: "fee", storedStatus: null, hasResolvedRefund: true }),
    ).toBe("refunded");
    expect(
      deriveAdminLedgerStatus({ kind: "payment", storedStatus: null, hasResolvedRefund: false }),
    ).toBe("settled");
    expect(
      deriveAdminLedgerStatus({ kind: "fee", storedStatus: null, hasResolvedRefund: false }),
    ).toBe("settled");
  });

  it("falls back to pending for any unrecognized kind", () => {
    expect(
      deriveAdminLedgerStatus({ kind: "mystery", storedStatus: null, hasResolvedRefund: false }),
    ).toBe("pending");
  });
});

describe("buildAdminLedgerRow", () => {
  it("carries the row's own posted amount as net, unconditionally", () => {
    const row = buildAdminLedgerRow(rawEntry({ amountMinor: 2300, currency: "USD" }));
    expect(row.net).toEqual({ amountMinor: 2300, currency: "USD" });
  });

  it("quotes gross/fee straight from the resolved order, unsigned, for a refund row", () => {
    const row = buildAdminLedgerRow(
      rawEntry({
        kind: "refund",
        amountMinor: -2300,
        orderGrossMinor: 2500,
        orderFeeMinor: 200,
      }),
    );
    // The order's own gross/fee stay positive - this module does not invent a negative sign
    // convention for them, only the row's own `net` carries the refund's true sign.
    expect(row.gross).toEqual({ amountMinor: 2500, currency: "USD" });
    expect(row.fee).toEqual({ amountMinor: 200, currency: "USD" });
    expect(row.net).toEqual({ amountMinor: -2300, currency: "USD" });
  });

  it("reports null gross/fee when no order resolved (transfer/payout kinds)", () => {
    const row = buildAdminLedgerRow(
      rawEntry({
        kind: "transfer",
        orderId: null,
        orderGrossMinor: null,
        orderFeeMinor: null,
        amountMinor: 1000,
      }),
    );
    expect(row.gross).toBeNull();
    expect(row.fee).toBeNull();
    expect(row.orderId).toBeNull();
    expect(row.net).toEqual({ amountMinor: 1000, currency: "USD" });
  });

  it("sets settledAt only once the derived status is terminal", () => {
    const settling = buildAdminLedgerRow(rawEntry({ kind: "payout_in_transit" }));
    expect(settling.status).toBe("settling");
    expect(settling.settledAt).toBeNull();

    const settled = buildAdminLedgerRow(rawEntry({ kind: "payment", hasResolvedRefund: false }));
    expect(settled.status).toBe("settled");
    expect(settled.settledAt).toEqual(rawEntry().occurredAt);
  });

  it("uses createdAt as updatedAt, since ledger_entries rows are never updated after insert", () => {
    const row = buildAdminLedgerRow(rawEntry());
    expect(row.updatedAt).toEqual(row.createdAt);
  });

  it("lets a stored status override the derived one on the built row", () => {
    const row = buildAdminLedgerRow(rawEntry({ kind: "payment", storedStatus: "held" }));
    expect(row.status).toBe("held");
    expect(row.settledAt).toBeNull();
  });
});

function fakeRepo(
  rows: AdminLedgerRow[],
  summary: AdminLedgerSummary,
): AdminLedgerRepo & {
  lastQuery: AdminLedgerQuery | null;
  lastSummaryQuery: Omit<AdminLedgerQuery, "cursor" | "limit"> | null;
} {
  return {
    lastQuery: null,
    lastSummaryQuery: null,
    async query(query): Promise<AdminLedgerQueryResult> {
      this.lastQuery = query;
      return { rows, nextCursor: null };
    },
    async summarize(query) {
      this.lastSummaryQuery = query;
      return summary;
    },
  };
}

describe("listAdminLedger", () => {
  it("defaults the limit to 50 when none is given", async () => {
    const repo = fakeRepo([], {});
    await listAdminLedger(repo, {});
    expect(repo.lastQuery?.limit).toBe(50);
  });

  it("clamps a requested limit above 200 down to the max", async () => {
    const repo = fakeRepo([], {});
    await listAdminLedger(repo, { limit: 5000 });
    expect(repo.lastQuery?.limit).toBe(200);
  });

  it("falls back to the default limit for a non-positive or non-finite request", async () => {
    const repo = fakeRepo([], {});
    await listAdminLedger(repo, { limit: 0 });
    expect(repo.lastQuery?.limit).toBe(50);
  });

  it("trims free-text search before it reaches the repo", async () => {
    const repo = fakeRepo([], {});
    await listAdminLedger(repo, { q: "  alice  " });
    expect(repo.lastQuery?.q).toBe("alice");
  });

  it("summarizes with the same filters minus cursor/limit", async () => {
    const repo = fakeRepo([], {});
    await listAdminLedger(repo, {
      sellerId: seller.id,
      currency: "USD",
      cursor: "opaque-cursor",
      limit: 10,
    });
    expect(repo.lastSummaryQuery).toEqual({ sellerId: seller.id, currency: "USD" });
  });

  it("returns rows, nextCursor and the summary from the repo untouched, per currency", async () => {
    const row = buildAdminLedgerRow(rawEntry());
    const summary: AdminLedgerSummary = {
      USD: { gross: 2500, fee: 200, net: 2300 },
      EUR: { gross: 900, fee: 90, net: 810 },
    };
    const repo = fakeRepo([row], summary);
    const page = await listAdminLedger(repo, {});
    expect(page.rows).toEqual([row]);
    expect(page.nextCursor).toBeNull();
    // Each currency's totals stand alone - nothing here ever adds USD and EUR together.
    expect(page.summary).toEqual(summary);
  });

  it("throws if the repo's summary reports a currency Money itself would reject", async () => {
    const repo = fakeRepo([], {
      XXX: { gross: 1, fee: 0, net: 1 },
    } as unknown as AdminLedgerSummary);
    await expect(listAdminLedger(repo, {})).rejects.toThrow(/invalid currency/);
  });
});
