import { type Money, money } from "../money";
import type { LedgerEntry } from "./ports";

export type PayoutHistoryRow = {
  id: string;
  date: string;
  amount: Money | null;
  status:
    | "requested"
    | "pending"
    | "in_review"
    | "processing"
    | "in_transit"
    | "paid_out"
    | "failed"
    | "canceled"
    | "denied"
    | "reversed";
};

type Transition = {
  status: PayoutHistoryRow["status"];
  terminal: boolean;
  tieOrder: number;
};

// Matches every payout status accepted by the inbox, including its legacy vocabulary.
const TRANSITIONS: Record<string, Transition> = {
  payout_requested: { status: "requested", terminal: false, tieOrder: 0 },
  payout_pending: { status: "pending", terminal: false, tieOrder: 1 },
  payout_in_review: { status: "in_review", terminal: false, tieOrder: 2 },
  payout_processing: { status: "processing", terminal: false, tieOrder: 3 },
  payout_in_transit: { status: "in_transit", terminal: false, tieOrder: 4 },
  payout_canceled: { status: "canceled", terminal: true, tieOrder: 5 },
  payout_denied: { status: "denied", terminal: true, tieOrder: 6 },
  payout_failed: { status: "failed", terminal: true, tieOrder: 7 },
  payout_completed: { status: "paid_out", terminal: true, tieOrder: 8 },
  payout_reversed: { status: "reversed", terminal: true, tieOrder: 9 },
};

type Observation = { entry: LedgerEntry; transition: Transition };

function compare(a: Observation, b: Observation): number {
  // A late pending/in-transit delivery cannot erase a terminal outcome. Among
  // terminal outcomes, chronology permits a later failure after completion.
  if (a.transition.terminal !== b.transition.terminal) return a.transition.terminal ? 1 : -1;
  const time = a.entry.occurredAt.getTime() - b.entry.occurredAt.getTime();
  // Progress cannot regress to an earlier stage. For tied terminal outcomes,
  // reversal takes precedence over completion so a recorded reversal stays visible;
  // completion then takes precedence over failed, denied and canceled.
  if (!a.transition.terminal) return a.transition.tieOrder - b.transition.tieOrder || time;
  return time || a.transition.tieOrder - b.transition.tieOrder;
}

function payoutAmount(entry: LedgerEntry): Money {
  const amount = money(Math.abs(entry.amount.amountMinor), entry.amount.currency);
  if (!amount.ok) throw new Error("Invalid amount on a persisted payout completion");
  return amount.value;
}

/** Read-only projection of one seller's ledger, with no mixed-activity page limit. */
export function buildPayoutHistory(entries: readonly LedgerEntry[]): PayoutHistoryRow[] {
  const payouts = new Map<string, { current: Observation; completed: Observation | null }>();
  for (const entry of entries) {
    if (entry.accountSide !== "seller" || entry.resourceType !== "payout") continue;
    if (!Object.hasOwn(TRANSITIONS, entry.kind)) continue;
    const transition = TRANSITIONS[entry.kind];
    if (!transition) continue;
    const observation = { entry, transition };
    let payout = payouts.get(entry.resourceId);
    if (!payout) {
      payout = { current: observation, completed: null };
      payouts.set(entry.resourceId, payout);
    }
    if (compare(observation, payout.current) > 0) payout.current = observation;
    if (
      entry.kind === "payout_completed" &&
      (!payout.completed || compare(observation, payout.completed) > 0)
    ) {
      payout.completed = observation;
    }
  }
  return [...payouts.entries()]
    .map(
      ([id, { current, completed }]): PayoutHistoryRow => ({
        id,
        date: current.entry.occurredAt.toISOString(),
        // Non-completion rows carry zero accounting effects, not requested amounts.
        // A later failure can retain the amount known from a prior completed debit.
        amount: completed ? payoutAmount(completed.entry) : null,
        status: current.transition.status,
      }),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
