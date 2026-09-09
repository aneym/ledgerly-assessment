import { describe, expect, it } from "vitest";
import {
  type AssistantHealthDeps,
  createAssistantHealthHandler,
} from "../../src/app/api/admin/assistant/health/route";

describe("createAssistantHealthHandler", () => {
  it("reports the configured shape with no secret values", async () => {
    const deps: AssistantHealthDeps = {
      getSession: async () => ({ userId: "op", role: "operator" }),
      getModel: () => "anthropic/claude-fable-5.1",
      isGatewayConfigured: () => true,
    };
    const handler = createAssistantHealthHandler(deps);
    const response = await handler(new Request("http://app.test/api/admin/assistant/health"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      model: "anthropic/claude-fable-5.1",
      gateway: "vercel-ai-gateway",
      configured: true,
    });
  });

  it("reports ok:false and configured:false when no gateway credential is present", async () => {
    const deps: AssistantHealthDeps = {
      getSession: async () => ({ userId: "op", role: "operator" }),
      getModel: () => "anthropic/claude-fable-5.1",
      isGatewayConfigured: () => false,
    };
    const handler = createAssistantHealthHandler(deps);
    const response = await handler(new Request("http://app.test/api/admin/assistant/health"));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.configured).toBe(false);
  });

  it("never includes a credential-shaped field in the body", async () => {
    const deps: AssistantHealthDeps = {
      getSession: async () => ({ userId: "op", role: "operator" }),
      getModel: () => "anthropic/claude-fable-5.1",
      isGatewayConfigured: () => true,
    };
    const handler = createAssistantHealthHandler(deps);
    const response = await handler(new Request("http://app.test/api/admin/assistant/health"));
    const body = (await response.json()) as Record<string, unknown>;
    const keys = Object.keys(body).join(",").toLowerCase();
    expect(keys).not.toMatch(/key|token|secret|credential/);
  });
});
