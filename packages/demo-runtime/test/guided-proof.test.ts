import { describe, expect, it } from "vitest";
import { mapTourInstrumentation, type InstrumentationEvent } from "../src/instrumentation";
import { reduceTour } from "../src/tour";

function journey() {
  const rows: InstrumentationEvent[] = [];
  function call(step: string, method: string, path: string, facts: Record<string, string>, support?: { db?: string; provider?: string }) {
    const correlation = `request-${rows.length}`;
    const add = (source: InstrumentationEvent["source"], eventMethod: string, eventPath: string, safe_ids: Record<string, string>) => rows.push({
      id: `event-${rows.length}`, seq: rows.length + 1, correlation_id: correlation, run_id: "run_demo", source,
      phase: "end", method: eventMethod, path: eventPath, status: source === "db" ? "ok" : 200,
      provenance: source === "whop" ? "mock" : source === "db" ? "pglite" : "app",
      safe_ids, summary: "Observed test boundary response", duration_ms: 1, at: "2026-09-09T00:00:00.000Z",
    });
    if (support?.db) add("db", "", support.db, {});
    if (support?.provider) add("whop", "POST", support.provider, {});
    add("app_api", method, path, { tour_step: step, ...facts });
  }
  call("C01", "POST", "/api/sellers", { tour_seller_id: "seller_1", tour_source: "mock" }, { db: "sellers", provider: "/accounts" });
  call("C02", "POST", "/api/sellers/seller_1/onboarding-link", {}, { provider: "/account_links" });
  call("C02", "POST", "/api/products", { tour_product_id: "product_1" });
  call("C03", "POST", "/api/checkouts", { tour_order_id: "order_1" }, { db: "orders", provider: "/checkout_configurations" });
  call("C03", "GET", "/api/orders/order_1", { tour_order_id: "order_1", tour_payment_id: "pay_1", tour_order_paid: "true", tour_seller_id: "seller_1", tour_product_id: "product_1", tour_source: "mock" });
  call("C04", "GET", "/api/sellers/seller_1/earnings", { tour_earnings_payment_ids: "pay_1" });
  call("C05", "POST", "/api/sellers/seller_1/payouts/simulation", { tour_sample_started: "true", tour_source: "mock" });
  call("C05", "POST", "/api/sellers/seller_1/payouts/simulation", { tour_sample_payout_id: "payout_1", tour_sample_payout_status: "requested", tour_source: "mock" });
  call("C06", "POST", "/api/admin/issues/demo-fault", { tour_case_id: "case_1", tour_seller_id: "seller_1", tour_source: "mock" });
  for (const action of ["refetch", "import_confirmed", "recheck"]) call("C07", "POST", `/api/admin/issues/case_1/actions/${action}`, {
    tour_case_id: "case_1", tour_issue_action: action, tour_action_succeeded: "true", tour_source: "mock", ...(action === "recheck" ? { tour_issue_resolved: "true" } : {}),
  }, { db: "resolution_run" });
  return rows;
}

describe("persisted guided proof", () => {
  it("replays all seven strict chapters from run-scoped server facts", () => {
    const state = reduceTour(mapTourInstrumentation(journey(), "run_demo"));
    expect(state.steps.map((step) => step.status)).toEqual(Array(7).fill("passed"));
    expect(state.outcome).toBe("completed");
  });
  it("cannot finish after the first repair action", () => {
    const rows = journey();
    const firstRepair = rows.findIndex((row) => row.path.endsWith("/actions/refetch"));
    const state = reduceTour(mapTourInstrumentation(rows.slice(0, firstRepair + 1), "run_demo"));
    expect(state.steps[6]?.status).toBe("observing");
    expect(state.steps[6]?.step.anchor).toBe("admin.issues.guided.import_confirmed");
    expect(state.outcome).toBe("in-progress");
  });
  it("rejects missing, foreign-run and ambiguous correlation evidence", () => {
    for (const mutate of [
      (rows: InstrumentationEvent[]) => rows.filter((row) => row.path !== "/api/orders/order_1"),
      (rows: InstrumentationEvent[]) => rows.map((row) => ({ ...row, run_id: "run_foreign" })),
      (rows: InstrumentationEvent[]) => rows.map((row) => ({ ...row, correlation_id: "forged-shared-correlation" })),
    ]) expect(reduceTour(mapTourInstrumentation(mutate(journey()), "run_demo")).outcome).not.toBe("completed");
  });
  it("rejects a paid order from another product or seller and a stale wrong payment earnings row", () => {
    for (const field of ["tour_product_id", "tour_seller_id"]) {
      const rows = journey();
      const order = rows.find((row) => row.path === "/api/orders/order_1");
      if (!order) throw new Error("missing fixture");
      order.safe_ids[field] = "foreign";
      expect(reduceTour(mapTourInstrumentation(rows, "run_demo")).steps[2]?.status).toBe("observing");
    }
    const rows = journey();
    const earnings = rows.find((row) => row.path.endsWith("/earnings"));
    if (!earnings) throw new Error("missing fixture");
    earnings.safe_ids.tour_earnings_payment_ids = "pay_other";
    expect(reduceTour(mapTourInstrumentation(rows, "run_demo")).steps[3]?.status).toBe("observing");
  });
});

it("does not replace accepted identities with later unrelated successful creations", () => {
  const rows = journey();
  const last = rows.at(-1);
  if (!last) throw new Error("missing fixture");
  rows.push({ ...last, id: "later-order", seq: last.seq + 1, correlation_id: "later-order", source: "app_api", method: "POST", path: "/api/checkouts", safe_ids: { tour_step: "C03", tour_order_id: "order_unpaid" } });
  const state = reduceTour(mapTourInstrumentation(rows, "run_demo"));
  expect(state.steps[2]?.proof.observed.tour_order_id).toBe("order_1");
  expect(state.steps[2]?.proof.observed.tour_payment_id).toBe("pay_1");
});
