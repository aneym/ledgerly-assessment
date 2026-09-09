// Every tool's inputSchema is a live zod schema at runtime (ai's `tool()` is an identity
// function; it returns exactly what was passed in), but its declared TYPE is the AI SDK's
// FlexibleSchema union, which does not expose zod's own `.safeParse` to the type checker.
// `asSchema(...).validate(...)` is the AI SDK's own type-safe entry point for this — it
// detects the zod schema at runtime and calls `safeParseAsync` internally — and is exported
// from `ai` itself (a direct dependency), so no extra package is needed. Bounds can then be
// asserted without running a model or a tool's execute function.

import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { createAssistantTools } from "../../src/lib/assistant/tools";
import { baseToolDeps } from "./fixtures";

const tools = createAssistantTools(baseToolDeps(), () => {});

function validate<T>(schema: Parameters<typeof asSchema<T>>[0], value: unknown) {
  return asSchema(schema).validate?.(value);
}

describe("assistant tool input bounds", () => {
  it("rejects a listLedger limit above 50", async () => {
    const result = await validate(tools.listLedger.inputSchema, { limit: 51 });
    expect(result?.success).toBe(false);
  });

  it("rejects a listLedger limit below 1", async () => {
    const result = await validate(tools.listLedger.inputSchema, { limit: 0 });
    expect(result?.success).toBe(false);
  });

  it("accepts a listLedger call with no arguments, defaulting the limit", async () => {
    const result = await validate<{ limit: number }>(tools.listLedger.inputSchema, {});
    expect(result?.success).toBe(true);
    if (result?.success) expect(result.value.limit).toBe(20);
  });

  it("rejects a getLedgerEntry id that is not a numeric string", async () => {
    const result = await validate(tools.getLedgerEntry.inputSchema, { id: "not-a-number" });
    expect(result?.success).toBe(false);
  });

  it("accepts a getLedgerEntry id that is a numeric string", async () => {
    const result = await validate(tools.getLedgerEntry.inputSchema, { id: "42" });
    expect(result?.success).toBe(true);
  });

  it("rejects an empty getSeller id", async () => {
    const result = await validate(tools.getSeller.inputSchema, { id: "" });
    expect(result?.success).toBe(false);
  });

  it("rejects an empty getOrder id", async () => {
    const result = await validate(tools.getOrder.inputSchema, { id: "" });
    expect(result?.success).toBe(false);
  });

  it("rejects listEventTrail with neither correlation_id nor run_id", async () => {
    const result = await validate(tools.listEventTrail.inputSchema, {});
    expect(result?.success).toBe(false);
  });

  it("rejects listEventTrail with both correlation_id and run_id", async () => {
    const result = await validate(tools.listEventTrail.inputSchema, {
      correlation_id: "corr_1",
      run_id: "run_1",
    });
    expect(result?.success).toBe(false);
  });

  it("accepts listEventTrail with exactly one of correlation_id or run_id", async () => {
    const result = await validate(tools.listEventTrail.inputSchema, { correlation_id: "corr_1" });
    expect(result?.success).toBe(true);
  });

  it("rejects a listEventTrail limit above 50", async () => {
    const result = await validate(tools.listEventTrail.inputSchema, {
      correlation_id: "corr_1",
      limit: 999,
    });
    expect(result?.success).toBe(false);
  });

  it("rejects a listIssues limit above 50", async () => {
    const result = await validate(tools.listIssues.inputSchema, { limit: 51 });
    expect(result?.success).toBe(false);
  });

  it("getIntegrationHealth takes no arguments and accepts an empty object", async () => {
    const result = await validate(tools.getIntegrationHealth.inputSchema, {});
    expect(result?.success).toBe(true);
  });
});
