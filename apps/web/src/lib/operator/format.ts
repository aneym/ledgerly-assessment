import { toDecimalString } from "@ledgerly/core/money";
import type {
  CapabilityState,
  LedgerEntryStatus,
  LedgerEntryType,
  Money,
  SalePolicy,
  VerificationState,
} from "./types";

const PREFIX: Record<Money["currency"], string> = { USD: "$", EUR: "€", BRL: "R$" };

/** "$55.20" or "−$55.20" with a true minus sign. Two decimals always, via core's toDecimalString. */
export function money(value: Money | null): string {
  if (!value) return "";
  const text = toDecimalString({ ...value, amountMinor: Math.abs(value.amountMinor) });
  return `${value.amountMinor < 0 ? "−" : ""}${PREFIX[value.currency]}${text}`;
}

type Timestamp = string | number | Date | null | undefined;
const TIME_PENDING = "pending";

/** App ISO dates and provider epoch seconds; millisecond epochs remain supported. */
function parseTimestamp(value: Timestamp): Date | null {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : null;
  const date =
    numeric !== null
      ? new Date(Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric)
      : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** "Sep 08" for a table, "Sep 08, 2026, 14:32 UTC" for a panel. */
export function shortDate(iso: Timestamp): string {
  const d = parseTimestamp(iso);
  if (!d) return TIME_PENDING;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  }).format(d);
}

export function longDate(iso: Timestamp): string {
  const d = parseTimestamp(iso);
  if (!d) return TIME_PENDING;
  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(d);
  return `${day}, ${time} UTC`;
}

export const POLICY_LABEL: Record<SalePolicy, string> = {
  direct: "Direct",
  platform_only: "Platform only",
};

export const POLICY_SENTENCE: Record<SalePolicy, string> = {
  direct: "The seller charges the buyer. Ledgerly takes 8 percent as an application fee.",
  platform_only:
    "Ledgerly charges the buyer, keeps 8 percent, and transfers the rest to the seller.",
};

export const VERIFICATION_LABEL: Record<VerificationState, string> = {
  not_started: "Not started",
  pending: "Pending",
  verified: "Verified",
};

export const CAPABILITY_LABEL: Record<CapabilityState, string> = {
  active: "active",
  inactive: "inactive",
  pending: "pending",
};

export const ACTION_LABEL: Record<string, string> = {
  identity_verification: "Identity verification",
  external_account: "External account",
  hosted_onboarding: "Hosted onboarding",
};

export const actionLabel = (key: string) => ACTION_LABEL[key] ?? key;

export const TYPE_LABEL: Record<LedgerEntryType, string> = {
  payment: "Payment",
  fee: "Fee",
  transfer: "Transfer",
  refund: "Refund",
  payout: "Payout",
};

export const STATUS_LABEL: Record<LedgerEntryStatus, string> = {
  settling: "Settling",
  settled: "Settled",
  pending: "Pending",
  held: "Held",
  refunded: "Refunded",
  paid_out: "Paid out",
  failed: "Failed",
};

export type Tone = "ok" | "warn" | "bad" | "plain";

export function statusTone(status: LedgerEntryStatus): Tone {
  switch (status) {
    case "settled":
    case "paid_out":
      return "ok";
    case "settling":
    case "pending":
      return "warn";
    case "held":
    case "failed":
      return "bad";
    default:
      return "plain";
  }
}

/** "Sep 08 14:32" in UTC, for the mono timestamp columns. */
export function stamp(iso: Timestamp): string {
  const d = parseTimestamp(iso);
  if (!d) return TIME_PENDING;
  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(d);
  return `${day} ${time}`;
}

/** "Sep 08" and "14:32", the two halves of a table date cell. */
export function dayOf(iso: Timestamp): string {
  const d = parseTimestamp(iso);
  if (!d) return TIME_PENDING;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  }).format(d);
}
export function timeOf(iso: Timestamp): string {
  const d = parseTimestamp(iso);
  if (!d) return TIME_PENDING;
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(d);
}

/** "3 days ago", "in 2 hours". For hover titles only, so it is computed on the client. */
export function relative(iso: Timestamp, now: number): string {
  const d = parseTimestamp(iso);
  if (!d || !Number.isFinite(now)) return TIME_PENDING;
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === "minute") return rtf.format(Math.round(diff / ms), unit);
  }
  return "now";
}

/** Two-letter initials for a business without an avatar; one rule for the whole app. */
export { initialsOf as initials } from "@/lib/identity/mark";

export function verificationTone(state: VerificationState): Tone {
  if (state === "verified") return "ok";
  if (state === "pending") return "warn";
  return "plain";
}
