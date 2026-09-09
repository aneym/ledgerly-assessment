// The assistant's eight read tools. Every tool re-checks the operator session itself
// (defense in depth: the route already gates on it before the model runs at all, but a
// tool is also a boundary the AI SDK calls independently of that check), validates its
// arguments with a bounded zod schema, and returns plain JSON-serializable data — no
// WhopPort/Drizzle objects escape a tool result. There is no raw-SQL tool and no write
// tool, by design: every query here goes through a named, bounded function.
import { whopAccountId } from "@ledgerly/core";
import { readPlatformCapabilities } from "@ledgerly/whop";
import { tool } from "ai";
import { z } from "zod";
import {
  formatLedgerEntry,
  type LookupDeps,
  lookupLedgerEntry,
  lookupOrder,
  lookupSeller,
} from "./lookups";
import { recordProvenance } from "./provenance";
import { getWebhookInboxSummary, listLedgerEntries } from "./queries";
import type { GetSessionFn, SourceData } from "./types";
import { isOperatorSession } from "./types";

export type ListEventTrailQuery =
  | { correlationId: string; afterSeq?: number }
  | { runId: string; afterSeq?: number };

export type AssistantToolDeps = LookupDeps & {
  getSession: GetSessionFn;
  platformAccountId: string | undefined;
  listEventTrail(query: ListEventTrailQuery): Promise<Array<Record<string, unknown>>>;
};

// Every tool that resolves a single record reports it here so the route can emit the
// contract's `data-source` part for it, in addition to returning it in the tool result.
export type ToolSourceSink = (source: SourceData) => void;

async function assertOperatorSession(deps: Pick<AssistantToolDeps, "getSession">): Promise<void> {
  const session = await deps.getSession();
  if (!isOperatorSession(session)) throw new Error("unauthorized: operator session required");
}

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(50)
  .default(20)
  .describe("Maximum rows to return. Bounded to 50.");

const ledgerIdSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, "ledger entry id must be a numeric string")
  .describe("The numeric ledger_entries.id, as a string.");

const nonEmptyIdSchema = z.string().trim().min(1).max(200);

export function createAssistantTools(deps: AssistantToolDeps, onSource: ToolSourceSink) {
  const provenance = recordProvenance(deps.whopMode);

  const getLedgerEntry = tool({
    description:
      "Look up a single ledger entry by its numeric id. Returns found: false if no such id exists.",
    inputSchema: z.object({ id: ledgerIdSchema }),
    async execute({ id }) {
      await assertOperatorSession(deps);
      const result = await lookupLedgerEntry(deps, id);
      if (result.found) onSource(result.source);
      return result.found ? { found: true as const, entry: result.entry } : result;
    },
  });

  const listLedger = tool({
    description:
      "List ledger entries, optionally filtered by seller_id, type (the entry's kind, e.g. payment/refund/fee/transfer), or currency. Newest first. `status` is accepted for contract compatibility but ledger entries have no status field, so it has no effect on the results.",
    inputSchema: z.object({
      seller_id: z.string().trim().min(1).max(200).optional(),
      type: z.string().trim().min(1).max(100).optional(),
      status: z.string().trim().min(1).max(100).optional(),
      currency: z.enum(["USD", "EUR", "BRL"]).optional(),
      limit: limitSchema,
    }),
    async execute({ seller_id, type, status, currency, limit }) {
      await assertOperatorSession(deps);
      const rows = await listLedgerEntries(deps.db, {
        sellerId: seller_id,
        kind: type,
        currency,
        limit,
      });
      return {
        entries: rows.map((row) => formatLedgerEntry(row, provenance)),
        count: rows.length,
        ...(status ? { note: "status was ignored: ledger entries have no status field" } : {}),
      };
    },
  });

  const getSeller = tool({
    description:
      "Look up a seller by id: the local record plus, when the seller has a linked Whop account, a read-through of that account's capabilities and required actions.",
    inputSchema: z.object({ id: nonEmptyIdSchema }),
    async execute({ id }) {
      await assertOperatorSession(deps);
      const result = await lookupSeller(deps, id);
      if (result.found) onSource(result.source);
      return result.found
        ? { found: true as const, seller: result.seller, whop: result.whop }
        : result;
    },
  });

  const getOrder = tool({
    description: "Look up a single order by id.",
    inputSchema: z.object({ id: nonEmptyIdSchema }),
    async execute({ id }) {
      await assertOperatorSession(deps);
      const result = await lookupOrder(deps, id);
      if (result.found) onSource(result.source);
      return result.found ? { found: true as const, order: result.order } : result;
    },
  });

  const listEventTrail = tool({
    description:
      "List instrumentation events for a correlation id or a run id, oldest first, most recent `limit` events when there are more than that.",
    inputSchema: z
      .object({
        correlation_id: z.string().trim().min(1).max(200).optional(),
        run_id: z.string().trim().min(1).max(200).optional(),
        limit: limitSchema,
      })
      .refine((v) => Boolean(v.correlation_id) !== Boolean(v.run_id), {
        message: "exactly one of correlation_id or run_id is required",
      }),
    async execute({ correlation_id, run_id, limit }) {
      await assertOperatorSession(deps);
      const query = correlation_id
        ? { correlationId: correlation_id }
        : { runId: run_id as string };
      const rows = await deps.listEventTrail(query);
      const bounded = rows.length > limit ? rows.slice(-limit) : rows;
      return { events: bounded, count: bounded.length, totalAvailable: rows.length };
    },
  });

  const listIssues = tool({
    description: "List operator-tracked issues. Not available in this environment yet.",
    inputSchema: z.object({
      status: z.string().trim().min(1).max(100).optional(),
      kind: z.string().trim().min(1).max(100).optional(),
      limit: limitSchema,
    }),
    async execute() {
      await assertOperatorSession(deps);
      return {
        available: false as const,
        reason: "no issue/resolution table exists in this environment yet",
      };
    },
  });

  const getIssue = tool({
    description:
      "Look up a single operator-tracked issue by id. Not available in this environment yet.",
    inputSchema: z.object({ id: nonEmptyIdSchema }),
    async execute() {
      await assertOperatorSession(deps);
      return {
        available: false as const,
        reason: "no issue/resolution table exists in this environment yet",
      };
    },
  });

  const getIntegrationHealth = tool({
    description:
      "Platform-wide integration health: webhook inbox delivery counts by status, last delivery time, the platform Whop account's capability snapshot, and the running WHOP_MODE.",
    inputSchema: z.object({}),
    async execute() {
      await assertOperatorSession(deps);
      const inbox = await getWebhookInboxSummary(deps.db);
      let platformCapabilities: unknown = {
        available: false,
        reason: "WHOP_PLATFORM_ACCOUNT_ID is not configured",
      };
      if (deps.platformAccountId) {
        const accountId = whopAccountId(deps.platformAccountId);
        if (accountId.ok) {
          const snapshot = await readPlatformCapabilities(deps.provider, accountId.value).read();
          platformCapabilities = {
            capabilities: snapshot.capabilities,
            requiredActions: snapshot.requiredActions,
            readAt: snapshot.readAt ? snapshot.readAt.toISOString() : null,
          };
        } else {
          platformCapabilities = {
            available: false,
            reason: "WHOP_PLATFORM_ACCOUNT_ID is malformed",
          };
        }
      }
      return {
        webhookInbox: {
          countsByStatus: inbox.countsByStatus,
          lastReceivedAt: inbox.lastReceivedAt ? inbox.lastReceivedAt.toISOString() : null,
        },
        platformCapabilities,
        whopMode: deps.whopMode ?? "mock",
        provenance,
      };
    },
  });

  return {
    getLedgerEntry,
    listLedger,
    getSeller,
    getOrder,
    listEventTrail,
    listIssues,
    getIssue,
    getIntegrationHealth,
  };
}
