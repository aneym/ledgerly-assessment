import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cleanRevision, compiledConfiguration, createArtifact, verifyArtifact, rejectUnsafeEnvironment } from "./compiled-artifact.mjs";

test("compiled admission rejects wrong source, changed asset, and changed configuration", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ledgerly-artifact-"));
  try {
    for (const directory of ["apps/web/.next/server", "apps/web/.next/static", "apps/web/public"]) mkdirSync(path.join(root, directory), { recursive: true });
    for (const name of ["apps/web/next.config.ts", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) writeFileSync(path.join(root, name), "fixture\n");
    writeFileSync(path.join(root, ".gitignore"), "apps/web/.next/\nmanifest.json\n");
    writeFileSync(path.join(root, "apps/web/.next/BUILD_ID"), "fixture-build");
    writeFileSync(path.join(root, "apps/web/.next/server/route.js"), "original");
    const git = args => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" }).trim();
    git(["init"]); git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@ledgerly.invalid", "commit", "-m", "fixture"]);
    const sha = git(["rev-parse", "HEAD"]);
    const config = compiledConfiguration(root, 4507, "0");
    const saved = createArtifact(root, sha, config);
    const filename = path.join(root, "manifest.json");
    writeFileSync(filename, JSON.stringify(saved));
    assert.equal(verifyArtifact(root, filename, sha, config).revision, sha);
    assert.throws(() => verifyArtifact(root, filename, "0".repeat(40), config), /clean source SHA/);
    assert.throws(() => verifyArtifact(root, filename, sha, { ...config, nodeEnv: "production" }), /configuration/);
    writeFileSync(path.join(root, "apps/web/.next/server/route.js"), "changed");
    assert.throws(() => verifyArtifact(root, filename, sha, config), /assets/);
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "changed");
    assert.throws(() => cleanRevision(root, sha), /clean source SHA/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("compiled admission refuses actual production, hosted environments, and all Next dotenv modes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ledgerly-env-"));
  try {
    assert.throws(() => rejectUnsafeEnvironment(root, { NODE_ENV: "production" }), /production/);
    assert.throws(() => rejectUnsafeEnvironment(root, { NODE_ENV: "test", VERCEL: "1" }), /production/);
    for (const name of [".env", ".env.local", ".env.test", ".env.test.local", ".env.production", ".env.production.local"]) {
      writeFileSync(path.join(root, name), "");
      assert.throws(() => rejectUnsafeEnvironment(root, { NODE_ENV: "test" }), /refuses/);
      rmSync(path.join(root, name));
    }
    rejectUnsafeEnvironment(root, { NODE_ENV: "test" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
