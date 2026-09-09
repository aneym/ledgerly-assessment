import { expect, test } from "vitest";
import {
  checkRecord,
  checkScenarioShape,
  isMockId,
  requirementNeedsProviderProof,
} from "./rules.ts";
import { allowlist, minimalRecord, scenario, withArtifact } from "./test-helpers.ts";

const scenarios = new Map([["S08", scenario()]]);
const none = () => undefined;

test("verified by the runner is rejected; a second actor passes", () => {
  const self = minimalRecord({ status: "verified", owner: "a", reviewer: "a" });
  expect(checkRecord(self, scenarios, none, allowlist).map((i) => i.rule)).toEqual([
    "second-actor",
  ]);
  const other = minimalRecord({ status: "verified", owner: "a", reviewer: "b" });
  expect(checkRecord(other, scenarios, none, allowlist)).toEqual([]);
});

test("artifact hashes must match paths and file contents", () => {
  const { rec, body, path } = withArtifact(minimalRecord(), "response.json", '{"ok":true}');
  expect(checkRecord(rec, scenarios, () => body, allowlist)).toEqual([]);
  expect(checkRecord(rec, scenarios, () => "tampered", allowlist).map((i) => i.rule)).toEqual([
    "artifact-hashes",
  ]);
  expect(checkRecord(rec, scenarios, none, allowlist).map((i) => i.rule)).toEqual([
    "artifact-missing",
  ]);
  const unlisted = { ...rec, artifact_paths: [] };
  expect(checkRecord(unlisted, scenarios, () => body, allowlist).map((i) => i.message)).toEqual([
    `hash for unlisted ${path}`,
  ]);
});

test("requirement ids must belong to the scenario", () => {
  const rec = minimalRecord({ requirement_ids: ["CODE-03", "BUILD-01"] });
  expect(checkRecord(rec, scenarios, none, allowlist).map((i) => i.message)).toEqual([
    "BUILD-01 is not in S08",
  ]);
  expect(
    checkRecord(minimalRecord({ scenario_id: "S99" }), scenarios, none, allowlist).map(
      (i) => i.rule,
    ),
  ).toEqual(["scenario"]);
});

test("a test-event sample cannot verify SUBMIT-04 on its own", () => {
  const base = {
    status: "verified" as const,
    owner: "a",
    reviewer: "b",
    sample_payload: true,
    requirement_ids: ["SUBMIT-04"],
  };
  expect(checkRecord(minimalRecord(base), scenarios, none, allowlist).map((i) => i.rule)).toEqual([
    "sample-payload",
  ]);
  const excepted = minimalRecord({
    ...base,
    notes: "assessor-approved exception: email of 2026-09-09",
  });
  expect(checkRecord(excepted, scenarios, none, allowlist)).toEqual([]);
});

test("provider ids need an allowlisted prefix and the allowlist version must be current", () => {
  const rec = minimalRecord({ provider_resource_ids: ["biz_abc123", "zzz_abc123"] });
  expect(checkRecord(rec, scenarios, none, allowlist).map((i) => i.message)).toEqual([
    "zzz_abc123 has no allowlisted prefix (allowlist ledgerly-1)",
  ]);
  const old = minimalRecord({
    redaction_review: { removed_fields: [], allowlist_version: "demo-runtime-1" },
  });
  expect(checkRecord(old, scenarios, none, allowlist).map((i) => i.rule)).toEqual([
    "allowlist-version",
  ]);
});

test("secret patterns are caught in the record and in artifacts", () => {
  const inRecord = minimalRecord({ notes: "used key sk_live_abcdefghijklmnop" });
  expect(checkRecord(inRecord, scenarios, none, allowlist).map((i) => i.rule)).toEqual([
    "secret-pattern",
  ]);
  const { rec, body } = withArtifact(
    minimalRecord(),
    "request.json",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
  );
  expect(checkRecord(rec, scenarios, () => body, allowlist).map((i) => i.rule)).toEqual([
    "secret-pattern",
  ]);
  const placeholder = minimalRecord({ notes: "sk_x is a placeholder" });
  expect(checkRecord(placeholder, scenarios, none, allowlist)).toEqual([]);
});

test("fixture-only scenarios cannot own provider-proof requirements", () => {
  expect(requirementNeedsProviderProof("two real calls and observed duplicate behavior")).toBe(
    true,
  );
  expect(requirementNeedsProviderProof("deterministic fee/currency tests")).toBe(false);
  const reqs = new Map([
    ["BUILD-05", { evidence_required: "two real calls and observed duplicate behavior" }],
    ["CODE-02", { evidence_required: "deterministic fee/currency tests" }],
  ]);
  const bad = scenario({
    scenario_id: "S03",
    requirement_ids: ["BUILD-05"],
    evidence_required: ["fixture"],
  });
  expect(checkScenarioShape(bad, reqs)).toHaveLength(1);
  const ok = scenario({
    scenario_id: "S05",
    requirement_ids: ["CODE-02"],
    evidence_required: ["fixture"],
  });
  expect(checkScenarioShape(ok, reqs)).toEqual([]);
  expect(checkScenarioShape(scenario({ requirement_ids: ["NOPE-01"] }), reqs)).toEqual([
    "S08 names unknown requirement NOPE-01",
  ]);
});

test("hybrid provenance: mock operations and mock ids never sit on a sandbox-api record", () => {
  const sandbox = minimalRecord({
    category: "sandbox-api",
    environment: "sandbox",
    provider_mode: "hybrid",
    operations: [
      { name: "account.create", source: "sandbox", resource_ids: ["biz_abc123"] },
      { name: "transfer.create", source: "mock", resource_ids: ["tsf_mock_1"] },
    ],
    provider_resource_ids: ["biz_abc123", "tsf_mock_1"],
  });
  const rules = checkRecord(sandbox, scenarios, none, allowlist).map((i) => i.rule);
  expect(rules).toContain("provenance");
  expect(rules).toContain("mock-id");
  const hybrid = minimalRecord({
    category: "hybrid-api",
    environment: "sandbox",
    provider_mode: "hybrid",
    operations: [
      { name: "account.create", source: "sandbox", resource_ids: ["biz_abc123"] },
      { name: "transfer.create", source: "mock", resource_ids: ["tsf_mock_1"] },
    ],
  });
  expect(checkRecord(hybrid, scenarios, none, allowlist)).toEqual([]);
  const leaked = minimalRecord({
    category: "hybrid-api",
    provider_mode: "hybrid",
    operations: [{ name: "transfer.create", source: "sandbox", resource_ids: ["tsf_mock_1"] }],
  });
  expect(checkRecord(leaked, scenarios, none, allowlist).map((i) => i.rule)).toEqual(["mock-id"]);
  expect(isMockId("biz_mock_1")).toBe(true);
  expect(isMockId("biz_fabricatedAccount")).toBe(false);
  const mockRun = minimalRecord({
    category: "mock",
    provider_mode: "mock",
    operations: [{ name: "transfer.create", source: "mock", resource_ids: ["tsf_mock_1"] }],
  });
  expect(checkRecord(mockRun, scenarios, none, allowlist)).toEqual([]);
});
