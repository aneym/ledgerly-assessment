import { access, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, expect, type TestContext, test } from "vitest";
import { FixtureAdapter, type OperationResult, SandboxAdapter } from "../src/adapters";
import { SANDBOX_API_BASE } from "../src/contract";
import { buildEvidence, evidenceId, writeEvidence } from "../src/evidence";
import { EventLog, MemoryStore } from "../src/log";
import { DemoRunner } from "../src/runner";
import { STEPS } from "../src/steps";
import { fixedClock, withOwnerGate } from "./helpers";

const repo = { code_revision: "unborn", dirty_tree: true };
const schemaUrl = new URL(
  "../../../docs/lanes/evidence/schemas/evidence-record.schema.json",
  import.meta.url,
);
const scenariosUrl = new URL(
  "../../../docs/lanes/evidence/schemas/scenarios.json",
  import.meta.url,
);

/**
 * The evidence schemas are owned by the evidence lane and land on main through
 * its branch. When a checkout lacks them, the conformance tests skip visibly
 * rather than fail, so this branch stays self-consistent before integration.
 */
async function requireEvidenceSchemas(t: TestContext): Promise<boolean> {
  try {
    await access(schemaUrl);
    await access(scenariosUrl);
    return true;
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    t.skip(
      "evidence lane schemas absent from this checkout (docs/lanes/evidence/schemas); integrate work/evidence-lane-q04 to run",
    );
    return false;
  }
}

type Schema = {
  required: string[];
  properties: Record<
    string,
    { pattern?: string; enum?: string[]; type?: string | string[]; items?: { pattern?: string } }
  >;
  allOf: { if: { properties: Record<string, { const: string }> }; then: { required: string[] } }[];
};

/** Structural check against the evidence lane's schema: required, no extras, patterns, enums, conditionals. */
async function checkAgainstSchema(record: Record<string, unknown>) {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as Schema;
  const errors: string[] = [];
  for (const k of schema.required) if (!(k in record)) errors.push(`missing ${k}`);
  for (const k of Object.keys(record)) {
    const spec = schema.properties[k];
    if (!spec) {
      errors.push(`unknown field ${k}`);
      continue;
    }
    const v = record[k];
    if (spec.enum && !spec.enum.includes(v as string))
      errors.push(`${k} not in enum: ${String(v)}`);
    if (spec.pattern && typeof v === "string" && !new RegExp(spec.pattern).test(v))
      errors.push(`${k} fails pattern: ${v}`);
    if (spec.items?.pattern && Array.isArray(v))
      for (const item of v)
        if (!new RegExp(spec.items.pattern).test(String(item)))
          errors.push(`${k} item fails pattern: ${String(item)}`);
    if (v === null) errors.push(`${k} is null`);
  }
  for (const cond of schema.allOf) {
    const entry = Object.entries(cond.if.properties)[0];
    if (!entry) continue;
    const [field, { const: value }] = entry;
    if (record[field] === value)
      for (const k of cond.then.required)
        if (!(k in record)) errors.push(`${field}=${value} requires ${k}`);
  }
  const hashes = record.artifact_hashes as Record<string, string>;
  assert.deepEqual(
    Object.keys(hashes).sort(),
    [...(record.artifact_paths as string[])].sort(),
    "hash keys equal artifact paths",
  );
  return errors;
}

test("evidence ids follow the lane's ev-YYYYMMDD-HHMMSS-xxxx form", () => {
  assert.match(
    evidenceId("2026-09-08T18:04:05.000Z", () => 0.5),
    /^ev-20260908-180405-[a-z0-9]{4}$/,
  );
});

test("every walkthrough step maps to a scenario and its requirements are a subset of that scenario's", async (t) => {
  if (!(await requireEvidenceSchemas(t))) return;
  const scenarios = JSON.parse(await readFile(scenariosUrl, "utf8")) as {
    scenario_id: string;
    requirement_ids: string[];
  }[];
  for (const step of STEPS) {
    const sc = scenarios.find((s) => s.scenario_id === step.scenario_id);
    assert.ok(sc, `${step.id} names unknown scenario ${step.scenario_id}`);
    for (const r of step.requirement_ids)
      assert.ok(
        sc.requirement_ids.includes(r),
        `${step.id} requirement ${r} is not in ${sc.scenario_id}`,
      );
  }
});

test("a fixture pass becomes a schema-conformant fixture record that says it cannot satisfy sandbox proof", async (t) => {
  if (!(await requireEvidenceSchemas(t))) return;
  const runner = new DemoRunner({
    log: new EventLog(new MemoryStore()),
    adapter: new FixtureAdapter(),
    clock: fixedClock(),
  });
  await runner.start();
  const o = await runner.runStep("C03");
  const { record, artifacts } = buildEvidence(o.events, repo);
  assert.deepEqual(await checkAgainstSchema(record as unknown as Record<string, unknown>), []);
  assert.equal(record.category, "fixture");
  assert.equal(record.status, "passed");
  assert.equal(record.scenario_id, "S05");
  assert.equal("api_base" in record, false, "fixture never claims the sandbox base");
  assert.match(record.limitations, /does not satisfy a sandbox/);
  assert.match(record.notes, new RegExp(o.correlation_id));
  assert.equal(record.exit_code, 0);
  assert.ok("request.json" in artifacts && "response.json" in artifacts);
});

test("an owner-gated sandbox step becomes a blocked sandbox-api record with blocked_by", async (t) => {
  if (!(await requireEvidenceSchemas(t))) return;
  const client = async (): Promise<OperationResult> => ({
    outcome: "ok",
    output: {},
    provider: {
      base_url: SANDBOX_API_BASE,
      http_status: 200,
      request_id: null,
      resource_ids: [],
      api_version_date: "2026-08-21",
      operation: null,
      duration_ms: null,
    },
    gate: null,
  });
  const runner = new DemoRunner({
    log: new EventLog(new MemoryStore()),
    adapter: new SandboxAdapter({ apiKey: "sk_x", apiVersionDate: "2026-08-21" }, client),
    clock: fixedClock(),
  });
  await runner.start();
  const o = await withOwnerGate("C05", () => runner.runStep("C05"));
  const { record } = buildEvidence(o.events, repo);
  assert.equal(record.status, "blocked");
  assert.equal(record.blocked_by, "G01");
  assert.equal(record.category, "sandbox-api");
  assert.equal(record.api_base, SANDBOX_API_BASE);
  const errs = await checkAgainstSchema(record as unknown as Record<string, unknown>);
  // The lane schema requires rest_version and request/response references for every sandbox-api record.
  // A step blocked before any call has none; this is raised with the evidence lane in the handoff.
  assert.deepEqual(errs, [
    "category=sandbox-api requires rest_version",
    "category=sandbox-api requires request_reference",
    "category=sandbox-api requires response_reference",
  ]);
});

test("a locally gated sandbox step (no credential) is not-run, never blocked-by-G or passed", async () => {
  const runner = new DemoRunner({
    log: new EventLog(new MemoryStore()),
    adapter: new SandboxAdapter({ apiKey: null, apiVersionDate: null }),
    clock: fixedClock(),
  });
  await runner.start();
  const o = await runner.runStep("C01");
  const { record } = buildEvidence(o.events, repo);
  assert.equal(record.status, "not-run");
  assert.equal("blocked_by" in record, false);
  assert.match(record.limitations, /local gate CRED/);
});

test("a real sandbox pass yields a fully conformant sandbox-api record with references", async (t) => {
  if (!(await requireEvidenceSchemas(t))) return;
  const client = async (req: { operation: string }): Promise<OperationResult> => ({
    outcome: "ok",
    output: { id: "biz_fixturePlatform", operation: req.operation },
    provider: {
      base_url: SANDBOX_API_BASE,
      http_status: 200,
      request_id: "req_1",
      resource_ids: ["biz_fixturePlatform"],
      api_version_date: "2026-08-21",
      operation: null,
      duration_ms: null,
    },
    gate: null,
  });
  const runner = new DemoRunner({
    log: new EventLog(new MemoryStore()),
    adapter: new SandboxAdapter({ apiKey: "sk_x", apiVersionDate: "2026-08-21" }, client),
    clock: fixedClock(),
  });
  await runner.start();
  const o = await runner.runStep("C01");
  const { record } = buildEvidence(o.events, repo);
  assert.deepEqual(await checkAgainstSchema(record as unknown as Record<string, unknown>), []);
  assert.equal(record.status, "passed");
  assert.equal(record.rest_version, "2026-08-21");
  assert.deepEqual(record.provider_resource_ids, ["biz_fixturePlatform"]);
  assert.match(record.request_reference ?? "", /request\.json$/);
});

test("records are written append-only as plain .json with hashed artifacts; reruns supersede", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledgerly-ev-"));
  const runner = new DemoRunner({
    log: new EventLog(new MemoryStore()),
    adapter: new FixtureAdapter(),
    clock: fixedClock(),
  });
  await runner.start();
  const first = buildEvidence((await runner.runStep("C01")).events, repo);
  const paths = await writeEvidence(dir, first);
  const stored = JSON.parse(await readFile(paths.record_path, "utf8"));
  assert.equal(
    stored.artifact_paths[0],
    `evidence/artifacts/${first.record.evidence_id}/demo-events.json`,
  );
  await expect(writeEvidence(dir, first)).rejects.toThrow(/EEXIST/);
  const second = buildEvidence((await runner.runStep("C01")).events, repo, {
    supersedes: first.record.evidence_id,
  });
  await writeEvidence(dir, second);
  assert.equal(second.record.supersedes, first.record.evidence_id);
  assert.equal((await readdir(join(dir, "records"))).length, 2);
  const all = await readdir(dir, { recursive: true });
  assert.ok(all.every((f) => !String(f).endsWith(".jsonl")));
});
