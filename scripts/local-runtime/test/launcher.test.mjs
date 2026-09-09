import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

test("caps only the local child heap and excludes inherited Node options", () => {
  const launcherUrl = new URL("../start.mjs", import.meta.url);
  const source = readFileSync(launcherUrl, "utf8")
    .replace(/^import .*;\n/gm, "")
    .replaceAll("import.meta.url", "launcherUrl");
  let launched;
  runInNewContext(source, {
    launcherUrl: launcherUrl.href,
    URL, path, fileURLToPath,
    randomBytes: () => ({ toString: () => "local-test-value" }),
    existsSync: () => false,
    createRequire: () => ({ resolve: () => "/fixture/tsx.mjs" }),
    execFileSync: (_command, args) => args[0] === "rev-parse" ? "a".repeat(40) : "",
    spawn: (binary, args, options) => {
      launched = { binary, args: Array.from(args), options };
      return { on() {}, kill() {} };
    },
    process: {
      execPath: "/fixture/node",
      argv: ["node", "start.mjs", "--port", "4474", "--data-dir", "/fixture/db"],
      env: { PATH: "/fixture/bin", NODE_OPTIONS: "--max-old-space-size=32768" },
      on() {},
    },
  });
  assert.equal(launched.binary, "/fixture/node");
  assert.deepEqual(launched.args.slice(0, 3), [
    "--max-old-space-size=8192", "--import", "/fixture/tsx.mjs",
  ]);
  assert.equal(launched.args.at(-1), "4474");
  assert.equal(launched.options.env.NODE_OPTIONS, undefined);
  assert.equal(launched.options.env.NODE_ENV, "development");
  assert.equal(launched.options.env.LEDGERLY_LOCAL_RUNTIME, "1");
  assert.equal(launched.options.env.LEDGERLY_TEST_MODE, "1");
  assert.equal(launched.options.env.WHOP_MODE, "mock");
});
