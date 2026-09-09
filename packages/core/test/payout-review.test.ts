import { expect, it } from "vitest";
import { parseEffectKey, runId, sellerId } from "../src/ids";
import { money } from "../src/money";
import { buildPayoutHistory } from "../src/services/payout-history";
import type { LedgerEntry } from "../src/services/ports";

function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw Error("fixture");
  return r.value;
}
const seller = {
  id: value(sellerId("seller_review")),
  runId: value(runId("run_review")),
  externalId: "review",
  email: "review@example.invalid",
  country: "US" as const,
  whopAccountId: null,
  salePolicy: "direct" as const,
  status: "active" as const,
};
function entry(status: string, second: number, amount = 0): LedgerEntry {
  return {
    sellerId: seller.id,
    runId: seller.runId,
    accountSide: "seller",
    resourceType: "payout",
    resourceId: "po_review",
    kind: `payout_${status}`,
    effectKey: value(parseEffectKey(`payout:po_review:${status}`)),
    amount: value(money(amount, "USD")),
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)),
  };
}
it.each(["requested", "in_review", "processing", "denied"])(
  "keeps supported current inbox status %s visible",
  (status) => {
    expect(buildPayoutHistory([entry(status, 1)])).toHaveLength(1);
  },
);
it("does not present a subsequently reversed payout as paid out", () => {
  const history = buildPayoutHistory([entry("completed", 1, -2500), entry("reversed", 2)]);
  expect(history[0]?.status).not.toBe("paid_out");
  expect(history[0]?.date).toBe("2026-01-01T00:00:02.000Z");
});
it("prefers reversal evidence over completion when timestamps tie in either input order", () => {
  const completed = entry("completed", 1, -2500);
  const reversed = entry("reversed", 1);
  for (const input of [
    [completed, reversed],
    [reversed, completed],
  ]) {
    const row = buildPayoutHistory(input)[0];
    expect(row?.status).toBe("reversed");
    expect(row?.amount).toEqual({ amountMinor: 2500, currency: "USD" });
  }
});
it("retains every supported payout across unrelated newer ledger activity", () => {
  const states = [
    "requested",
    "in_review",
    "processing",
    "pending",
    "in_transit",
    "completed",
    "reversed",
    "denied",
    "canceled",
    "failed",
  ];
  const entries = states.map((s, i) => ({
    ...entry(s, i + 1, s === "completed" ? -2500 : 0),
    resourceId: `po_${s}`,
  }));
  entries.push(
    ...Array.from({ length: 40 }, (_, i) => ({
      ...entry("completed", 45, -2500),
      resourceType: "payment",
      kind: "payment",
      resourceId: `pay_${i}`,
    })),
  );
  const rows = buildPayoutHistory(entries);
  expect(rows).toHaveLength(10);
  expect(new Set(rows.map((row) => row.id)).size).toBe(10);
});
