import type { WhopAccountId } from "@ledgerly/core";
import { expect, it, vi } from "vitest";
import { createSandboxAdapter, createWhopClient } from "../src/index";

// A simulator-issued id (see packages/whop/src/simulator) should never reach a real sandbox
// call: if one does, it means routing between the mock/simulator leg and the sandbox leg broke
// upstream. The whopAccountId() constructor never produces a "sim_"-prefixed value itself (it
// requires the "biz_" prefix), so this cast stands in for the only realistic way one could leak
// in: a bug that skips validation, not a value a caller could construct through the normal API.
const simAccountId = "sim_leaked_account" as unknown as WhopAccountId;

it("rejects a createTransfer whose origin id carries the simulator's sim_ prefix", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = createWhopClient({
    baseUrl: "https://sandbox.invalid/api/v1",
    apiKey: "fixture-key",
    apiVersionDate: "2026-08-21",
    fetch,
  });
  const adapter = createSandboxAdapter({
    client,
    parentAccountId: "biz_platform" as WhopAccountId,
  });
  const result = await adapter.createTransfer(
    {
      originId: simAccountId,
      destinationId: "biz_platform" as WhopAccountId,
      amount: { amountMinor: 100, currency: "USD" },
      metadata: {},
    },
    "guard-key",
  );
  expect(result).toEqual({ ok: false, error: { kind: "invalid_request" } });
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects a createTransfer whose destination id carries the simulator's sim_ prefix", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = createWhopClient({
    baseUrl: "https://sandbox.invalid/api/v1",
    apiKey: "fixture-key",
    apiVersionDate: "2026-08-21",
    fetch,
  });
  const adapter = createSandboxAdapter({
    client,
    parentAccountId: "biz_platform" as WhopAccountId,
  });
  const result = await adapter.createTransfer(
    {
      originId: "biz_platform" as WhopAccountId,
      destinationId: simAccountId,
      amount: { amountMinor: 100, currency: "USD" },
      metadata: {},
    },
    "guard-key-2",
  );
  expect(result).toEqual({ ok: false, error: { kind: "invalid_request" } });
  expect(fetch).not.toHaveBeenCalled();
});
