import { productionCheckOptions } from "./production-check-options.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compiledConfiguration, verifyArtifact } from "./compiled-artifact.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { artifact, sha, output, port, fixtureMode, origin, host } = productionCheckOptions(process.argv.slice(2));
assert.equal(process.env.NODE_ENV, "production", "negative proof requires actual production process");
assert.ok(path.isAbsolute(output ?? ""), "negative evidence path must be absolute");
const config = compiledConfiguration(root, port, fixtureMode);
const before = verifyArtifact(root, artifact, sha, config);
const require = createRequire(import.meta.url);
const nextRoot = path.join(root, "apps/web/.next");
const entry = "server/app/api/local-runtime/events/route.js";
const source = readFileSync(path.join(nextRoot, entry), "utf8");
const runtime = require(path.join(nextRoot, "server/chunks/[turbopack]_runtime.js"))(entry);
const chunks = [...source.matchAll(/R\.c\("([^"]+)"\)/g)].map(match => match[1]);
assert.ok(chunks.length > 0, "compiled route must register emitted chunks");
const targets = new Map();
for (const chunkPath of chunks) {
  assert.ok(chunkPath.startsWith("server/chunks/") && !chunkPath.includes(".."));
  runtime.c(chunkPath);
  const registration = require(path.join(nextRoot, chunkPath));
  assert.ok(Array.isArray(registration), "expected emitted Turbopack module registration");
  for (let index = 1; index < registration.length; index++) {
    const factory = registration[index];
    if (typeof factory !== "function") continue;
    const body = factory.toString();
    for (const name of ["actualNodeEnvironment", "createTestEventHandlers", "createLocalRefundIsolation"]) {
      if (!body.includes(`.s(["${name}",`)) continue;
      const id = registration[index - 1];
      assert.ok(typeof id === "number" || typeof id === "string");
      const previous = targets.get(name);
      assert.ok(!previous || previous.id === id, `ambiguous emitted export ${name}`);
      targets.set(name, { id, chunkPath, body });
    }
  }
}
assert.equal(targets.size, 3, "all required compiled exports must be discoverable");
// Verify every emitted consumer, including separate SSR copies. Do not replace
// or instrument these factories; their saved runtime instantiates the exact bytes.
const inspected = [];
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) { inspect(filename); continue; }
    if (!filename.endsWith(".js") || filename.includes("[turbopack]_runtime")) continue;
    const registration = require(filename);
    if (!Array.isArray(registration)) continue;
    for (let index = 1; index < registration.length; index++) {
      if (typeof registration[index] !== "function") continue;
      const body = registration[index].toString();
      const helper = body.includes('.s(["actualNodeEnvironment",');
      const guard = body.includes('.s(["createTestEventHandlers",') || body.includes('.s(["createLocalRefundIsolation",');
      const route = body.includes("nodeEnv:") && body.includes("createTestEventHandlers");
      if (!helper && !guard && !route) continue;
      if (helper) {
        assert.match(body, /getBuiltinModule/);
        assert.match(body, /["']process["']/);
        assert.match(body, /\.env\.NODE_ENV/);
      } else {
        assert.match(body, /actualNodeEnvironment/);
        assert.doesNotMatch(body, /nodeEnv:["'](?:production|test)["']/);
      }
      inspected.push({ file: path.relative(root, filename), id: registration[index - 1], kind: helper ? "builtin-accessor" : route ? "route-config" : "guard" });
    }
  }
}
inspect(path.join(nextRoot, "server/chunks"));
assert.ok(inspected.some(item => item.kind === "route-config"));
const exportsFor = async name => await runtime.m(targets.get(name).id).exports;
const actual = await exportsFor("actualNodeEnvironment");
assert.equal(actual.actualNodeEnvironment(), "production");
const events = await exportsFor("createTestEventHandlers");
const refund = await exportsFor("createLocalRefundIsolation");
const touched = [];
const rejectTouch = label => ({ get() { touched.push(label); throw new Error(`Forbidden production access: ${label}`); } });
const eventDeps = { config: { enabled: true, nodeEnv: "test", provider: "mock", database: "pglite", origin, runId: "run_fixture", platformAccountId: "biz_fixture" } };
for (const name of ["authenticate", "orders", "sellers", "uow", "inbox", "refundSafety", "readDelivery", "webhookSecret", "now"]) Object.defineProperty(eventDeps, name, rejectTouch(`events.${name}`));
const handlers = events.createTestEventHandlers(eventDeps);
const statuses = {};
for (const method of ["GET", "POST"]) {
  const response = await handlers[method.toLowerCase()](new Request(`${origin}/api/local-runtime/events`, { method, headers: { host, origin } }));
  assert.equal(response.status, 404, `${method} must refuse actual production despite test config`);
  statuses[method] = response.status;
}
const refundDeps = { env: { NODE_ENV: "test", LEDGERLY_LOCAL_RUNTIME: "1", LEDGERLY_TEST_MODE: "1", WHOP_MODE: "mock", APP_BASE_URL: origin, LEDGERLY_LOCAL_DB_DIR: "/unused-production-denial-fixture" } };
for (const name of ["client", "databaseReady", "baseUow", "platformAccountId", "now", "emitter"]) Object.defineProperty(refundDeps, name, rejectTouch(`refund.${name}`));
assert.throws(() => refund.createLocalRefundIsolation(refundDeps), /Local refund isolation refuses production/);
await Promise.resolve();
assert.deepEqual(touched, [], "production denial must precede authentication, data access, DDL, and readiness scheduling");
const after = verifyArtifact(root, artifact, sha, config);
assert.equal(after.digest, before.digest);
const evidence = { port, fixtureMode, node: process.version, actualNodeEnv: process.env.NODE_ENV, injectedNodeEnv: "test", revision: sha, artifactDigest: after.digest, statuses, refundRefusedBeforeDataAccess: true, touched, inspected, modules: Object.fromEntries([...targets].map(([name, value]) => [name, { id: value.id, chunk: value.chunkPath }])) };
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(evidence));
