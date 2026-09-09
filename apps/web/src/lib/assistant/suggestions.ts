import type { AssistantContext } from "./types";

// Three to four suggested questions per selected context kind, per the marketplace lane's
// contract. Static per kind rather than model-generated: deterministic, free, and instant
// at stream start (the contract requires them emitted before any model output).
const BY_KIND: Record<NonNullable<AssistantContext["kind"]>, string[]> = {
  issue: [
    "What is the current status of this issue?",
    "What ledger entries are linked to this issue?",
    "What's the next action to resolve it?",
    "Has this issue happened before for this seller?",
  ],
  ledger_entry: [
    "What order does this ledger entry belong to?",
    "Who is the seller for this entry?",
    "Are there related entries for the same effect?",
    "Is this entry part of a completed payout?",
  ],
  seller: [
    "What is this seller's onboarding status?",
    "What capabilities are active for this seller?",
    "Show recent ledger activity for this seller.",
    "Are there any open issues for this seller?",
  ],
};

const NO_CONTEXT = [
  "How many issues are currently open?",
  "What is the platform's integration health?",
  "Show the most recent ledger entries.",
  "Which sellers have required actions pending?",
];

export function getSuggestedQuestions(context: AssistantContext): string[] {
  if (context.kind === null) return NO_CONTEXT;
  return BY_KIND[context.kind];
}
