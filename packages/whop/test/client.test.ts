import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createWhopClient } from "../src/index";

const options = {
  baseUrl: "https://sandbox.invalid/api/v1",
  apiKey: "test-key",
  apiVersionDate: "2026-08-21",
};
it("sends authorization, version, idempotency, and JSON headers", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('{"id":"biz_test"}'));
  const client = createWhopClient({ ...options, fetch });
  expect(
    await client.request("POST", "/accounts", {
      body: { title: "Test" },
      idempotencyKey: "op-1",
      schema: z.object({ id: z.string() }),
    }),
  ).toEqual({ ok: true, value: { id: "biz_test" } });
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(String(url)).toBe("https://sandbox.invalid/api/v1/accounts");
  expect(init?.headers).toEqual({
    Authorization: "Bearer test-key",
    "Api-Version-Date": "2026-08-21",
    "Idempotency-Key": "op-1",
    "content-type": "application/json",
  });
  expect(init?.body).toBe('{"title":"Test"}');
  expect(init?.redirect).toBe("error");
});
it("preserves HTTP errors and request IDs without retry", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      new Response('{"error":"rejected"}', { status: 422, headers: { "x-request-id": "req-1" } }),
    );
  const result = await createWhopClient({ ...options, fetch }).request("POST", "/accounts", {
    schema: z.unknown(),
  });
  expect(result).toEqual({
    ok: false,
    error: { kind: "http", status: 422, body: { error: "rejected" }, requestId: "req-1" },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(["not json", '{"wrong":"shape"}'])(
  "rejects invalid successful response %s",
  async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
    expect(
      await createWhopClient({ ...options, fetch }).request("GET", "/accounts", {
        schema: z.object({ id: z.string() }),
      }),
    ).toMatchObject({ ok: false, error: { kind: "decode", status: 200 } });
  },
);
it("returns unknown network outcomes without retry", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("fetch failed"));
  expect(
    await createWhopClient({ ...options, fetch }).request("POST", "/transfers", {
      schema: z.unknown(),
    }),
  ).toEqual({ ok: false, error: { kind: "network", status: 0, body: null } });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("throws bugs instead of disguising them as provider errors", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new RangeError("bug"));
  await expect(
    createWhopClient({ ...options, fetch }).request("GET", "/accounts", { schema: z.unknown() }),
  ).rejects.toThrow("bug");
});
it("rejects paths outside the configured API before sending credentials", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = createWhopClient({ ...options, fetch });
  for (const path of ["https://other.invalid/", "../outside"])
    await expect(client.request("GET", path, { schema: z.unknown() })).rejects.toThrow(
      "configured API base",
    );
  expect(fetch).not.toHaveBeenCalled();
});
