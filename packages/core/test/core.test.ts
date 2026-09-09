import { describe, expect, it } from "vitest";
import {
  add,
  canonicalEventType,
  canSellDirect,
  computePlatformFee,
  effectKey,
  fromDecimalString,
  money,
  type Result,
  runId,
  type Seller,
  sellerId,
  subtract,
  toDecimalString,
  whopAccountId,
  whopPaymentId,
} from "../src/index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
describe("money", () => {
  it.each([0, 1, -1, 2500, -2500, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
    "round trips %s minor units",
    (amount) => {
      const original = value(money(amount, "USD"));
      expect(fromDecimalString(toDecimalString(original), "USD")).toEqual({
        ok: true,
        value: original,
      });
    },
  );
  it.each(["NaN", "1e2", "1.001", " 1.00", ".50", "90071992547409.92"])(
    "rejects invalid decimal %s",
    (input) => {
      expect(fromDecimalString(input, "USD").ok).toBe(false);
    },
  );
  it("supports all currencies and one decimal place", () => {
    for (const currency of ["USD", "EUR", "BRL"] as const)
      expect(fromDecimalString("25.5", currency)).toEqual({
        ok: true,
        value: { amountMinor: 2550, currency },
      });
  });
  it("rejects unsafe and fractional amounts", () => {
    for (const amount of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(money(amount, "USD").ok).toBe(false);
  });
  it("adds and subtracts exactly and rejects overflow", () => {
    expect(
      add({ amountMinor: 2300, currency: "USD" }, { amountMinor: 200, currency: "USD" }),
    ).toEqual({ ok: true, value: { amountMinor: 2500, currency: "USD" } });
    expect(
      subtract({ amountMinor: 0, currency: "USD" }, { amountMinor: 200, currency: "USD" }),
    ).toEqual({ ok: true, value: { amountMinor: -200, currency: "USD" } });
    expect(
      add(
        { amountMinor: Number.MAX_SAFE_INTEGER, currency: "USD" },
        { amountMinor: 1, currency: "USD" },
      ),
    ).toEqual({ ok: false, error: { kind: "overflow" } });
  });
  it("rejects currency mismatch", () => {
    for (const operation of [add, subtract])
      expect(
        operation({ amountMinor: 2500, currency: "USD" }, { amountMinor: 200, currency: "EUR" }),
      ).toEqual({ ok: false, error: { kind: "currency_mismatch" } });
  });
});
describe("fees", () => {
  it("allocates 25.00 USD to 2.00 and 23.00", () => {
    expect(computePlatformFee({ amountMinor: 2500, currency: "USD" })).toEqual({
      ok: true,
      value: {
        fee: { amountMinor: 200, currency: "USD" },
        sellerShare: { amountMinor: 2300, currency: "USD" },
      },
    });
  });
  it("rejects one minor unit gross", () => {
    expect(computePlatformFee({ amountMinor: 1, currency: "USD" })).toEqual({
      ok: false,
      error: { kind: "fee_not_positive" },
    });
  });
  it("rounds a half minor unit up", () => {
    expect(
      value(computePlatformFee({ amountMinor: 25, currency: "USD" }, 1000)).fee.amountMinor,
    ).toBe(3);
  });
  it.each([
    [24, 2],
    [26, 3],
  ])("rounds %s minor units at ten percent to %s", (gross, fee) => {
    expect(
      value(computePlatformFee({ amountMinor: gross, currency: "USD" }, 1000)).fee.amountMinor,
    ).toBe(fee);
  });
  it("rejects fees equal to or above gross", () => {
    for (const rate of [10000, 11000])
      expect(computePlatformFee({ amountMinor: 100, currency: "USD" }, rate)).toEqual({
        ok: false,
        error: { kind: "fee_not_less_than_gross" },
      });
  });
  it("rejects invalid gross and rates", () => {
    expect(computePlatformFee({ amountMinor: 0, currency: "USD" }).ok).toBe(false);
    for (const rate of [-1, 0.5, NaN])
      expect(computePlatformFee({ amountMinor: 2500, currency: "USD" }, rate).ok).toBe(false);
  });
  it("handles the maximum safe amount without precision loss", () => {
    expect(
      value(computePlatformFee({ amountMinor: Number.MAX_SAFE_INTEGER, currency: "USD" })).fee
        .amountMinor,
    ).toBe(720575940379279);
  });
});
describe("policy and identity", () => {
  const seller: Seller = {
    id: value(sellerId("seller")),
    runId: value(runId("run")),
    externalId: "external",
    email: "fictional@example.invalid",
    country: "US",
    whopAccountId: null,
    salePolicy: "direct",
    status: "active",
  };
  it("allows active direct sellers", () => {
    expect(canSellDirect(seller)).toEqual({ ok: true, value: true });
  });
  it("rejects platform-only sellers", () => {
    expect(canSellDirect({ ...seller, salePolicy: "platform_only" })).toEqual({
      ok: false,
      error: { kind: "platform_only" },
    });
  });
  it("rejects suspended sellers under either policy", () => {
    for (const salePolicy of ["direct", "platform_only"] as const)
      expect(canSellDirect({ ...seller, status: "suspended", salePolicy })).toEqual({
        ok: false,
        error: { kind: "seller_suspended" },
      });
  });
  it("validates prefixes and nonempty IDs", () => {
    expect(whopAccountId("pay_wrong").ok).toBe(false);
    expect(whopPaymentId("biz_wrong").ok).toBe(false);
    expect(whopAccountId("biz_").ok).toBe(false);
    expect(sellerId("").ok).toBe(false);
  });
  it("deduplicates payout aliases without collapsing transitions", () => {
    expect(canonicalEventType("withdrawal.created")).toBe("payout.created");
    expect(effectKey("withdrawal", "payout_1", "updated")).toBe("payout:payout_1:updated");
    expect(effectKey("payout", "payout_1", "created")).not.toBe(
      effectKey("payout", "payout_1", "updated"),
    );
  });
});

it("preserves unknown event names including object property names", () => {
  expect(canonicalEventType("toString")).toBe("toString");
});
