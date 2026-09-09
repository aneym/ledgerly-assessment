import { test } from "node:test";
import assert from "node:assert/strict";
import { productionCheckOptions } from "./production-check-options.mjs";
const base = ["/owned/artifact.json", "a".repeat(40), "/owned/result.json"];

test("explicit CI and feasibility allocations retain their selected fixture modes", () => {
  assert.deepEqual(productionCheckOptions([...base, "--port", "4474", "--webhook-fixture", "1"]), { artifact: base[0], sha: base[1], output: base[2], port: 4474, fixtureMode: "1", origin: "http://127.0.0.1:4474", host: "127.0.0.1:4474" });
  assert.equal(productionCheckOptions([...base, "--port", "4507", "--webhook-fixture", "0"]).port, 4507);
  assert.equal(productionCheckOptions([...base, "--port", "4507", "--webhook-fixture", "0"]).fixtureMode, "0");
});
test("refuses missing values, duplicate options, and unknown options", () => {
  assert.throws(() => productionCheckOptions(base), /Explicit --port/);
  assert.throws(() => productionCheckOptions([...base, "--port"]), /require values/);
  const valid = ["--port", "4474", "--webhook-fixture", "1"];
  assert.throws(() => productionCheckOptions([...base, ...valid, "--port", "4507"]), /duplicate/);
  assert.throws(() => productionCheckOptions([...base, ...valid, "--mode", "test"]), /Unknown/);
});
test("rejects invalid ports and fixtures with every other required input valid", () => {
  for (const port of ["80", "65536", "4474.5", "http://127.0.0.1:4474"]) {
    assert.throws(() => productionCheckOptions([...base, "--port", port, "--webhook-fixture", "1"]), /Invalid production check port or fixture mode/);
  }
  assert.throws(() => productionCheckOptions([...base, "--port", "4474", "--webhook-fixture", "yes"]), /Invalid production check port or fixture mode/);
});
test("rejects relative evidence paths and incomplete source identity", () => {
  const valid = ["--port", "4474", "--webhook-fixture", "1"];
  assert.throws(() => productionCheckOptions(["relative.json", ...base.slice(1), ...valid]), /absolute artifact/);
  assert.throws(() => productionCheckOptions([base[0], "short", base[2], ...valid]), /exact source SHA/);
});
