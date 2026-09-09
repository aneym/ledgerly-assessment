import { z } from "zod";

const embeddedSession = z.object({
  kind: z.literal("embedded"),
  token: z.string().min(1),
  accountId: z.string().min(1),
  environment: z.literal("sandbox"),
  returnUrl: z.url(),
  expiresAt: z.iso.datetime(),
});
export type EmbeddedPayoutSession = z.infer<typeof embeddedSession>;
const hostedSession = z.object({
  kind: z.literal("hosted"),
  url: z.url(),
  source: z.literal("sandbox"),
});
const messages: Record<string, string> = {
  unauthenticated: "Sign in to open your payouts.",
  seller_owner_required:
    "Only the seller who owns this account can open payouts. Demo and operator access cannot authorize withdrawals.",
  fixture_mode:
    "This is a local demo. Whop's payout components and bank withdrawals are not available in fixture mode.",
  sandbox_payouts_unavailable:
    "Whop payouts are unavailable in this sandbox. No bank withdrawal or hosted payout session was created.",
  capability_inactive:
    "Whop has not enabled payouts for this sandbox. No bank withdrawal or hosted payout session was created.",
  credential_missing: "The server is not connected to Whop. Payouts cannot open yet.",
  seller_suspended: "Payout access is paused while this seller account is suspended.",
  account_not_connected: "Connect your Whop account before opening payouts.",
  hosted_origin_required:
    "Whop verification needs the deployed HTTPS app. It cannot return to a local development address.",
};
export async function requestPayoutSession(
  sellerId: string,
  view: "embedded" | "hosted",
  signal?: AbortSignal,
) {
  const response = await fetch(`/api/sellers/${encodeURIComponent(sellerId)}/payouts/session`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    throw new Error(
      (error.success && messages[error.data.error]) || "Payouts could not open. Please try again.",
    );
  }
  const data = (view === "embedded" ? embeddedSession : hostedSession).parse(body);
  if (data.kind === "hosted") {
    const url = new URL(data.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !(url.hostname === "whop.com" || url.hostname.endsWith(".whop.com"))
    )
      throw new Error("Whop returned an invalid portal link.");
  }
  return data;
}

// Pinned public loader; provider frames remain hosted by Whop. See lane SDK contract.
export const PAYOUT_SDK_SRC = "https://js.whop.cloud/elements/amber/elements.js";
export const PAYOUT_SDK_INTEGRITY = "sha256-7yipHZrfT7FZveoyht6pcddm9OhLVYu56R4DFPofRy8=";

// Current documented wallet API, restricted to the read-only breakdown we mount.
export type WhopWallet = {
  create: (
    type: "balances",
    options: { openHoldingOnSelect: false },
  ) => {
    create: (
      type: "breakdown",
      options: { enabled: true; onReady: () => void; onError: () => void },
    ) => { mount: (selector: string) => void };
  };
  update: (options: { accessToken: string }) => void;
  destroy: () => void;
};
export type WhopElementsSdk = (options: {
  environment: "sandbox";
  baseUrl: "https://js.whop.cloud/elements/amber";
  locale: "en";
  analytics: false;
  toasts: false;
}) => {
  wallet: {
    create: (options: { accountId: string; accessToken: string; currency: "usd" }) => WhopWallet;
  };
};

export function mountPayoutElements(
  sdk: WhopElementsSdk,
  initial: EmbeddedPayoutSession,
  refresh: (signal: AbortSignal) => Promise<EmbeddedPayoutSession>,
  rootId: string,
  ready: () => void,
  failed: () => void,
) {
  const data = embeddedSession.parse(initial);
  if (Date.parse(data.expiresAt) <= Date.now()) throw new Error("Payout session expired");
  const wallet = sdk({
    environment: "sandbox",
    baseUrl: "https://js.whop.cloud/elements/amber",
    locale: "en",
    analytics: false,
    toasts: false,
  }).wallet.create({ accountId: data.accountId, accessToken: data.token, currency: "usd" });
  let active = true;
  let painted = false;
  const abort = new AbortController();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const destroy = () => {
    if (!active) return;
    active = false;
    abort.abort();
    clearTimeout(refreshTimer);
    clearTimeout(expiryTimer);
    clearTimeout(readyTimer);
    wallet.destroy();
  };
  const fail = () => {
    if (!active) return;
    destroy();
    failed();
  };
  const schedule = (expiresAt: string) => {
    const remaining = Date.parse(expiresAt) - Date.now();
    clearTimeout(expiryTimer);
    // A stalled refresh must not leave an expired account frame mounted.
    expiryTimer = setTimeout(fail, remaining);
    refreshTimer = setTimeout(
      async () => {
        try {
          const next = embeddedSession.parse(await refresh(abort.signal));
          if (!active) return;
          if (
            next.accountId !== data.accountId ||
            Date.parse(next.expiresAt) <= Date.now() + 15_000
          )
            throw new Error("Payout session changed or expired");
          wallet.update({ accessToken: next.token });
          schedule(next.expiresAt);
        } catch {
          fail();
        }
      },
      Math.max(0, remaining - 15_000),
    );
  };
  try {
    readyTimer = setTimeout(fail, 30_000);
    schedule(data.expiresAt);
    wallet
      .create("balances", { openHoldingOnSelect: false })
      .create("breakdown", {
        enabled: true,
        onReady: () => {
          if (!active || painted) return;
          painted = true;
          clearTimeout(readyTimer);
          ready();
        },
        onError: fail,
      })
      .mount(`#${rootId}-balance`);
  } catch (error) {
    destroy();
    throw error;
  }
  return { destroy };
}
