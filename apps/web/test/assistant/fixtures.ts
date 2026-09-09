// Shared test fixtures for the operator assistant suite. Builds fakes for the three
// dependency surfaces the assistant backend touches (a Drizzle-shaped db handle, a
// WhopPort, and a session lookup) without a real database or network call, matching the
// sibling apps/web/test/api/*.test.ts convention of a baseDeps(overrides) helper and deep
// relative imports into packages/core/src/* for domain types.

import type { WhopPort } from "../../../../packages/core/src/ports/whop";
import type { WhopError } from "../../../../packages/core/src/ports/whop-types";
import { err, type Result } from "../../../../packages/core/src/result";
import type { AssistantDb } from "../../src/lib/assistant/queries";
import type { AssistantToolDeps } from "../../src/lib/assistant/tools";
import type { AssistantSession, GetSessionFn } from "../../src/lib/assistant/types";

export const OPERATOR_SESSION: AssistantSession = { userId: "op_1", role: "operator" };
export const SELLER_SESSION: AssistantSession = { userId: "user_1", role: "seller" };

export function getSessionReturning(session: AssistantSession | null): GetSessionFn {
  return () => Promise.resolve(session);
}

const NOT_IMPLEMENTED: WhopError = { kind: "network" };

function notImplemented(): Promise<Result<never, WhopError>> {
  return Promise.resolve(err(NOT_IMPLEMENTED));
}

// Every WhopPort method the assistant does not exercise in a given test rejects with a
// plain WhopError rather than throwing, so an accidental call surfaces as a normal Result
// failure instead of an unhandled rejection. Cast once at construction; overrides come in
// already typed against the real interface.
export function stubWhopPort(overrides: Partial<WhopPort> = {}): WhopPort {
  const base = {
    createAccount: notImplemented,
    updateAccount: notImplemented,
    listPayments: notImplemented,
    listTransfers: notImplemented,
    createOrFetchAccount: notImplemented,
    createOnboardingLink: notImplemented,
    createCheckoutConfiguration: notImplemented,
    getAccount: notImplemented,
    getPayment: notImplemented,
    listPaymentFees: notImplemented,
    refundPayment: notImplemented,
    createTransfer: notImplemented,
    createAccessToken: notImplemented,
    createPayoutPortalLink: notImplemented,
  } as unknown as WhopPort;
  return { ...base, ...overrides };
}

export type StubDbOptions = {
  ledgerEntry?: Record<string, unknown> | null;
  ledgerEntries?: Array<Record<string, unknown>>;
  // Keyed by webhook_inbox.status; queries.ts's getWebhookInboxSummary asks once per
  // status, so this stub resolves the `where` callback against a marker object to learn
  // which status is being asked for, then returns the rows registered for it.
  webhookCountsByStatus?: Record<string, Array<Record<string, unknown>>>;
  lastWebhookReceivedAt?: Date | null;
};

type DrizzleWhere = (
  row: Record<string, string>,
  ops: { eq: (field: unknown, value: unknown) => unknown },
) => unknown;

export function stubDb(options: StubDbOptions = {}): AssistantDb {
  const webhookCountsByStatus = options.webhookCountsByStatus ?? {};
  const fake = {
    query: {
      ledgerEntries: {
        findFirst: async () => options.ledgerEntry ?? null,
        findMany: async () => options.ledgerEntries ?? [],
      },
      webhookInbox: {
        findFirst: async () =>
          options.lastWebhookReceivedAt !== undefined
            ? options.lastWebhookReceivedAt === null
              ? null
              : { receivedAt: options.lastWebhookReceivedAt }
            : null,
        findMany: async (args?: { where?: DrizzleWhere }) => {
          if (!args?.where) return [];
          const status = args.where(
            { status: "status" },
            { eq: (_field, value) => value },
          ) as string;
          return webhookCountsByStatus[status] ?? [];
        },
      },
    },
  };
  return fake as unknown as AssistantDb;
}

export function baseToolDeps(overrides: Partial<AssistantToolDeps> = {}): AssistantToolDeps {
  return {
    db: stubDb(),
    provider: stubWhopPort(),
    sellers: { get: async () => null },
    orders: { get: async () => null },
    getSession: getSessionReturning(OPERATOR_SESSION),
    whopMode: "mock",
    platformAccountId: undefined,
    listEventTrail: async () => [],
    ...overrides,
  };
}
