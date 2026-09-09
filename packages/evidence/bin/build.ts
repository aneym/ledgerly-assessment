/**
 * Builds the static evidence report.
 *
 *   node bin/build.ts [--evidence DIR] [--out DIR] [--label TEXT] [--allow-issues]
 *
 * Defaults: evidence .runtime/evidence, out .runtime/report, both relative to the
 * repo root. Exits 1 on any schema or rule issue unless --allow-issues is given,
 * so this doubles as the CI gate for the ledger.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveState, loadLedger } from "../src/ledger.ts";
import { renderReport } from "../src/render.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v ?? fallback;
};
const flag = (name: string) => args.includes(`--${name}`);

const evidenceRoot = resolve(repoRoot, opt("evidence", ".runtime/evidence"));
const out = resolve(repoRoot, opt("out", ".runtime/report"));
const label = opt(
  "label",
  "Generated report. Check each record's category before treating it as proof.",
);

function git(cmd: string): string | null {
  try {
    return execSync(`git ${cmd}`, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const ledger = loadLedger({
  laneDocs: join(repoRoot, "docs/lanes/evidence"),
  requirements: join(repoRoot, "docs/wiki/requirements.json"),
  evidenceRoot,
});
const state = deriveState(ledger);
const html = renderReport(ledger, state, {
  generatedAt: new Date().toISOString(),
  codeRevision: git("rev-parse --verify HEAD") ?? "unborn",
  dirtyTree: (git("status --porcelain") ?? "") !== "",
  label,
});

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), html);
writeFileSync(
  join(out, "state.json"),
  JSON.stringify(
    {
      totals: state.totals,
      scenarios: state.scenarios.map((s) => ({
        scenario_id: s.scenario.scenario_id,
        status: s.status,
        blocked_by: s.blockedBy,
        categories: s.categories.map((c) => ({
          category: c.category,
          status: c.status,
          evidence_id: c.latest?.evidence_id,
        })),
      })),
      requirements: state.requirements.map((r) => ({
        id: r.requirement.id,
        status: r.status,
        scenarios: r.scenarioIds,
      })),
    },
    null,
    2,
  ),
);

const issueCount =
  ledger.schemaIssues.reduce((n, f) => n + f.issues.length, 0) +
  ledger.ruleIssues.length +
  ledger.shapeIssues.length;
console.log(
  `records ${ledger.records.length}, requirements ${ledger.requirements.length}, issues ${issueCount}`,
);
console.log(`totals ${JSON.stringify(state.totals)}`);
console.log(`wrote ${join(out, "index.html")}`);
for (const f of ledger.schemaIssues)
  for (const i of f.issues) console.error(`schema ${f.file} ${i.path}: ${i.message}`);
for (const i of ledger.ruleIssues) console.error(`rule ${i.evidence_id} ${i.rule}: ${i.message}`);
for (const s of ledger.shapeIssues) console.error(`shape ${s}`);
if (issueCount && !flag("allow-issues")) process.exit(1);
