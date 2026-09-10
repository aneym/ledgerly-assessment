import type { ReconciliationReport } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import {
  formatDrift,
  formatFailure,
  formatMoney,
  formatOutcome,
  parseArgs,
  type ReconcileOutcome,
  summarize,
} from "../../scripts/reconcile-format";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" as const });

function report(overrides: Partial<ReconciliationReport> = {}): ReconciliationReport {
  return {
    comparisons: [
      {
        resourceType: "payment",
        resourceId: "pay_matched",
        local: usd(2500),
        provider: usd(2500),
        providerStatus: "succeeded",
        matches: true,
      },
      {
        resourceType: "payment",
        resourceId: "pay_provider_only",
        local: null,
        provider: usd(1000),
        providerStatus: "succeeded",
        matches: false,
      },
      {
        resourceType: "transfer",
        resourceId: "trf_local_only",
        local: usd(500),
        provider: null,
        providerStatus: null,
        matches: false,
      },
    ],
    missingLocally: [
      { resourceType: "payment", resourceId: "pay_provider_only", amount: usd(1000) },
    ],
    missingAtProvider: [
      { resourceType: "transfer", resourceId: "trf_local_only", amount: usd(500) },
    ],
    amountMismatch: [],
    pendingOrReserve: [],
    ...overrides,
  };
}

function outcome(overrides: Partial<ReconcileOutcome> = {}): ReconcileOutcome {
  return {
    mode: "mock",
    sellerId: "seller-1",
    whopAccountId: "biz_mock_1",
    generatedAt: "2026-09-09T22:54:05.000Z",
    report: report(),
    ...overrides,
  };
}

describe("parseArgs", () => {
  it("reads the seller, flags, page bound and env file, ignoring pnpm's -- separator", () => {
    expect(
      parseArgs(["--", "--seller", "biz_x", "--json", "--max-pages", "3", "--env-file", "x.env"]),
    ).toEqual({
      seller: "biz_x",
      json: true,
      mock: false,
      maxPages: 3,
      envFile: "x.env",
    });
  });
  it("lets --mock run without a seller", () => {
    expect(parseArgs(["--mock"])).toEqual({
      seller: null,
      json: false,
      mock: true,
      maxPages: 10,
      envFile: null,
    });
  });
  it("rejects a missing seller, a bare --seller, a bad page bound and unknown flags", () => {
    expect(() => parseArgs([])).toThrow("--seller is required without --mock");
    expect(() => parseArgs(["--seller"])).toThrow("--seller needs a value");
    expect(() => parseArgs(["--seller", "--json"])).toThrow("--seller needs a value");
    expect(() => parseArgs(["--seller", "s", "--env-file"])).toThrow("--env-file needs a path");
    expect(() => parseArgs(["--seller", "s", "--max-pages", "0"])).toThrow("--max-pages");
    expect(() => parseArgs(["--seller", "s", "--max-pages", "1001"])).toThrow("--max-pages");
    expect(() => parseArgs(["--seller", "s", "--verbose"])).toThrow("Unknown argument: --verbose");
  });
});

describe("formatMoney", () => {
  it("prints minor units as a decimal with the currency", () => {
    expect(formatMoney(usd(2500))).toBe("25.00 USD");
    expect(formatMoney(usd(5))).toBe("0.05 USD");
    expect(formatMoney(usd(-1230))).toBe("-12.30 USD");
  });
});

describe("summarize", () => {
  it("counts every bucket on one line", () => {
    expect(summarize(outcome())).toBe(
      "reconcile mock seller seller-1 (biz_mock_1): 3 compared, 1 matched, 1 missing locally, " +
        "1 missing at provider, 0 amount mismatches, 0 pending or reserve; transfers listed",
    );
  });
  it("names an unavailable transfer read and the activity comparison", () => {
    const line = summarize(
      outcome({
        report: report({
          transfersUnavailable: "capability_inactive",
          financialActivity: {
            provider: {
              available: [],
              pending: [],
              reserve: [],
              line_count: 0,
              has_more: false,
              basis: "first_page_activity",
              provenance: "mock",
            },
            provider_error: null,
            lines: [],
            comparisons: [
              { resourceId: "pay_matched", provider: usd(2300), local: usd(2300), matches: true },
              { resourceId: "pay_other", provider: usd(100), local: null, matches: false },
            ],
          },
        }),
      }),
    );
    expect(line).toContain("transfers unavailable (capability_inactive)");
    expect(line).toContain("activity 0 lines, 1 matched");
  });
  it("reports a failed activity read without a provider summary", () => {
    const line = summarize(
      outcome({
        report: report({
          financialActivity: {
            provider: null,
            provider_error: "http",
            lines: [],
            comparisons: [],
          },
        }),
      }),
    );
    expect(line).toContain("activity unavailable (http)");
  });
});

describe("formatDrift", () => {
  it("lists one line per discrepancy with both amounts on a mismatch", () => {
    const lines = formatDrift(
      report({
        amountMismatch: [
          {
            local: { resourceType: "transfer", resourceId: "trf_a", amount: usd(2200) },
            provider: { resourceType: "transfer", resourceId: "trf_a", amount: usd(2300) },
          },
        ],
        pendingOrReserve: [
          { resourceType: "transfer", resourceId: "trf_p", amount: usd(500), status: "pending" },
        ],
      }),
    );
    expect(lines).toEqual([
      "  missing locally: payment pay_provider_only 10.00 USD",
      "  missing at provider: transfer trf_local_only 5.00 USD",
      "  amount mismatch: transfer trf_a local 22.00 USD provider 23.00 USD",
      "  pending: transfer trf_p 5.00 USD",
    ]);
  });
});

describe("formatOutcome", () => {
  it("prints the summary, drift lines and pretty report by default", () => {
    const text = formatOutcome(outcome(), false);
    const [first, ...rest] = text.split("\n");
    expect(first).toBe(summarize(outcome()));
    expect(rest.slice(0, 2)).toEqual(formatDrift(report()));
    expect(JSON.parse(rest.slice(2).join("\n"))).toEqual(report());
  });
  it("prints one JSON document with --json", () => {
    const parsed = JSON.parse(formatOutcome(outcome(), true));
    expect(parsed).toEqual(outcome());
    expect(parsed.report.comparisons).toHaveLength(3);
  });
});

describe("formatFailure", () => {
  it("names the error kind in text and keeps the error in JSON", () => {
    const input = { mode: "sandbox" as const, seller: "s", error: { kind: "page_limit" } };
    expect(formatFailure(input, false)).toBe("reconcile sandbox seller s: failed (page_limit)");
    expect(JSON.parse(formatFailure(input, true))).toEqual({
      mode: "sandbox",
      seller: "s",
      ok: false,
      error: { kind: "page_limit" },
    });
    expect(formatFailure({ ...input, error: new Error("boom") }, false)).toContain("(unknown)");
  });
});
