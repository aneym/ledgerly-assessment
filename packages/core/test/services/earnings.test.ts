import { describe, expect, it } from "vitest";
import { parseEffectKey, runId, sellerId } from "../../src/ids";
import { money } from "../../src/money";
import type { Result } from "../../src/result";
import { createEarningsService } from "../../src/services/earnings";
import type { LedgerEntry, LedgerRepo } from "../../src/services/ports";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const run = value(runId("run_earnings"));
const seller = value(sellerId("seller_1"));

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    runId: run,
    sellerId: seller,
    accountSide: "seller",
    amount: value(money(1000, "USD")),
    kind: "payment",
    resourceType: "payment",
    resourceId: "pay_1",
    effectKey: value(parseEffectKey("effect_1")),
    occurredAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeLedger(entries: LedgerEntry[]): Pick<LedgerRepo, "forSeller"> {
  return {
    async forSeller() {
      return entries;
    },
  };
}

describe("createEarningsService", () => {
  it("sums only the seller's own side of the ledger, grouped by currency", async () => {
    const entries = [
      entry({ effectKey: value(parseEffectKey("effect_1")), amount: value(money(1000, "USD")) }),
      entry({
        effectKey: value(parseEffectKey("effect_1")),
        accountSide: "platform",
        amount: value(money(200, "USD")),
      }),
      entry({ effectKey: value(parseEffectKey("effect_2")), amount: value(money(2300, "USD")) }),
      entry({
        effectKey: value(parseEffectKey("effect_3")),
        amount: value(money(500, "EUR")),
        resourceId: "pay_2",
      }),
    ];
    const getEarnings = createEarningsService({ ledger: fakeLedger(entries) });
    const earnings = await getEarnings(seller);
    expect(earnings.totals).toEqual(
      expect.arrayContaining([
        { currency: "USD", total: { amountMinor: 3300, currency: "USD" } },
        { currency: "EUR", total: { amountMinor: 500, currency: "EUR" } },
      ]),
    );
    expect(earnings.totals).toHaveLength(2);
  });

  it("lists recent entries newest first, limited to the requested count", async () => {
    const entries = [
      entry({
        effectKey: value(parseEffectKey("effect_old")),
        occurredAt: new Date("2026-01-01T00:00:00Z"),
        resourceId: "pay_old",
      }),
      entry({
        effectKey: value(parseEffectKey("effect_new")),
        occurredAt: new Date("2026-08-01T00:00:00Z"),
        resourceId: "pay_new",
      }),
      entry({
        effectKey: value(parseEffectKey("effect_mid")),
        occurredAt: new Date("2026-04-01T00:00:00Z"),
        resourceId: "pay_mid",
      }),
    ];
    const getEarnings = createEarningsService({ ledger: fakeLedger(entries) });
    const earnings = await getEarnings(seller, 2);
    expect(earnings.recent.map((e) => e.resourceId)).toEqual(["pay_new", "pay_mid"]);
  });

  it("returns an empty report for a seller with no ledger entries", async () => {
    const getEarnings = createEarningsService({ ledger: fakeLedger([]) });
    const earnings = await getEarnings(seller);
    expect(earnings).toEqual({ totals: [], recent: [] });
  });
});
