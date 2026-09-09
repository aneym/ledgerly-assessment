// End-to-end streamed run against a MockLanguageModelV4 (from `ai/test`; the brief names
// MockLanguageModelV2, which does not exist in the installed ai@7.0.93 — V4 is the current
// mock for this SDK's model spec version). Drives the real route handler and real tool
// wiring, only the model call itself is faked, and asserts on the actual SSE bytes the
// route would send a client: a data-suggestions part at the very start, a data-source part
// for the tool's resolved record, and the standard tool-input-available /
// tool-output-available parts for the one tool call the mock model makes.

import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  type AssistantChatDeps,
  createAssistantChatHandler,
} from "../../src/app/api/admin/assistant/route";
import { baseToolDeps, stubDb } from "./fixtures";

// `@ai-sdk/provider` (the package that names LanguageModelV4StreamPart) is only a transitive
// dependency of `ai` here, not a direct or hoisted dependency of apps/web, so it cannot be
// imported by name from this test. Instead the chunk array is written inline as the argument
// to `doStream`, where TypeScript contextually types it against MockLanguageModelV4's own
// constructor parameter type (which does resolve, via `ai/test`) — no separate type import
// needed, and no widening of the literal `type` fields to `string`.
function mockModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "getLedgerEntry",
            input: JSON.stringify({ id: "1" }),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
}

async function collectSseEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length))
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

function chatRequest(): Request {
  return new Request("https://example.invalid/api/admin/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "chat_1",
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "What is ledger entry 1?" }] },
      ],
      context: { kind: null, id: null, route: "/admin" },
    }),
  });
}

describe("createAssistantChatHandler streamed run", () => {
  it("emits data-suggestions at start, a data-source for the tool's record, and standard tool parts", async () => {
    const deps: AssistantChatDeps = {
      getToolDeps: () =>
        baseToolDeps({
          db: stubDb({
            ledgerEntry: {
              id: 1,
              runId: "run_1",
              sellerId: "seller_1",
              accountSide: "platform",
              kind: "fee",
              amountMinor: 500,
              currency: "USD",
              providerResourceType: "payment",
              providerResourceId: "pay_1",
              effectKey: "effect_1",
              occurredAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          }),
        }),
      getModel: () => mockModel(),
      isGatewayConfigured: () => true,
    };

    const handler = createAssistantChatHandler(deps);
    const response = await handler(chatRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectSseEvents(response);

    const suggestions = events.find((e) => e.type === "data-suggestions");
    expect(suggestions).toBeDefined();
    const suggestionsData = suggestions?.data as { questions: string[] } | undefined;
    expect(suggestionsData?.questions.length).toBeGreaterThanOrEqual(3);
    expect(suggestionsData?.questions.length).toBeLessThanOrEqual(4);
    // The suggestions part must be one of the very first chunks emitted, not appended
    // after the model has already started talking.
    expect(events.findIndex((e) => e.type === "data-suggestions")).toBeLessThan(
      events.findIndex((e) => e.type === "tool-input-available"),
    );

    const source = events.find(
      (e) =>
        e.type === "data-source" &&
        (e.data as { kind?: string; id?: string }).kind === "ledger_entry" &&
        (e.data as { kind?: string; id?: string }).id === "1",
    );
    expect(source).toBeDefined();
    expect((source?.data as { href?: string } | undefined)?.href).toBe("/admin/ledger/1");

    const toolInput = events.find(
      (e) => e.type === "tool-input-available" && e.toolName === "getLedgerEntry",
    );
    expect(toolInput).toBeDefined();
    expect(toolInput?.input).toEqual({ id: "1" });

    const toolOutput = events.find((e) => e.type === "tool-output-available");
    expect(toolOutput).toBeDefined();
    const output = toolOutput?.output as { found?: boolean; entry?: { provenance?: string } };
    expect(output.found).toBe(true);
    expect(output.entry?.provenance).toBe("mock");
  });

  it("classifies a free-tier RestrictedModelsError as an unavailable stream error, not gateway_auth_missing", async () => {
    // Shaped after the real error a live probe against the gateway returned for
    // anthropic/claude-fable-5.1 on the free tier (see
    // docs/lanes/architecture/operator-assistant-contract.md): a GatewayInternalServerError
    // with statusCode 403, wrapping an APICallError cause whose message carries the
    // "Free tier users do not have access to this model" text the AI SDK puts there.
    const restrictedModel = new MockLanguageModelV4({
      doStream: async () => {
        const cause = new Error(
          '{"error":{"message":"Free tier users do not have access to this model. Upgrade to paid credits...","type":"no_providers_available","param":{"name":"RestrictedModelsError"}}}',
        );
        const error = new Error(
          "Free tier users do not have access to this model. Upgrade to paid credits at https://vercel.com/d?to=...",
        ) as Error & { statusCode: number; cause: Error };
        error.name = "GatewayInternalServerError";
        error.statusCode = 403;
        error.cause = cause;
        throw error;
      },
    });

    const deps: AssistantChatDeps = {
      getToolDeps: () => baseToolDeps(),
      getModel: () => restrictedModel,
      isGatewayConfigured: () => true,
    };

    const handler = createAssistantChatHandler(deps);
    const response = await handler(chatRequest());
    // Already past the point where an HTTP status can change: the stream started at 200.
    expect(response.status).toBe(200);

    const events = await collectSseEvents(response);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    const parsed = JSON.parse(errorEvent?.errorText as string) as {
      error: string;
      message: string;
    };
    expect(parsed.error).toBe("unavailable");
    expect(parsed.message).toBe("model restricted on the free gateway tier");
  });
});
