import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type JsonSchema, type SchemaIssue, validate } from "./json-schema.ts";
import { checkRecord, checkScenarioShape, type RuleIssue } from "./rules.ts";
import type {
  Allowlist,
  Category,
  EvidenceRecord,
  Requirement,
  Scenario,
  Status,
} from "./types.ts";

export interface LedgerPaths {
  /** Directory holding evidence-record.schema.json, scenario.schema.json, scenarios.json, redaction-allowlist.json. */
  laneDocs: string;
  /** docs/wiki/requirements.json */
  requirements: string;
  /** Directory with records/*.json and artifacts/<id>/... */
  evidenceRoot: string;
}

export interface Ledger {
  requirements: Requirement[];
  scenarios: Scenario[];
  records: EvidenceRecord[];
  allowlist: Allowlist;
  schemaIssues: { file: string; issues: SchemaIssue[] }[];
  ruleIssues: RuleIssue[];
  shapeIssues: string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadLedger(paths: LedgerPaths): Ledger {
  const recordSchema = readJson<JsonSchema>(
    join(paths.laneDocs, "schemas/evidence-record.schema.json"),
  );
  const scenarioSchema = readJson<JsonSchema>(join(paths.laneDocs, "schemas/scenario.schema.json"));
  const scenarios = readJson<Scenario[]>(join(paths.laneDocs, "schemas/scenarios.json"));
  const allowlist = readJson<Allowlist>(join(paths.laneDocs, "redaction-allowlist.json"));
  const requirements = readJson<{ requirements: Requirement[] }>(paths.requirements).requirements;

  const schemaIssues: Ledger["schemaIssues"] = [];
  scenarios.forEach((s, i) => {
    const issues = validate(scenarioSchema, s);
    if (issues.length) schemaIssues.push({ file: `scenarios.json[${i}]`, issues });
  });

  const recordsDir = join(paths.evidenceRoot, "records");
  const records: EvidenceRecord[] = [];
  if (existsSync(recordsDir)) {
    for (const name of readdirSync(recordsDir)
      .filter((n) => n.endsWith(".json"))
      .sort()) {
      const raw = readJson<unknown>(join(recordsDir, name));
      const issues = validate(recordSchema, raw);
      if (issues.length) schemaIssues.push({ file: `records/${name}`, issues });
      else records.push(raw as EvidenceRecord);
    }
  }

  const scenarioById = new Map(scenarios.map((s) => [s.scenario_id, s]));
  const requirementById = new Map(requirements.map((r) => [r.id, r]));
  const readArtifact = (p: string) => {
    // artifact_paths are repo-relative "evidence/artifacts/<id>/<file>"; evidenceRoot is that "evidence" directory.
    const rel = p.startsWith("evidence/") ? p.slice("evidence/".length) : p;
    const full = resolve(paths.evidenceRoot, rel);
    return existsSync(full) ? readFileSync(full, "utf8") : undefined;
  };
  const ruleIssues = records.flatMap((r) => checkRecord(r, scenarioById, readArtifact, allowlist));
  const shapeIssues = scenarios.flatMap((s) => checkScenarioShape(s, requirementById));

  return { requirements, scenarios, records, allowlist, schemaIssues, ruleIssues, shapeIssues };
}

/* ---------- derived state ---------- */

export type ScenarioStatus = "verified" | "passed" | "failed" | "blocked" | "partial" | "not-run";

export interface CategoryState {
  category: Category;
  latest?: EvidenceRecord;
  status: Status | "missing";
}

export interface ScenarioState {
  scenario: Scenario;
  status: ScenarioStatus;
  categories: CategoryState[];
  records: EvidenceRecord[];
  blockedBy: string[];
}

export interface RequirementState {
  requirement: Requirement;
  scenarioIds: string[];
  status: ScenarioStatus;
  records: EvidenceRecord[];
}

export interface DerivedState {
  scenarios: ScenarioState[];
  requirements: RequirementState[];
  totals: Record<ScenarioStatus, number>;
}

/** Newest record wins; a superseded record never counts as latest. */
export function latestRecords(records: EvidenceRecord[]): EvidenceRecord[] {
  const superseded = new Set(records.map((r) => r.supersedes).filter(Boolean));
  return records
    .filter((r) => !superseded.has(r.evidence_id))
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at));
}

export function deriveState(ledger: Ledger): DerivedState {
  const live = latestRecords(ledger.records);
  const scenarios = [...ledger.scenarios]
    .sort((a, b) => a.handover_step - b.handover_step)
    .map((scenario) =>
      deriveScenario(
        scenario,
        live.filter((r) => r.scenario_id === scenario.scenario_id),
      ),
    );
  const byId = new Map(scenarios.map((s) => [s.scenario.scenario_id, s]));

  const requirements = ledger.requirements.map((requirement) => {
    const owning = ledger.scenarios.filter((s) => s.requirement_ids.includes(requirement.id));
    const states = owning
      .map((s) => byId.get(s.scenario_id))
      .filter((s): s is ScenarioState => !!s);
    const records = live.filter((r) => r.requirement_ids.includes(requirement.id));
    return {
      requirement,
      scenarioIds: owning.map((s) => s.scenario_id),
      status: combine(states.map((s) => s.status)),
      records,
    };
  });

  const totals: Record<ScenarioStatus, number> = {
    verified: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    partial: 0,
    "not-run": 0,
  };
  for (const r of requirements) totals[r.status] += 1;
  return { scenarios, requirements, totals };
}

function deriveScenario(scenario: Scenario, records: EvidenceRecord[]): ScenarioState {
  const categories: CategoryState[] = scenario.evidence_required.map((category) => {
    const latest = records.find((r) => r.category === category);
    return latest ? { category, latest, status: latest.status } : { category, status: "missing" };
  });
  const statuses = categories.map((c) => c.status);
  const blockedBy = [...new Set(records.map((r) => r.blocked_by).filter((g): g is string => !!g))];
  let status: ScenarioStatus;
  if (statuses.every((s) => s === "verified")) status = "verified";
  else if (statuses.includes("failed")) status = "failed";
  else if (statuses.includes("blocked")) status = "blocked";
  else if (statuses.every((s) => s === "passed" || s === "verified")) status = "passed";
  else if (records.length === 0) status = "not-run";
  else status = "partial";
  return { scenario, status, categories, records, blockedBy };
}

/** A requirement spanning several scenarios takes the weakest of them. */
function combine(statuses: ScenarioStatus[]): ScenarioStatus {
  const order: ScenarioStatus[] = ["not-run", "failed", "blocked", "partial", "passed", "verified"];
  if (statuses.length === 0) return "not-run";
  return statuses.reduce((worst, s) => (order.indexOf(s) < order.indexOf(worst) ? s : worst));
}
