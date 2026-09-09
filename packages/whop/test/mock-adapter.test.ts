import type { Result } from "@ledgerly/core";
import { expect, it } from "vitest";
import {
  createMockAdapter,
  createWhopAdapter,
  decodeEnvelope,
  verifyStandardWebhook,
} from "../src/index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const seller = {
  externalId: "run1:seller1",
  runId: "run1",
  email: "test@example.invalid",
  country: "US" as const,
  title: "Test seller",
};
const now = new Date("2026-09-08T12:00:00Z");
it("returns the same account for duplicate and concurrent external IDs", async () => {
  const mock = createMockAdapter();
  const accounts = await Promise.all([
    mock.createOrFetchAccount(seller, "a"),
    mock.createOrFetchAccount(seller, "b"),
  ]);
  expect(value(accounts[0] ?? { ok: false, error: "missing" }).id).toBe("biz_mock_1");
  expect(value(accounts[0] ?? { ok: false, error: "missing" }).disposition).toBe("unknown");
  expect(value(accounts[1] ?? { ok: false, error: "missing" })).toMatchObject({
    id: "biz_mock_1",
    disposition: "fetched",
  });
});
it("rejects nested creation", async () => {
  expect(
    await createMockAdapter({ accountKind: "connected" }).createOrFetchAccount(seller, "a"),
  ).toEqual({ ok: false, error: { kind: "nested_account" } });
});
it("rejects reuse of an operation key for a different request", async () => {
  const mock = createMockAdapter();
  await mock.createOrFetchAccount(seller, "a");
  expect(await mock.createOrFetchAccount({ ...seller, externalId: "other" }, "a")).toEqual({
    ok: false,
    error: { kind: "idempotency_conflict" },
  });
});
it("debits and credits once and rejects insufficient funds", async () => {
  const mock = createMockAdapter();
  const origin = value(await mock.createOrFetchAccount(seller, "a"));
  const destination = value(
    await mock.createOrFetchAccount(
      { ...seller, externalId: "seller2", email: "second@example.invalid" },
      "b",
    ),
  );
  const input = {
    originId: origin.id,
    destinationId: destination.id,
    amount: { amountMinor: 2300, currency: "USD" as const },
    metadata: {},
  };
  expect(await mock.createTransfer(input, "transfer")).toEqual({
    ok: false,
    error: { kind: "insufficient_balance" },
  });
  expect(mock.seedBalance(origin.id, { amountMinor: 2500, currency: "USD" }).ok).toBe(true);
  const transfer = await mock.createTransfer(input, "transfer");
  expect(transfer.ok).toBe(true);
  expect(await mock.createTransfer(input, "transfer")).toEqual(transfer);
  expect(mock.getBalance(origin.id, "USD").amountMinor).toBe(200);
  expect(mock.getBalance(destination.id, "USD").amountMinor).toBe(2300);
  expect(mock.getBalance(destination.id, "EUR").amountMinor).toBe(0);
});
it("creates signed versioned offline deliveries", () => {
  const mock = createMockAdapter({
    now: () => now,
    webhookSecret: "ws_fixture",
    apiVersionDate: "2026-06-01",
  });
  const request = mock.emitWebhook("withdrawal.updated", { status: "pending" });
  expect(verifyStandardWebhook({ ...request, secret: "ws_fixture", now }).ok).toBe(true);
  const decoded = value(decodeEnvelope(request.rawBody));
  expect(decoded.originalAccountField).toBe("company_id");
  expect(decoded.eventType).toBe("payout.updated");
});
it("refunds only the remaining amount and replays refund operations", async () => {
  const mock = createMockAdapter();
  const payment = value(mock.seedPayment({ amountMinor: 2500, currency: "USD" }));
  expect(payment.id).toBe("pay_mock_1");
  const first = await mock.refundPayment(payment.id, "refund", {
    amountMinor: 500,
    currency: "USD",
  });
  expect(first.ok).toBe(true);
  expect(
    await mock.refundPayment(payment.id, "refund", { amountMinor: 500, currency: "USD" }),
  ).toEqual(first);
  expect(
    (await mock.refundPayment(payment.id, "bad", { amountMinor: 2100, currency: "USD" })).ok,
  ).toBe(false);
  expect((await mock.refundPayment(payment.id, "rest")).ok).toBe(true);
  expect((await mock.refundPayment(payment.id, "again")).ok).toBe(false);
});
it("rejects empty scopes and expired access tokens", async () => {
  const mock = createMockAdapter({ now: () => now });
  const account = value(await mock.createOrFetchAccount(seller, "account"));
  expect(
    (
      await mock.createAccessToken(
        { accountId: account.id, scopedActions: [], expiresAt: new Date(now.getTime() + 60000) },
        "empty",
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await mock.createAccessToken(
        { accountId: account.id, scopedActions: ["payout:read"], expiresAt: now },
        "expired",
      )
    ).ok,
  ).toBe(false);
});
it("defaults to mock and refuses incomplete sandbox configuration", () => {
  expect(createWhopAdapter({})).toHaveProperty("emitWebhook");
  expect(() => createWhopAdapter({ WHOP_MODE: "sandbox" })).toThrow("requires");
  expect(() => createWhopAdapter({ WHOP_MODE: "production" })).toThrow("mock or sandbox");
});

it("fetches an existing email with reused and fresh keys, including a connected parent", async () => {
  const mock = createMockAdapter();
  const first = value(await mock.createAccount({ ...seller, country: "DE" }, "first"));
  expect(first.country).toBe("DE");
  expect(first.raw).toMatchObject({ metadata: { external_id: seller.externalId, run_id: "run1" } });
  expect(value(await mock.createAccount({ ...seller, country: "DE" }, "first"))).toMatchObject({
    id: first.id,
    disposition: "fetched",
  });
  expect(
    value(await mock.createAccount({ ...seller, externalId: "different" }, "fresh")),
  ).toMatchObject({ id: first.id, country: "DE", disposition: "fetched" });
  const connected = createMockAdapter({ accountKind: "connected", accounts: [first] });
  expect(value(await connected.createAccount(seller, "nested"))).toMatchObject({
    id: first.id,
    disposition: "fetched",
  });
});
it("keeps patched account state on fetch and external-ID replay", async () => {
  const mock = createMockAdapter();
  const first = value(await mock.createAccount(seller, "first"));
  const patch = {
    country: "BR" as const,
    title: "Brazil",
    metadata: { external_id: seller.externalId, run_id: "run2" },
  };
  const updated = await mock.updateAccount(first.id, patch, "patch");
  expect(value(updated)).toMatchObject({ country: "BR", raw: patch });
  expect(await mock.updateAccount(first.id, patch, "patch")).toEqual(updated);
  expect(value(await mock.getAccount(first.id, "read")).country).toBe("BR");
  expect(value(await mock.createAccount(seller, "new")).country).toBe("BR");
});
it("lists account-scoped payments and transfers without duplicate writes", async () => {
  const mock = createMockAdapter({ now: () => now });
  const first = value(await mock.createAccount(seller, "first"));
  const second = value(
    await mock.createAccount(
      { ...seller, externalId: "second", email: "second@example.invalid" },
      "second",
    ),
  );
  const amount = { amountMinor: 2300, currency: "USD" as const };
  mock.seedPayment(amount, first.id);
  mock.seedPayment(amount, second.id);
  mock.seedBalance(first.id, amount);
  const transfer = { originId: first.id, destinationId: second.id, amount, metadata: {} };
  await mock.createTransfer(transfer, "transfer");
  await mock.createTransfer(transfer, "transfer");
  expect(value(await mock.listPayments({ accountId: first.id })).items).toHaveLength(1);
  expect(value(await mock.listTransfers({ accountId: first.id })).items).toHaveLength(1);
  expect(value(await mock.listTransfers({ accountId: second.id })).items[0]).toMatchObject({
    status: "succeeded",
    amount,
    createdAt: now.toISOString(),
  });
});
it("paginates mock payments and rejects unknown cursors", async () => {
  const mock = createMockAdapter();
  const account = value(await mock.createAccount(seller, "first"));
  for (let i = 0; i < 51; i++) mock.seedPayment({ amountMinor: 100, currency: "USD" }, account.id);
  const first = value(await mock.listPayments({ accountId: account.id }));
  expect(first.items).toHaveLength(50);
  expect(first.nextCursor).not.toBeNull();
  const last = value(
    await mock.listPayments({ accountId: account.id, cursor: first.nextCursor ?? "missing" }),
  );
  expect(last.items).toHaveLength(1);
  expect(last.nextCursor).toBeNull();
  expect((await mock.listPayments({ accountId: account.id, cursor: "missing" })).ok).toBe(false);
});
it("paginates transfers without exposing another account's records or mutable state", async () => {
  const mock = createMockAdapter({ now: () => now });
  const origin = value(await mock.createAccount(seller, "origin"));
  const destination = value(
    await mock.createAccount(
      { ...seller, externalId: "destination", email: "destination@example.invalid" },
      "destination",
    ),
  );
  const unrelated = value(
    await mock.createAccount(
      { ...seller, externalId: "unrelated", email: "unrelated@example.invalid" },
      "unrelated",
    ),
  );
  value(mock.seedBalance(origin.id, { amountMinor: 5100, currency: "USD" }));
  for (let i = 0; i < 51; i++) {
    value(
      await mock.createTransfer(
        {
          originId: origin.id,
          destinationId: destination.id,
          amount: { amountMinor: 100, currency: "USD" },
          metadata: {},
        },
        `transfer-${i}`,
      ),
    );
  }
  const first = value(await mock.listTransfers({ accountId: destination.id }));
  expect(first.items).toHaveLength(50);
  const second = value(
    await mock.listTransfers({ accountId: destination.id, cursor: first.nextCursor ?? "missing" }),
  );
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(51);
  expect(value(await mock.listTransfers({ accountId: unrelated.id }))).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(
    await mock.listTransfers({ accountId: unrelated.id, cursor: first.nextCursor ?? "missing" }),
  ).toEqual({ ok: false, error: { kind: "invalid_request" } });
  const item = first.items[0];
  if (!item) throw new Error("Missing first transfer");
  item.destination.id = unrelated.id;
  const reread = value(await mock.listTransfers({ accountId: destination.id }));
  expect(reread.items[0]?.destination.id).toBe(destination.id);
});
