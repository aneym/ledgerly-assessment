const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const dateOnly = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

/** `Sep 08, 2026, 14:32 UTC`; null when the input is not a date. */
export function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${dateTime.format(date)} UTC`;
}

/** `Sep 08, 2026`; null when the input is not a date. */
export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return dateOnly.format(date);
}

export type ChipTone = "ok" | "warn" | "bad" | "plain";

/**
 * Title for a failed GET /api/orders/{id}: the route is live, so a 404 with a JSON body is
 * a missing order and a 401 or 403 is the route's seller-owner-or-operator rule, not an
 * absent route. Only a bare 404 page or no response means the route is not there.
 */
export function orderFailureTitle(failure: {
  kind: "network" | "http" | "unexpected";
  status: number | null;
  apiMessage?: string | undefined;
}): string {
  if (failure.kind === "network") return "Could not reach the app API";
  if (failure.kind === "unexpected") return "The order route answered with an unexpected response";
  if (failure.status === 404 && failure.apiMessage) return "Order not found";
  if (failure.status === 401) return "Sign in to read this order";
  if (failure.status === 403) return "This session may not read this order";
  if (failure.status === 404) return "Order API is not live yet";
  return "Could not read this order";
}

/** Maps an order status string from the API to a label and a chip tone. */
export function describeStatus(status: string): { label: string; tone: ChipTone } {
  const key = status.toLowerCase().replace(/[\s-]+/g, "_");
  switch (key) {
    case "paid":
    case "succeeded":
    case "completed":
    case "complete":
    case "settled":
      return { label: "Paid", tone: "ok" };
    case "pending":
    case "created":
    case "checkout_created":
    case "open":
    case "awaiting_payment":
    case "requires_payment":
    case "checkout":
      return { label: "Awaiting payment", tone: "warn" };
    case "settling":
    case "processing":
      return { label: "Settling", tone: "warn" };
    case "refunded":
      return { label: "Refunded", tone: "plain" };
    case "failed":
    case "declined":
      return { label: "Payment failed", tone: "bad" };
    case "cancelled":
    case "canceled":
    case "expired":
      return { label: "Cancelled", tone: "plain" };
    default:
      return { label: status.replace(/_/g, " "), tone: "plain" };
  }
}
