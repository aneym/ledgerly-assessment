// Tests createForwardEmailAuthHandler, the thin wrapper POST /api/auth/sign-up and
// /api/auth/sign-in both use to reach Better Auth's own /sign-up/email and /sign-in/email
// paths. A fake `handler` dependency stands in for Better Auth's real request handler
// (which needs a live database), so this stays a unit test.
import { describe, expect, it } from "vitest";
import { createForwardEmailAuthHandler } from "../../src/lib/auth";

function signUpRequest(body: unknown) {
  return new Request("https://example.invalid/api/auth/sign-up", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("createForwardEmailAuthHandler", () => {
  it("forwards the request to Better Auth's own email path", async () => {
    let seenUrl: string | undefined;
    let seenBody: string | undefined;
    const handler = createForwardEmailAuthHandler("sign-up/email", {
      handler: async (request) => {
        seenUrl = new URL(request.url).pathname;
        seenBody = await request.text();
        return Response.json(
          { user: { id: "user_1" } },
          { headers: { "set-cookie": "session=abc" } },
        );
      },
    });
    const response = await handler(
      signUpRequest({ email: "alice@example.invalid", password: "hunter22", name: "Alice" }),
    );
    expect(seenUrl).toBe("/api/auth/sign-up/email");
    expect(JSON.parse(seenBody ?? "{}")).toEqual({
      email: "alice@example.invalid",
      password: "hunter22",
      name: "Alice",
    });
    expect(response.status).toBe(200);
  });

  it("passes a successful response through unchanged, cookie included", async () => {
    const handler = createForwardEmailAuthHandler("sign-in/email", {
      handler: async () =>
        Response.json(
          { user: { id: "user_1" } },
          { headers: { "set-cookie": "session=abc; Path=/" } },
        ),
    });
    const response = await handler(
      signUpRequest({ email: "alice@example.invalid", password: "hunter22" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBe("session=abc; Path=/");
    expect(await response.json()).toEqual({ user: { id: "user_1" } });
  });

  it("normalizes a Better Auth error body to { error } using its code", async () => {
    const handler = createForwardEmailAuthHandler("sign-in/email", {
      handler: async () =>
        Response.json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "bad" }, { status: 401 }),
    });
    const response = await handler(
      signUpRequest({ email: "alice@example.invalid", password: "wrong" }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_email_or_password" });
  });

  it("falls back to a generic error when Better Auth's error body is not JSON", async () => {
    const handler = createForwardEmailAuthHandler("sign-up/email", {
      handler: async () => new Response("not json", { status: 500 }),
    });
    const response = await handler(
      signUpRequest({ email: "alice@example.invalid", password: "hunter22" }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "auth_failed" });
  });
});
