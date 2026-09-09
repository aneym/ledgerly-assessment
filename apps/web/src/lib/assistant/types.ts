// Shared types for the operator assistant backend: the request shape the marketplace-owned
// sidebar sends, the custom UI-message data parts the stream emits, and the small session
// type every tool re-checks against. Kept separate from tools.ts/route.ts so both can import
// without a cycle.
import type { UIMessage } from "ai";

export type AssistantContextKind = "issue" | "ledger_entry" | "seller" | null;

// The selected-record context the sidebar sends alongside the chat turn, per the
// marketplace lane's contract: which kind of admin record the operator was looking at
// (or null off any admin page), its id, and the route it came from.
export type AssistantContext = {
  kind: AssistantContextKind;
  id: string | null;
  route: string;
};

export type AssistantChatRequestBody = {
  id: string;
  messages: unknown[];
  context: AssistantContext;
};

// A record the assistant can link back into the admin UI. "order" is not one of the
// context kinds the sidebar sends (orders have no admin page yet), but getOrder is one of
// the eight tools, so its result still needs a source kind of its own.
export type SourceKind = "issue" | "ledger_entry" | "seller" | "order";

export type SourceData = {
  kind: SourceKind;
  id: string;
  label: string;
  href: string;
  // Where the record came from ("sandbox", "mock", "app"), per the marketplace contract.
  provenance: string;
};

export type SuggestionsData = {
  questions: string[];
};

// The data-part vocabulary is exactly the two kinds the contract calls for:
// data-suggestions (once, at stream start) and data-source (once per resolved record).
export type AssistantUIMessage = UIMessage<
  never,
  {
    suggestions: SuggestionsData;
    source: SourceData;
  }
>;

export type AssistantSession = { userId: string; role: string };

export type GetSessionFn = () => Promise<AssistantSession | null>;

export function isOperatorSession(session: AssistantSession | null): boolean {
  return session !== null && session.role === "operator";
}
