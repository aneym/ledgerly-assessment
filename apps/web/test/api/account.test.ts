import { describe, expect, it } from "vitest";
import { createGetAccountHandler, type GetAccountDeps } from "../../src/app/api/account/route";

function baseDeps(overrides: Partial<GetAccountDeps> = {}): GetAccountDeps {
  return {
    getSession: () => Promise.resolve({ userId: "user_1", role: "seller" }),
    getUser: () =>
      Promise.resolve({
        id: "user_1",
        email: "alice@example.invalid",
        name: "Alice",
        role: "seller",
      }),
    getSellerIdForUser: () => Promise.resolve("seller_1"),
    ...overrides,
  };
}

function get() {
  return new Request("https://example.invalid/api/account");
}

describe("createGetAccountHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createGetAccountHandler(baseDeps({ getSession: () => Promise.resolve(null) }));
    const response = await handler(get());
    expect(response.status).toBe(401);
  });

  it("returns 404 when the session's user has vanished", async () => {
    const handler = createGetAccountHandler(baseDeps({ getUser: () => Promise.resolve(null) }));
    const response = await handler(get());
    expect(response.status).toBe(404);
  });

  it("returns the user's profile with their seller id, in the exact JSON shape", async () => {
    const handler = createGetAccountHandler(baseDeps());
    const response = await handler(get());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { id: string; email: string; name: string; role: string };
      seller: { id: string } | null;
    };
    expect(body).toEqual({
      user: { id: "user_1", email: "alice@example.invalid", name: "Alice", role: "seller" },
      seller: { id: "seller_1" },
    });
  });

  it("reports a null seller for a buyer with no seller account", async () => {
    const handler = createGetAccountHandler(
      baseDeps({
        getSession: () => Promise.resolve({ userId: "buyer_1", role: "buyer" }),
        getUser: () =>
          Promise.resolve({
            id: "buyer_1",
            email: "bob@example.invalid",
            name: "Bob",
            role: "buyer",
          }),
        getSellerIdForUser: () => Promise.resolve(null),
      }),
    );
    const response = await handler(get());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { seller: { id: string } | null };
    expect(body.seller).toBeNull();
  });
});
