/**
 * The operator assistant contract as proposed to architecture. POST /api/admin/assistant
 * is a Vercel AI SDK UI message stream; GET /api/admin/assistant/health says whether
 * the gateway and model are configured. Nothing here fakes a model reply.
 */
import type { UIMessage } from "ai";
import { apiFetch } from "@/lib/catalog/api";
import type { Provenance } from "./types";

export const ASSISTANT_PATH = "/api/admin/assistant";
export const ASSISTANT_HEALTH_PATH = `${ASSISTANT_PATH}/health`;

export type ContextKind = "issue" | "ledger_entry" | "seller";

/** What the page has selected. Sent with every message so tools start from the right record. */
export type AssistantContext = {
  kind: ContextKind | null;
  id: string | null;
  route: string;
  /** Display only, never sent. */
  label?: string;
  href?: string;
};

export type AssistantSource = {
  kind: ContextKind | "order" | "reconciliation" | "event";
  id: string;
  label: string;
  href: string;
  /** The route does not send this today; shown when it does. */
  provenance?: Provenance;
};

/** Data parts the stream carries next to text and tool parts. The route sends { questions }. */
export type AssistantData = {
  suggestions: { questions: string[] } | string[];
  source: AssistantSource;
};

/** Both shapes the contract has named for data-suggestions. */
export function suggestionList(data: AssistantData["suggestions"]): string[] {
  return Array.isArray(data) ? data : Array.isArray(data?.questions) ? data.questions : [];
}

export type AssistantMessage = UIMessage<unknown, AssistantData>;

export type AssistantErrorCode =
  | "unavailable"
  | "unauthorized"
  | "gateway_auth_missing"
  | "rate_limited";

export type AssistantError = { error: AssistantErrorCode | "unknown"; message: string };

export const ERROR_LABEL: Record<AssistantError["error"], string> = {
  unavailable: "Assistant unavailable",
  unauthorized: "Not allowed for this session",
  gateway_auth_missing: "Gateway credentials missing",
  rate_limited: "Rate limited",
  unknown: "Request failed",
};

/** The transport throws with the response body as the message. Read the contract's JSON out of it. */
export function parseAssistantError(error: unknown): AssistantError {
  const text = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(text) as Partial<AssistantError>;
    if (parsed && typeof parsed.error === "string") {
      const code = (
        ["unavailable", "unauthorized", "gateway_auth_missing", "rate_limited"] as const
      ).includes(parsed.error as AssistantErrorCode)
        ? (parsed.error as AssistantErrorCode)
        : "unknown";
      return { error: code, message: parsed.message ?? text };
    }
  } catch {
    // Not JSON. Fall through to the raw text.
  }
  return { error: "unknown", message: text || "No detail returned." };
}

export type AssistantHealth = {
  ok: boolean;
  model: string;
  gateway: string;
  configured: boolean;
};

export type HealthState =
  | { kind: "checking" }
  | { kind: "ok"; health: AssistantHealth }
  | { kind: "down"; status: number; reason: string; health: AssistantHealth | null };

/** GET the health route. A 404 is the honest "not live" state, not a failure to hide. */
export async function readHealth(): Promise<HealthState> {
  try {
    const response = await apiFetch(ASSISTANT_HEALTH_PATH, { cache: "no-store" });
    if (response.status === 404) {
      return { kind: "down", status: 404, reason: "Route not live yet.", health: null };
    }
    const body = (await response.json().catch(() => null)) as
      | (AssistantHealth & Partial<AssistantError>)
      | null;
    if (!response.ok || !body) {
      return {
        kind: "down",
        status: response.status,
        reason: body?.message ?? `Health returned ${response.status}.`,
        health: null,
      };
    }
    if (!body.ok || !body.configured) {
      return {
        kind: "down",
        status: response.status,
        reason:
          body.message ?? (body.configured ? "Gateway reports not ok." : "Gateway not configured."),
        health: body,
      };
    }
    return { kind: "ok", health: body };
  } catch {
    return { kind: "down", status: 0, reason: "No response from the server.", health: null };
  }
}

/**
 * Suggested questions to show when the route is not live, so the panel can be
 * screenshot and toured. Labelled MOCK in the UI. When the stream is live, its
 * `data-suggestions` part replaces these.
 */
export const MOCK_SUGGESTIONS: Record<ContextKind | "none", string[]> = {
  issue: [
    "What does the provider return for this record right now?",
    "Which ledger rows and events touch this order?",
    "What is the safe next action and why?",
    "Has this business had the same kind of issue before?",
  ],
  ledger_entry: [
    "Walk me through the events behind this entry.",
    "Does the provider agree with the amounts on this row?",
    "When will this settle and what is holding it?",
  ],
  seller: [
    "What can this seller do today: payments, transfers, payouts?",
    "Which of their orders are still settling or held?",
    "Is there an open issue for this seller?",
  ],
  none: [
    "Which businesses have open issues right now?",
    "What settled in the last 24 hours, by currency?",
    "Is the Whop integration healthy?",
  ],
};

export const KIND_WORD: Record<ContextKind, string> = {
  issue: "Issue",
  ledger_entry: "Ledger entry",
  seller: "Seller",
};

/** Plain words for a tool call line: "Reading ledger entry led_0c41a9". */
export function describeTool(toolName: string, input: unknown): string {
  const id =
    input && typeof input === "object"
      ? (Object.entries(input as Record<string, unknown>).find(
          ([key, value]) =>
            typeof value === "string" && /(^id$|_id$|^entry|^issue|^seller)/.test(key),
        )?.[1] as string | undefined)
      : undefined;
  const noun = toolName
    .replace(/^(get|read|fetch|list|lookup)_?/i, "")
    .replace(/_/g, " ")
    .trim();
  return `Reading ${noun || toolName}${id ? ` ${id}` : ""}`;
}
