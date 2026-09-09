import { type ProviderRef, SANDBOX_API_BASE, type Source } from "./contract";

export interface OperationRequest {
  operation: string;
  step_id: string;
  run_id: string;
  input: Record<string, unknown>;
}

export interface OperationResult {
  outcome: "ok" | "error" | "blocked";
  /** Redacted response body or summary. */
  output: Record<string, unknown>;
  provider: ProviderRef | null;
  gate: { id: string; reason: string } | null;
  ledger_rows?: Record<string, unknown>[];
  inbox_rows?: Record<string, unknown>[];
}

/**
 * Provider seam. `kind` is a property of the adapter, not of the caller: the
 * runtime labels events from it, so a caller cannot ask for a sandbox label.
 * The interface has no delete or destructive member on purpose; reset cannot
 * reach the provider through it.
 */
export interface Adapter {
  readonly kind: Source;
  call(req: OperationRequest): Promise<OperationResult>;
}

/** Fixture adapter for headless rehearsal: deterministic responses with fx_ ids, labelled mock. */
export class FixtureAdapter implements Adapter {
  readonly kind = "mock" as const;
  readonly calls: OperationRequest[] = [];
  private counter = 0;
  private readonly overrides: Record<string, (req: OperationRequest) => OperationResult>;
  constructor(overrides: Record<string, (req: OperationRequest) => OperationResult> = {}) {
    this.overrides = overrides;
  }
  async call(req: OperationRequest): Promise<OperationResult> {
    this.calls.push(req);
    const custom = this.overrides[req.operation];
    if (custom) return custom(req);
    this.counter += 1;
    const id = `fx_${req.operation.replace(/\W/g, "")}${this.counter}`;
    return {
      outcome: "ok",
      output: { id, operation: req.operation, fixture: true },
      provider: {
        base_url: "mock://local",
        http_status: 200,
        request_id: null,
        resource_ids: [id],
        api_version_date: null,
        operation: req.operation,
        duration_ms: 0,
      },
      gate: null,
      ledger_rows:
        req.operation.startsWith("checkout") ||
        req.operation.startsWith("transfer") ||
        req.operation.startsWith("payment")
          ? [{ ref: id, operation: req.operation }]
          : [],
      inbox_rows: req.operation.startsWith("webhook")
        ? [{ ref: id, operation: req.operation }]
        : [],
    };
  }
}

export interface SandboxCredentials {
  /** Read from process env by the host, never persisted or logged. */
  apiKey: string | null;
  apiVersionDate: string | null;
}

export type ProviderClient = (
  req: OperationRequest,
  creds: SandboxCredentials,
) => Promise<OperationResult>;

/**
 * Sandbox adapter. It never fabricates a response: without a credential it
 * blocks on the credential gate, and without a provider client (owned by the
 * architecture lane) it blocks on the wiring gate. Any result the client
 * returns must name the explicit sandbox base or it is rejected as mislabelled.
 */
export class SandboxAdapter implements Adapter {
  readonly kind = "sandbox" as const;
  private readonly creds: SandboxCredentials;
  private readonly client: ProviderClient | null;
  constructor(creds: SandboxCredentials, client: ProviderClient | null = null) {
    this.creds = creds;
    this.client = client;
  }
  async call(req: OperationRequest): Promise<OperationResult> {
    if (!this.creds.apiKey)
      return {
        outcome: "blocked",
        output: {},
        provider: null,
        gate: { id: "CRED", reason: "no sandbox credential configured in this environment" },
      };
    if (!this.client)
      return {
        outcome: "blocked",
        output: {},
        provider: null,
        gate: {
          id: "WIRE",
          reason: "provider adapter not wired; architecture lane owns pinned request shapes",
        },
      };
    const result = await this.client(req, this.creds);
    if (result.outcome === "ok") {
      if (
        !result.provider ||
        result.provider.base_url !== SANDBOX_API_BASE ||
        result.provider.http_status === null
      )
        throw new Error(
          `sandbox client returned success without an observed response from ${SANDBOX_API_BASE}`,
        );
    }
    return result;
  }
}
