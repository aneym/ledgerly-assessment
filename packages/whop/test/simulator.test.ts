import { money, type Result } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import { decodeEnvelope } from "../src/envelope";
import { createSimulatorAdapter, type SimulatorAdapter } from "../src/simulator";
import { verifyStandardWebhook, type WebhookHeaders } from "../src/webhooks";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function usd(minor: number) {
  return value(money(minor, "USD"));
}
async function account(sim: SimulatorAdapter, external: string) {
  const result = await sim.createAccount(
    {
      externalId: external,
      runId: "run_1",
      email: `${external}@example.invalid`,
      country: "US",
      title: external,
    },
    `create-${external}`,
  );
  return value(result).id;
}
type Delivery = { rawBody: string; headers: WebhookHeaders };
function deliverySpy() {
  const deliveries: Delivery[] = [];
  return { deliveries, deliver: (delivery: Delivery) => void deliveries.push(delivery) };
}
function decodedData(delivery: Delivery): Record<string, unknown> {
  const envelope = value(decodeEnvelope(delivery.rawBody));
  return envelope.raw.data as Record<string, unknown>;
}
const secret = "ws_test_secret";

describe("createSimulatorAdapter balances", () => {
  it("seeds and reads back an account balance", async () => {
    const sim = createSimulatorAdapter();
    const seller = await account(sim, "alice");
    expect(sim.seedBalance(seller, usd(5000))).toEqual({ ok: true, value: true });
    expect(sim.getBalance(seller, "USD")).toEqual({
      available: usd(5000),
      pending: { amountMinor: 0, currency: "USD" },
    });
  });
});

describe("createSimulatorAdapter createTransfer", () => {
  async function twoAccounts(sim: SimulatorAdapter) {
    const origin = await account(sim, "platform");
    const destination = await account(sim, "seller");
    sim.seedBalance(origin, usd(10_000));
    return { origin, destination };
  }

  it("mints a sim_tr_-prefixed id and moves the amount to the destination's pending balance", async () => {
    const sim = createSimulatorAdapter();
    const { origin, destination } = await twoAccounts(sim);
    const result = await sim.createTransfer(
      { originId: origin, destinationId: destination, amount: usd(1500), metadata: {} },
      "tr-key-1",
    );
    const transfer = value(result);
    expect(transfer.id).toMatch(/^sim_tr_\d+$/);
    expect(transfer.raw).toMatchObject({ status: "pending", amount: "15.00", currency: "USD" });
    expect(sim.getBalance(origin, "USD").available).toEqual(usd(8500));
    expect(sim.getBalance(destination, "USD").pending).toEqual(usd(1500));
    expect(sim.getBalance(destination, "USD").available).toEqual({
      amountMinor: 0,
      currency: "USD",
    });
  });

  it("replays the cached result for a repeated idempotency key with the same input", async () => {
    const sim = createSimulatorAdapter();
    const { origin, destination } = await twoAccounts(sim);
    const input = { originId: origin, destinationId: destination, amount: usd(1000), metadata: {} };
    const first = value(await sim.createTransfer(input, "same-key"));
    const second = value(await sim.createTransfer(input, "same-key"));
    expect(second).toEqual(first);
    expect(sim.getBalance(origin, "USD").available).toEqual(usd(9000));
  });

  it("rejects a repeated idempotency key whose input changed", async () => {
    const sim = createSimulatorAdapter();
    const { origin, destination } = await twoAccounts(sim);
    await sim.createTransfer(
      { originId: origin, destinationId: destination, amount: usd(1000), metadata: {} },
      "reused-key",
    );
    const conflict = await sim.createTransfer(
      { originId: origin, destinationId: destination, amount: usd(2000), metadata: {} },
      "reused-key",
    );
    expect(conflict).toEqual({ ok: false, error: { kind: "idempotency_conflict" } });
  });

  it("rejects when the origin balance is short", async () => {
    const sim = createSimulatorAdapter();
    const origin = await account(sim, "empty-origin");
    const destination = await account(sim, "seller2");
    const result = await sim.createTransfer(
      { originId: origin, destinationId: destination, amount: usd(100), metadata: {} },
      "short-key",
    );
    expect(result).toEqual({ ok: false, error: { kind: "insufficient_balance" } });
  });

  describe("simulate metadata flag", () => {
    it("timeout always fails with a network error and never debits the balance", async () => {
      const sim = createSimulatorAdapter();
      const { origin, destination } = await twoAccounts(sim);
      const input = {
        originId: origin,
        destinationId: destination,
        amount: usd(500),
        metadata: { simulate: "timeout" },
      };
      expect(await sim.createTransfer(input, "timeout-key")).toEqual({
        ok: false,
        error: { kind: "network" },
      });
      expect(await sim.createTransfer(input, "timeout-key-2")).toEqual({
        ok: false,
        error: { kind: "network" },
      });
      expect(sim.getBalance(origin, "USD").available).toEqual(usd(10_000));
    });

    it("insufficient_balance always fails regardless of the actual balance", async () => {
      const sim = createSimulatorAdapter();
      const { origin, destination } = await twoAccounts(sim);
      const result = await sim.createTransfer(
        {
          originId: origin,
          destinationId: destination,
          amount: usd(500),
          metadata: { simulate: "insufficient_balance" },
        },
        "insufficient-key",
      );
      expect(result).toEqual({ ok: false, error: { kind: "insufficient_balance" } });
    });

    it("unknown_outcome fails the first call and succeeds a retry with the same key", async () => {
      const sim = createSimulatorAdapter();
      const { origin, destination } = await twoAccounts(sim);
      const input = {
        originId: origin,
        destinationId: destination,
        amount: usd(500),
        metadata: { simulate: "unknown_outcome" },
      };
      expect(await sim.createTransfer(input, "unknown-key")).toEqual({
        ok: false,
        error: { kind: "network" },
      });
      const retry = value(await sim.createTransfer(input, "unknown-key"));
      expect(retry.raw).toMatchObject({ status: "pending" });
      expect(sim.getBalance(origin, "USD").available).toEqual(usd(9500));
    });

    it("fail_then_succeed fails the first call and succeeds a retry with the same key", async () => {
      const sim = createSimulatorAdapter();
      const { origin, destination } = await twoAccounts(sim);
      const input = {
        originId: origin,
        destinationId: destination,
        amount: usd(500),
        metadata: { simulate: "fail_then_succeed" },
      };
      expect(await sim.createTransfer(input, "fail-then-key")).toEqual({
        ok: false,
        error: { kind: "insufficient_balance" },
      });
      const retry = value(await sim.createTransfer(input, "fail-then-key"));
      expect(retry.raw).toMatchObject({ status: "pending" });
    });
  });
});

describe("createSimulatorAdapter tick()", () => {
  it("completes a pending transfer and delivers a signed transfer.completed webhook", async () => {
    const { deliveries, deliver } = deliverySpy();
    const sim = createSimulatorAdapter({ webhookSecret: secret, deliver });
    const origin = await account(sim, "platform");
    const destination = await account(sim, "seller3");
    sim.seedBalance(origin, usd(10_000));
    const transfer = value(
      await sim.createTransfer(
        { originId: origin, destinationId: destination, amount: usd(2500), metadata: {} },
        "tick-key",
      ),
    );
    await sim.tick();
    expect(sim.getBalance(destination, "USD")).toEqual({
      available: usd(2500),
      pending: { amountMinor: 0, currency: "USD" },
    });
    const listed = value(await sim.listTransfers({ accountId: destination }));
    expect(listed.items[0]).toMatchObject({ id: transfer.id, status: "completed" });
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0];
    if (!delivery) throw new Error("Expected a delivery");
    expect(
      verifyStandardWebhook({ rawBody: delivery.rawBody, headers: delivery.headers, secret }),
    ).toEqual({ ok: true, value: true });
    const envelope = value(decodeEnvelope(delivery.rawBody));
    expect(envelope.eventType).toBe("transfer.completed");
    expect(envelope.accountId).toBe(destination);
    expect(decodedData(delivery)).toMatchObject({
      id: transfer.id,
      status: "completed",
      destination_id: destination,
    });
  });

  it("does not re-deliver for a transfer already completed by an earlier tick", async () => {
    const { deliveries, deliver } = deliverySpy();
    const sim = createSimulatorAdapter({ webhookSecret: secret, deliver });
    const origin = await account(sim, "platform");
    const destination = await account(sim, "seller4");
    sim.seedBalance(origin, usd(10_000));
    await sim.createTransfer(
      { originId: origin, destinationId: destination, amount: usd(100), metadata: {} },
      "no-double-key",
    );
    await sim.tick();
    await sim.tick();
    expect(deliveries).toHaveLength(1);
  });
});

describe("createSimulatorAdapter originatePayout", () => {
  it("mints a sim_po_-prefixed id and delivers payout.created with the pending status", async () => {
    const { deliveries, deliver } = deliverySpy();
    const sim = createSimulatorAdapter({ webhookSecret: secret, deliver });
    const accountId = await account(sim, "payee");
    const result = await sim.originatePayout(
      { accountId, amount: usd(3000), metadata: { note: "weekly" } },
      "payout-key",
    );
    const payout = value(result);
    expect(payout.id).toMatch(/^sim_po_\d+$/);
    expect(payout.status).toBe("requested");
    expect(sim.getPayoutStatus(payout.id)).toBe("requested");
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0];
    if (!delivery) throw new Error("Expected a delivery");
    const envelope = value(decodeEnvelope(delivery.rawBody));
    expect(envelope.eventType).toBe("payout.created");
    expect(decodedData(delivery)).toMatchObject({ id: payout.id, status: "pending" });
  });

  it("moves requested -> processing -> completed across three ticks, one webhook per transition", async () => {
    const { deliveries, deliver } = deliverySpy();
    const sim = createSimulatorAdapter({ webhookSecret: secret, deliver });
    const accountId = await account(sim, "payee2");
    const payout = value(
      await sim.originatePayout({ accountId, amount: usd(4000) }, "payout-tick-key"),
    );
    deliveries.length = 0; // drop the payout.created delivery from originatePayout itself

    await sim.tick();
    expect(sim.getPayoutStatus(payout.id)).toBe("processing");
    expect(deliveries).toHaveLength(1);
    expect(decodedData(deliveries[0] as Delivery)).toMatchObject({
      id: payout.id,
      status: "in_transit",
    });

    await sim.tick();
    expect(sim.getPayoutStatus(payout.id)).toBe("processing");
    expect(deliveries).toHaveLength(1); // tick 2 is a silent hold, no new delivery

    await sim.tick();
    expect(sim.getPayoutStatus(payout.id)).toBe("completed");
    expect(deliveries).toHaveLength(2);
    expect(decodedData(deliveries[1] as Delivery)).toMatchObject({
      id: payout.id,
      status: "completed",
    });
  });
});

describe("createSimulatorAdapter pass-throughs and id rewrites", () => {
  it("rewrites the payout portal link to the sandbox.whop.com simulated path", async () => {
    const sim = createSimulatorAdapter();
    const accountId = await account(sim, "portal");
    const result = await sim.createPayoutPortalLink(
      { accountId, returnUrl: "https://example.invalid/return" },
      "portal-key",
    );
    expect(value(result).url).toBe(`https://sandbox.whop.com/simulated/payouts/${accountId}`);
  });

  it("rewrites an access token id to the sim_token_ prefix", async () => {
    const sim = createSimulatorAdapter();
    const accountId = await account(sim, "token-holder");
    const result = await sim.createAccessToken(
      {
        accountId,
        scopedActions: ["payments:read"],
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      },
      "token-key",
    );
    expect(value(result).token).toMatch(/^sim_token_\d+$/);
  });

  it("rewrites a refund id to sim_ref_ and delivers refund.created to the payment's account", async () => {
    const { deliveries, deliver } = deliverySpy();
    const sim = createSimulatorAdapter({ webhookSecret: secret, deliver });
    const accountId = await account(sim, "refund-target");
    const payment = value(sim.seedPayment(usd(2000), accountId));
    const result = await sim.refundPayment(payment.id, "refund-key");
    expect(value(result).id).toMatch(/^sim_ref_\d+$/);
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0];
    if (!delivery) throw new Error("Expected a delivery");
    const envelope = value(decodeEnvelope(delivery.rawBody));
    expect(envelope.eventType).toBe("refund.created");
    expect(envelope.accountId).toBe(accountId);
  });
});
