// POST /api/admin/assistant: the operator sidebar's chat endpoint. Streams an AI SDK UI
// message stream back to the client, grounded on the operator's selected admin record and
// backed by eight read-only tools (see ../../../../lib/assistant/tools.ts). No write path
// exists anywhere in this file or its dependencies.
//
// Two error regimes are honored here, and the difference is not a shortcut, it is what a
// streaming HTTP response allows: once createUIMessageStreamResponse returns, the status
// code and headers are already committed at 200, so only failures detected before that
// point (auth, malformed input, a broken context lookup) can become the contract's
// `{error: "..."}` JSON responses. A failure surfacing after the model turn has started
// (for example the gateway rate-limiting mid-stream) can only be reported inside the
// stream itself, via createUIMessageStream's onError, which is what the AI SDK's streaming
// model is built for. This gap is documented in
// docs/lanes/architecture/operator-assistant-contract.md.
//
// createAssistantChatHandler takes its model and tool dependencies as arguments, the same
// injected-deps shape as the sibling apps/web/src/app/api/orders/[id]/route.ts and
// apps/web/src/app/api/sellers/[id]/route.ts, so a test can hand it a MockLanguageModelV4
// from `ai/test` and fake tool deps without a real gateway call or database.
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type LanguageModel,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { demoScopeFor } from "@/lib/demo-scope";
import { createAssistantToolDeps } from "../../../../lib/assistant/deps";
import { getAssistantModelId, isGatewayConfigured } from "../../../../lib/assistant/model";
import { getSuggestedQuestions } from "../../../../lib/assistant/suggestions";
import { buildSystemPrompt, getContextSummary } from "../../../../lib/assistant/system-prompt";
import { type AssistantToolDeps, createAssistantTools } from "../../../../lib/assistant/tools";
import type {
  AssistantChatRequestBody,
  AssistantContext,
  AssistantUIMessage,
} from "../../../../lib/assistant/types";
import { instrumented } from "../../../../lib/instrument";
import { createDemoAssistantTools } from "./demo-tools";

export const runtime = "nodejs";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The gateway account here is on the free tier, which returns a 403 whose body's
// error.param.name is "RestrictedModelsError" for any model above the free allowance
// (verified directly against the live gateway on 2026-09-08: every Anthropic model newer
// than Claude 3 was rejected this way). The AI SDK's gateway provider surfaces this as a
// GatewayInternalServerError whose own message, and its wrapped APICallError cause's
// message, both carry the human-readable "Free tier users do not have access to this
// model..." text verbatim, so matching on that text (rather than parsing the nested JSON
// response body) is what's checked here. This must not be confused with a real credential
// failure, which gets "gateway_auth_missing" instead.
function isRestrictedModelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { statusCode?: number; status?: number }).statusCode;
  if (status !== 403) return false;
  const cause = (error as { cause?: unknown }).cause;
  const haystack = [error.message, cause instanceof Error ? cause.message : undefined]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /RestrictedModelsError|free tier/i.test(haystack);
}

// Never leak provider error internals (they can carry request ids, org ids, or wrapped
// auth material) to the client. Classify what we can from shape and name; everything else
// becomes "unavailable". Logged server-side in full for operators debugging via the trace
// panel. The returned string becomes a stream {type: "error", errorText} part (both
// toUIMessageStream's and createUIMessageStream's onError contracts, see below), so it is
// shaped as the same {error, message} JSON the pre-stream error responses use, for a client
// that wants one parser for both.
function classifyAssistantStreamError(error: unknown): string {
  console.error("assistant stream error", error instanceof Error ? error.message : error);
  const name = error instanceof Error ? error.name : "";
  const status =
    (error as { statusCode?: number; status?: number } | undefined)?.statusCode ??
    (error as { statusCode?: number; status?: number } | undefined)?.status;
  if (isRestrictedModelError(error)) {
    return JSON.stringify({
      error: "unavailable",
      message: "model restricted on the free gateway tier",
    });
  }
  // The SDK retries a rate-limited call and then throws AI_RetryError whose message quotes
  // the last GatewayRateLimitError ("Free tier requests on this model are rate-limited"),
  // so the text is checked as well as the name and status.
  const message = error instanceof Error ? error.message : "";
  if (status === 429 || name.includes("RateLimit") || /rate.?limit/i.test(message)) {
    return JSON.stringify({
      error: "rate_limited",
      message: "The AI Gateway is rate-limiting requests. Try again shortly.",
    });
  }
  if (status === 401 || status === 403 || name.includes("AuthenticationError")) {
    return JSON.stringify({
      error: "gateway_auth_missing",
      message: "The AI Gateway rejected the configured credential.",
    });
  }
  return JSON.stringify({
    error: "unavailable",
    message: "The assistant could not complete this request.",
  });
}

function parseContext(value: unknown): AssistantContext | null {
  if (!isPlainObject(value)) return null;
  const { kind, id, route } = value;
  if (kind !== "issue" && kind !== "ledger_entry" && kind !== "seller" && kind !== null)
    return null;
  if (typeof id !== "string" && id !== null) return null;
  if (typeof route !== "string") return null;
  return { kind, id, route };
}

async function parseBody(
  request: Request,
): Promise<
  | { ok: true; value: { id: string; messages: UIMessage[]; context: AssistantContext } }
  | { ok: false }
> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false };
  }
  if (!isPlainObject(raw)) return { ok: false };
  const { id, messages, context: rawContext } = raw as Partial<AssistantChatRequestBody>;
  if (typeof id !== "string" || !Array.isArray(messages)) return { ok: false };
  const context = parseContext(rawContext);
  if (!context) return { ok: false };
  return { ok: true, value: { id, messages: messages as UIMessage[], context } };
}

export type AssistantChatDeps = {
  // A getter, not a resolved AssistantToolDeps, so building it (a real db handle, Whop
  // provider, and repos via getCommerce()) happens per request rather than at module load —
  // the same lazy-at-request-time convention documented in the sibling
  // apps/web/src/app/api/sellers/route.ts, needed because env vars like DATABASE_URL may
  // not be set yet at import time (a build, or a test that imports this module only for its
  // exported handler factory).
  getToolDeps: () => AssistantToolDeps;
  getModel: () => LanguageModel;
  isGatewayConfigured: () => boolean;
};

export function createAssistantChatHandler(
  deps: AssistantChatDeps,
): (request: Request) => Promise<Response> {
  return async function handlePost(request: Request): Promise<Response> {
    const toolDeps = deps.getToolDeps();
    const session = await toolDeps.getSession();
    const scope = demoScopeFor(session, request);
    if (!scope) {
      return Response.json(
        {
          error: session?.role === "demo" ? "demo_scope" : "unauthorized",
          message: "operator session required",
        },
        { status: session?.role === "demo" ? 403 : 401 },
      );
    }

    if (!deps.isGatewayConfigured()) {
      return Response.json(
        {
          error: "gateway_auth_missing",
          message:
            "The AI Gateway has no credentials configured. Set AI_GATEWAY_API_KEY, or run `vercel env pull` for a VERCEL_OIDC_TOKEN in local development.",
        },
        { status: 503 },
      );
    }

    const parsed = await parseBody(request);
    if (!parsed.ok) {
      return Response.json(
        {
          error: "unavailable",
          message: "malformed request body: expected { id, messages, context }",
        },
        { status: 400 },
      );
    }
    const { messages, context } = parsed.value;

    let contextSummary: Awaited<ReturnType<typeof getContextSummary>> = null;
    try {
      // The ordinary context lookup is deployment-wide. Demo records are retrieved only
      // through the scoped tools below, including when the client supplies a context id.
      if (scope.kind === "operator") contextSummary = await getContextSummary(toolDeps, context);
    } catch (cause) {
      console.error(
        "assistant context lookup failed",
        cause instanceof Error ? cause.message : cause,
      );
      return Response.json(
        { error: "unavailable", message: "failed to load the selected record" },
        { status: 502 },
      );
    }

    let modelMessages: Awaited<ReturnType<typeof convertToModelMessages>>;
    try {
      modelMessages = await convertToModelMessages(messages);
    } catch (cause) {
      console.error(
        "assistant message conversion failed",
        cause instanceof Error ? cause.message : cause,
      );
      return Response.json(
        { error: "unavailable", message: "malformed chat messages" },
        { status: 400 },
      );
    }

    const stream = createUIMessageStream<AssistantUIMessage>({
      async execute({ writer }) {
        writer.write({ type: "start" });
        writer.write({
          type: "data-suggestions",
          data: { questions: getSuggestedQuestions(context) },
        });
        if (contextSummary?.source) {
          writer.write({ type: "data-source", data: contextSummary.source });
        }

        const tools =
          scope.kind === "demo"
            ? createDemoAssistantTools(request)
            : createAssistantTools(toolDeps, (source) => {
                writer.write({ type: "data-source", data: source });
              });

        const result = streamText({
          model: deps.getModel(),
          system: buildSystemPrompt(context, contextSummary?.text ?? null),
          messages: modelMessages,
          tools,
          // Without a stop condition streamText ends after the first tool call and the
          // operator sees a tool part with no answer; five steps covers a lookup, a
          // follow-up lookup and the written reply.
          stopWhen: stepCountIs(5),
          abortSignal: request.signal,
        });

        // sendStart: false, since the {type:'start'} chunk above already opened the
        // message; merging a second one would duplicate it. toUIMessageStream has its own
        // onError (the AI SDK's own doc comment: "prevent leaking server error details to
        // the client by default"), separate from createUIMessageStream's onError below — a
        // model-stream failure (rate limit, restricted model, bad credential) is caught and
        // converted to an error chunk right here, inside the merged stream, and never
        // reaches the outer onError at all. Both are wired to the same classifier so a
        // failure is reported identically regardless of which layer catches it.
        writer.merge(
          toUIMessageStream({
            stream: result.stream,
            tools,
            sendStart: false,
            onError: classifyAssistantStreamError,
          }),
        );
      },
      // Catches only what toUIMessageStream's own onError above cannot: a synchronous throw
      // in this execute() function itself, before or after the merge call (for example, if
      // createAssistantTools or buildSystemPrompt were to throw).
      onError: classifyAssistantStreamError,
    });

    return createUIMessageStreamResponse({ stream });
  };
}

const handlePost = createAssistantChatHandler({
  getToolDeps: createAssistantToolDeps,
  getModel: getAssistantModelId,
  isGatewayConfigured,
});

export async function POST(request: Request) {
  return instrumented((req) => handlePost(req))(request);
}
