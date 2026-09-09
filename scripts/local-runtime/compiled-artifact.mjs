import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export function rejectUnsafeEnvironment(root, env = process.env) {
  if (env.NODE_ENV === "production" || env.CI_PRODUCTION || Object.keys(env).some(key => /^(VERCEL|NETLIFY|AWS_LAMBDA|AWS_EXECUTION_ENV|K_SERVICE|FLY_APP_NAME|RAILWAY_|RENDER)/.test(key))) {
    throw new Error("Local runtime cannot launch in production");
  }
  for (const directory of [root, path.join(root, "apps/web")]) {
    for (const name of [".env", ".env.local", ".env.development", ".env.development.local", ".env.test", ".env.test.local", ".env.production", ".env.production.local"]) {
      if (existsSync(path.join(directory, name))) throw new Error(`Local compiled runtime refuses ${name}`);
    }
  }
}
export function cleanRevision(root, expected) {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(expected ?? "") || revision !== expected || dirty) throw new Error("Compiled runtime requires matching clean source SHA");
  return revision;
}
export function compiledConfiguration(root, port, fixtureMode) {
  return { mode: "compiled-test", nodeEnv: "test", builder: "turbopack", origin: `http://127.0.0.1:${port}`, repositoryRoot: realpathSync(root), fixtureMode };
}
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export function artifactFiles(root) {
  const files = {};
  function visit(relative) {
    const absolute = path.join(root, relative);
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`Artifact symlink refused: ${relative}`);
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    } else if (info.isFile()) files[relative] = digest(readFileSync(absolute));
  }
  // These are served assets and executable bundles. Next's mutable cache/trace files
  // are not request inputs and are deliberately outside the artifact inventory.
  for (const directory of ["apps/web/.next/server", "apps/web/.next/static", "apps/web/public"]) visit(directory);
  for (const name of readdirSync(path.join(root, "apps/web/.next")).sort()) {
    if (name === "BUILD_ID" || name.endsWith(".json")) visit(`apps/web/.next/${name}`);
  }
  for (const name of ["apps/web/next.config.ts", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) visit(name);
  return files;
}
export function createArtifact(root, expected, configuration) {
  cleanRevision(root, expected);
  if (!existsSync(path.join(root, "apps/web/.next/BUILD_ID"))) throw new Error("Compiled build is missing BUILD_ID");
  const files = artifactFiles(root);
  return { version: 1, revision: expected, configuration, files, digest: digest(JSON.stringify(files)) };
}
export function verifyArtifact(root, filename, expected, configuration) {
  const saved = JSON.parse(readFileSync(filename, "utf8"));
  const observed = createArtifact(root, expected, configuration);
  if (JSON.stringify(saved) !== JSON.stringify(observed)) throw new Error("Compiled source, assets, or configuration do not match artifact manifest");
  return observed;
}
