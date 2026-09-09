import { createHash } from "node:crypto";
import type { Allowlist, EvidenceRecord, Scenario } from "./types.ts";

/**
 * The checks the JSON schema cannot express. Listed under x-generator-checks in
 * evidence-record.schema.json. Each returns issues; none mutates a record.
 */

export interface RuleIssue {
  evidence_id: string;
  rule: string;
  message: string;
}

export type ArtifactReader = (path: string) => string | undefined;

export function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Words in a requirement's proof column that a fixture or mock record can never satisfy. */
const PROVIDER_PROOF = /\b(sandbox|provider|hosted|human|actual|real)\b/i;

/** Categories produced without touching the real provider. */
export const LOCAL_CATEGORIES: ReadonlySet<string> = new Set(["fixture", "mock"]);

export function requirementNeedsProviderProof(evidenceRequired: string): boolean {
  return PROVIDER_PROOF.test(evidenceRequired);
}

export function checkRecord(
  rec: EvidenceRecord,
  scenarios: Map<string, Scenario>,
  readArtifact: ArtifactReader,
  allowlist: Allowlist,
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const add = (rule: string, message: string) =>
    issues.push({ evidence_id: rec.evidence_id, rule, message });

  if (rec.status === "verified") {
    if (!rec.reviewer) add("second-actor", "verified without a reviewer");
    else if (rec.reviewer === rec.owner)
      add("second-actor", `reviewer ${rec.reviewer} is the owner; verified needs a second actor`);
  }

  const paths = new Set(rec.artifact_paths);
  const hashed = new Set(Object.keys(rec.artifact_hashes));
  for (const p of paths) if (!hashed.has(p)) add("artifact-hashes", `no hash for ${p}`);
  for (const p of hashed) if (!paths.has(p)) add("artifact-hashes", `hash for unlisted ${p}`);
  for (const [p, expected] of Object.entries(rec.artifact_hashes)) {
    const body = readArtifact(p);
    if (body === undefined) add("artifact-missing", `${p} not found`);
    else if (sha256(body) !== expected) add("artifact-hashes", `${p} content does not match hash`);
  }

  const scenario = scenarios.get(rec.scenario_id);
  if (!scenario) add("scenario", `unknown scenario ${rec.scenario_id}`);
  else
    for (const id of rec.requirement_ids)
      if (!scenario.requirement_ids.includes(id))
        add("scenario", `${id} is not in ${rec.scenario_id}`);

  if (
    rec.sample_payload === true &&
    rec.status === "verified" &&
    rec.requirement_ids.includes("SUBMIT-04") &&
    !/assessor-approved exception/i.test(rec.notes ?? "")
  )
    add(
      "sample-payload",
      "a test-event sample cannot verify SUBMIT-04 without an assessor-approved exception noted",
    );

  const prefixes = Object.keys(allowlist.id_prefixes);
  for (const id of rec.provider_resource_ids ?? [])
    if (!prefixes.some((p) => id.startsWith(p)))
      add("id-allowlist", `${id} has no allowlisted prefix (allowlist ${allowlist.version})`);

  // Hybrid provenance: a sandbox-api record is sandbox on every operation, and mock ids stay on mock operations.
  const ops = rec.operations ?? [];
  const mockOps = ops.filter((o) => o.source === "mock");
  if (rec.category === "sandbox-api" && mockOps.length)
    add(
      "provenance",
      `sandbox-api record has mock operations: ${mockOps.map((o) => o.name).join(", ")}`,
    );
  if (rec.category === "sandbox-api" && rec.provider_mode && rec.provider_mode !== "sandbox")
    add("provenance", `sandbox-api record ran in provider_mode ${rec.provider_mode}`);
  if (mockOps.length && !LOCAL_CATEGORIES.has(rec.category) && rec.category !== "hybrid-api")
    add(
      "provenance",
      `mock operations require category hybrid-api, mock or fixture, not ${rec.category}`,
    );
  for (const id of rec.provider_resource_ids ?? [])
    if (isMockId(id) && rec.category === "sandbox-api")
      add("mock-id", `${id} is a mock id on a sandbox-api record`);
  for (const o of ops)
    if (o.source === "sandbox")
      for (const id of o.resource_ids ?? [])
        if (isMockId(id)) add("mock-id", `${id} is a mock id on sandbox operation ${o.name}`);

  if (rec.redaction_review.allowlist_version !== allowlist.version)
    add(
      "allowlist-version",
      `record redacted under ${rec.redaction_review.allowlist_version}, current is ${allowlist.version}`,
    );

  const patterns = allowlist.secret_patterns.map(compile);
  const scan = (label: string, text: string) => {
    for (const re of patterns)
      if (re.test(text)) add("secret-pattern", `${label} matches ${re.source}`);
  };
  scan("record", JSON.stringify(rec));
  for (const p of paths) {
    const body = readArtifact(p);
    if (body !== undefined) scan(p, body);
  }

  return issues;
}

/** The mock adapter mints ids like biz_mock_1, pay_mock_3 and urls on mock.invalid. */
export function isMockId(id: string): boolean {
  return /_mock_|mock\.invalid|^mock_/.test(id);
}

/** Patterns in the allowlist use a leading (?i) for case-insensitive, which JS spells as a flag. */
function compile(pattern: string): RegExp {
  if (pattern.startsWith("(?i)")) return new RegExp(pattern.slice(4), "i");
  return new RegExp(pattern);
}

/** A scenario whose requirements demand provider proof must not rely on fixture evidence alone. */
export function checkScenarioShape(
  scenario: Scenario,
  requirements: Map<string, { evidence_required: string }>,
): string[] {
  const problems: string[] = [];
  const onlyFixture =
    scenario.evidence_required.length > 0 &&
    scenario.evidence_required.every((c) => LOCAL_CATEGORIES.has(c));
  for (const id of scenario.requirement_ids) {
    const req = requirements.get(id);
    if (!req) {
      problems.push(`${scenario.scenario_id} names unknown requirement ${id}`);
      continue;
    }
    if (onlyFixture && requirementNeedsProviderProof(req.evidence_required))
      problems.push(
        `${scenario.scenario_id} lists only fixture evidence but ${id} needs: ${req.evidence_required}`,
      );
  }
  return problems;
}
