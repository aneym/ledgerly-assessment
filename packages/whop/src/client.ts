import { randomUUID } from "node:crypto";
import {
  type Emitter,
  err,
  gateFromError,
  type InstrumentationEvent,
  noopEmitter,
  ok,
  type Result,
  type SafeIds,
  withSpan,
} from "@ledgerly/core";
import type { ZodType } from "zod";
export type WhopHttpError = {
  kind: "http" | "decode" | "network";
  status: number;
  body: unknown;
  requestId?: string;
};
export type WhopClientOptions = {
  baseUrl: string;
  apiKey: string;
  apiVersionDate: string;
  fetch?: typeof globalThis.fetch;
  // Instrumentation sink for the guided-tour overlay. Optional so every existing caller
  // keeps working unchanged; apps/web/src/lib/server.ts wires a real one.
  onEvent?: (event: InstrumentationEvent) => void;
};
type RequestInput<T> = {
  body?: unknown;
  idempotencyKey?: string;
  schema: ZodType<T>;
  // Instrumentation context for this one call. Optional today because the sandbox adapter
  // does not yet thread the app's correlation id through — see the caller for the gap.
  correlationId?: string;
  runId?: string;
  safeIds?: SafeIds;
};
export function createWhopClient(options: WhopClientOptions) {
  const base = new URL(`${options.baseUrl.replace(/\/$/, "")}/`);
  if (!options.apiKey || !/^\d{4}-\d{2}-\d{2}$/.test(options.apiVersionDate))
    throw new Error("Whop API key and version date are required");
  const fetcher = options.fetch ?? globalThis.fetch;
  const emitter: Emitter = options.onEvent ? { emit: options.onEvent } : noopEmitter;
  return {
    async request<T>(
      method: string,
      path: string,
      input: RequestInput<T>,
    ): Promise<Result<T, WhopHttpError>> {
      const cleanPath = path.split("?")[0] ?? path;
      const { result } = await withSpan<{ result: Result<T, WhopHttpError>; status: number }>(
        emitter,
        {
          source: "whop",
          method,
          path: cleanPath,
          correlationId: input.correlationId ?? randomUUID(),
          provenance: "sandbox",
          ...(input.runId === undefined ? {} : { runId: input.runId }),
        },
        async () => {
          const url = new URL(path.replace(/^\//, ""), base);
          if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
            throw new Error("Whop request path must stay within the configured API base");
          const headers: Record<string, string> = {
            Authorization: `Bearer ${options.apiKey}`,
            "Api-Version-Date": options.apiVersionDate,
            "content-type": "application/json",
          };
          if (input.idempotencyKey !== undefined) headers["Idempotency-Key"] = input.idempotencyKey;
          const init: RequestInit = { method, headers, redirect: "error" };
          if (input.body !== undefined) init.body = JSON.stringify(input.body);
          let response: Response;
          try {
            response = await fetcher(url, init);
          } catch (cause) {
            if (
              !(cause instanceof TypeError) &&
              !(cause instanceof Error && ["AbortError", "TimeoutError"].includes(cause.name))
            )
              throw cause;
            return { result: err({ kind: "network", status: 0, body: null }), status: 0 };
          }
          const requestId =
            response.headers.get("x-request-id") ?? response.headers.get("request-id");
          const context = { status: response.status, ...(requestId ? { requestId } : {}) };
          let text: string;
          try {
            text = await response.text();
          } catch {
            return {
              result: err({ kind: "network", ...context, body: null }),
              status: response.status,
            };
          }
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            return {
              result: err({ kind: response.ok ? "decode" : "http", ...context, body: text }),
              status: response.status,
            };
          }
          if (!response.ok)
            return { result: err({ kind: "http", ...context, body }), status: response.status };
          const parsed = input.schema.safeParse(body);
          return {
            result: parsed.success ? ok(parsed.data) : err({ kind: "decode", ...context, body }),
            status: response.status,
          };
        },
        ({ result, status }) => ({
          status,
          ...(input.safeIds === undefined ? {} : { safeIds: input.safeIds }),
          // Set only when the failed Result carries a gate field (see gateFromError:
          // packages/whop/src/hybrid-adapter.ts's gateError() attaches gate to a
          // kind: "invalid_request" error rather than using a dedicated kind literal).
          // WhopHttpError (this client's own error type: http/decode/network) never
          // carries one today — a gated or credential-missing call short-circuits in the
          // hybrid adapter before this request() ever runs, so this client never observes
          // it. gateFromError reads an arbitrary error-shaped object rather than a typed
          // kind, so this stays correct without change if a future error path threads a
          // gate through this client instead.
          gate: result.ok ? null : gateFromError(result.error),
          summary: result.ok
            ? `whop ${method} ${cleanPath} succeeded`
            : `whop ${method} ${cleanPath} failed (${result.error.kind})`,
        }),
      );
      return result;
    },
  };
}
export type WhopClient = ReturnType<typeof createWhopClient>;
