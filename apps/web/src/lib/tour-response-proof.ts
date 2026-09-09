/** Small, allowlisted facts from successful route responses. Never copies response bodies. */
type SafeProof = Record<string, string>;
type ObjectValue = Record<string, unknown>;
const segment = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const orderPath = new RegExp(`^/api/orders/(${segment})$`);
const earningsPath = new RegExp(`^/api/sellers/(${segment})/earnings$`);
const simulationPath = new RegExp(`^/api/sellers/(${segment})/payouts/simulation$`);
const actionPath = new RegExp(
  `^/api/admin/issues/(${segment})/actions/(refetch|import_confirmed|recheck)$`,
);
const nextActions = new Set(["refetch", "import_confirmed", "recheck", "escalate"]);
const payoutStatuses = new Set([
  "requested",
  "pending",
  "in_transit",
  "completed",
  "failed",
  "cancelled",
]);

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function safeId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) &&
    !/^(apik_|ws_|Bearer|npg_|sk_|pk_|eyJ)/i.test(value)
    ? value
    : undefined;
}
function money(value: unknown): { currency: string; amountMinor: number } | undefined {
  const row = object(value);
  return typeof row.currency === "string" &&
    /^[A-Z]{3}$/.test(row.currency) &&
    typeof row.amountMinor === "number" &&
    Number.isSafeInteger(row.amountMinor)
    ? { currency: row.currency, amountMinor: row.amountMinor }
    : undefined;
}

/** Step attribution comes from the executed server route, never a caller's claimed step. */
export function classifyTourRoute(method: string, path: string): string | null {
  if (method === "POST" && path === "/api/sellers") return "C01";
  if (
    method === "POST" &&
    (path === "/api/products" || /^\/api\/sellers\/[^/]+\/onboarding-link$/.test(path))
  )
    return "C02";
  if (
    (method === "POST" && path === "/api/checkouts") ||
    (method === "GET" && orderPath.test(path))
  )
    return "C03";
  if (method === "GET" && earningsPath.test(path)) return "C04";
  if (method === "POST" && simulationPath.test(path)) return "C05";
  if (method === "POST" && path === "/api/admin/issues/demo-fault") return "C06";
  if (method === "POST" && actionPath.test(path)) return "C07";
  return null;
}

export async function projectTourResponse(
  method: string,
  path: string,
  response: Response,
): Promise<SafeProof> {
  const order = method === "GET" ? orderPath.exec(path) : null;
  const earnings = method === "GET" ? earningsPath.exec(path) : null;
  const simulation = method === "POST" || method === "GET" ? simulationPath.exec(path) : null;
  const action = method === "POST" ? actionPath.exec(path) : null;
  const seller = method === "POST" && path === "/api/sellers";
  const product = method === "POST" && path === "/api/products";
  const checkout = method === "POST" && path === "/api/checkouts";
  const fault = method === "POST" && path === "/api/admin/issues/demo-fault";
  if (
    !(order || earnings || simulation || action || seller || product || checkout || fault) ||
    !response.ok ||
    !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
  )
    return {};
  try {
    const body = object(await response.clone().json());
    const proof: SafeProof = {};
    const putId = (key: string, value: unknown) => {
      const id = safeId(value);
      if (id) proof[key] = id;
    };
    if (body.source === "mock" || body.provenance === "mock") proof.tour_source = "mock";
    if (seller) {
      putId("tour_seller_id", body.id ?? object(body.seller).id);
      // The route rereads the durable seller and separately reads its provider account.
      // Only agreement between those server response fields proves account reuse.
      const localAccount = safeId(body.whop_account_id);
      if (proof.tour_seller_id && localAccount && localAccount === safeId(object(body.account).id))
        proof.tour_seller_account_readback = localAccount;
    }
    if (product) putId("tour_product_id", body.id);
    if (checkout) putId("tour_order_id", body.order_id);
    if (order && body.id === order[1]) {
      putId("tour_order_id", body.id);
      putId("tour_seller_id", object(body.seller).id);
      putId("tour_product_id", object(body.product).id);
      putId("tour_payment_id", body.payment_id);
      if (body.status === "paid" && proof.tour_payment_id) proof.tour_order_paid = "true";
    }
    if (earnings && Array.isArray(body.rows)) {
      // Bound both scan cost and output. An oversized result cannot complete the tour.
      const ids = [
        ...new Set(
          body.rows
            .slice(0, 100)
            .map((row) => safeId(object(row).order_id))
            .filter((id): id is string => !!id),
        ),
      ];
      const joined = ids.join(",");
      if (joined && joined.length <= 2048) proof.tour_earnings_order_ids = joined;
      const payments = body.rows.slice(0, 100).flatMap((value) => {
        const row = object(value);
        const id = safeId(row.provider_resource_id);
        const gross = money(row.gross);
        const fee = money(row.fee);
        const net = money(row.net);
        if (
          !id ||
          row.item !== "payment" ||
          row.status !== "settled" ||
          !gross ||
          !fee ||
          !net ||
          gross.amountMinor <= 0 ||
          net.amountMinor <= 0 ||
          fee.amountMinor < 0 ||
          gross.currency !== fee.currency ||
          gross.currency !== net.currency ||
          !Number.isSafeInteger(fee.amountMinor + net.amountMinor) ||
          fee.amountMinor + net.amountMinor !== gross.amountMinor
        )
          return [];
        return [id];
      });
      const joinedPayments = [...new Set(payments)].join(",");
      if (joinedPayments && joinedPayments.length <= 2048)
        proof.tour_earnings_payment_ids = joinedPayments;
    }
    if (fault || (action && body.id === action[1])) {
      putId("tour_seller_id", object(body.seller).id);
      putId("tour_case_id", body.id);
      putId("tour_payment_id", object(body.subject).provider_resource_id);
      const next = object(body.next_safe_action);
      if (next.available === true && typeof next.id === "string" && nextActions.has(next.id))
        proof.tour_next_action = next.id;
      if (action && proof.tour_case_id) {
        const latest = object(Array.isArray(body.history) ? body.history.at(-1) : null);
        const requested = action[2];
        proof.tour_issue_action = requested;
        if (
          (latest.action === requested ||
            (requested === "recheck" && latest.action === "resolve")) &&
          latest.outcome === "succeeded"
        ) {
          proof.tour_action_succeeded = "true";
          const amounts = object(body.amounts);
          const local = money(amounts.local);
          const provider = money(amounts.provider);
          if (
            requested === "recheck" &&
            body.status === "resolved" &&
            latest.action === "resolve" &&
            local &&
            provider &&
            local.currency === provider.currency &&
            local.amountMinor === provider.amountMinor
          )
            proof.tour_issue_resolved = "true";
        }
      }
    }
    if (simulation && body.source === "mock" && body.kind === "ready") {
      if (Array.isArray(body.payouts) && body.payouts.length === 0)
        proof.tour_sample_started = "true";
      // The guided sample starts empty and requests one payout. Multiple rows are ambiguous.
      if (Array.isArray(body.payouts) && body.payouts.length === 1) {
        const payout = object(body.payouts[0]);
        const amount = money(payout.amount);
        const id = safeId(payout.id);
        if (
          id &&
          amount &&
          amount.amountMinor > 0 &&
          typeof payout.status === "string" &&
          payoutStatuses.has(payout.status)
        ) {
          proof.tour_sample_payout_id = id;
          proof.tour_sample_payout_status = payout.status;
        }
      }
    }
    return proof;
  } catch {
    // Projection is optional telemetry; malformed JSON or an unreadable clone cannot fail a route.
    return {};
  }
}
