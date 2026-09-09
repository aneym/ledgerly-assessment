import { createHash } from "node:crypto";
import { fromDecimalString, type Seller, whopAccountId } from "@ledgerly/core";
import { createMockAdapter } from "@ledgerly/whop";
import { z } from "zod";

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("reset") }).strict(),
  z
    .object({
      action: z.literal("withdraw"),
      amount: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/),
      requestId: z.uuid(),
    })
    .strict(),
]);
type Entry = {
  adapter: ReturnType<typeof createMockAdapter>;
  accountId: ReturnType<typeof account>;
  currency: "USD" | "EUR" | "BRL";
  createdAt: number;
};
function account(key: string) {
  const id = whopAccountId(
    `biz_payout_demo_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
  );
  if (!id.ok) throw new Error("Invalid fixture account");
  return id.value;
}
const methodId = "potk_local_sample_bank";
const lifetime = 30 * 60 * 1000;
export type PayoutSimulationDeps = {
  enabled: boolean;
  authorize: (
    request: Request,
    sellerId: string,
  ) => Promise<{ ok: true; userId: string } | { ok: false; status: number }>;
  getSeller: (id: string) => Promise<Seller | null>;
  now: () => Date;
};
function reply(body: object, status = 200) {
  return Response.json(
    { source: "mock", ...body },
    { status, headers: { "Cache-Control": "no-store, private" } },
  );
}
// Separate, bounded memory for the explicit sample. Never gets the configured Whop provider,
// never calls the network and never writes a real seller's application ledger.
export function createPayoutSimulationStore() {
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<void>>();
  // Serialize state changes and response snapshots for each viewer/seller/run.
  // Body parsing happens first, so a slow request cannot block a ready command.
  async function inSession(key: string, operation: () => Promise<Response>): Promise<Response> {
    const previous = pending.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (pending.get(key) === current) pending.delete(key);
    }
  }
  return {
    async handle(request: Request, sellerId: string, deps: PayoutSimulationDeps) {
      if (!deps.enabled) return reply({ error: "not_found" }, 404);
      const auth = await deps.authorize(request, sellerId);
      if (!auth.ok) return reply({ error: "forbidden" }, auth.status);
      const seller = await deps.getSeller(sellerId);
      if (!seller) return reply({ error: "not_found" }, 404);
      const key = JSON.stringify([auth.userId, seller.id, seller.runId]);
      let input: z.infer<typeof command> | undefined;
      if (request.method === "POST") {
        if (
          request.headers.get("origin") !== new URL(request.url).origin ||
          request.headers.get("sec-fetch-site") === "cross-site"
        )
          return reply({ error: "invalid_origin" }, 403);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return reply({ error: "invalid_request" }, 400);
        }
        const parsed = command.safeParse(body);
        if (!parsed.success) return reply({ error: "invalid_request" }, 400);
        input = parsed.data;
      } else if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
      return inSession(key, async () => {
        const now = deps.now().getTime();
        for (const [id, entry] of entries)
          if (now - entry.createdAt >= lifetime) entries.delete(id);
        let entry = entries.get(key);
        if (input) {
          if (input.action === "start" || input.action === "reset") {
            if (!entry || input.action === "reset") {
              if (!entry && entries.size >= 200)
                return reply({ error: "simulation_capacity" }, 503);
              const accountId = account(key);
              const currency =
                seller.country === "DE" ? "EUR" : seller.country === "BR" ? "BRL" : "USD";
              const adapter = createMockAdapter({
                accounts: [{ id: accountId, raw: { title: "Local payout sample" } }],
                payoutMethods: [
                  {
                    accountId,
                    record: {
                      id: methodId,
                      currency,
                      isDefault: true,
                      raw: { label: "Sample bank, no real account" },
                    },
                  },
                ],
                now: deps.now,
              });
              adapter.seedBalance(accountId, { amountMinor: 10000, currency });
              entry = { adapter, accountId, currency, createdAt: now };
              entries.set(key, entry);
            }
          } else {
            if (!entry) return reply({ error: "simulation_expired" }, 409);
            const amount = fromDecimalString(input.amount, entry.currency);
            if (!amount.ok || amount.value.amountMinor <= 0)
              return reply({ error: "invalid_amount" }, 400);
            const result = await entry.adapter.createPayout(
              {
                accountId: entry.accountId,
                amount: amount.value,
                payoutMethodId: methodId,
                speed: "standard",
                metadata: { mode: "explicit_local_sample" },
              },
              `sample-withdraw:${input.requestId}`,
            );
            if (!result.ok) return reply({ error: result.error.kind }, 409);
          }
        }
        if (!entry) return reply({ kind: "not_started" });
        const [ledger, payouts] = await Promise.all([
          entry.adapter.getLedgerAccount(entry.accountId, "sample-read"),
          entry.adapter.listPayouts({ accountId: entry.accountId }),
        ]);
        if (!ledger.ok || !payouts.ok) return reply({ error: "simulation_failed" }, 500);
        // The sample starts with 10,000 minor units and each withdrawal spends at least
        // one. Read every page of this bounded history while holding the session lock.
        const history = [...payouts.value.items];
        let cursor = payouts.value.nextCursor;
        while (cursor !== null) {
          const page = await entry.adapter.listPayouts({ accountId: entry.accountId, cursor });
          if (!page.ok) return reply({ error: "simulation_failed" }, 500);
          history.push(...page.value.items);
          cursor = page.value.nextCursor;
        }
        return reply({
          kind: "ready",
          currency: entry.currency,
          available: ledger.value.balances.find((b) => b.currency === entry.currency)?.available,
          method: "Sample bank, no real account",
          expiresAt: new Date(entry.createdAt + lifetime).toISOString(),
          payouts: history.map((p) => ({
            id: p.id,
            status: p.status,
            amount: p.amount,
            createdAt: p.createdAt,
          })),
          persistence:
            "Temporary server memory. Resets after 30 minutes or a server restart. Separate from your seller ledger.",
        });
      });
    },
  };
}
