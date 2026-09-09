import { test } from "node:test";
import assert from "node:assert/strict";
import { env as runtimeEnvironment } from "node:process";
import { createLocalRefundIsolation } from "../../apps/web/src/lib/local-refund-isolation";
import { createTestEventHandlers } from "../../apps/web/src/lib/runtime-test-contract/test-events";

test("actual production refuses local factories even with injected test configuration", async () => {
  const before = runtimeEnvironment.NODE_ENV;
  runtimeEnvironment.NODE_ENV = "production";
  try {
    assert.throws(() => createLocalRefundIsolation({ env: {
      NODE_ENV: "test", LEDGERLY_LOCAL_RUNTIME: "1", LEDGERLY_TEST_MODE: "1", WHOP_MODE: "mock",
      APP_BASE_URL: "http://127.0.0.1:4507", LEDGERLY_LOCAL_DB_DIR: "/disposable-fixture-not-opened",
    } } as any), /refuses production/);
    const handlers = createTestEventHandlers({ config: {
      enabled: true, nodeEnv: "test", provider: "mock", database: "pglite",
      origin: "http://127.0.0.1:4507", runId: "run_fixture", platformAccountId: "biz_fixture",
    }, authenticate() { throw new Error("Production must refuse before authentication"); } } as any);
    const response = await handlers.post(new Request("http://127.0.0.1:4507/api/local-runtime/events", { method: "POST" }));
    assert.equal(response.status, 404);
  } finally {
    if (before === undefined) delete runtimeEnvironment.NODE_ENV; else runtimeEnvironment.NODE_ENV = before;
  }
});
