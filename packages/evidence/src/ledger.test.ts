import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { deriveState, type Ledger, latestRecords, loadLedger } from "./ledger.ts";
import { allowlist, minimalRecord, scenario, withArtifact } from "./test-helpers.ts";
import type { Requirement } from "./types.ts";

const laneDocs = join(import.meta.dirname, "../../../docs/lanes/evidence");
const requirements = join(import.meta.dirname, "../../../docs/wiki/requirements.json");

function ledgerWith(records: Ledger["records"], scenarios = [scenario()]): Ledger {
  const reqs: Requirement[] = [
    {
      id: "BUILD-18",
      requirement: "",
      evidence_required: "webhook readback",
      section: "",
      state: "not-run",
    },
    {
      id: "BUILD-19",
      requirement: "",
      evidence_required: "real signed test/replay IDs",
      section: "",
      state: "not-run",
    },
    {
      id: "CODE-03",
      requirement: "",
      evidence_required: "raw signature tests",
      section: "",
      state: "not-run",
    },
    {
      id: "SUBMIT-04",
      requirement: "",
      evidence_required: "eight provider payload types",
      section: "",
      state: "not-run",
    },
  ];
  return {
    requirements: reqs,
    scenarios,
    records,
    allowlist,
    schemaIssues: [],
    ruleIssues: [],
    shapeIssues: [],
  };
}

test("a fixture pass leaves a scenario that also needs sandbox proof partly run", () => {
  const state = deriveState(ledgerWith([minimalRecord()]));
  const s08 = state.scenarios[0];
  expect(s08?.status).toBe("partial");
  expect(s08?.categories.map((c) => `${c.category}:${c.status}`)).toEqual([
    "fixture:passed",
    "sandbox-api:missing",
  ]);
  expect(state.totals).toMatchObject({ partial: 4, verified: 0 });
});

test("verified across every required category makes the scenario and its requirements verified", () => {
  const fixture = minimalRecord({
    status: "verified",
    reviewer: "b",
    reviewed_at: "2026-09-08T01:00:00Z",
  });
  const sandbox = minimalRecord({
    evidence_id: "ev-20260908-000001-test",
    category: "sandbox-api",
    environment: "sandbox",
    status: "verified",
    reviewer: "b",
    reviewed_at: "2026-09-08T01:00:00Z",
    requirement_ids: ["BUILD-18", "BUILD-19", "CODE-03", "SUBMIT-04"],
  });
  const state = deriveState(ledgerWith([fixture, sandbox]));
  expect(state.scenarios[0]?.status).toBe("verified");
  expect(state.requirements.find((r) => r.requirement.id === "BUILD-18")?.status).toBe("verified");
  expect(state.requirements.find((r) => r.requirement.id === "CODE-03")?.status).toBe("verified");
});

test("a blocked sandbox record marks the scenario blocked and names the gate", () => {
  const blocked = minimalRecord({
    evidence_id: "ev-20260908-000002-test",
    category: "sandbox-api",
    environment: "sandbox",
    status: "blocked",
    blocked_by: "G01",
    api_base: "https://sandbox-api.whop.com/api/v1",
  });
  const state = deriveState(ledgerWith([minimalRecord(), blocked]));
  expect(state.scenarios[0]?.status).toBe("blocked");
  expect(state.scenarios[0]?.blockedBy).toEqual(["G01"]);
});

test("a newer record and a superseding record replace the old one", () => {
  const old = minimalRecord({
    evidence_id: "ev-20260908-000000-aaaa",
    status: "failed",
    observed_at: "2026-09-08T00:00:00Z",
  });
  const fix = minimalRecord({
    evidence_id: "ev-20260908-000100-bbbb",
    status: "passed",
    observed_at: "2026-09-08T00:01:00Z",
    supersedes: old.evidence_id,
  });
  expect(latestRecords([old, fix]).map((r) => r.evidence_id)).toEqual([fix.evidence_id]);
  const later = minimalRecord({
    evidence_id: "ev-20260908-000200-cccc",
    status: "failed",
    observed_at: "2026-09-08T00:02:00Z",
  });
  expect(deriveState(ledgerWith([fix, later])).scenarios[0]?.status).toBe("failed");
});

test("a requirement spanning two scenarios takes the weaker state", () => {
  const a = scenario({
    scenario_id: "S02",
    requirement_ids: ["BUILD-18"],
    evidence_required: ["fixture"],
    handover_step: 2,
  });
  const b = scenario({
    scenario_id: "S08",
    requirement_ids: ["BUILD-18"],
    evidence_required: ["fixture"],
    handover_step: 8,
  });
  const ok = minimalRecord({
    scenario_id: "S02",
    requirement_ids: ["BUILD-18"],
    status: "verified",
    reviewer: "b",
    reviewed_at: "2026-09-08T01:00:00Z",
  });
  const state = deriveState(ledgerWith([ok], [a, b]));
  expect(state.requirements.find((r) => r.requirement.id === "BUILD-18")?.status).toBe("not-run");
});

test("loadLedger reads the lane files, validates records and checks artifact hashes on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "ledgerly-evidence-"));
  mkdirSync(join(root, "records"), { recursive: true });
  const { rec, body, path } = withArtifact(minimalRecord(), "response.json", '{"ok":true}');
  mkdirSync(join(root, "artifacts", rec.evidence_id), { recursive: true });
  writeFileSync(join(root, path.replace(/^evidence\//, "")), body);
  writeFileSync(join(root, "records", `${rec.evidence_id}.json`), JSON.stringify(rec));
  writeFileSync(join(root, "records", "broken.json"), JSON.stringify({ evidence_id: "nope" }));
  const ledger = loadLedger({ laneDocs, requirements, evidenceRoot: root });
  expect(ledger.requirements).toHaveLength(37);
  expect(ledger.scenarios).toHaveLength(12);
  expect(ledger.records.map((r) => r.evidence_id)).toEqual([rec.evidence_id]);
  expect(ledger.schemaIssues.map((f) => f.file)).toEqual(["records/broken.json"]);
  expect(ledger.ruleIssues).toEqual([]);
  expect(ledger.shapeIssues).toEqual([]);
});
