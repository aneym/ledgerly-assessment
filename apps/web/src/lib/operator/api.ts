/**
 * Operator calls to the app API. Every request forwards the demo runtime's
 * correlation id (through apiFetch) so the overlay can join app, database and
 * Whop events on it. A route that is not live comes back as { ok: false } with
 * the method, path and status, and the page shows that instead of a result.
 */
import { apiFetch } from "@/lib/catalog/api";
import type {
  Issue,
  IssueActionKind,
  IssuesPage,
  LedgerEntryDetail,
  LedgerPage,
  OperatorSeller,
  ReconciliationRun,
  SalePolicy,
} from "./types";

export type Method = "GET" | "POST";

export type ApiOk<T> = { ok: true; status: number; data: T };
/**
 * `kind`: `network` never got an HTTP answer (status 0), `http` got a non-2xx status,
 * `unexpected` got a 2xx whose body was not a JSON object (a Next 404 page, a text handler),
 * which is never treated as success. `detail` is the route's own error code and message when
 * it sent JSON, for example "seller_not_connected".
 */
export type ApiMissKind = "network" | "http" | "unexpected";
export type ApiMiss = {
  ok: false;
  kind: ApiMissKind;
  status: number;
  path: string;
  method: Method;
  detail?: string;
};
export type ApiResult<T> = ApiOk<T> | ApiMiss;

type Options = { body?: unknown; headers?: Record<string, string> };

/** Status 0 means the request never reached a server (network error, aborted). */
export async function operatorRequest<T>(
  method: Method,
  path: string,
  options: Options = {},
): Promise<ApiResult<T>> {
  try {
    const response = await apiFetch(path, {
      method,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: options.headers,
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = await errorDetail(response);
      return {
        ok: false,
        kind: "http",
        status: response.status,
        path,
        method,
        ...(detail ? { detail } : {}),
      };
    }
    // Success needs a JSON object or array; a 2xx HTML or text body is an unexpected response.
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    if (data === undefined || data === null || typeof data !== "object") {
      return {
        ok: false,
        kind: "unexpected",
        status: response.status,
        path,
        method,
        detail: "unexpected response",
      };
    }
    return { ok: true, status: response.status, data: data as T };
  } catch {
    return {
      ok: false,
      kind: "network",
      status: 0,
      path,
      method,
      detail: "could not reach the app API",
    };
  }
}

/** The route's { error, message } as one line, or the first line of a text body. */
async function errorDetail(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    try {
      const body = JSON.parse(text) as { error?: unknown; message?: unknown; reason?: unknown };
      const parts = [body.error, body.reason, body.message].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (parts.length > 0) return [...new Set(parts)].join(": ").slice(0, 200);
    } catch {
      // not JSON
    }
    return text.split("\n")[0]?.slice(0, 200) || undefined;
  } catch {
    return undefined;
  }
}

/** One key per durable operation attempt. The server dedupes on it. */
function idempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* ---------- sellers ---------- */

export const sellerPath = (id: string) => `/api/sellers/${encodeURIComponent(id)}`;

export function getSeller(id: string) {
  return operatorRequest<OperatorSeller>("GET", sellerPath(id));
}

export function setSellerPolicy(id: string, salePolicy: SalePolicy) {
  return operatorRequest<OperatorSeller>("POST", `${sellerPath(id)}/policy`, {
    body: { sale_policy: salePolicy },
  });
}

export function suspendSeller(id: string) {
  return operatorRequest<OperatorSeller>("POST", `${sellerPath(id)}/suspend`);
}

/* ---------- platform ledger ---------- */

export const ADMIN_LEDGER_PATH = "/api/admin/ledger";

/** The platform ledger, filtered by the same query the URL carries. */
export function getAdminLedger(query: string) {
  return operatorRequest<LedgerPage>(
    "GET",
    query ? `${ADMIN_LEDGER_PATH}?${query}` : ADMIN_LEDGER_PATH,
  );
}

export function getLedgerEntry(id: string) {
  return operatorRequest<LedgerEntryDetail>(
    "GET",
    `${ADMIN_LEDGER_PATH}/${encodeURIComponent(id)}`,
  );
}

export function reconcileSeller(id: string) {
  return operatorRequest<ReconciliationRun>("POST", `/api/reconcile/${encodeURIComponent(id)}`, {
    headers: { "Idempotency-Key": idempotencyKey() },
  });
}

/* ---------- issue resolution ---------- */

export const ADMIN_ISSUES_PATH = "/api/admin/issues";

export function getIssues(query: string) {
  return operatorRequest<IssuesPage>(
    "GET",
    query ? `${ADMIN_ISSUES_PATH}?${query}` : ADMIN_ISSUES_PATH,
  );
}

export function getIssue(id: string) {
  return operatorRequest<Issue>("GET", `${ADMIN_ISSUES_PATH}/${encodeURIComponent(id)}`);
}

export const issueActionPath = (id: string, action: IssueActionKind) =>
  `${ADMIN_ISSUES_PATH}/${encodeURIComponent(id)}/actions/${action}`;

/** Every action is one durable operation with its own Idempotency-Key. */
export function runIssueAction(id: string, action: IssueActionKind) {
  return operatorRequest<Issue>("POST", issueActionPath(id, action), {
    headers: { "Idempotency-Key": idempotencyKey() },
  });
}

export const DEMO_FAULT_PATH = `${ADMIN_ISSUES_PATH}/demo-fault`;

/** DEMO_MODE only. Seeds one clearly labelled, simulated case for the tour. */
export function injectDemoFault(input: {
  kind: "missing_local_payment";
  seller_id: string;
  payment_id?: string;
  fresh?: boolean;
}) {
  return operatorRequest<Issue>("POST", `${DEMO_FAULT_PATH}?kind=${input.kind}`, {
    headers: { "Idempotency-Key": idempotencyKey() },
    body: {
      seller_id: input.seller_id,
      ...(input.payment_id === undefined ? {} : { payment_id: input.payment_id }),
      ...(input.fresh === undefined ? {} : { fresh: input.fresh }),
    },
  });
}

/** One line for the inline route state. Reads the same at 200, 404 and 0. */
export function describeMiss(miss: ApiMiss): string {
  if (miss.kind === "network" || miss.status === 0)
    return "Could not reach the app API. Nothing was sent or confirmed.";
  if (miss.kind === "unexpected")
    return "Unexpected response. The route answered without the JSON this screen expects; nothing was confirmed.";
  if (miss.status === 404) return "Route not live yet. Nothing was changed.";
  if (miss.status === 401 || miss.status === 403) return "Not allowed for this session.";
  if (miss.status === 409) return "Already applied or in progress. Nothing was repeated.";
  if (miss.status >= 500) return "The server failed. Nothing was confirmed.";
  return "The request was rejected. Nothing was changed.";
}
