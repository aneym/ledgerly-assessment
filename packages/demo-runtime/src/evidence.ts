import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DemoEvent, Source } from "./contract";
import { getStep } from "./steps";

/**
 * Evidence record as the evidence lane defines it in
 * docs/lanes/evidence/schemas/evidence-record.schema.json. This lane consumes
 * that schema and adds nothing to it. Optional fields are omitted, not null,
 * because the schema forbids unknown values and nulls.
 */
export interface EvidenceRecord {
  evidence_id: string;
  requirement_ids: string[];
  scenario_id: string;
  category: "fixture" | "sandbox-api";
  status: "not-run" | "blocked" | "failed" | "passed";
  owner: string;
  observed_at: string;
  environment: "local" | "sandbox";
  code_revision: string;
  dirty_tree: boolean;
  api_base?: "https://sandbox-api.whop.com/api/v1";
  rest_version?: string;
  command: string;
  exit_code: number;
  request_reference?: string;
  response_reference?: string;
  provider_resource_ids?: string[];
  artifact_paths: string[];
  artifact_hashes: Record<string, string>;
  redaction_review: { removed_fields: string[]; allowlist_version: string };
  limitations: string;
  blocked_by?: string;
  supersedes?: string;
  notes: string;
}

export interface RepoState {
  code_revision: string;
  dirty_tree: boolean;
}

export const CATEGORY_BY_SOURCE: Record<Source, EvidenceRecord["category"]> = {
  local: "fixture",
  mock: "fixture",
  sandbox: "sandbox-api",
};
export const REDACTION_ALLOWLIST_VERSION = "demo-runtime-1";

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

/** ev-YYYYMMDD-HHMMSS-xxxx, from the observation time plus four random base36 chars. */
export function evidenceId(observedAt: string, rand = Math.random): string {
  const d = new Date(observedAt);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const suffix = Array.from(
    { length: 4 },
    () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 36)],
  ).join("");
  return `ev-${stamp}-${suffix}`;
}

export interface EvidenceBuildOptions {
  owner?: string;
  supersedes?: string;
  rand?: () => number;
}

/** The artifacts one record carries, keyed by file name under evidence/artifacts/<id>/. */
export interface EvidenceBundle {
  record: EvidenceRecord;
  artifacts: Record<string, string>;
}

/**
 * Builds one record plus its artifacts from the events of one step attempt.
 * Status is passed, failed, blocked or not-run. Blocked is reserved for owner
 * gates (G##) as the schema requires; a local gate such as a missing credential
 * or unwired provider client is recorded as not-run with the reason in notes.
 * Verified never happens here: it needs a second actor and a provider readback.
 */
export function buildEvidence(
  events: DemoEvent[],
  repo: RepoState,
  opts: EvidenceBuildOptions = {},
): EvidenceBundle {
  const finished = events.find((e) => e.kind === "step.finished");
  if (!finished?.step_id) throw new Error("evidence needs a step.finished event with a step_id");
  if (finished.state === "verified" || finished.state === "pending" || finished.state === "running")
    throw new Error(`no evidence for state ${finished.state}`);
  const def = getStep(finished.step_id);
  const requests = events.filter((e) => e.kind === "operation.requested");
  const responses = events.filter((e) => e.kind === "operation.responded");
  // Strongest provider label on the attempt. A step that blocked before any call
  // still belongs to the adapter it ran against, so the environment decides then.
  const strongest: Source = responses.some((e) => e.source === "sandbox")
    ? "sandbox"
    : responses.some((e) => e.source === "mock")
      ? "mock"
      : finished.environment === "sandbox"
        ? "sandbox"
        : "local";
  const providerRefs = responses
    .map((e) => e.provider)
    .filter((p): p is NonNullable<typeof p> => !!p);
  const resource_ids = [...new Set(providerRefs.flatMap((p) => p.resource_ids))];
  const evidence_id = evidenceId(finished.at, opts.rand);
  const base = `evidence/artifacts/${evidence_id}`;

  const limitations: string[] = [];
  if (strongest !== "sandbox")
    limitations.push(
      "fixture observation; does not satisfy a sandbox, browser or human requirement",
    );
  if (def.human_gate)
    limitations.push("hosted human step recorded as a hand-off, not completed by the runtime");
  const ownerGate = finished.gate && /^G[0-9]{2}$/.test(finished.gate.id) ? finished.gate : null;
  const localGate = finished.gate && !ownerGate ? finished.gate : null;
  let status: EvidenceRecord["status"];
  if (finished.state === "passed") status = "passed";
  else if (finished.state === "failed") status = "failed";
  else if (ownerGate) status = "blocked";
  else status = "not-run";
  if (ownerGate) limitations.push(`blocked by ${ownerGate.id}: ${ownerGate.reason}`);
  if (localGate) limitations.push(`not run: local gate ${localGate.id}, ${localGate.reason}`);

  const artifacts: Record<string, string> = { "demo-events.json": JSON.stringify(events, null, 2) };
  if (requests.length)
    artifacts["request.json"] = JSON.stringify(
      requests.map((e) => ({ event_id: e.event_id, seq: e.seq, at: e.at, ...e.payload })),
      null,
      2,
    );
  if (responses.length)
    artifacts["response.json"] = JSON.stringify(
      responses.map((e) => ({
        event_id: e.event_id,
        seq: e.seq,
        at: e.at,
        provider: e.provider,
        ...e.payload,
      })),
      null,
      2,
    );
  const artifact_paths = Object.keys(artifacts).map((name) => `${base}/${name}`);
  const artifact_hashes = Object.fromEntries(
    Object.entries(artifacts).map(([name, body]) => [`${base}/${name}`, sha256(body)]),
  );
  const seqs = events.map((e) => e.seq);

  const record: EvidenceRecord = {
    evidence_id,
    requirement_ids: def.requirement_ids,
    scenario_id: def.scenario_id,
    category: CATEGORY_BY_SOURCE[strongest],
    status,
    owner: opts.owner ?? "demo-runtime",
    observed_at: finished.at,
    environment: strongest === "sandbox" ? "sandbox" : "local",
    code_revision: repo.code_revision,
    dirty_tree: repo.dirty_tree,
    command: `demo-runtime runStep ${def.id} attempt ${finished.attempt} source ${strongest}`,
    exit_code: status === "passed" ? 0 : 1,
    artifact_paths,
    artifact_hashes,
    redaction_review: {
      removed_fields: [
        ...new Set(
          events.flatMap((e) =>
            Array.isArray(e.payload.redacted_fields) ? (e.payload.redacted_fields as string[]) : [],
          ),
        ),
      ],
      allowlist_version: REDACTION_ALLOWLIST_VERSION,
    },
    limitations: limitations.length ? limitations.join(". ") : "none",
    notes: `demo run_id=${finished.run_id} correlation_id=${finished.correlation_id} step_id=${def.id} attempt=${finished.attempt} seq=${Math.min(...seqs)}..${Math.max(...seqs)}`,
  };
  if (strongest === "sandbox") {
    record.api_base = "https://sandbox-api.whop.com/api/v1";
    const rest = providerRefs.find((p) => p.api_version_date)?.api_version_date;
    if (rest) record.rest_version = rest;
    record.provider_resource_ids = resource_ids;
    if (artifacts["request.json"]) record.request_reference = `${base}/request.json`;
    if (artifacts["response.json"]) record.response_reference = `${base}/response.json`;
  }
  if (ownerGate) record.blocked_by = ownerGate.id;
  if (opts.supersedes) record.supersedes = opts.supersedes;
  return { record, artifacts };
}

/**
 * Writes the record and artifacts under `evidenceRoot`, which should be the
 * repo's evidence/ directory so artifact_paths resolve. Append-only: an
 * existing id is never overwritten. Everything is plain .json.
 */
export async function writeEvidence(
  evidenceRoot: string,
  bundle: EvidenceBundle,
): Promise<{ record_path: string; artifact_paths: string[] }> {
  const { record, artifacts } = bundle;
  const artDir = join(evidenceRoot, "artifacts", record.evidence_id);
  await mkdir(join(evidenceRoot, "records"), { recursive: true });
  await mkdir(artDir, { recursive: true });
  const written: string[] = [];
  for (const [name, body] of Object.entries(artifacts)) {
    const p = join(artDir, name);
    await writeFile(p, body, { flag: "wx" });
    written.push(p);
  }
  const record_path = join(evidenceRoot, "records", `${record.evidence_id}.json`);
  await writeFile(record_path, JSON.stringify(record, null, 2), { flag: "wx" });
  return { record_path, artifact_paths: written };
}
