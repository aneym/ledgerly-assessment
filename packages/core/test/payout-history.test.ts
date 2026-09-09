import { describe, expect, it } from "vitest";
import { parseEffectKey, runId, sellerId } from "../src/ids";
import { type Money, money } from "../src/money";
import type { Result } from "../src/result";
import { buildPayoutHistory } from "../src/services/payout-history";
import type { LedgerEntry } from "../src/services/ports";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Invalid fixture");
  return result.value;
}
function entry(
  id: string,
  status: string,
  date: string,
  amount: Money = value(money(0, "USD")),
): LedgerEntry {
  return {
    runId: value(runId("run_1")),
    sellerId: value(sellerId("seller_1")),
    accountSide: "seller",
    resourceType: "payout",
    resourceId: id,
    kind: `payout_${status}`,
    effectKey: value(parseEffectKey(`payout:${id}:${status}`)),
    occurredAt: new Date(date),
    amount,
  };
}
const EARLIER = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

describe("buildPayoutHistory", () => {
  it("keeps completion stable under replay, reordering and late pending delivery", () => {
    const completed = entry("po_1", "completed", EARLIER, value(money(-2300, "EUR")));
    const late = entry("po_1", "pending", LATER);
    const expected = [
      {
        id: "po_1",
        date: EARLIER,
        status: "paid_out",
        amount: { amountMinor: 2300, currency: "EUR" },
      },
    ];
    expect(buildPayoutHistory([completed, late, completed])).toEqual(expected);
    expect(buildPayoutHistory([late, completed])).toEqual(expected);
    expect(completed.amount.amountMinor).toBe(-2300);
  });
  it("uses the latest terminal transition and keeps an already known amount", () => {
    const completed = entry("po_1", "completed", EARLIER, value(money(-500, "BRL")));
    const failed = entry("po_1", "failed", LATER);
    for (const entries of [
      [completed, failed],
      [failed, completed],
    ]) {
      expect(buildPayoutHistory(entries)).toEqual([
        {
          id: "po_1",
          date: LATER,
          status: "failed",
          amount: { amountMinor: 500, currency: "BRL" },
        },
      ]);
    }
  });
  it("permits a later completion after a failed transition", () => {
    const failed = entry("po_1", "failed", EARLIER);
    const completed = entry("po_1", "completed", LATER, value(money(-500, "USD")));
    expect(buildPayoutHistory([completed, failed])[0]).toEqual({
      id: "po_1",
      date: LATER,
      status: "paid_out",
      amount: { amountMinor: 500, currency: "USD" },
    });
  });
  it("resolves tied terminal states deterministically, preferring the recorded completion", () => {
    const states = [
      entry("po_1", "completed", EARLIER, value(money(-500, "USD"))),
      entry("po_1", "failed", EARLIER),
      entry("po_1", "canceled", EARLIER),
    ];
    expect(buildPayoutHistory(states)[0]?.status).toBe("paid_out");
    expect(buildPayoutHistory([...states].reverse())).toEqual(buildPayoutHistory(states));
  });
  it("preserves in-transit progress when pending arrives later with an unknown amount", () => {
    expect(
      buildPayoutHistory([entry("po_1", "in_transit", EARLIER), entry("po_1", "pending", LATER)]),
    ).toEqual([{ id: "po_1", date: EARLIER, status: "in_transit", amount: null }]);
  });
  it("reports failed and canceled amounts as unknown without a completed debit", () => {
    expect(
      buildPayoutHistory([
        entry("po_failed", "failed", EARLIER),
        entry("po_canceled", "canceled", EARLIER),
      ]),
    ).toEqual([
      { id: "po_canceled", date: EARLIER, status: "canceled", amount: null },
      { id: "po_failed", date: EARLIER, status: "failed", amount: null },
    ]);
  });
  it("excludes platform entries, non-payout resources and unsupported kinds", () => {
    const payout = entry("po_1", "completed", EARLIER, value(money(-500, "USD")));
    expect(
      buildPayoutHistory([
        { ...payout, accountSide: "platform" },
        { ...payout, resourceType: "payment" },
        { ...payout, kind: "payout_unknown" },
        { ...payout, kind: "toString" },
      ]),
    ).toEqual([]);
  });
  it("returns all payouts in stable date and ID order without mutating input", () => {
    const payouts = Array.from({ length: 25 }, (_, i) =>
      entry(`po_${String(i).padStart(2, "0")}`, "pending", EARLIER),
    );
    const newest = entry("po_new", "pending", LATER);
    const input = Object.freeze([newest, ...payouts].reverse());
    const history = buildPayoutHistory(input);
    expect(history).toHaveLength(26);
    expect(history.map((row) => row.id)).toEqual([
      "po_new",
      ...payouts.map((row) => row.resourceId),
    ]);
    expect(input[0]?.resourceId).toBe("po_24");
  });
});

describe("current inbox payout vocabulary", () => {
  it.each(["requested", "in_review", "processing", "reversed", "denied"])(
    "includes %s with an unknown amount",
    (status) => {
      expect(buildPayoutHistory([entry("po_1", status, EARLIER)])).toEqual([
        { id: "po_1", date: EARLIER, status, amount: null },
      ]);
    },
  );
  it("shows a later reversal and retains the amount of the completed payout", () => {
    const completed = entry("po_1", "completed", EARLIER, value(money(-2500, "USD")));
    const reversed = entry("po_1", "reversed", LATER);
    const expected = [
      {
        id: "po_1",
        date: LATER,
        status: "reversed",
        amount: { amountMinor: 2500, currency: "USD" },
      },
    ];
    expect(buildPayoutHistory([completed, reversed])).toEqual(expected);
    expect(buildPayoutHistory([reversed, completed])).toEqual(expected);
  });
  it("prefers a reversal to completion when their timestamps tie", () => {
    const completed = entry("po_1", "completed", EARLIER, value(money(-2500, "USD")));
    const reversed = entry("po_1", "reversed", EARLIER);
    expect(buildPayoutHistory([completed, reversed])[0]?.status).toBe("reversed");
    expect(buildPayoutHistory([reversed, completed])[0]?.status).toBe("reversed");
  });
  it("preserves processing progress over a later requested or review notification", () => {
    expect(
      buildPayoutHistory([
        entry("po_1", "processing", EARLIER),
        entry("po_1", "in_review", LATER),
        entry("po_1", "requested", LATER),
      ]),
    ).toEqual([{ id: "po_1", date: EARLIER, status: "processing", amount: null }]);
  });
});
