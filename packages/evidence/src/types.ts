/**
 * Shapes mirror docs/lanes/evidence/schemas/*.schema.json. The JSON schema is
 * the source of truth; these types exist so the rest of the package reads well.
 */

export const CATEGORIES = [
  "fixture",
  "sandbox-api",
  "browser",
  "mock",
  "hybrid-api",
  "human",
  "source-research",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const STATUSES = ["not-run", "running", "blocked", "failed", "passed", "verified"] as const;
export type Status = (typeof STATUSES)[number];

export interface Readback {
  method:
    | "provider-get"
    | "provider-deliveries"
    | "db-readback"
    | "browser-recording"
    | "human-review"
    | "source-refetch";
  reference: string;
  read_at: string;
}

export interface Operation {
  name: string;
  source: "sandbox" | "mock" | "app" | "neon" | "pglite";
  method?: string;
  path?: string;
  status?: number | "ok" | "error";
  resource_ids?: string[];
}

export interface Correlation {
  run_id?: string;
  correlation_id: string;
  step_id?: string;
  attempt?: number;
}

export interface EvidenceRecord {
  evidence_id: string;
  requirement_ids: string[];
  scenario_id: string;
  category: Category;
  status: Status;
  owner: string;
  observed_at: string;
  environment: "local" | "sandbox" | "docs";
  code_revision: string;
  dirty_tree: boolean;
  api_base?: string;
  rest_version?: string;
  webhook_version?: string;
  sdk_version?: string;
  command: string;
  exit_code?: number;
  request_reference?: string;
  response_reference?: string;
  provider_resource_ids?: string[];
  sample_payload?: boolean;
  artifact_paths: string[];
  artifact_hashes: Record<string, string>;
  redaction_review: {
    removed_fields: string[];
    allowlist_version: string;
    human_reviewed_by?: string;
    human_reviewed_at?: string;
  };
  limitations: string;
  readback?: Readback;
  reviewer?: string;
  reviewed_at?: string;
  supersedes?: string;
  provider_mode?: "sandbox" | "mock" | "hybrid";
  operations?: Operation[];
  correlation?: Correlation;
  blocked_by?: string;
  notes?: string;
}

export interface FailureCase {
  name: string;
  category: Category;
  expect: string;
}

export interface Scenario {
  scenario_id: string;
  title: string;
  requirement_ids: string[];
  evidence_required: Category[];
  handover_step: number;
  prerequisites: string[];
  gates: string[];
  command: string;
  expected_invariant: string;
  failure_cases: FailureCase[];
  owner: string;
  recording?: string;
  notes?: string;
}

export interface Requirement {
  id: string;
  requirement: string;
  evidence_required: string;
  section: string;
  state: string;
}

export interface Allowlist {
  version: string;
  id_prefixes: Record<string, string>;
  secret_patterns: string[];
}
