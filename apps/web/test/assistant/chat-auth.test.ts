// Covers the request-handler gates that can only be tested at the HTTP layer: the
// operator-session check, the gateway-configured check, and body validation. All of these
// return before any model call, so the model dep here is never invoked.
import { describe, expect, it } from "vitest";
import {
  type AssistantChatDeps,
  createAssistantChatHandler,
} from "../../src/app/api/admin/assistant/route";
import { baseToolDeps, getSessionReturning, SELLER_SESSION } from "./fixtures";

function baseDeps(overrides: Partial<AssistantChatDeps> = {}): AssistantChatDeps {
  return {
    getToolDeps: () => baseToolDeps(),
    getModel: () => "anthropic/claude-fable-5.1",
    isGatewayConfigured: () => true,
    ...overrides,
  };
}

function chatRequest(body: unknown): Request {
  return new Request("https://example.invalid/api/admin/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  id: "chat_1",
  messages: [],
  context: { kind: null, id: null, route: "/admin" },
};

describe("createAssistantChatHandler auth and validation", () => {
  it("returns 401 for an anonymous session", async () => {
    const handler = createAssistantChatHandler(
      baseDeps({ getToolDeps: () => baseToolDeps({ getSession: getSessionReturning(null) }) }),
    );
    const response = await handler(chatRequest(VALID_BODY));
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("unauthorized");
  });

  it("returns 401 for a seller session", async () => {
    const handler = createAssistantChatHandler(
      baseDeps({
        getToolDeps: () => baseToolDeps({ getSession: getSessionReturning(SELLER_SESSION) }),
      }),
    );
    const response = await handler(chatRequest(VALID_BODY));
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("unauthorized");
  });

  it("returns gateway_auth_missing when the gateway has no credentials, without leaking a value", async () => {
    const handler = createAssistantChatHandler(baseDeps({ isGatewayConfigured: () => false }));
    const response = await handler(chatRequest(VALID_BODY));
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("gateway_auth_missing");
    expect(JSON.stringify(body)).not.toMatch(/sk-|AIza|Bearer /);
  });

  it("returns unavailable for a malformed body", async () => {
    const handler = createAssistantChatHandler(baseDeps());
    const response = await handler(chatRequest({ id: "chat_1" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("unavailable");
  });

  it("returns unavailable for an invalid context kind", async () => {
    const handler = createAssistantChatHandler(baseDeps());
    const response = await handler(
      chatRequest({
        id: "chat_1",
        messages: [],
        context: { kind: "bogus", id: null, route: "/admin" },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("returns unavailable for unparsable JSON", async () => {
    const handler = createAssistantChatHandler(baseDeps());
    const response = await handler(
      new Request("https://example.invalid/api/admin/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(response.status).toBe(400);
  });
});
