import { sha256 } from "./rules.ts";
import type { Allowlist, EvidenceRecord, Scenario } from "./types.ts";

/** A valid fixture record. Every value is an obvious placeholder, never a claimed observation. */
export function minimalRecord(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidence_id: "ev-20260908-000000-test",
    requirement_ids: ["CODE-03"],
    scenario_id: "S08",
    category: "fixture",
    status: "passed",
    owner: "test-runner",
    observed_at: "2026-09-08T00:00:00Z",
    environment: "local",
    code_revision: "unborn",
    dirty_tree: true,
    command: "vitest run signature.test.ts",
    exit_code: 0,
    artifact_paths: [],
    artifact_hashes: {},
    redaction_review: { removed_fields: [], allowlist_version: "ledgerly-1" },
    limitations: "fixture observation; does not satisfy a sandbox, browser or human requirement",
    ...over,
  };
}

export function withArtifact(
  rec: EvidenceRecord,
  name: string,
  body: string,
): { rec: EvidenceRecord; body: string; path: string } {
  const path = `evidence/artifacts/${rec.evidence_id}/${name}`;
  return {
    rec: {
      ...rec,
      artifact_paths: [...rec.artifact_paths, path],
      artifact_hashes: { ...rec.artifact_hashes, [path]: sha256(body) },
    },
    body,
    path,
  };
}

export function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    scenario_id: "S08",
    title: "Webhook consumer",
    requirement_ids: ["BUILD-18", "BUILD-19", "CODE-03", "SUBMIT-04"],
    evidence_required: ["fixture", "sandbox-api"],
    handover_step: 8,
    prerequisites: [],
    gates: ["G01"],
    command: "test",
    expected_invariant: "one effect per event",
    failure_cases: [{ name: "tamper", category: "fixture", expect: "rejected" }],
    owner: "unassigned",
    ...over,
  };
}

export const allowlist: Allowlist = {
  version: "ledgerly-1",
  id_prefixes: { biz_: "business", msg_: "delivery" },
  secret_patterns: ["sk_[A-Za-z0-9_]{8,}", "(?i)authorization:\\s*bearer\\s+[A-Za-z0-9._-]{12,}"],
};
