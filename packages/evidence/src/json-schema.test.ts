import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type JsonSchema, validate } from "./json-schema.ts";
import { minimalRecord } from "./test-helpers.ts";

const laneDocs = join(import.meta.dirname, "../../../docs/lanes/evidence");
const recordSchema = JSON.parse(
  readFileSync(join(laneDocs, "schemas/evidence-record.schema.json"), "utf8"),
) as JsonSchema;
const scenarioSchema = JSON.parse(
  readFileSync(join(laneDocs, "schemas/scenario.schema.json"), "utf8"),
) as JsonSchema;
const scenarios = JSON.parse(
  readFileSync(join(laneDocs, "schemas/scenarios.json"), "utf8"),
) as unknown[];

test("all twelve scenarios in the lane validate", () => {
  expect(scenarios).toHaveLength(12);
  for (const s of scenarios) expect(validate(scenarioSchema, s)).toEqual([]);
});

test("a minimal fixture record validates", () => {
  expect(validate(recordSchema, minimalRecord())).toEqual([]);
});

test("verified needs reviewer, reviewed_at and readback", () => {
  const issues = validate(recordSchema, minimalRecord({ status: "verified" }));
  expect(issues.map((i) => i.message).sort()).toEqual([
    "missing readback",
    "missing reviewed_at",
    "missing reviewer",
  ]);
});

test("blocked needs blocked_by; local gates are allowed", () => {
  expect(
    validate(recordSchema, minimalRecord({ status: "blocked" })).map((i) => i.message),
  ).toEqual(["missing blocked_by"]);
  expect(validate(recordSchema, minimalRecord({ status: "blocked", blocked_by: "G01" }))).toEqual(
    [],
  );
  expect(
    validate(recordSchema, minimalRecord({ status: "blocked", blocked_by: "local:credential" })),
  ).toEqual([]);
  expect(
    validate(recordSchema, minimalRecord({ status: "blocked", blocked_by: "CRED" })),
  ).toHaveLength(1);
});

test("artifact hash values are validated as sha256 hex", () => {
  const bad = minimalRecord({
    artifact_paths: ["evidence/artifacts/ev-20260908-000000-test/a.json"],
    artifact_hashes: { "evidence/artifacts/ev-20260908-000000-test/a.json": "not-a-hash" },
  });
  expect(validate(recordSchema, bad).map((i) => i.path)).toEqual([
    "$.artifact_hashes.evidence/artifacts/ev-20260908-000000-test/a.json",
  ]);
});

test("a sandbox-api pass needs provider references; a blocked one does not", () => {
  const passed = minimalRecord({
    category: "sandbox-api",
    environment: "sandbox",
    status: "passed",
  });
  const missing = validate(recordSchema, passed).map((i) => i.message);
  expect(missing).toContain("missing rest_version");
  expect(missing).toContain("missing request_reference");
  const blocked = minimalRecord({
    category: "sandbox-api",
    environment: "sandbox",
    status: "blocked",
    blocked_by: "G01",
    api_base: "https://sandbox-api.whop.com/api/v1",
  });
  expect(validate(recordSchema, blocked)).toEqual([]);
});

test("unknown fields, bad ids and the production base are rejected", () => {
  const issues = validate(recordSchema, {
    ...minimalRecord(),
    extra: 1,
    evidence_id: "ev-1",
    api_base: "https://api.whop.com/api/v1",
  }).map((i) => `${i.path} ${i.message}`);
  expect(issues).toContain("$ unexpected extra");
  expect(issues.some((m) => m.startsWith("$.evidence_id does not match"))).toBe(true);
  expect(issues.some((m) => m.startsWith("$.api_base expected one of"))).toBe(true);
});
