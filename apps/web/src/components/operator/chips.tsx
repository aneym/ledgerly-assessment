import { CAPABILITY_LABEL } from "@/lib/operator/format";
import type { Capabilities } from "@/lib/operator/types";

const GATES: Array<keyof Capabilities> = ["payments", "transfers", "payouts"];

/** Three dots: payments, transfers, payouts. Separate gates, shown separately. */
export function CapabilityDots({ capabilities }: { capabilities: Capabilities }) {
  const text = GATES.map((gate) => `${gate} ${CAPABILITY_LABEL[capabilities[gate]]}`).join(", ");
  return (
    <span className="op-dots" title={text}>
      {GATES.map((gate) => (
        <i key={gate} className={`op-dot ${capabilities[gate]}`} aria-hidden="true" />
      ))}
      <span className="op-sr">{text}</span>
    </span>
  );
}
