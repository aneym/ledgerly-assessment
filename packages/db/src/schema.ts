import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
export const country = pgEnum("country", ["US", "DE", "BR", "CA", "KR", "PT"]);
export const currency = pgEnum("currency", ["USD", "EUR", "BRL"]);
export const salePolicy = pgEnum("sale_policy", ["direct", "platform_only"]);
export const sellerStatus = pgEnum("seller_status", ["active", "suspended"]);
export const operationStatus = pgEnum("operation_status", [
  "pending",
  "succeeded",
  "failed",
  "unknown",
]);
export const inboxStatus = pgEnum("inbox_status", [
  "received",
  "processed",
  "failed",
  "quarantined",
]);
export const accountField = pgEnum("account_field", ["account_id", "company_id"]);
export const accountSide = pgEnum("account_side", ["platform", "seller"]);
export const orderFlow = pgEnum("order_flow", ["direct", "platform_transfer"]);
export const userRole = pgEnum("user_role", ["buyer", "seller", "operator"]);
export const instrumentationSource = pgEnum("instrumentation_source", ["app_api", "db", "whop"]);
export const instrumentationPhase = pgEnum("instrumentation_phase", ["start", "end"]);
// Additive (admin-resolution): backs the admin issue resolution center described in
// docs/lanes/admin-resolution.md and docs/lanes/architecture/admin-resolution-contract.md.
export const resolutionCaseKind = pgEnum("resolution_case_kind", [
  "missing_local_payment",
  "unconfirmed_transfer",
  "amount_mismatch",
]);
export const resolutionCaseStatus = pgEnum("resolution_case_status", [
  "detected",
  "investigating",
  "action_pending",
  "rechecking",
  "resolved",
  "escalated",
]);
export const resolutionActionType = pgEnum("resolution_action_type", [
  "refetch",
  "import_confirmed",
  "recheck",
  "escalate",
  "resolve",
  "note",
]);
export const resolutionActionOutcome = pgEnum("resolution_action_outcome", [
  "succeeded",
  "no_change",
  "failed",
  "uncertain",
]);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const sellers = pgTable(
  "sellers",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    externalId: text("external_id").notNull(),
    email: text("email").notNull(),
    country: country("country").notNull(),
    whopAccountId: text("whop_account_id").unique(),
    salePolicy: salePolicy("sale_policy").notNull(),
    status: sellerStatus("status").notNull().default("active"),
    // Additive (admin-ledger): a human-readable business name and a safe avatar URL for the
    // cross-business admin ledger UI. Both are unknown until an operator sets them or a Whop
    // readback populates them, so both stay nullable; callers fall back to the Whop account
    // title (if available) and then to externalId when displayName is null.
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    createdAt: createdAt(),
  },
  (table) => [unique("sellers_run_external_unique").on(table.runId, table.externalId)],
);
export const operations = pgTable("operations", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  kind: text("kind").notNull(),
  request: jsonb("request").notNull(),
  apiVersionDate: text("api_version_date").notNull(),
  status: operationStatus("status").notNull().default("pending"),
  response: jsonb("response"),
  providerResourceId: text("provider_resource_id"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const webhookInbox = pgTable("webhook_inbox", {
  deliveryId: text("delivery_id").primaryKey(),
  eventType: text("event_type").notNull(),
  apiVersionDate: text("api_version_date").notNull(),
  accountField: accountField("account_field").notNull(),
  accountId: text("account_id").notNull(),
  rawBody: text("raw_body").notNull(),
  headers: jsonb("headers").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  status: inboxStatus("status").notNull().default("received"),
  error: text("error"),
});
export const businessEffects = pgTable("business_effects", {
  effectKey: text("effect_key").primaryKey(),
  deliveryId: text("delivery_id").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  transition: text("transition").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  detail: jsonb("detail"),
});
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id").notNull(),
    sellerId: text("seller_id"),
    accountSide: accountSide("account_side").notNull(),
    currency: currency("currency").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    providerResourceType: text("provider_resource_type").notNull(),
    providerResourceId: text("provider_resource_id").notNull(),
    effectKey: text("effect_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    // Additive (admin-ledger): provenance distinguishes sandbox-sourced rows from
    // mock-sourced rows for the admin ledger UI, matching the same "mock" | "sandbox"
    // vocabulary already used by instrumentation_events.provenance. Defaulted so every
    // existing and future row (webhook-derived entries are all mock or sandbox today) has a
    // value without a backfill. `status`, when set, is an operator/compliance override (e.g.
    // a manual hold) that always wins over the derived status in
    // packages/core/src/services/admin-ledger.ts; it is null for the overwhelming majority
    // of rows, which get their status derived instead. `correlationId` links the entry back
    // to the instrumentation events emitted while it was written, when known.
    provenance: text("provenance").notNull().default("mock"),
    status: text("status"),
    correlationId: text("correlation_id"),
  },
  (table) => [unique("ledger_effect_side_unique").on(table.effectKey, table.accountSide)],
);
export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  sellerId: text("seller_id").notNull(),
  productTitle: text("product_title").notNull(),
  // Additive: the seller's own identifier for the product being checked out, and the
  // provider's hosted purchase URL for the created checkout. Both are unknown until a
  // checkout configuration has been requested, so both stay nullable.
  productExternalId: text("product_external_id"),
  // Additive: the signed-in buyer who created this order, when checkout happened while
  // signed in. Nullable because checkout has always allowed a guest/anonymous buyer (see
  // apps/web/src/app/api/checkouts/route.ts's module comment) and every pre-existing row
  // predates this column; GET /api/orders/{id} uses it to let a buyer read their own
  // receipt without seller ownership.
  buyerUserId: text("buyer_user_id"),
  grossMinor: bigint("gross_minor", { mode: "number" }).notNull(),
  currency: currency("currency").notNull(),
  feeMinor: bigint("fee_minor", { mode: "number" }).notNull(),
  flow: orderFlow("flow").notNull(),
  checkoutConfigurationId: text("checkout_configuration_id"),
  purchaseUrl: text("purchase_url"),
  paymentId: text("payment_id"),
  transferId: text("transfer_id"),
  status: text("status").notNull(),
  createdAt: createdAt(),
  // Additive (admin-ledger): mirrors ledger_entries.provenance for the same reason -
  // the admin ledger UI needs to tell a sandbox order apart from a mock one at the
  // order level too, not only at the ledger-row level.
  provenance: text("provenance").notNull().default("mock"),
});

// Additive (missing-routes): a seller's catalog listing, created through POST /api/products
// (see apps/web/src/components/seller/ProductForm.tsx for the exact request body). `slug` is
// derived server-side from the title (the form never sends one) and is unique per seller, not
// globally, since two sellers may each title a product the same thing; POST /api/checkouts's
// LookupProduct resolves `product_slug` against (sellerId, slug) for exactly this reason.
// `files`/cover fields store only the client-supplied name/size/type metadata - no upload
// pipeline exists yet, so nothing here is a real object-storage reference.
export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey(),
    sellerId: text("seller_id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    category: text("category").notNull(),
    description: text("description"),
    priceMinor: bigint("price_minor", { mode: "number" }).notNull(),
    currency: currency("currency").notNull(),
    coverName: text("cover_name"),
    coverSize: integer("cover_size"),
    coverType: text("cover_type"),
    files: jsonb("files").notNull().default([]),
    createdAt: createdAt(),
  },
  (table) => [unique("products_seller_slug_unique").on(table.sellerId, table.slug)],
);

// Additive (missing-routes): a buyer's refund ask on one order, created through
// POST /api/orders/{id}/refund-request and read back through GET /api/refunds?buyer=me.
// amountMinor/currency are copied from the order's gross at request time so the row stands on
// its own even if the order later changes; `status` is plain text (matching orders.status's own
// precedent) since only "requested" is ever written today and no resolution workflow exists yet.
export const refundRequests = pgTable("refund_requests", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  buyerUserId: text("buyer_user_id").notNull(),
  sellerId: text("seller_id").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currency: currency("currency").notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("requested"),
  createdAt: createdAt(),
});

// Better Auth tables. Shape verified against the Better Auth CLI schema
// generator (better-auth 1.7.3) for the Drizzle Postgres adapter, so the
// adapter can read and write these tables without a mapping layer. The
// `role` column is our own addition: new sign-ups default to "buyer" and
// only server code sets "seller" or "operator" (Better Auth's client never
// writes this field).
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  role: userRole("role").notNull().default("buyer"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);
export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// Maps a seller record to the user account that owns it, so an app API
// route can check "does this signed-in user own this seller" without
// touching the existing sellers table. A seller has exactly one owner.
export const sellerOwners = pgTable("seller_owners", {
  sellerId: text("seller_id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

// Instrumentation events. One row per start/end of an observed operation,
// exactly as specified in docs/lanes/architecture/instrumentation-contract.md. This mirrors
// packages/core/src/instrumentation's InstrumentationEvent type: `method` is nullable because
// a db-source event carries no HTTP method, `status` is stored as text because it is a number
// for app_api/whop and "ok"/"error" for db, and `runId`/`durationMs` are only known once an
// operation has a run to attribute to, or has finished.
export const instrumentationEvents = pgTable(
  "instrumentation_events",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    correlationId: text("correlation_id").notNull(),
    runId: text("run_id"),
    source: instrumentationSource("source").notNull(),
    phase: instrumentationPhase("phase").notNull(),
    method: text("method"),
    path: text("path").notNull(),
    status: text("status"),
    durationMs: integer("duration_ms"),
    provenance: text("provenance").notNull(),
    safeIds: jsonb("safe_ids").notNull().default({}),
    summary: text("summary").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("instrumentation_events_correlation_id_idx").on(table.correlationId),
    index("instrumentation_events_run_id_idx").on(table.runId),
  ],
);

// Admin issue resolution cases. A candidate case, not a claim of a live incident, per
// docs/lanes/admin-resolution.md. Upserted by (kind, provider_resource_id) so repeated
// detection never duplicates an open case.
export const resolutionCases = pgTable(
  "resolution_cases",
  {
    id: text("id").primaryKey(),
    kind: resolutionCaseKind("kind").notNull(),
    status: resolutionCaseStatus("status").notNull().default("detected"),
    sellerId: text("seller_id"),
    orderId: text("order_id"),
    providerResourceType: text("provider_resource_type").notNull(),
    providerResourceId: text("provider_resource_id").notNull(),
    expected: jsonb("expected"),
    observed: jsonb("observed"),
    impact: text("impact").notNull(),
    nextSafeAction: text("next_safe_action"),
    assignedTo: text("assigned_to"),
    // Where the evidence came from: the hybrid adapter's real meta.source when available,
    // else the configured WHOP_MODE. Mirrors ledger_entries.provenance's vocabulary.
    provenance: text("provenance").notNull(),
    // True only when created through injectSimulatedFault (the demo fault injector), never
    // for a genuine detection. Surfaced in the admin UI so a demo fault is always labeled.
    simulated: boolean("simulated").notNull().default(false),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    correlationId: text("correlation_id"),
  },
  (table) => [
    unique("resolution_cases_kind_resource_unique").on(table.kind, table.providerResourceId),
  ],
);
// One row per operator action taken on a case, idempotent on idempotencyKey so a repeated
// request (retry, double-click, concurrent submit) never re-applies its side effects.
export const resolutionActions = pgTable("resolution_actions", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => resolutionCases.id),
  action: resolutionActionType("action").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  outcome: resolutionActionOutcome("outcome").notNull(),
  detail: jsonb("detail").notNull().default({}),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

// Demo tour event store (owned by the demo-runtime lane); re-exported so
// drizzle-kit includes it in migrations.
export { demoEvents } from "./repos/demo-events";
