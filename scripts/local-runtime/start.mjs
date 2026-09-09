import { compiledConfiguration, rejectUnsafeEnvironment, verifyArtifact } from "./compiled-artifact.mjs";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
if (args.length % 2 || args.some((arg, index) => index % 2 === 0 && !["--port", "--data-dir", "--webhook-fixture", "--mode", "--expected-sha", "--artifact"].includes(arg))) {
  throw new Error("Usage: node scripts/local-runtime/start.mjs --port 4474 --data-dir /absolute/disposable/path");
}
if (process.env.NODE_ENV === "production" || process.env.CI_PRODUCTION || Object.keys(process.env).some((key) => /^(VERCEL|NETLIFY|AWS_LAMBDA|AWS_EXECUTION_ENV|K_SERVICE|FLY_APP_NAME|RAILWAY_|RENDER)/.test(key))) {
  throw new Error("Local runtime cannot launch in production");
}
const mode = option("--mode", "development");
if (!["development", "compiled-test"].includes(mode)) throw new Error("Invalid runtime mode");
if (mode === "compiled-test") rejectUnsafeEnvironment(root);
const port = Number(option("--port", "4474"));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local port");
const dataDir = option("--data-dir", path.join(root, ".local-runtime", "4474"));
if (!dataDir || !path.isAbsolute(dataDir)) throw new Error("--data-dir must be absolute");
// Next automatically loads dotenv files. Refuse them rather than import deployment credentials.
for (const directory of [root, path.join(root, "apps/web")]) {
  for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    if (existsSync(path.join(directory, name))) throw new Error(`Remove local runtime from checkout with ${name} before launching`);
  }
}
const fixtureMode = option("--webhook-fixture", "0");
if (!["0", "1"].includes(fixtureMode)) throw new Error("--webhook-fixture must be 0 or 1");
const fixture = fixtureMode === "1" ? JSON.parse(readFileSync(path.join(root, "tests/qa/fixtures/webhook_vectors.json"), "utf8")) : null;
if (fixture && (fixture.secret_is_fake !== true || typeof fixture.secret !== "string")) throw new Error("Expected public fake webhook fixture");
if (mode === "compiled-test") {
  const artifact = option("--artifact");
  if (!path.isAbsolute(artifact ?? "")) throw new Error("Compiled runtime requires absolute --artifact");
  verifyArtifact(root, artifact, option("--expected-sha"), compiledConfiguration(root, port, fixtureMode));
}
const base = `http://127.0.0.1:${port}`;
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim();
// An allowlist prevents inherited database/provider credentials from entering the child.
const env = {
  PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp",
  NODE_ENV: mode === "compiled-test" ? "test" : "development", NEXT_TELEMETRY_DISABLED: "1",
  LEDGERLY_RUNTIME_MODE: mode, LEDGERLY_REPOSITORY_ROOT: root,
  ...(mode === "compiled-test" ? { LEDGERLY_COMPILED_ARTIFACT: option("--artifact"), LEDGERLY_COMPILED_SHA: option("--expected-sha"), LEDGERLY_COMPILED_FIXTURE: fixtureMode } : {}),
  LEDGERLY_LOCAL_RUNTIME: "1", LEDGERLY_TEST_MODE: "1", LEDGERLY_LOCAL_DB_DIR: dataDir,
  LEDGERLY_LOADED_REVISION: revision, LEDGERLY_LOADED_DIRTY: dirty ? "1" : "0",
  APP_BASE_URL: base, BETTER_AUTH_URL: base, WHOP_MODE: "mock", DEMO_MODE: "1",
  DEMO_PROFILES_ENABLED: "1", WHOP_API_VERSION_DATE: "2026-08-21",
  RUN_ID: `run_local${randomBytes(8).toString("hex")}`,
  WHOP_WEBHOOK_SECRET: fixture?.secret ?? randomBytes(32).toString("base64url"),
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  ONBOARDING_RETURN_URL: `${base}/sell`, ONBOARDING_REFRESH_URL: `${base}/sell`,
};
const require = createRequire(path.join(root, "packages/db/package.json"));
// Repeated local Webpack compilations exhausted the default 4 GiB heap. Keep a fixed
// child-only cap; do not inherit NODE_OPTIONS or change the host's Node configuration.
const child = spawn(process.execPath, ["--max-old-space-size=8192", "--import", require.resolve("tsx"), path.join(root, "scripts/local-runtime/server.mts"), String(port)], {
  cwd: root, env, stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => { process.exitCode = code ?? 1; });
