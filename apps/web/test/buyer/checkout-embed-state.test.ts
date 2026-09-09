import { describe, expect, it } from "vitest";
import {
  chooseSurface,
  type EmbedPhase,
  isPaidStatus,
  offersHostedFallback,
  reduce,
} from "@/lib/buyer/checkout-embed-state";

const loading: EmbedPhase = { kind: "loading" };

describe("chooseSurface", () => {
  it("mounts the real embed only for a provider-issued configuration", () => {
    expect(
      chooseSurface({
        provenance: "sandbox",
        checkoutConfigurationId: "ch_123",
        purchaseUrl: "https://sandbox.whop.com/checkout/ch_123",
      }),
    ).toBe("embed");
  });
  it("shows the labelled simulation for mock provenance or a mock purchase url", () => {
    expect(
      chooseSurface({ provenance: "mock", checkoutConfigurationId: "ch_1", purchaseUrl: null }),
    ).toBe("simulation");
    expect(
      chooseSurface({
        provenance: "sandbox",
        checkoutConfigurationId: "ch_1",
        purchaseUrl: "https://mock.invalid/checkout/ch_1",
      }),
    ).toBe("simulation");
  });
  it("is unavailable without a configuration", () => {
    expect(
      chooseSurface({ provenance: "sandbox", checkoutConfigurationId: null, purchaseUrl: null }),
    ).toBe("unavailable");
  });
});

describe("completion is idempotent and never marks paid on its own", () => {
  it("counts repeated completion callbacks without changing the outcome", () => {
    const once = reduce(loading, { type: "complete", receiptId: "rcpt_1" });
    expect(once).toEqual({ kind: "completed", receiptId: "rcpt_1", completions: 1 });
    const twice = reduce(once, { type: "complete", receiptId: "rcpt_1" });
    expect(twice).toEqual({ kind: "completed", receiptId: "rcpt_1", completions: 2 });
  });
  it("confirms only when the server reads the order as paid", () => {
    const completed = reduce(loading, { type: "complete", receiptId: null });
    expect(reduce(completed, { type: "order_read", status: "checkout_created" })).toEqual(
      completed,
    );
    expect(reduce(completed, { type: "order_read", status: "paid" })).toEqual({
      kind: "confirmed",
      receiptId: null,
    });
  });
  it("ignores a paid read before any completion (the page shows the server status instead)", () => {
    expect(reduce(loading, { type: "order_read", status: "paid" })).toEqual(loading);
  });
  it("does not regress a completed checkout on later errors or state flickers", () => {
    const completed = reduce(loading, { type: "complete", receiptId: "r" });
    expect(reduce(completed, { type: "payment_error", message: "x", code: null })).toEqual(
      completed,
    );
    expect(reduce(completed, { type: "state", state: "loading" })).toEqual(completed);
    expect(reduce(completed, { type: "timeout" })).toEqual(completed);
  });
});

describe("hosted fallback gating", () => {
  it("is offered only when the embed never reported ready", () => {
    expect(offersHostedFallback(loading)).toBe(false);
    expect(offersHostedFallback(reduce(loading, { type: "timeout" }))).toBe(true);
    const ready = reduce(loading, { type: "state", state: "ready" });
    expect(offersHostedFallback(reduce(ready, { type: "timeout" }))).toBe(false);
  });
  it("is offered on an explicit load error, with the reason kept", () => {
    const failed = reduce(loading, { type: "load_error", reason: "blocked by CSP" });
    expect(failed).toEqual({ kind: "mount_failed", reason: "blocked by CSP" });
    expect(offersHostedFallback(failed)).toBe(true);
  });
  it("a payment decline keeps the embed, without the fallback", () => {
    const ready = reduce(loading, { type: "state", state: "ready" });
    const declined = reduce(ready, {
      type: "payment_error",
      message: "Declined",
      code: "card_declined",
    });
    expect(declined).toEqual({ kind: "payment_error", message: "Declined", code: "card_declined" });
    expect(offersHostedFallback(declined)).toBe(false);
  });
});

describe("isPaidStatus", () => {
  it("accepts the paid synonyms the receipt uses and nothing else", () => {
    expect(isPaidStatus("paid")).toBe(true);
    expect(isPaidStatus("Settled")).toBe(true);
    expect(isPaidStatus("checkout_created")).toBe(false);
    expect(isPaidStatus("refunded")).toBe(false);
  });
});
