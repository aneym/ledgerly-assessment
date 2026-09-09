import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whopAccountId } from "@ledgerly/core";
import { createSimulatorAdapter } from "@ledgerly/whop";
import { expect, it } from "vitest";
import { persistLocalProvider } from "../src/lib/local-provider";

it("restores mock identities, payments, refund allocations and idempotency without replaying delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ledgerly-provider-"));
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    LEDGERLY_LOCAL_RUNTIME: "1",
    LEDGERLY_TEST_MODE: "1",
    WHOP_MODE: "mock",
    APP_BASE_URL: "http://127.0.0.1:4474",
    LEDGERLY_LOCAL_DB_DIR: directory,
  };
  const platform = whopAccountId("biz_platform_sim");
  if (!platform.ok) throw new Error("Invalid fixture ID");
  let deliveries = 0;
  const create = () =>
    persistLocalProvider(
      createSimulatorAdapter({
        parentAccountId: platform.value,
        accounts: [{ id: platform.value, raw: {} }],
        deliver: async () => {
          deliveries++;
        },
      }),
      env,
      true,
    );
  try {
    const first = create();
    const account = await first.createOrFetchAccount(
      {
        externalId: "run_restart:seller",
        runId: "run_restart",
        email: "seller@ledgerly.test",
        country: "US",
        title: "Seller",
      },
      "account-one",
    );
    if (!account.ok) throw new Error("Account fixture failed");
    const paid = first.seedPayment(
      { amountMinor: 2500, currency: "USD" },
      account.value.id,
      "order-one",
    );
    if (!paid.ok) throw new Error("Payment fixture failed");
    expect(
      (
        await first.refundPayment(paid.value.id, "refund-one", {
          amountMinor: 500,
          currency: "USD",
        })
      ).ok,
    ).toBe(true);
    expect(deliveries).toBe(1);
    first.seedBalance(platform.value, { amountMinor: 0, currency: "USD" });
    const restarted = create();
    expect(restarted.getBalance(platform.value, "USD").available.amountMinor).toBe(0);
    expect(deliveries).toBe(1);
    expect(await restarted.getAccount(account.value.id, "read")).toEqual(
      await first.getAccount(account.value.id, "read"),
    );
    expect(
      restarted.seedPayment({ amountMinor: 2500, currency: "USD" }, account.value.id, "order-one"),
    ).toEqual(paid);
    const second = await restarted.createOrFetchAccount(
      {
        externalId: "run_restart:other",
        runId: "run_restart",
        email: "other@ledgerly.test",
        country: "US",
        title: "Other",
      },
      "account-two",
    );
    expect(second.ok && second.value.id).not.toBe(account.value.id);
    const excessive = await restarted.refundPayment(paid.value.id, "refund-too-large", {
      amountMinor: 2001,
      currency: "USD",
    });
    expect(excessive.ok).toBe(false);
    expect((await restarted.listPayments({ accountId: account.value.id })).ok).toBe(true);
    await rm(join(directory, "mock-provider.bin"));
    expect(() => persistLocalProvider(createSimulatorAdapter(), env)).toThrow(
      "missing its mock provider snapshot",
    );
    await writeFile(join(directory, "mock-provider.pending"), "interrupted local call");
    expect(create).toThrow("Interrupted local mock provider call");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
