import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../../src/app/api/demo/scenarios/route";

const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://ledgerly.example/api/demo/scenarios", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("public isolated assessment endpoint", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Network access is forbidden in assessment scenarios");
      }),
    );
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("lists fixed mock scenarios without starting a run", async () => {
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-ledgerly-source")).toBe("mock");
    const body = await response.json();
    expect(body.mode).toBe("mock");
    expect(body.isolated).toBe(true);
    expect(body.scenarios.map((item: { id: string }) => item.id)).toEqual([
      "onboarding",
      "direct-refund",
      "platform-transfer",
      "webhook-events",
    ]);
  });

  it.each(["onboarding", "direct-refund", "platform-transfer", "webhook-events"])(
    "runs %s through real handler and reports only mock results",
    async (scenarioId) => {
      const response = await POST(request({ scenarioId, mode: "mock" }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ scenarioId, mode: "mock", label: "Demo/Mock", isolated: true });
      expect(body.steps.length).toBeGreaterThan(0);
      expect(body.assertions.length).toBeGreaterThan(0);
      expect(body.assertions.filter((item: { passed: boolean }) => !item.passed)).toEqual([]);
      expect(body.limitations.length).toBeGreaterThan(0);
    },
  );

  it("gives simultaneous requests independent fresh memory", async () => {
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        POST(request({ scenarioId: "platform-transfer", mode: "mock" })),
      ),
    );
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies[0].finalState).toEqual(bodies[1].finalState);
    expect(bodies[1].finalState).toEqual(bodies[2].finalState);
    expect(bodies[0].steps[0].before).toEqual(bodies[2].steps[0].before);
  });

  it.each([
    { scenarioId: "direct-refund", mode: "sandbox" },
    { scenarioId: "direct-refund", mode: "mock", accountId: "biz_actual" },
    { scenarioId: "direct-refund", mode: "mock", amountMinor: 99999 },
    { scenarioId: "unknown", mode: "mock" },
    null,
    [],
    {},
  ])(
    "refuses caller-selected identities, amounts, modes and malformed selections: %j",
    async (body) => {
      expect((await POST(request(body))).status).toBe(400);
    },
  );

  it("rejects malformed JSON and unsupported content type", async () => {
    expect(
      (
        await POST(
          new Request("https://ledgerly.example/api/demo/scenarios", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{",
          }),
        )
      ).status,
    ).toBe(400);
    expect((await POST(request({}, { "Content-Type": "text/plain" }))).status).toBe(415);
  });

  it("bounds actual request bytes even when Content-Length lies", async () => {
    const response = await POST(
      request(
        { scenarioId: "onboarding", mode: "mock", padding: "x".repeat(2000) },
        { "Content-Length": "1" },
      ),
    );
    expect(response.status).toBe(413);
  });
});
