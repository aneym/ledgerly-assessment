/**
 * Seller-side client for the app API. Never throws to a page: every call
 * resolves to an ApiResult so a route that is not live yet renders as a calm
 * inline state naming method, path and status.
 *
 * Every request carries x-ledgerly-correlation-id, taken from the page's
 * `correlationId` search param when the demo runtime hands one over, else minted here.
 */
export const CORRELATION_HEADER = "x-ledgerly-correlation-id";

export type ApiMethod = "GET" | "POST";

export type ApiOk<T> = { ok: true; status: number; data: T; correlationId: string };

/**
 * `network`: no HTTP answer (status null). `http`: a non-2xx status. `unexpected`: a 2xx
 * whose body was not JSON, or not the shape the caller expects; never a success.
 */
export type ApiFailKind = "network" | "http" | "unexpected";

export type ApiFail = {
  ok: false;
  kind: ApiFailKind;
  /** HTTP status; null when the request never reached a server. */
  status: number | null;
  path: string;
  method: ApiMethod;
  correlationId: string;
  /** Short reason from the response body or the transport, when one exists. */
  reason?: string;
  /** Field names a validation error named, from `{ error: "invalid_body", fields: [...] }`. */
  fields?: string[];
};
export type ApiResult<T> = ApiOk<T> | ApiFail;

export type ApiCallOptions = {
  method?: ApiMethod;
  body?: unknown;
  correlationId?: string | null;
  signal?: AbortSignal;
  /** Shape check on a 2xx JSON body; false makes the call fail as `unexpected`. */
  expect?: (data: unknown) => boolean;
};

export const UNEXPECTED_RESPONSE = "unexpected response";
export const NOT_REACHED_MESSAGE = "could not reach the app API";

/** A JSON object with a non-empty string under one of `keys`. */
export function hasStringKey(...keys: string[]): (data: unknown) => boolean {
  return (data) => {
    if (!data || typeof data !== "object") return false;
    const record = data as Record<string, unknown>;
    return keys.some((key) => typeof record[key] === "string" && record[key] !== "");
  };
}

/** Reads `?correlationId=` from the current location. Browser only; null on the server. */
export function correlationIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("correlationId");
}

export function mintCorrelationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `cid_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function reasonFrom(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["error", "message", "reason", "kind"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object") {
      const nested = reasonFrom(value);
      if (nested) return nested;
    }
  }
  return undefined;
}

function fieldsFrom(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const value = (body as Record<string, unknown>).fields;
  return Array.isArray(value) ? value.filter((f): f is string => typeof f === "string") : [];
}

export async function callApi<T>(
  path: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<T>> {
  const method: ApiMethod = options.method ?? "GET";
  const correlationId = options.correlationId ?? correlationIdFromLocation() ?? mintCorrelationId();
  const headers = new Headers({ accept: "application/json", [CORRELATION_HEADER]: correlationId });
  const init: RequestInit = { method, headers, cache: "no-store" };
  if (options.signal) init.signal = options.signal;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    return {
      ok: false,
      kind: "network",
      status: null,
      path,
      method,
      correlationId,
      reason: NOT_REACHED_MESSAGE,
    };
  }

  // A body that parses as JSON counts as JSON whatever the content-type says; a Next 404
  // page or a plain text handler does not.
  let body: unknown = null;
  let isJson = false;
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text);
      isJson = true;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const fail: ApiFail = {
      ok: false,
      kind: "http",
      status: response.status,
      path,
      method,
      correlationId,
    };
    const reason = reasonFrom(body);
    if (reason) fail.reason = reason;
    const fields = fieldsFrom(body);
    if (fields.length > 0) fail.fields = fields;
    return fail;
  }
  if (!isJson || (options.expect && !options.expect(body))) {
    // A 2xx without JSON (the Next not-found page, a text handler) or with the wrong shape
    // is never a success: nothing the caller wanted has been confirmed.
    return {
      ok: false,
      kind: "unexpected",
      status: response.status,
      path,
      method,
      correlationId,
      reason: UNEXPECTED_RESPONSE,
    };
  }
  return { ok: true, status: response.status, data: body as T, correlationId };
}

/** True for a failure that reads as "the route is not there": no answer, or a 404. */
export function isNotLive(fail: Pick<ApiFail, "kind" | "status">): boolean {
  return fail.kind === "network" || fail.status === 404;
}

/**
 * One line for the inline state: "GET /api/sellers/x returned 404",
 * "POST /api/sellers: could not reach the app API", or "... returned 200, unexpected response".
 */
export function describeFailure(fail: ApiFail): string {
  if (fail.kind === "network") return `${fail.method} ${fail.path}: ${NOT_REACHED_MESSAGE}`;
  const line = `${fail.method} ${fail.path} returned ${fail.status ?? "no status"}`;
  return fail.kind === "unexpected" ? `${line}, ${UNEXPECTED_RESPONSE}` : line;
}

// ---- Seller routes ----------------------------------------------------------

/** POST /api/sellers accepts the six catalog countries (packages/core/src/seller.ts). */
export type SellerCountry = "US" | "DE" | "BR" | "CA" | "KR" | "PT";

/**
 * Body of POST /api/sellers. `externalId` is the create-or-fetch key inside the run and
 * becomes the Whop account title; `title` is accepted by the route for a later round.
 */
export type CreateSellerInput = {
  externalId: string;
  email: string;
  country: SellerCountry;
  title?: string;
};

/**
 * A stable external id for a seller from the form values: the display name as a slug
 * plus a short hash of the email, so the same person resubmitting gets the same seller
 * and two people with the same name do not collide. No colon: the route rejects one.
 */
export function sellerExternalId(name: string, email: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "seller";
  let hash = 0x811c9dc5;
  for (const char of email.trim().toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${slug}-${hash.toString(16).padStart(8, "0").slice(0, 6)}`;
}

/**
 * Response of POST /api/sellers: the seller at the top level with `onboarding_url` (contract
 * shape), or nested under `seller` with `onboardingUrl` (pre-contract shape).
 */
export type CreateSellerResponse = {
  id?: string;
  seller?: {
    id: string;
    externalId?: string;
    email?: string;
    country?: string;
    whopAccountId?: string | null;
  };
  onboardingUrl?: string;
  onboarding_url?: string;
};

export type Capability =
  | { status?: string; active?: boolean; requested?: boolean }
  | string
  | boolean;

/**
 * The seller as the onboarding and payouts screens use it: the seller row from
 * GET /api/sellers/[id] flattened, plus the contract fields (verification,
 * status, sale policy, required_actions, capabilities, onboarding_url, provenance) read from
 * the same response when the route carries them. Fields beyond `id` are read defensively.
 */
export type ApiSeller = {
  id: string;
  externalId?: string;
  name?: string;
  email?: string;
  country?: string;
  whopAccountId?: string | null;
  whop_account_id?: string | null;
  salePolicy?: string;
  sale_policy?: string;
  /** The seller row's own status: "active" or "suspended". Not the identity verification. */
  status?: string;
  verification?: string | { status?: string; state?: string } | null;
  required_actions?: Array<string | { code?: string; description?: string; deadline?: string }>;
  requiredActions?: Array<string | { code?: string; description?: string; deadline?: string }>;
  capabilities?: Record<string, Capability> | null;
  /** Present when the create call already minted a hosted onboarding link. */
  onboarding_url?: string;
  provenance?: string;
  source?: string;
  /** The Whop account id the route read back, when the seller has one. */
  accountId?: string | null;
  /** The error kind the route hit reading the account back, when it did. */
  accountError?: string | null;
};

/**
 * The envelope GET /api/sellers/[id] answers: `{ seller, account, accountError }`. `account`
 * carries the provider's raw readback, which the screens never render; only its id is kept.
 */
type SellerEnvelope = {
  seller?: Partial<ApiSeller> & { id?: string };
  account?: { id?: string } | null;
  accountError?: string | null;
  verification?: ApiSeller["verification"];
  required_actions?: ApiSeller["required_actions"];
  capabilities?: ApiSeller["capabilities"];
  onboarding_url?: string;
  onboardingUrl?: string;
  provenance?: string;
  source?: string;
} & Partial<ApiSeller>;

function flattenSeller(data: SellerEnvelope): ApiSeller | null {
  const row = data.seller ?? data;
  const id = data.id ?? row.id;
  if (typeof id !== "string" || !id) return null;
  const seller: ApiSeller = { ...row, id };
  // serializeSeller's flat fields are canonical; its nested seller is a sparse legacy row.
  for (const key of ["name", "email", "country", "externalId"] as const) {
    if (typeof data[key] === "string") seller[key] = data[key];
  }
  // First defined value wins: top-level snake_case, top-level camelCase, then row aliases.
  // Normalize both aliases because consumers may prefer either. Unknown policy/status values
  // stay absent rather than falling back to a stale row or inventing an active/verified state.
  const policy = [data.sale_policy, data.salePolicy, row.sale_policy, row.salePolicy].find(
    (value) => value !== undefined,
  );
  delete seller.sale_policy;
  delete seller.salePolicy;
  if (policy === "direct" || policy === "direct_charge") {
    seller.sale_policy = seller.salePolicy = "direct";
  } else if (policy === "platform_only" || policy === "platform_charge_transfer") {
    seller.sale_policy = seller.salePolicy = "platform_only";
  }
  const status = data.status !== undefined ? data.status : row.status;
  delete seller.status;
  if (status === "active" || status === "suspended") seller.status = status;
  const accountId = [
    data.whop_account_id,
    data.whopAccountId,
    row.whop_account_id,
    row.whopAccountId,
  ].find((value) => value !== undefined);
  if (accountId === null || typeof accountId === "string") {
    seller.whop_account_id = seller.whopAccountId = accountId;
  }
  if (data.verification !== undefined) seller.verification = data.verification;
  if (data.required_actions !== undefined) seller.required_actions = data.required_actions;
  if (data.capabilities !== undefined) seller.capabilities = data.capabilities;
  const onboardingUrl = data.onboarding_url ?? data.onboardingUrl;
  if (onboardingUrl !== undefined) seller.onboarding_url = onboardingUrl;
  if (data.provenance !== undefined) seller.provenance = data.provenance;
  if (data.source !== undefined) seller.source = data.source;
  if (data.account !== undefined) seller.accountId = data.account?.id ?? null;
  if (data.accountError !== undefined) seller.accountError = data.accountError;
  return seller;
}

export type OnboardingLink = {
  url?: string;
  link?: string;
  /** What POST /api/sellers/[id]/onboarding-link answers today. */
  onboardingUrl?: string;
  onboarding_url?: string;
  expires_at?: string;
  expiresAt?: string;
  provenance?: string;
  source?: string;
};

/** The hosted onboarding url out of a link response, whichever key carries it. */
export function onboardingUrlOf(link: OnboardingLink): string | null {
  return link.url ?? link.link ?? link.onboardingUrl ?? link.onboarding_url ?? null;
}

export type ApiLedgerRow = {
  id?: string;
  date?: string;
  at?: string;
  item?: string;
  title?: string;
  product?: string | { title?: string };
  note?: string;
  order?: string;
  orderId?: string;
  order_id?: string;
  status?: string;
  gross?: ApiAmount;
  fee?: ApiAmount;
  net?: ApiAmount;
  provider_resource_id?: string;
  provenance?: string;
};

export type ApiAmount =
  | number
  | string
  | { amountMinor?: number; amount_minor?: number; amount?: string | number; currency?: string };

/** One ledger entry as GET /api/sellers/[id]/earnings lists it under `recent`. */
export type ApiLedgerEntry = {
  amount?: ApiAmount;
  kind?: string;
  resourceType?: string;
  resource_type?: string;
  resourceId?: string;
  resource_id?: string;
  effectKey?: string;
  effect_key?: string;
  occurredAt?: string;
  occurred_at?: string;
  accountSide?: string;
  account_side?: string;
};

export type ApiEarnings = {
  available?: ApiAmount;
  pending?: ApiAmount;
  held?: ApiAmount;
  currency?: string;
  rows?: ApiLedgerRow[];
  transactions?: ApiLedgerRow[];
  /** What the earnings route answers today: one total per currency plus recent entries. */
  totals?: Array<{ currency?: string; total?: ApiAmount }>;
  recent?: ApiLedgerEntry[];
  provenance?: string;
  source?: string;
  salePolicy?: string;
  sale_policy?: string;
  /** Confirmed contract: "direct" or "platform_transfer". camelCase until the contract push. */
  charge_model?: string;
  chargeModel?: string;
};

export type ApiPayouts = {
  hosted_url?: string;
  hostedUrl?: string;
  portal_url?: string;
  history?: ApiPayoutRow[];
  payouts?: ApiPayoutRow[];
  provenance?: string;
  source?: string;
};

export type ApiPayoutRow = {
  id?: string;
  date?: string;
  at?: string;
  /** Null when ledger transitions do not record the requested payout amount. */
  amount?: ApiAmount | null;
  status?: string;
  method?: string;
  rail?: string;
};

export const sellerApi = {
  create(input: CreateSellerInput, correlationId?: string | null) {
    return callApi<CreateSellerResponse>("/api/sellers", {
      method: "POST",
      body: input,
      correlationId: correlationId ?? null,
      // A seller exists only when the answer carries its id (top level, or nested pre-contract).
      expect: (data) =>
        hasStringKey("id")(data) || hasStringKey("id")((data as { seller?: unknown })?.seller),
    });
  },
  async read(id: string, correlationId?: string | null): Promise<ApiResult<ApiSeller>> {
    const path = `/api/sellers/${encodeURIComponent(id)}`;
    const result = await callApi<SellerEnvelope>(path, { correlationId: correlationId ?? null });
    if (!result.ok) return result;
    const seller = flattenSeller(result.data);
    if (!seller) {
      return {
        ok: false,
        kind: "unexpected",
        status: result.status,
        path,
        method: "GET",
        correlationId: result.correlationId,
        reason: `${UNEXPECTED_RESPONSE}: no seller id`,
      };
    }
    return { ok: true, status: result.status, data: seller, correlationId: result.correlationId };
  },
  onboardingLink(id: string, correlationId?: string | null) {
    return callApi<OnboardingLink>(`/api/sellers/${encodeURIComponent(id)}/onboarding-link`, {
      method: "POST",
      correlationId: correlationId ?? null,
      expect: hasStringKey("url", "link", "onboardingUrl", "onboarding_url"),
    });
  },
  earnings(id: string, correlationId?: string | null) {
    return callApi<ApiEarnings>(`/api/sellers/${encodeURIComponent(id)}/earnings`, {
      correlationId: correlationId ?? null,
    });
  },
  payouts(id: string, correlationId?: string | null) {
    return callApi<ApiPayouts>(`/api/sellers/${encodeURIComponent(id)}/payouts`, {
      correlationId: correlationId ?? null,
    });
  },
};
