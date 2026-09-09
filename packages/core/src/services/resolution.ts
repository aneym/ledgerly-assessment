// Admin issue resolution: turns a reconciliation discrepancy into a tracked case with a
// safe recovery path, per docs/lanes/admin-resolution.md and
// docs/lanes/architecture/admin-resolution-contract.md.
//
// This reuses reconcileSeller (packages/core/src/services/reconciliation.ts) as the sole
// source of truth for "what is wrong" — detection never re-derives a discrepancy on its
// own, and recheck/resolve never trust a button click, only a fresh reconciliation report.
// Every write this service makes to the ledger goes through the same effectKey() a webhook
// would produce for the same provider event, so a later real webhook for the same resource
// collides on the existing business_effects unique constraint and becomes a no-op, and two
// admin action calls with the same idempotencyKey collide on resolution_actions' own unique
// constraint the same way.
import { effectKey } from "../effects";
import { computePlatformFee } from "../fee";
import { deliveryId, type OrderId, type SellerId, type WhopAccountId } from "../ids";
import { type Money, subtract, toDecimalString } from "../money";
import type { WhopError, WhopPayment } from "../ports/whop-types";
import { err, ok, type Result } from "../result";
import type {
  Clock,
  EffectRepo,
  LedgerRepo,
  ListInput,
  ProviderRecord,
  ReconciliationProvider,
  Seller,
  SellerRepo,
} from "./ports";
import type { createReconciliationService, ReconciliationReport } from "./reconciliation";

export type ResolutionCaseKind =
  | "missing_local_payment"
  | "unconfirmed_transfer"
  | "amount_mismatch";
export type ResolutionCaseStatus =
  | "detected"
  | "investigating"
  | "action_pending"
  | "rechecking"
  | "resolved"
  | "escalated";
// The five actions an operator may request through the API. "resolve" is a sixth,
// system-written action-log value: a `recheck` request that finds the discrepancy gone is
// stored as a "resolve" row instead of a "recheck" row, so the audit trail names the moment
// a case actually closed without giving operators a separate button that could bypass
// verification. See the contract doc for the full rule.
//
// "import_confirmed" (not "import_confirmed_payment"): renamed to match the marketplace
// issues contract's action-id enum, since apps/web's dynamic route reads this literal
// straight off a URL path segment (POST .../actions/{action}) and the contract's literal
// spelling is "import_confirmed". Same status rename below ("open" -> "detected").
export type ResolutionActionRequest =
  | "refetch"
  | "import_confirmed"
  | "recheck"
  | "escalate"
  | "note";
export type ResolutionActionType = ResolutionActionRequest | "resolve";
export type ResolutionActionOutcome = "succeeded" | "no_change" | "failed" | "uncertain";

export type ResolutionCase = {
  id: string;
  kind: ResolutionCaseKind;
  status: ResolutionCaseStatus;
  sellerId: SellerId | null;
  orderId: OrderId | null;
  providerResourceType: "payment" | "transfer";
  providerResourceId: string;
  expected: Money | null;
  observed: Money | null;
  impact: string;
  nextSafeAction: string | null;
  assignedTo: string | null;
  provenance: string;
  simulated: boolean;
  openedAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  correlationId: string | null;
};

export type ResolutionAction = {
  id: string;
  caseId: string;
  action: ResolutionActionType;
  actorUserId: string;
  idempotencyKey: string;
  outcome: ResolutionActionOutcome;
  detail: unknown;
  at: Date;
};

export type NewResolutionCase = {
  id: string;
  kind: ResolutionCaseKind;
  sellerId: SellerId | null;
  orderId?: OrderId | null;
  providerResourceType: "payment" | "transfer";
  providerResourceId: string;
  expected: Money | null;
  observed: Money | null;
  impact: string;
  nextSafeAction: string | null;
  provenance: string;
  simulated: boolean;
  correlationId?: string | null;
  now: Date;
};
export type ResolutionCasePatch = Partial<{
  status: ResolutionCaseStatus;
  observed: Money | null;
  impact: string;
  nextSafeAction: string | null;
  assignedTo: string | null;
  resolvedAt: Date | null;
}>;
export type ResolutionCaseFilter = {
  kind?: ResolutionCaseKind;
  status?: ResolutionCaseStatus;
  sellerId?: SellerId;
  provenance?: string;
  limit: number;
  cursor?: string;
};
export interface ResolutionCaseRepo {
  // Dedupes on (kind, providerResourceId): a repeated detection for the same discrepancy
  // returns the existing row untouched (created: false) rather than resetting an
  // operator's in-progress status or assignment.
  upsert(input: NewResolutionCase): Promise<{ case: ResolutionCase; created: boolean }>;
  get(id: string): Promise<ResolutionCase | null>;
  findOpenByResource(
    kind: ResolutionCaseKind,
    providerResourceId: string,
  ): Promise<ResolutionCase | null>;
  update(id: string, patch: ResolutionCasePatch, now: Date): Promise<ResolutionCase>;
  list(filter: ResolutionCaseFilter): Promise<ResolutionCase[]>;
}

export type NewResolutionAction = {
  id: string;
  caseId: string;
  action: ResolutionActionType;
  actorUserId: string;
  idempotencyKey: string;
  outcome: ResolutionActionOutcome;
  detail: unknown;
  at: Date;
};
export interface ResolutionActionRepo {
  // Idempotent on idempotencyKey: a second insert with the same key never re-applies
  // whatever the first call's outcome caused, it only returns that first row.
  insert(input: NewResolutionAction): Promise<{ action: ResolutionAction; created: boolean }>;
  get(idempotencyKey: string): Promise<ResolutionAction | null>;
  listForCase(caseId: string): Promise<ResolutionAction[]>;
}

// A narrow slice of the shared Repositories/UnitOfWork ports (packages/core/src/services/
// ports.ts), not an extension of them. Resolution owns its own two tables and only borrows
// read/append access to sellers/ledger/effects, so this can evolve without touching the
// shared interface every other lane's repos implement.
export type ResolutionRepositories = {
  cases: ResolutionCaseRepo;
  actions: ResolutionActionRepo;
  sellers: Pick<SellerRepo, "get">;
  ledger: Pick<LedgerRepo, "append" | "settleOrder">;
  effects: Pick<EffectRepo, "insert">;
};
export type ResolutionUnitOfWork = {
  run<T>(fn: (r: ResolutionRepositories) => Promise<T>): Promise<T>;
};

const ALLOWED_ACTIONS: Record<ResolutionCaseKind, readonly ResolutionActionRequest[]> = {
  missing_local_payment: ["refetch", "import_confirmed", "recheck", "escalate", "note"],
  unconfirmed_transfer: ["refetch", "recheck", "escalate", "note"],
  amount_mismatch: ["refetch", "recheck", "escalate", "note"],
};
export function allowedActionsFor(kind: ResolutionCaseKind): readonly ResolutionActionRequest[] {
  return ALLOWED_ACTIONS[kind];
}

function format(amount: Money): string {
  return `${toDecimalString(amount)} ${amount.currency}`;
}

type ProviderLookup = Pick<ReconciliationProvider, "listPayments" | "listTransfers">;
type LookupResult =
  | { status: "found"; record: ProviderRecord }
  | { status: "not_found" }
  | { status: "inconclusive"; reason: string };

// Bounded search for one resource by id. WhopPort has no single-resource decoded read for
// payments (getPayment returns only {id, raw}, undecoded) or transfers at all, only
// paginated listPayments/listTransfers — so "refetch one resource" means paginating with
// the same cycle-detection reconcileSeller uses, stopping as soon as the id is found.
async function findProviderRecord(
  provider: ProviderLookup,
  accountId: ListInput["accountId"],
  resourceType: "payment" | "transfer",
  resourceId: string,
  maxPages: number,
): Promise<LookupResult> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    if (page >= maxPages) return { status: "inconclusive", reason: "page_limit" };
    const input: ListInput = { accountId, limit: 100, ...(cursor ? { cursor } : {}) };
    const result = await (resourceType === "payment"
      ? provider.listPayments(input)
      : provider.listTransfers(input));
    if (!result.ok) return { status: "inconclusive", reason: result.error.kind };
    const match = result.value.data.find((record) => record.id === resourceId);
    if (match) return { status: "found", record: match };
    if (result.value.nextCursor === null) return { status: "not_found" };
    cursor = result.value.nextCursor;
    if (!cursor || seen.has(cursor)) return { status: "inconclusive", reason: "pagination_cycle" };
    seen.add(cursor);
  }
}

const CONFIRMED_STATUS: Record<"payment" | "transfer", ProviderRecord["status"]> = {
  payment: "succeeded",
  transfer: "completed",
};

export type DetectInput = {
  sellerId: SellerId;
  provider: ProviderLookup;
  // Where this detection's evidence came from: the hybrid adapter's real meta.source when
  // available, else the configured WHOP_MODE. Core stays adapter-oblivious — the caller in
  // apps/web computes this string, it is never derived from adapter internals in here.
  provenance: string;
  maxPages?: number;
  simulated?: boolean;
};

export function createResolutionService(deps: {
  uow: ResolutionUnitOfWork;
  reconcileSeller: ReturnType<typeof createReconciliationService>;
  clock: Clock;
  ids: { case: () => string; action: () => string };
}) {
  async function detectResolutionCases(
    input: DetectInput,
  ): Promise<Result<ResolutionCase[], { kind: string }>> {
    const result = await deps.reconcileSeller({
      sellerId: input.sellerId,
      provider: input.provider,
      ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
    });
    if (!result.ok) return result;
    const report: ReconciliationReport = result.value;
    const now = deps.clock.now();
    const simulated = input.simulated ?? false;
    return deps.uow.run(async (r) => {
      const cases: ResolutionCase[] = [];
      for (const item of report.missingLocally) {
        if (item.resourceType !== "payment") continue;
        const { case: kase } = await r.cases.upsert({
          id: deps.ids.case(),
          kind: "missing_local_payment",
          sellerId: input.sellerId,
          providerResourceType: "payment",
          providerResourceId: item.resourceId,
          expected: item.amount,
          observed: null,
          impact: `Provider shows a paid payment of ${format(item.amount)} with no matching ledger entry.`,
          nextSafeAction: "refetch",
          provenance: input.provenance,
          simulated,
          now,
        });
        cases.push(kase);
      }
      for (const item of report.missingAtProvider) {
        if (item.resourceType !== "transfer") continue;
        const { case: kase } = await r.cases.upsert({
          id: deps.ids.case(),
          kind: "unconfirmed_transfer",
          sellerId: input.sellerId,
          providerResourceType: "transfer",
          providerResourceId: item.resourceId,
          expected: item.amount,
          observed: null,
          impact: `Local ledger recorded a transfer of ${format(item.amount)} that the provider does not confirm as completed.`,
          nextSafeAction: "refetch",
          provenance: input.provenance,
          simulated,
          now,
        });
        cases.push(kase);
      }
      for (const pair of report.amountMismatch) {
        const { case: kase } = await r.cases.upsert({
          id: deps.ids.case(),
          kind: "amount_mismatch",
          sellerId: input.sellerId,
          providerResourceType: pair.local.resourceType,
          providerResourceId: pair.local.resourceId,
          expected: pair.local.amount,
          observed: pair.provider.amount,
          impact: `Ledger shows ${format(pair.local.amount)} but the provider reports ${format(pair.provider.amount)}.`,
          nextSafeAction: "recheck",
          provenance: input.provenance,
          simulated,
          now,
        });
        cases.push(kase);
      }
      return ok(cases);
    });
  }

  type RunActionInput = {
    caseId: string;
    action: ResolutionActionRequest;
    idempotencyKey: string;
    actorUserId: string;
    note?: string;
    maxPages?: number;
  };
  type RunActionError =
    | { kind: "case_not_found" }
    | { kind: "action_not_allowed"; action: ResolutionActionRequest; caseKind: ResolutionCaseKind }
    | { kind: "seller_not_connected" };

  async function runAction(
    provider: ProviderLookup,
    input: RunActionInput,
  ): Promise<Result<{ action: ResolutionAction; case: ResolutionCase }, RunActionError>> {
    const kase = await deps.uow.run((r) => r.cases.get(input.caseId));
    if (!kase) return err({ kind: "case_not_found" });
    if (!ALLOWED_ACTIONS[kase.kind].includes(input.action))
      return err({ kind: "action_not_allowed", action: input.action, caseKind: kase.kind });

    const seller: Seller | null = kase.sellerId
      ? await deps.uow.run((r) => r.sellers.get(kase.sellerId as SellerId))
      : null;
    const maxPages = input.maxPages ?? 100;

    let outcome: ResolutionActionOutcome;
    let detail: unknown;
    let storedAction: ResolutionActionType = input.action;
    let apply: (r: ResolutionRepositories) => Promise<ResolutionCase>;

    if (input.action === "note") {
      outcome = "succeeded";
      detail = { note: input.note ?? "" };
      apply = async () => kase;
    } else if (input.action === "escalate") {
      outcome = "succeeded";
      detail = input.note !== undefined ? { note: input.note } : {};
      apply = (r) =>
        r.cases.update(
          kase.id,
          { status: "escalated", assignedTo: input.actorUserId },
          deps.clock.now(),
        );
    } else if (input.action === "refetch") {
      if (!seller?.whopAccountId) return err({ kind: "seller_not_connected" });
      const lookup = await findProviderRecord(
        provider,
        seller.whopAccountId,
        kase.providerResourceType,
        kase.providerResourceId,
        maxPages,
      );
      if (lookup.status === "inconclusive") {
        outcome = "uncertain";
        detail = { reason: lookup.reason };
        apply = async () => kase;
      } else if (lookup.status === "found") {
        outcome = "succeeded";
        detail = { status: lookup.record.status, amount: lookup.record.amount };
        const nextStatus = kase.status === "detected" ? "investigating" : kase.status;
        apply = (r) =>
          r.cases.update(
            kase.id,
            { observed: lookup.record.amount, status: nextStatus },
            deps.clock.now(),
          );
      } else {
        outcome = "no_change";
        detail = { reason: "not_found_at_provider" };
        apply = async () => kase;
      }
    } else if (input.action === "import_confirmed") {
      if (!seller?.whopAccountId) return err({ kind: "seller_not_connected" });
      const lookup = await findProviderRecord(
        provider,
        seller.whopAccountId,
        "payment",
        kase.providerResourceId,
        maxPages,
      );
      if (lookup.status === "inconclusive") {
        outcome = "uncertain";
        detail = { reason: lookup.reason };
        apply = async () => kase;
      } else if (lookup.status === "not_found") {
        outcome = "failed";
        detail = { reason: "not_found_at_provider" };
        apply = async () => kase;
      } else if (lookup.record.status !== CONFIRMED_STATUS.payment) {
        // Not yet paid at the provider: no import, no status change. Never guess.
        outcome = "no_change";
        detail = { status: lookup.record.status };
        apply = async () => kase;
      } else {
        outcome = "succeeded";
        detail = { imported: lookup.record.amount };
        const connectedSeller = seller;
        apply = async (r) => {
          // Same lookup and stamp a payment.succeeded webhook performs: find the order this
          // payment belongs to and mark it paid with this delivery's provenance. When no
          // order matches, `allocation` is null and the fee is computed from the amount.
          const { allocation } = await r.ledger.settleOrder(
            connectedSeller,
            { paymentId: kase.providerResourceId },
            {
              paymentId: kase.providerResourceId,
              status: "paid",
              provenance: kase.provenance === "mock" ? "mock" : "sandbox",
            },
          );
          let sellerShare: Money;
          let fee: Money;
          if (allocation) {
            const share = subtract(allocation.gross, allocation.fee);
            if (!share.ok) throw new Error("Invalid order allocation for imported payment");
            sellerShare = share.value;
            fee = allocation.fee;
          } else {
            const computed = computePlatformFee(lookup.record.amount);
            if (!computed.ok) throw new Error("Cannot compute fee for imported payment");
            sellerShare = computed.value.sellerShare;
            fee = computed.value.fee;
          }
          // Same effectKey a payment.succeeded webhook would produce, so a later webhook
          // for this exact payment collides on business_effects and never double-posts.
          const key = effectKey("payment", kase.providerResourceId, "succeeded");
          const delivery = deliveryId(`admin_action:${input.idempotencyKey}`);
          if (!delivery.ok) throw new Error("Invalid synthetic delivery id for admin import");
          const now = deps.clock.now();
          const applied = await r.effects.insert(
            {
              key,
              deliveryId: delivery.value,
              resourceType: "payment",
              resourceId: kase.providerResourceId,
              transition: "succeeded",
            },
            now,
          );
          if (applied) {
            await r.ledger.append([
              {
                runId: connectedSeller.runId,
                sellerId: connectedSeller.id,
                accountSide: "seller",
                amount: sellerShare,
                kind: "payment",
                resourceType: "payment",
                resourceId: kase.providerResourceId,
                effectKey: key,
                occurredAt: now,
              },
              {
                runId: connectedSeller.runId,
                sellerId: connectedSeller.id,
                accountSide: "platform",
                amount: fee,
                kind: "fee",
                resourceType: "payment",
                resourceId: kase.providerResourceId,
                effectKey: key,
                occurredAt: now,
              },
            ]);
          }
          return r.cases.update(
            kase.id,
            { observed: lookup.record.amount, status: "rechecking", nextSafeAction: "recheck" },
            now,
          );
        };
      }
    } else {
      // recheck: the only action allowed to close a case, and only after re-running the
      // same detection reconcileSeller performs, never on the click alone.
      if (!seller) return err({ kind: "seller_not_connected" });
      const reconciled = await deps.reconcileSeller({ sellerId: seller.id, provider, maxPages });
      if (!reconciled.ok) {
        outcome = "failed";
        detail = { reason: reconciled.error.kind };
        apply = async () => kase;
      } else {
        const report = reconciled.value;
        const isResource = (item: { resourceType: string; resourceId: string }) =>
          item.resourceType === kase.providerResourceType &&
          item.resourceId === kase.providerResourceId;
        // A missing payment that becomes an amount mismatch is still unresolved. Require
        // positive equality from this same snapshot, rather than absence from one list.
        const comparisons = report.comparisons?.filter(isResource) ?? [];
        const comparison = comparisons.length === 1 ? comparisons[0] : undefined;
        const currentAmounts = {
          local: comparison?.local ?? null,
          provider: comparison?.provider ?? null,
          matches: comparison?.matches === true,
        };
        const stillPresent =
          !currentAmounts.matches ||
          comparison?.providerStatus !== CONFIRMED_STATUS[kase.providerResourceType] ||
          report.missingLocally.some(isResource) ||
          report.missingAtProvider.some(isResource) ||
          report.amountMismatch.some((pair) => isResource(pair.local)) ||
          report.pendingOrReserve.some(isResource);
        if (stillPresent) {
          outcome = "no_change";
          detail = { evidence: "discrepancy still present at recheck", currentAmounts };
          apply = (r) => r.cases.update(kase.id, { status: "investigating" }, deps.clock.now());
        } else {
          outcome = "succeeded";
          detail = { evidence: "discrepancy no longer present at recheck", currentAmounts };
          // Stored as "resolve", not "recheck": the audit trail names the moment the case
          // actually closed, distinct from a recheck that only observed no change.
          storedAction = "resolve";
          const now = deps.clock.now();
          apply = (r) => r.cases.update(kase.id, { status: "resolved", resolvedAt: now }, now);
        }
      }
    }

    return deps.uow.run(async (r) => {
      const claim = await r.actions.insert({
        id: deps.ids.action(),
        caseId: kase.id,
        action: storedAction,
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        outcome,
        detail,
        at: deps.clock.now(),
      });
      if (!claim.created) {
        const current = await r.cases.get(kase.id);
        if (!current) throw new Error("Case disappeared mid-action");
        return ok({ action: claim.action, case: current });
      }
      const updated = await apply(r);
      return ok({ action: claim.action, case: updated });
    });
  }

  return { detectResolutionCases, runAction };
}

// Fault injection for the demo, gated on DEMO_MODE by the caller (apps/web reads the env
// var; this function only trusts the boolean it is handed, it never reads process.env
// itself, matching this package's "no outward runtime dependencies" rule). The ledger is
// append-only (LedgerRepo has no delete), so a "missing local payment" fault can only be
// simulated by withholding the local effect for a real, provider-confirmed payment, never
// by deleting an existing ledger row.
export type InjectFaultInput = {
  sellerId: SellerId;
  paymentId?: string;
  fresh?: boolean;
  runId?: string;
  provenance: string;
};
export type InjectFaultError =
  | { kind: "demo_mode_required" }
  | { kind: "seller_not_connected" }
  | { kind: "payment_not_confirmed" }
  | { kind: "case_resolved"; caseId: string }
  | { kind: "payment_required"; message: string }
  | { kind: "run_required"; message: string };

export type DemoPaymentSeeder = {
  seedDemoPayment?: (
    accountId: WhopAccountId,
    key: string,
  ) => Result<WhopPayment, WhopError> | Promise<Result<WhopPayment, WhopError>>;
};

export async function injectSimulatedFault(
  deps: {
    uow: ResolutionUnitOfWork;
    provider: ProviderLookup & DemoPaymentSeeder;
    clock: Clock;
    // `action` is optional so callers that only need the case (e.g. existing tests built
    // before the marketplace-issues contract added a demo-fault history entry) keep working
    // unchanged; the HTTP route wires both ids.
    ids: { case: () => string; action?: () => string };
    demoMode: boolean;
    maxPages?: number;
  },
  input: InjectFaultInput,
): Promise<Result<ResolutionCase, InjectFaultError>> {
  if (!deps.demoMode) return err({ kind: "demo_mode_required" });
  const seller = await deps.uow.run((r) => r.sellers.get(input.sellerId));
  if (!seller?.whopAccountId) return err({ kind: "seller_not_connected" });
  let paymentId = input.paymentId;
  const fresh = input.fresh === true || !paymentId;
  if (fresh) {
    if (!deps.provider.seedDemoPayment)
      return err({
        kind: "payment_required",
        message: "Provide a payment ID. Demo payment seeding is unavailable.",
      });
    if (!input.runId || !/^run_[A-Za-z0-9_-]+$/.test(input.runId))
      return err({ kind: "run_required", message: "Provide a demo run ID shaped run_<id>." });
    const seeded = await deps.provider.seedDemoPayment(seller.whopAccountId, input.runId);
    if (!seeded.ok) return err({ kind: "payment_not_confirmed" });
    paymentId = seeded.value.id;
  }
  if (!paymentId) return err({ kind: "payment_required", message: "Provide a payment ID." });
  const lookup = await findProviderRecord(
    deps.provider,
    seller.whopAccountId,
    "payment",
    paymentId,
    deps.maxPages ?? 100,
  );
  if (lookup.status !== "found" || lookup.record.status !== CONFIRMED_STATUS.payment)
    return err({ kind: "payment_not_confirmed" });
  return deps.uow.run(async (r) => {
    const now = deps.clock.now();
    const { case: kase, created } = await r.cases.upsert({
      id: deps.ids.case(),
      kind: "missing_local_payment",
      sellerId: input.sellerId,
      providerResourceType: "payment",
      providerResourceId: paymentId,
      expected: lookup.record.amount,
      observed: null,
      impact: `Provider shows ${paymentId} paid; the ledger has no entry.`,
      nextSafeAction: "refetch",
      provenance: fresh ? "mock" : input.provenance,
      simulated: true,
      now,
    });
    if (kase.status === "resolved") return err({ kind: "case_resolved", caseId: kase.id });
    // A "note" history row labeled "demo fault injected", so the case's audit trail records
    // the moment the fault was manufactured — distinct from any operator-authored note. Only
    // written on a fresh case (upsert dedupes on kind+providerResourceId): repeating the same
    // demo-fault request against an already-open case must not duplicate this entry, matching
    // every other write in this file's idempotency-key convention.
    if (created && deps.ids.action) {
      await r.actions.insert({
        id: deps.ids.action(),
        caseId: kase.id,
        action: "note",
        actorUserId: "system:demo-fault",
        idempotencyKey: `demo_fault:${kase.id}`,
        outcome: "succeeded",
        detail: { note: "demo fault injected" },
        at: now,
      });
    }
    return ok(kase);
  });
}
