import { assert, test } from "vitest";
import { FixtureAdapter } from "../src/adapters";
import { EventLog, MemoryStore } from "../src/log";
import { authorize, ROLE_VIEWS, type ServerPrincipal } from "../src/roles";
import { DemoRunner } from "../src/runner";

const creator: ServerPrincipal = {
  session_id: "sess_1",
  seller_ids: ["seller_us"],
  permissions: ["payouts.read"],
};

test("switching the demo role to admin grants nothing on the server", async () => {
  const runner = new DemoRunner({
    log: new EventLog(new MemoryStore()),
    adapter: new FixtureAdapter(),
  });
  await runner.start();
  await runner.switchRole("admin");
  assert.equal(runner.currentRole, "admin");
  assert.equal(authorize(creator, "account.suspend", "seller_de", "admin").allowed, false);
  assert.equal(
    authorize(creator, "payouts.read", "seller_de", "admin").allowed,
    false,
    "sibling seller denied",
  );
  assert.equal(
    authorize(creator, "payouts.read", "seller_us", "buyer").allowed,
    true,
    "own grant works whatever the view",
  );
  assert.equal(authorize(null, "payouts.read", "seller_us", "admin").allowed, false);
});

test("every demo role has a screen list", () => {
  assert.deepEqual(Object.keys(ROLE_VIEWS).sort(), ["admin", "buyer", "creator"]);
});
