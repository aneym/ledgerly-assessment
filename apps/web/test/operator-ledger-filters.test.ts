import { describe, expect, it } from "vitest";
import {
  applyFilters,
  isFiltered,
  normalizeSummary,
  parseFilters,
  toQuery,
} from "../src/lib/operator/ledger-filters";
import type { LedgerRow } from "../src/lib/operator/types";

const row: LedgerRow = {
  id: "entry-1",
  seller: { id: "seller-1", name: "Onda", whop_account_id: null, sale_policy: "direct" },
  type: "payment",
  order_id: "order-1",
  provider_resource_id: null,
  status: "settled",
  gross: { amountMinor: 10000, currency: "USD" },
  fee: { amountMinor: 800, currency: "USD" },
  net: { amountMinor: 9200, currency: "USD" },
  currency: "USD",
  created_at: "2026-09-08T23:59:59.999Z",
  updated_at: "2026-09-08T23:59:59.999Z",
  settled_at: null,
  correlation_id: "correlation-1",
  provenance: "mock",
};

describe("decluttered ledger URL filters", () => {
  it("retains provenance and inclusive date filters after their controls are removed", () => {
    const filters = parseFilters(
      new URLSearchParams("provenance=mock&from=2026-09-08&to=2026-09-08"),
    );
    expect(isFiltered(filters)).toBe(true);
    expect(toQuery(filters)).toBe("provenance=mock&from=2026-09-08&to=2026-09-08");
    expect(
      applyFilters(
        [
          row,
          { ...row, id: "outside", created_at: "2026-09-09T00:00:00Z" },
          { ...row, id: "sandbox", provenance: "sandbox" },
        ],
        filters,
      ).map((entry) => entry.id),
    ).toEqual(["entry-1"]);
  });

  it("keeps seller, search, currency, type and status filters usable together", () => {
    const filters = parseFilters(
      new URLSearchParams("q=order-1&seller_id=seller-1&currency=USD&type=payment&status=settled"),
    );
    expect(applyFilters([row, { ...row, id: "pending", status: "pending" }], filters)).toEqual([
      row,
    ]);
    expect(applyFilters([row], { ...filters, currency: "EUR" })).toEqual([]);
  });
});

describe("ledger route summary conversion", () => {
  it("retains zero and negative minor units as currency-tagged Money", () => {
    expect(normalizeSummary({ USD: { gross: 0, fee: -800, net: 800 } })).toEqual([
      {
        currency: "USD",
        gross: { amountMinor: 0, currency: "USD" },
        fee: { amountMinor: -800, currency: "USD" },
        net: { amountMinor: 800, currency: "USD" },
      },
    ]);
  });

  it("keeps fixture Money values and drops incomplete route totals", () => {
    const fixture = [{ currency: "USD", gross: row.gross, fee: row.fee, net: row.net }];
    expect(normalizeSummary(fixture)).toEqual(fixture);
    expect(normalizeSummary({ USD: { gross: 100, fee: 8 } })).toEqual([]);
  });
});
