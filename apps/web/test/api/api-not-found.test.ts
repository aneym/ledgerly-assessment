import { describe, expect, it } from "vitest";
import { DELETE, GET, PATCH, POST, PUT } from "../../src/app/api/[...missing]/route";

describe("/api catch-all", () => {
  it("answers 404 JSON for every method on an unmatched API path", async () => {
    for (const [method, handler] of Object.entries({ GET, POST, PUT, PATCH, DELETE })) {
      const response = await handler(new Request("http://app.test/api/nope/x", { method }));
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("not_found");
      expect(body.message).toContain(`${method} /api/nope/x`);
    }
  });
});
