import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReceiptSlip } from "../../src/components/buyer/ReceiptSlip";
import { resolveCover, resolveSeller } from "../../src/components/buyer/resolve";
import { toOrderView } from "../../src/lib/buyer/api";

function render(overrides: Record<string, unknown> = {}) {
  const order = toOrderView({
    id: "order_1",
    product: { title: "Course" },
    gross: { amountMinor: 2500, currency: "USD" },
    status: "paid",
    payment_id: "pay_1",
    flow: "platform_transfer",
    seller: { id: "seller_1", name: "Seller", sale_policy: "direct" },
    ...overrides,
  });
  if (!order) throw new Error("Invalid test order");
  return renderToStaticMarkup(
    createElement(ReceiptSlip, {
      order,
      cover: resolveCover(order.product),
      seller: resolveSeller(order.seller),
      correlationId: "receipt_test",
    }),
  );
}
describe("receipt refund eligibility", () => {
  it("offers a paid platform refund using the historical flow despite current seller policy", () => {
    const html = render();
    expect(html).toContain('data-tour="receipt.refund"');
    expect(html).toContain("Ledgerly took this payment");
  });
  it.each(["pending", "checkout_created", "failed", "refunded", "unknown"])(
    "does not offer a refund or claim payment for %s",
    (status) => {
      const html = render({ status });
      expect(html).not.toContain('data-tour="receipt.refund"');
      expect(html).not.toContain("You paid");
      expect(html).not.toContain("Paid by card");
    },
  );
  it("keeps a paid direct order directed to the seller after a policy change", () => {
    const html = render({
      flow: "direct",
      seller: { name: "Creator", sale_policy: "platform_only" },
    });
    expect(html).not.toContain('data-tour="receipt.refund"');
    expect(html).toContain("Creator took this payment");
  });
  it.each([{ flow: undefined }, { flow: "unknown" }, { payment_id: null }])(
    "fails closed when payment or charge information is missing: %j",
    (change) => {
      expect(render(change)).not.toContain('data-tour="receipt.refund"');
    },
  );
});
