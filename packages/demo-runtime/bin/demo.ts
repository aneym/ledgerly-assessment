#!/usr/bin/env node
/**
 * Exercises the runtime end to end from the command line.
 *
 *   node bin/demo.ts [--source fixture|sandbox] [--evidence DIR] [--step W05]
 *
 * Prints the live log side panel view, then writes evidence records and a
 * static event export. Sandbox needs WHOP_SANDBOX_API_KEY in the environment
 * and a provider client from the architecture lane; without those it blocks
 * and says so. Nothing here ever deletes a remote resource.
 */
import { execSync } from "node:child_process";
import { FixtureAdapter, SandboxAdapter } from "../src/adapters";
import { buildEvidence, writeEvidence } from "../src/evidence";
import { EventLog, MemoryStore } from "../src/log";
import { DemoRunner } from "../src/runner";
import { STEPS } from "../src/steps";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const source = opt("source", "fixture");
const evidenceDir = opt("evidence", ".runtime/evidence");
const only = opt("step", "");

function repoState() {
  try {
    const rev = execSync("git rev-parse --verify HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const dirty =
      execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim().length > 0;
    return { code_revision: rev, dirty_tree: dirty };
  } catch {
    return { code_revision: "unborn", dirty_tree: true };
  }
}

const adapter =
  source === "sandbox"
    ? new SandboxAdapter({
        apiKey: process.env.WHOP_SANDBOX_API_KEY ?? null,
        apiVersionDate: process.env.WHOP_API_VERSION_DATE ?? null,
      })
    : new FixtureAdapter();
const log = new EventLog(new MemoryStore());
const runner = new DemoRunner({ log, adapter });

log.subscribe((e) => {
  const gate = e.gate ? ` [${e.gate.id}]` : "";
  const http = e.provider?.http_status != null ? ` ${e.provider.http_status}` : "";
  console.log(
    `${String(e.seq).padStart(3)} ${e.at.slice(11, 19)} ${e.role.padEnd(7)} ${e.source.padEnd(7)} ${e.state.padEnd(7)} ${e.kind.padEnd(19)}${http} ${e.summary}${gate}`,
  );
});

await runner.start();
const repo = repoState();
const written: string[] = [];
for (const def of STEPS) {
  if (only && def.id !== only) continue;
  const outcome = await runner.runStep(def.id);
  const bundle = buildEvidence(outcome.events, repo);
  const out = await writeEvidence(evidenceDir, bundle);
  written.push(
    `${bundle.record.evidence_id} ${def.id} ${bundle.record.category} ${bundle.record.status}`,
  );
  void out;
}
const snap = await runner.snapshot();
console.log("\nsnapshot:");
for (const s of snap.steps)
  console.log(
    `  ${s.step_id} ${s.state.padEnd(8)} ${s.source ?? "-"} attempt=${s.attempt}${s.gate ? ` gate=${s.gate.id}` : ""}`,
  );
console.log(`\nevidence written under ${evidenceDir}/records:`);
for (const w of written) console.log(`  ${w}`);
console.log(
  `\nrepo: ${repo.code_revision}${repo.dirty_tree ? " (dirty)" : ""}; contract ${snap.contract_version}; run ${snap.run_id}; ${snap.last_seq} events`,
);
