// Pure helpers for the reconcile CLI: argument parsing and report formatting.
// No I/O here, so apps/web/test/scripts/reconcile-format.test.ts can cover every branch.
import type { Money, ReconciliationReport } from "@ledgerly/core";

export type ReconcileArgs = {
  seller: string | null;
  json: boolean;
  mock: boolean;
  maxPages: number;
  envFile: string | null;
};

export const USAGE = [
  "Usage: pnpm reconcile --seller <sellerId|biz_...> [--json] [--max-pages N] [--env-file PATH]",
  "       pnpm reconcile --mock [--seller <sellerId>] [--json]",
  "",
  "  --seller     Local seller id, or the seller's Whop account id (biz_...).",
  "  --mock       Mock adapter plus an in-memory database seeded with one seller. No credentials.",
  "  --json       Print one JSON document and no summary line.",
  "  --max-pages  Provider pages read per resource type (default 10, max 1000).",
  "  --env-file   Dotenv file for missing WHOP_* and DATABASE_URL values (default apps/web/.env.local).",
].join("\n");

export function parseArgs(argv: readonly string[]): ReconcileArgs {
  const args: ReconcileArgs = {
    seller: null,
    json: false,
    mock: false,
    maxPages: 10,
    envFile: null,
  };
  const rest = argv.filter((arg) => arg !== "--");
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--json") args.json = true;
    else if (flag === "--mock") args.mock = true;
    else if (flag === "--seller") {
      const value = rest[++i];
      if (!value || value.startsWith("--")) throw new Error("--seller needs a value");
      args.seller = value;
    } else if (flag === "--env-file") {
      const value = rest[++i];
      if (!value || value.startsWith("--")) throw new Error("--env-file needs a path");
      args.envFile = value;
    } else if (flag === "--max-pages") {
      const value = Number(rest[++i]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
        throw new Error("--max-pages needs an integer from 1 to 1000");
      args.maxPages = value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.mock && !args.seller) throw new Error("--seller is required without --mock");
  return args;
}

export type ReconcileOutcome = {
  mode: "mock" | "sandbox";
  sellerId: string;
  whopAccountId: string;
  generatedAt: string;
  report: ReconciliationReport;
};

export function formatMoney(amount: Money): string {
  const sign = amount.amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amount.amountMinor);
  const whole = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${cents} ${amount.currency}`;
}

function count(label: string, n: number): string {
  return `${n} ${label}`;
}

// One line an operator can read in a log. Drift counts come straight from the report;
// "matched" counts comparisons where both sides agree, which is only settled when the
// provider status is confirmed (the JSON carries providerStatus for that check).
export function summarize(outcome: ReconcileOutcome): string {
  const { report } = outcome;
  const comparisons = report.comparisons ?? [];
  const matched = comparisons.filter((row) => row.matches).length;
  const parts = [
    count("compared", comparisons.length),
    count("matched", matched),
    count("missing locally", report.missingLocally.length),
    count("missing at provider", report.missingAtProvider.length),
    count("amount mismatches", report.amountMismatch.length),
    count("pending or reserve", report.pendingOrReserve.length),
  ];
  const transfers =
    report.transfersUnavailable === undefined
      ? "transfers listed"
      : `transfers unavailable (${report.transfersUnavailable})`;
  const activity = report.financialActivity
    ? report.financialActivity.provider
      ? `; activity ${count("lines", report.financialActivity.lines.length)}, ${count(
          "matched",
          report.financialActivity.comparisons.filter((row) => row.matches).length,
        )}`
      : `; activity unavailable (${report.financialActivity.provider_error ?? "unknown"})`
    : "";
  return `reconcile ${outcome.mode} seller ${outcome.sellerId} (${outcome.whopAccountId}): ${parts.join(", ")}; ${transfers}${activity}`;
}

export function formatDrift(report: ReconciliationReport): string[] {
  const lines: string[] = [];
  for (const item of report.missingLocally)
    lines.push(
      `  missing locally: ${item.resourceType} ${item.resourceId} ${formatMoney(item.amount)}`,
    );
  for (const item of report.missingAtProvider)
    lines.push(
      `  missing at provider: ${item.resourceType} ${item.resourceId} ${formatMoney(item.amount)}`,
    );
  for (const pair of report.amountMismatch)
    lines.push(
      `  amount mismatch: ${pair.local.resourceType} ${pair.local.resourceId} local ${formatMoney(
        pair.local.amount,
      )} provider ${formatMoney(pair.provider.amount)}`,
    );
  for (const item of report.pendingOrReserve)
    lines.push(
      `  ${item.status}: ${item.resourceType} ${item.resourceId} ${formatMoney(item.amount)}`,
    );
  return lines;
}

// Default output: summary line, drift lines, then the report as pretty JSON.
// --json output: one JSON document with the run metadata and the report.
export function formatOutcome(outcome: ReconcileOutcome, json: boolean): string {
  if (json) return JSON.stringify(outcome, null, 2);
  return [
    summarize(outcome),
    ...formatDrift(outcome.report),
    JSON.stringify(outcome.report, null, 2),
  ].join("\n");
}

export function formatFailure(
  input: { mode: "mock" | "sandbox"; seller: string; error: unknown },
  json: boolean,
): string {
  const kind =
    typeof input.error === "object" && input.error && "kind" in input.error
      ? String((input.error as { kind: unknown }).kind)
      : "unknown";
  if (json)
    return JSON.stringify(
      { mode: input.mode, seller: input.seller, ok: false, error: input.error },
      null,
      2,
    );
  return `reconcile ${input.mode} seller ${input.seller}: failed (${kind})`;
}
