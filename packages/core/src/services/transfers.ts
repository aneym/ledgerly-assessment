import { effectKey } from "../effects";
import type { OrderId, RunId, SellerId, WhopAccountId } from "../ids";
import { type Money, subtract } from "../money";
import type { WhopPort } from "../ports/whop";
import type { SellerLookup } from "./orders";
import type { Clock, LedgerRepo, UnitOfWork } from "./ports";

// The slice of an order this service needs to decide whether, and how much,
// to transfer. Read-only: the amounts and identity fields never change once
// an order is paid, so this is not the same shape as orders.ts's full Order.
export type TransferCandidate = {
  id: OrderId;
  runId: RunId;
  sellerId: SellerId;
  gross: Money;
  fee: Money;
  createdAt: Date;
};

export interface TransferOrdersRepo {
  // Orders on the platform_transfer flow, paid, past the hold, with no transfer id
  // recorded yet. The "no transfer id yet" filter is what makes a successful transfer
  // final: once recordTransfer writes a row, that order never comes back here, even
  // across a process restart, so this is the actual double-send guard, not just the
  // provider's own idempotency cache.
  findEligible(input: { olderThan: Date; limit: number }): Promise<TransferCandidate[]>;
  recordTransfer(id: OrderId, transferId: string): Promise<void>;
}

export type ReleaseTransfersResult = { released: number; retried: number; failed: number };

// orders.transferId only ever moves from null to a real transfer id, never back — this
// hold-timing check uses createdAt because orders carries no paidAt column yet (settleOrder
// writes status only); documented as a known simplification in platform-simulation.md.
export function createTransferReleaseService(deps: {
  uow: Pick<UnitOfWork, "exclusive">;
  provider: Pick<WhopPort, "createTransfer">;
  orders: TransferOrdersRepo;
  sellers: SellerLookup;
  ledger: Pick<LedgerRepo, "append">;
  clock: Clock;
  platformAccountId: WhopAccountId;
  holdSeconds?: number;
  limit?: number;
}) {
  const holdSeconds = deps.holdSeconds ?? 0;
  return async function releaseTransfers(): Promise<ReleaseTransfersResult> {
    const olderThan = new Date(deps.clock.now().getTime() - holdSeconds * 1000);
    const candidates = await deps.orders.findEligible({ olderThan, limit: deps.limit ?? 100 });
    const counts: ReleaseTransfersResult = { released: 0, retried: 0, failed: 0 };
    for (const order of candidates) {
      const outcome = await deps.uow.exclusive(`order:${order.id}`, async () => {
        const seller = await deps.sellers.get(order.sellerId);
        if (!seller?.whopAccountId) return "failed" as const;
        const share = subtract(order.gross, order.fee);
        if (!share.ok) return "failed" as const;
        const transfer = await deps.provider.createTransfer(
          {
            originId: deps.platformAccountId,
            destinationId: seller.whopAccountId,
            amount: share.value,
            metadata: { order_id: order.id },
          },
          `transfer:${order.id}`,
        );
        if (!transfer.ok)
          return transfer.error.kind === "network" ? ("retried" as const) : ("failed" as const);
        await deps.orders.recordTransfer(order.id, transfer.value.id);
        // A zero-amount, single-sided observation, not a balance-affecting entry: the real
        // debit/credit pair lands later when the simulator's transfer.completed webhook
        // reaches inbox.ts, keyed by the provider's transfer id and "completed" transition
        // (see entriesFor in inbox.ts). Keying this row by the order id and "requested"
        // instead keeps it from ever colliding with that later pair under ledger_entries'
        // (effectKey, accountSide) unique constraint.
        await deps.ledger.append([
          {
            runId: order.runId,
            sellerId: order.sellerId,
            accountSide: "seller",
            amount: { ...share.value, amountMinor: 0 },
            kind: "transfer_requested",
            resourceType: "order",
            resourceId: order.id,
            effectKey: effectKey("order", order.id, "requested"),
            occurredAt: deps.clock.now(),
          },
        ]);
        return "released" as const;
      });
      counts[outcome]++;
    }
    return counts;
  };
}
