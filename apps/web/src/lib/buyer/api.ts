/**
 * Buyer-side fetch helpers for the app API.
 *
 * Every call forwards `x-ledgerly-correlation-id` so the demo overlay can join
 * the request to its database and provider events. Nothing here throws to a
 * page: a network failure, a non-2xx status or an unreadable body all come
 * back as `{ ok: false }` with the method, path and status so the screen can
 * say plainly what did not happen.
 */

import { displaySeller } from "@/lib/catalog/display-name";

export const CORRELATION_HEADER = "x-ledgerly-correlation-id";

export type ApiMethod = "GET" | "POST";

export type ApiOk<T> = {
  ok: true;
  status: number;
  data: T;
  method: ApiMethod;
  path: string;
  correlationId: string;
};

/**
 * Why a call did not succeed: `network` never got an HTTP answer (status null),
 * `http` got a non-2xx status, `unexpected` got a 2xx whose body was not JSON or not the
 * shape the caller expects (a Next 404 page, a plain text handler, a bare object).
 */
export type ApiFailureKind = "network" | "http" | "unexpected";

export type ApiFailure = {
  ok: false;
  kind: ApiFailureKind;
  /** HTTP status; null when the request never reached a server. */
  status: number | null;
  method: ApiMethod;
  path: string;
  correlationId: string;
  /** Short, human readable reason. Never contains a payload. */
  message: string;
  /** Message the API sent back, when its body was JSON with `error` or `message`. */
  apiMessage?: string;
};

export type ApiResult<T> = ApiOk<T> | ApiFailure;

export const UNEXPECTED_RESPONSE = "unexpected response";
export const NOT_REACHED_MESSAGE = "could not reach the app API";

/**
 * Browsers expose crypto.randomUUID only in secure contexts; on a plain-http tailnet origin
 * it is undefined and every buyer form threw before its first request (QA walkthrough
 * finding). The fallback is a random hex id, unique enough for request correlation.
 */
export function newCorrelationId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/** Uses the caller's id when it looks like one, otherwise mints a fresh id. */
export function pickCorrelationId(candidate: string | string[] | null | undefined): string {
  const value = Array.isArray(candidate) ? candidate[0] : candidate;
  if (typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value)) return value;
  return newCorrelationId();
}

export type RequestOptions = {
  method?: ApiMethod;
  body?: unknown;
  correlationId: string;
  /** Absolute origin to resolve `path` against. Omit in the browser. */
  origin?: string;
  /** Extra request headers, such as a forwarded cookie on the server. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Shape check on a 2xx JSON body. When it returns false the call fails as
   * `unexpected`, so a caller never treats the wrong payload as success.
   */
  expect?: (data: unknown) => boolean;
};

/** A 2xx JSON object with a non-empty string under one of `keys`. */
export function hasStringKey(...keys: string[]): (data: unknown) => boolean {
  return (data) => {
    if (!data || typeof data !== "object") return false;
    const record = data as Record<string, unknown>;
    return keys.some((key) => typeof record[key] === "string" && record[key] !== "");
  };
}

/** A 2xx JSON object (not an array, not a scalar). */
export function isJsonObject(data: unknown): boolean {
  return !!data && typeof data === "object" && !Array.isArray(data);
}

function readApiMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const candidate = record.error ?? record.message;
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  if (candidate && typeof candidate === "object") {
    const inner = (candidate as Record<string, unknown>).message;
    if (typeof inner === "string" && inner.trim()) return inner.trim();
  }
  return undefined;
}

/**
 * Performs one request against the app API and never throws.
 * `path` is a root-relative path such as `/api/orders/ord_1`.
 */
export async function apiRequest<T>(path: string, options: RequestOptions): Promise<ApiResult<T>> {
  const method = options.method ?? "GET";
  const { correlationId } = options;
  const url = options.origin ? new URL(path, options.origin).toString() : path;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      cache: "no-store",
      signal: options.signal,
      headers: {
        ...options.headers,
        accept: "application/json",
        [CORRELATION_HEADER]: correlationId,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    return {
      ok: false,
      kind: "network",
      status: null,
      method,
      path,
      correlationId,
      message:
        cause instanceof Error && cause.name === "AbortError"
          ? "Request cancelled"
          : NOT_REACHED_MESSAGE,
    };
  }

  // A body that parses as JSON (the literal null included) counts as JSON; anything else,
  // such as a Next 404 page or a plain text handler, does not.
  let payload: unknown = null;
  let isJson = false;
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      payload = JSON.parse(text);
      isJson = true;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      kind: "http",
      status: response.status,
      method,
      path,
      correlationId,
      message:
        response.status === 404 ? "Route not found" : response.statusText || "Request failed",
      apiMessage: readApiMessage(payload),
    };
  }

  if (!isJson || (options.expect && !options.expect(payload))) {
    return {
      ok: false,
      kind: "unexpected",
      status: response.status,
      method,
      path,
      correlationId,
      message: UNEXPECTED_RESPONSE,
    };
  }

  return { ok: true, status: response.status, data: payload as T, method, path, correlationId };
}

/** True for a failure that reads as "the route is not there": no answer, or a 404. */
export function isNotLive(failure: Pick<ApiFailure, "kind" | "status">): boolean {
  return failure.kind === "network" || failure.status === 404;
}

/* ------------------------------------------------------------------ */
/* Order payloads                                                       */
/* ------------------------------------------------------------------ */

export type Provenance = "mock" | "sandbox" | "live";
export type Currency = "USD" | "EUR" | "BRL";
export type Money = { amountMinor: number; currency: Currency };

/** How the seller is charged; decides who handles refunds. */
export type SalePolicy = "direct_charge" | "platform_charge_transfer";

export type OrderView = {
  id: string;
  flow?: "direct" | "platform_transfer" | null;
  paymentId?: string | null;
  status: string;
  provenance: Provenance;
  /** True when the payload carried no provenance and the badge fell back to MOCK. */
  provenanceAssumed: boolean;
  createdAt: string | null;
  purchaseUrl: string | null;
  /** The provider checkout configuration id (ch_...) the embedded checkout mounts from. */
  checkoutConfigurationId: string | null;
  downloadUrl: string | null;
  buyerEmail: string | null;
  cardLast4: string | null;
  /** Gross, as the API sent it. Money is always minor units plus currency. */
  price: Money;
  /** Fee and seller share from the API; null when the payload left them out. */
  fee: Money | null;
  sellerShare: Money | null;
  product: {
    id: string | null;
    /** Order seller identity used to verify optional fixture artwork. */
    sellerId?: string | null;
    slug: string | null;
    title: string;
    subtitle: string | null;
    category: string | null;
  };
  seller: {
    id: string | null;
    name: string;
    handle: string | null;
    city: string | null;
    salePolicy: SalePolicy | null;
  };
};

type Rec = Record<string, unknown>;

const asRecord = (value: unknown): Rec | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const pick = (record: Rec | null, ...keys: string[]): unknown => {
  if (!record) return undefined;
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
};

function readProvenance(value: unknown): Provenance | null {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  return lower === "mock" || lower === "sandbox" || lower === "live" ? lower : null;
}

function readPolicy(value: unknown): SalePolicy | null {
  if (typeof value !== "string") return null;
  if (value === "direct_charge" || value === "direct") return "direct_charge";
  if (
    value === "platform_charge_transfer" ||
    value === "platform_only" ||
    value === "platform_charge"
  )
    return "platform_charge_transfer";
  return null;
}

function readCurrency(value: unknown): Currency | null {
  return value === "USD" || value === "EUR" || value === "BRL" ? value : null;
}

function readPrice(source: unknown): Money | null {
  const record = asRecord(source);
  if (!record) return null;
  const amount = pick(record, "amount_minor", "amountMinor");
  const currency = readCurrency(pick(record, "currency"));
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || !currency) return null;
  return { amountMinor: amount, currency };
}

/**
 * Turns whatever `/api/orders/{id}` returned into the shape the screens use.
 * Accepts snake_case and camelCase keys. Returns null when the payload does
 * not carry an id, a product title and an integer price, which is the minimum
 * a receipt can be honest about.
 */
export function toOrderView(payload: unknown): OrderView | null {
  const root = asRecord(payload);
  const order = asRecord(pick(root, "order")) ?? root;
  if (!order) return null;

  const id = str(pick(order, "id", "order_id", "orderId"));
  const product = asRecord(pick(order, "product"));
  const seller = asRecord(pick(order, "seller"));
  const title =
    str(pick(product, "title", "name")) ?? str(pick(order, "product_title", "productTitle"));
  const price =
    readPrice(pick(order, "gross", "price", "amount")) ??
    readPrice(pick(product, "price")) ??
    readPrice({
      amount_minor: pick(order, "amount_minor", "amountMinor"),
      currency: pick(order, "currency"),
    });
  if (!id || !title || !price) return null;

  const provenance = readProvenance(pick(order, "provenance"));
  const sellerId = str(pick(seller, "id")) ?? str(pick(order, "seller_id", "sellerId"));
  const rawSellerName =
    str(pick(seller, "display_name", "displayName", "name")) ??
    str(pick(order, "seller_name", "sellerName"));
  // A placeholder seller name (an external id such as qa-… or …-journey-…) is replaced by
  // the canonical demo identity for that seller id; a real display name is kept.
  const sellerName =
    sellerId || rawSellerName
      ? displaySeller({
          id: sellerId ?? rawSellerName ?? "",
          name: rawSellerName,
          external_id: str(pick(seller, "external_id", "externalId")),
          country: str(pick(seller, "country")),
        }).name
      : "Seller";

  // The order routes send the fee they computed but not the seller share. The share is
  // gross minus that fee, so it is still the API's number, not a fee recomputed here.
  const fee = readPrice(pick(order, "fee", "platform_fee", "platformFee"));
  const sellerShare =
    readPrice(pick(order, "seller_share", "sellerShare", "net")) ??
    (fee && fee.currency === price.currency
      ? { amountMinor: price.amountMinor - fee.amountMinor, currency: price.currency }
      : null);

  return {
    id,
    status: str(pick(order, "status", "state")) ?? "unknown",
    flow:
      pick(order, "flow") === "direct"
        ? "direct"
        : pick(order, "flow") === "platform_transfer"
          ? "platform_transfer"
          : null,
    paymentId: str(pick(order, "payment_id", "paymentId")),
    provenance: provenance ?? "mock",
    provenanceAssumed: provenance === null,
    createdAt: str(pick(order, "created_at", "createdAt", "paid_at", "paidAt")),
    purchaseUrl: str(pick(order, "purchase_url", "purchaseUrl", "checkout_url", "checkoutUrl")),
    checkoutConfigurationId: str(
      pick(order, "checkout_configuration_id", "checkoutConfigurationId"),
    ),
    downloadUrl: str(pick(order, "download_url", "downloadUrl")),
    buyerEmail:
      str(pick(order, "buyer_email", "buyerEmail")) ??
      str(pick(asRecord(pick(order, "buyer")), "email")),
    cardLast4: str(pick(order, "card_last4", "cardLast4", "last4")),
    price,
    fee,
    sellerShare,
    product: {
      id: str(pick(product, "id")) ?? str(pick(order, "product_id", "productId")),
      sellerId,
      slug: str(pick(product, "slug")),
      title,
      subtitle: str(pick(product, "subtitle", "summary")),
      category: str(pick(product, "category")),
    },
    seller: {
      id: str(pick(seller, "id")) ?? str(pick(order, "seller_id", "sellerId")),
      name: sellerName,
      handle: str(pick(seller, "handle")),
      city: str(pick(seller, "city")),
      salePolicy:
        readPolicy(pick(seller, "sale_policy", "salePolicy")) ??
        readPolicy(pick(order, "sale_policy", "salePolicy")),
    },
  };
}

/** `/api/orders?buyer=me` may answer with a bare array or `{ orders: [...] }`. */
export function toOrderList(payload: unknown): OrderView[] {
  const root = asRecord(payload);
  const list = Array.isArray(payload) ? payload : pick(root, "orders", "items", "data");
  if (!Array.isArray(list)) return [];
  return list.map(toOrderView).filter((order): order is OrderView => order !== null);
}

/* ------------------------------------------------------------------ */
/* Account payloads                                                     */
/* ------------------------------------------------------------------ */

export type AccountView = {
  id: string;
  name: string | null;
  email: string | null;
  createdAt: string | null;
  role: string | null;
};

/**
 * `GET /api/auth/get-session`: Better Auth answers `{ session, user }` for a signed-in
 * request and a bare `null` otherwise. The user block is the signed-in user's own row.
 */
export function toAccountView(payload: unknown): AccountView | null {
  const root = asRecord(payload);
  const user = asRecord(pick(root, "user", "account")) ?? root;
  if (!user) return null;
  const id = str(pick(user, "id", "user_id", "userId"));
  if (!id) return null;
  return {
    id,
    name: str(pick(user, "name", "display_name", "displayName")),
    email: str(pick(user, "email")),
    createdAt: str(pick(user, "created_at", "createdAt", "member_since", "memberSince")),
    role: str(pick(user, "role")),
  };
}

export type RefundView = {
  id: string;
  orderId: string | null;
  status: string;
  createdAt: string | null;
  amount: Money | null;
  reason: string | null;
  productTitle: string | null;
};

/** `/api/refunds?buyer=me`: refund requests, newest first as the API orders them. */
export function toRefundList(payload: unknown): RefundView[] {
  const root = asRecord(payload);
  const list = Array.isArray(payload)
    ? payload
    : pick(root, "refund_requests", "refunds", "requests", "items", "data");
  if (!Array.isArray(list)) return [];
  const views: RefundView[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    const id = str(pick(record, "id", "refund_id", "refundId"));
    if (!record || !id) continue;
    views.push({
      id,
      orderId: str(pick(record, "order_id", "orderId")),
      status: str(pick(record, "status", "state")) ?? "requested",
      createdAt: str(pick(record, "created_at", "createdAt", "requested_at", "requestedAt")),
      amount: readPrice(pick(record, "amount", "gross")),
      reason: str(pick(record, "reason")),
      productTitle:
        str(pick(asRecord(pick(record, "product")), "title")) ?? str(pick(record, "product_title")),
    });
  }
  return views;
}
