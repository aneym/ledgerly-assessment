"use client";

import { useState } from "react";
import { z } from "zod";
import { formatMoney } from "@/lib/catalog/money";

const money = z.object({ amountMinor: z.number().int(), currency: z.enum(["USD", "EUR", "BRL"]) });
const stateSchema = z.object({
  source: z.literal("mock"),
  kind: z.literal("ready"),
  available: money,
  currency: z.enum(["USD", "EUR", "BRL"]),
  persistence: z.string(),
  payouts: z.array(
    z.object({ id: z.string(), status: z.string(), amount: money, createdAt: z.string() }),
  ),
});
type State = z.infer<typeof stateSchema>;
const errors: Record<string, string> = {
  insufficient_balance: "The sample balance is too low. Try a smaller amount.",
  invalid_amount: "Enter an amount greater than zero, with up to two decimal places.",
  invalid_request: "Enter a valid amount with up to two decimal places.",
  simulation_expired: "This sample session expired or the server restarted. Start a fresh sample.",
};
export function PayoutsSimulation({ sellerId }: { sellerId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [amount, setAmount] = useState("25.00");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCommand, setLastCommand] = useState<{ amount: string; requestId: string } | null>(
    null,
  );
  async function act(action: "start" | "reset" | "withdraw") {
    setPending(true);
    setError(null);
    let body: object = { action };
    if (action === "withdraw") {
      const command =
        lastCommand?.amount === amount ? lastCommand : { amount, requestId: crypto.randomUUID() };
      setLastCommand(command);
      body = { action, ...command };
    }
    try {
      const response = await fetch(
        `/api/sellers/${encodeURIComponent(sellerId)}/payouts/simulation`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data: unknown = await response.json();
      if (!response.ok) {
        const failure = z.object({ error: z.string() }).safeParse(data);
        if (failure.success && failure.data.error === "simulation_expired") setState(null);
        throw new Error(
          (failure.success && errors[failure.data.error]) ||
            "The payout sample could not run. Try again.",
        );
      }
      setState(stateSchema.parse(data));
      setLastCommand(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The payout sample could not run.");
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      className="sl-paper p-6 md:p-8 flex flex-col gap-4"
      aria-labelledby="payout-simulation-title"
      data-tour="sell.payouts.simulation"
    >
      <h2 id="payout-simulation-title" className="font-serif text-[22px]">
        Local payout demo
      </h2>
      <p className="text-[13px] text-ink-2">
        Mock endpoints, no Whop connection. Try a withdrawal from a separate sample balance. This
        never uses your bank details or changes your seller ledger.
      </p>
      {!state ? (
        <button
          className="pill self-start"
          type="button"
          disabled={pending}
          onClick={() => void act("start")}
          data-tour="sell.payouts.sample.start"
        >
          Start with 100.00 in sample funds
        </button>
      ) : (
        <>
          <p className="text-[18px]">
            Available sample balance: <strong>{formatMoney(state.available)}</strong>
          </p>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void act("withdraw");
            }}
          >
            <label className="flex flex-col gap-1 text-[13px]" htmlFor="sample-payout-amount">
              Amount in {state.currency}
              <input
                id="sample-payout-amount"
                className="rounded-in border border-line-strong p-2"
                inputMode="decimal"
                value={amount}
                disabled={pending}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setLastCommand(null);
                }}
                required
                pattern="[0-9]+([.][0-9]{1,2})?"
              />
            </label>
            <button
              type="submit"
              className="pill ink"
              disabled={pending}
              data-tour="sell.payouts.sample.withdraw"
            >
              Request sample withdrawal
            </button>
            <button
              type="button"
              className="pill"
              disabled={pending}
              onClick={() => void act("reset")}
            >
              Reset sample
            </button>
          </form>
          <p className="text-[12px] text-muted">
            Sample bank, no real account. Standard rail. The sample fee is zero. Requests stay
            requested; they do not prove arrival at a bank.
          </p>
          {state.payouts.length > 0 && (
            <ul className="flex flex-col gap-2" aria-label="Sample withdrawals">
              {state.payouts.map((payout) => (
                <li key={payout.id} className="rounded-in border border-line p-3 text-[13px]">
                  {formatMoney(payout.amount)} · {payout.status} ·{" "}
                  <span className="font-mono text-[11px]">{payout.id}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12px] text-muted">{state.persistence}</p>
        </>
      )}
      {pending && (
        <p role="status" className="text-[13px]">
          Running the local sample…
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-warn">
          {error}
        </p>
      )}
    </section>
  );
}
