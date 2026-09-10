import type { WhopPort as AdapterPort } from "../ports/whop";
import { err, ok } from "../result";
import type { ProviderRecord, ReconciliationProvider } from "./ports";

// The sandbox REST payment reads report a settled payment as "paid" (the webhook that
// announces the same fact is payment.succeeded, and the mock adapter mirrors that word), so
// both spellings mean the same confirmed state here. Anything outside this table is a
// vocabulary change the reconciliation must not guess at.
const PAYMENT_STATUS: Record<string, ProviderRecord["status"]> = {
  paid: "succeeded",
  succeeded: "succeeded",
  completed: "completed",
  pending: "pending",
  reserve: "reserve",
  failed: "failed",
};
function paymentStatus(raw: string): ProviderRecord["status"] | null {
  return PAYMENT_STATUS[raw] ?? null;
}

// The provider's payments and transfers have different ownership fields.
export function createReconciliationProvider(
  provider: Pick<AdapterPort, "listPayments" | "listTransfers">,
): Pick<ReconciliationProvider, "listPayments" | "listTransfers"> {
  return {
    async listPayments(input) {
      const result = await provider.listPayments(input);
      if (!result.ok) return result;
      const data: ProviderRecord[] = [];
      for (const item of result.value.items) {
        if (!item.amount || item.accountId !== input.accountId) return err({ kind: "decode" });
        const status = paymentStatus(item.status);
        if (!status) return err({ kind: "decode" });
        data.push({ id: item.id, accountId: item.accountId, amount: item.amount, status });
      }
      return ok({ data, nextCursor: result.value.nextCursor });
    },
    async listTransfers(input) {
      // Reconciliation compares incoming seller allocations, never the adapter's
      // default outgoing list. The provider adapter independently checks ownership.
      const result = await provider.listTransfers({ ...input, direction: "destination" });
      if (!result.ok) return result;
      const data: ProviderRecord[] = [];
      for (const item of result.value.items) {
        if (item.destination.type !== "Company" || item.destination.id !== input.accountId)
          return err({ kind: "decode" });
        // Whop documents succeeded/processing; local fixtures retain the earlier
        // completed/pending vocabulary. Preserve pending without treating it as paid.
        const status =
          item.status === "succeeded"
            ? "completed"
            : item.status === "processing"
              ? "pending"
              : item.status;
        if (!["completed", "pending", "reserve", "failed"].includes(status))
          return err({ kind: "decode" });
        data.push({
          id: item.id,
          accountId: input.accountId,
          amount: item.amount,
          status: status as ProviderRecord["status"],
        });
      }
      return ok({ data, nextCursor: result.value.nextCursor });
    },
  };
}
