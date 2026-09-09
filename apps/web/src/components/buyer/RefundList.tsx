import Link from "next/link";
import type { RefundView } from "@/lib/buyer/api";
import { describeStatus, formatDate } from "@/lib/buyer/format";
import { formatMoney } from "@/lib/catalog";
import { Chip } from "./primitives";

function refundStatus(status: string) {
  const key = status.toLowerCase();
  if (key === "refunded" || key === "approved" || key === "completed")
    return { label: "Refunded", tone: "ok" as const };
  if (key === "requested" || key === "pending" || key === "open")
    return { label: "Requested", tone: "warn" as const };
  if (key === "declined" || key === "rejected") return { label: "Declined", tone: "bad" as const };
  return describeStatus(status);
}

/** Refund requests the buyer has made, newest first as the API orders them. */
export function RefundList({ refunds }: { refunds: RefundView[] }) {
  if (refunds.length === 0) {
    return (
      <section className="card by-refunds" data-tour="account.refunds">
        <div className="by-lib-empty small">
          <p>
            No refund requests. Direct-charge sellers handle refunds themselves; requests for
            platform-charge orders show here.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="card by-refunds" aria-label="Refund requests">
      <ul className="by-lib-list" data-tour="account.refunds">
        {refunds.map((refund) => {
          const status = refundStatus(refund.status);
          const when = formatDate(refund.createdAt);
          return (
            <li key={refund.id} data-tour-item={refund.id}>
              <div className="by-refund-row">
                <div className="what">
                  <b>{refund.productTitle ?? "Refund request"}</b>
                  <span className="by-mono">
                    {refund.orderId ? (
                      <Link
                        className="by-link"
                        href={`/receipt/${encodeURIComponent(refund.orderId)}`}
                      >
                        {refund.orderId}
                      </Link>
                    ) : (
                      refund.id
                    )}
                  </span>
                </div>
                <Chip tone={status.tone}>{status.label}</Chip>
                <div className="when">
                  <b>{refund.amount ? formatMoney(refund.amount) : "—"}</b>
                  {when ? <time dateTime={refund.createdAt ?? undefined}>{when}</time> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
