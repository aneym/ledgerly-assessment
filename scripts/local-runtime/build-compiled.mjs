import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanRevision, compiledConfiguration, createArtifact, rejectUnsafeEnvironment } from "./compiled-artifact.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const allowed = new Set(["--port", "--expected-sha", "--artifact", "--webhook-fixture"]);
if (args.length % 2 || args.some((arg, index) => index % 2 === 0 && !allowed.has(arg))) throw new Error("Expected --port, --expected-sha, --artifact and optional --webhook-fixture");
const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
const port = Number(options["--port"]);
const artifact = options["--artifact"];
const fixture = options["--webhook-fixture"] ?? "0";
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !path.isAbsolute(artifact ?? "") || !["0", "1"].includes(fixture)) throw new Error("Invalid compiled build configuration");
rejectUnsafeEnvironment(root);
cleanRevision(root, options["--expected-sha"]);
if (existsSync(artifact) || existsSync(path.join(root, "apps/web/.next/BUILD_ID"))) throw new Error("Preserve existing artifact; compiled feasibility permits one fresh build");
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const result = spawnSync(process.execPath, ["--max-old-space-size=8192", require.resolve("next/dist/bin/next"), "build", "--turbopack"], {
  cwd: path.join(root, "apps/web"), stdio: "inherit",
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", WHOP_MODE: "mock", DEMO_MODE: "1" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const manifest = createArtifact(root, options["--expected-sha"], compiledConfiguration(root, port, fixture));
writeFileSync(artifact, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ revision: manifest.revision, artifact, digest: manifest.digest, fileCount: Object.keys(manifest.files).length }));
