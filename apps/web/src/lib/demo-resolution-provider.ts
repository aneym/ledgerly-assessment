import type { WhopAccountId } from "../../../../packages/core/src/ids";
import type { ReconciliationProvider } from "../../../../packages/core/src/services/ports";
import type {
  InjectFaultInput,
  NewResolutionAction,
  ResolutionAction,
  ResolutionCase,
} from "../../../../packages/core/src/services/resolution";

export type DemoReadFaultInput = InjectFaultInput & { providerOutcome?: "uncertain" };
type ProviderLookup = Pick<ReconciliationProvider, "listPayments" | "listTransfers">;

const MARKER = "mock_provider_read_timeout_v1";
export const DEMO_READ_FAULT_NOTE = "mock provider read timeout injected";

export function demoReadFaultEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.DEMO_MODE === "1" && env.WHOP_DEMO_FALLBACK === "1";
}

function isFreshMockPaymentCase(kase: ResolutionCase): boolean {
  return (
    kase.simulated &&
    kase.provenance === "mock" &&
    kase.kind === "missing_local_payment" &&
    kase.providerResourceType === "payment" &&
    /^pay_mock_demo_[a-f0-9]{64}$/.test(kase.providerResourceId) &&
    kase.sellerId !== null
  );
}

/** A durable system marker selects a mock read failure for this one fresh demo issue. */
export function demoReadFaultMarker(
  kase: ResolutionCase,
  id: string,
  at: Date,
): NewResolutionAction {
  if (!isFreshMockPaymentCase(kase))
    throw new Error("Read fault requires a fresh mock payment issue");
  return {
    id,
    caseId: kase.id,
    action: "note",
    actorUserId: "system:demo-read-fault",
    idempotencyKey: `${MARKER}:${kase.id}`,
    outcome: "succeeded",
    detail: {
      note: DEMO_READ_FAULT_NOTE,
      fixture: MARKER,
      sellerId: kase.sellerId,
      providerResourceId: kase.providerResourceId,
    },
    at,
  };
}

/** Ordinary cases retain the original reader. This fixture never calls or changes Whop. */
export function providerForDemoReadFault(
  provider: ProviderLookup,
  kase: ResolutionCase | null,
  actions: ResolutionAction[],
  accountId: WhopAccountId | null,
  enabled: boolean,
): ProviderLookup {
  if (!enabled || !kase || !accountId || !isFreshMockPaymentCase(kase)) return provider;
  const marked = actions.some((action) => {
    const detail = action.detail as Record<string, unknown> | null;
    return (
      action.caseId === kase.id &&
      action.action === "note" &&
      action.actorUserId === "system:demo-read-fault" &&
      action.idempotencyKey === `${MARKER}:${kase.id}` &&
      action.outcome === "succeeded" &&
      detail?.fixture === MARKER &&
      detail.sellerId === kase.sellerId &&
      detail.providerResourceId === kase.providerResourceId
    );
  });
  if (!marked) return provider;
  // A foreign account is refused, never passed through the fixture or read from Whop.
  const fail: ProviderLookup["listPayments"] = async (input) =>
    input.accountId === accountId
      ? { ok: false, error: { kind: "network", body: { code: "mock_timeout" } } }
      : { ok: false, error: { kind: "invalid_request" } };
  return { listPayments: fail, listTransfers: fail };
}
