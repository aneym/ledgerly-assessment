import { describe, expect, it } from "vitest";
import { runId, type SellerId, sellerId, whopAccountId, whopPaymentId } from "../../src/ids";
import type { Result } from "../../src/result";
import { ok } from "../../src/result";
import type {
  Effect,
  LedgerEntry,
  ProviderPage,
  ProviderRecord,
  ReconciliationProvider,
  Repositories,
  Seller,
  UnitOfWork,
} from "../../src/services/ports";
import { createReconciliationService } from "../../src/services/reconciliation";
import {
  allowedActionsFor,
  createResolutionService,
  injectSimulatedFault,
  type NewResolutionAction,
  type NewResolutionCase,
  type ResolutionAction,
  type ResolutionCase,
  type ResolutionCaseFilter,
  type ResolutionCasePatch,
  type ResolutionRepositories,
  type ResolutionUnitOfWork,
} from "../../src/services/resolution";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const now = new Date("2026-09-08T12:00:00Z");
const clock = { now: () => now };
const RUN = value(runId("run_resolution"));
const SELLER_ID = value(sellerId("seller_1"));
const ACCOUNT_ID = value(whopAccountId("biz_alice"));
const seller: Seller = {
  id: SELLER_ID,
  runId: RUN,
  externalId: "alice",
  email: "alice@example.invalid",
  country: "US",
  whopAccountId: ACCOUNT_ID,
};

function record(
  id: string,
  amountMinor: number,
  status: ProviderRecord["status"] = "succeeded",
): ProviderRecord {
  return { id, accountId: ACCOUNT_ID, amount: { amountMinor, currency: "USD" }, status };
}

// Shared mutable state behind both the reconciliation service's plain UnitOfWork and the
// resolution service's own narrower ResolutionUnitOfWork, so a ledger write made through one
// is visible to a read made through the other -- exactly like two unit-of-work wrappers over
// the same Postgres connection in production.
type State = {
  sellers: Map<SellerId, Seller>;
  ledger: LedgerEntry[];
  effects: Set<string>;
  cases: Map<string, ResolutionCase>;
  casesByResource: Map<string, string>;
  actionsByKey: Map<string, ResolutionAction>;
};
function createState(): State {
  return {
    sellers: new Map([[SELLER_ID, seller]]),
    ledger: [],
    effects: new Set(),
    cases: new Map(),
    casesByResource: new Map(),
    actionsByKey: new Map(),
  };
}
function notUsed(name: string) {
  return async () => {
    throw new Error(`${name} is not exercised by this fixture`);
  };
}
function createCoreUow(state: State): UnitOfWork {
  const repos: Repositories = {
    orders: {
      byId: notUsed("orders.byId"),
      byPaymentId: notUsed("orders.byPaymentId"),
      byCheckoutConfigurationId: notUsed("orders.byCheckoutConfigurationId"),
    },
    lock: notUsed("lock"),
    sellers: {
      async get(id) {
        return state.sellers.get(id) ?? null;
      },
      createOrFetch: notUsed("sellers.createOrFetch"),
      byAccount: notUsed("sellers.byAccount"),
      attach: notUsed("sellers.attach"),
      list: notUsed("sellers.list"),
      count: notUsed("sellers.count"),
    },
    operations: {
      createOrFetch: notUsed("operations.createOrFetch"),
      get: notUsed("operations.get"),
      finish: notUsed("operations.finish"),
    },
    inbox: {
      insert: notUsed("inbox.insert"),
      pending: notUsed("inbox.pending"),
      get: notUsed("inbox.get"),
      mark: notUsed("inbox.mark"),
    },
    effects: {
      async insert(effect: Effect) {
        if (state.effects.has(effect.key)) return false;
        state.effects.add(effect.key);
        return true;
      },
    },
    ledger: {
      async append(entries) {
        state.ledger.push(...entries);
      },
      async forSeller(id) {
        return state.ledger.filter((entry) => entry.sellerId === id);
      },
      resolveOrder: async () => ({ allocation: null, matched: false }),
      settleOrder: async () => ({ allocation: null, matched: false }),
    },
  };
  return {
    async run(fn) {
      return fn(repos);
    },
    async exclusive(_key, fn) {
      return fn({ run: (fn2) => fn2(repos) });
    },
  };
}
function createResolutionUow(state: State): ResolutionUnitOfWork {
  const repos: ResolutionRepositories = {
    sellers: {
      async get(id) {
        return state.sellers.get(id) ?? null;
      },
    },
    ledger: {
      async append(entries) {
        state.ledger.push(...entries);
      },
      settleOrder: async () => ({ allocation: null, matched: false }),
    },
    effects: {
      async insert(effect: Effect) {
        if (state.effects.has(effect.key)) return false;
        state.effects.add(effect.key);
        return true;
      },
    },
    cases: {
      async upsert(input: NewResolutionCase) {
        const resourceKey = `${input.kind}:${input.providerResourceId}`;
        const existingId = state.casesByResource.get(resourceKey);
        if (existingId) {
          const existing = state.cases.get(existingId);
          if (!existing) throw new Error("Dangling case index");
          return { case: existing, created: false };
        }
        const kase: ResolutionCase = {
          id: input.id,
          kind: input.kind,
          status: "detected",
          sellerId: input.sellerId,
          orderId: input.orderId ?? null,
          providerResourceType: input.providerResourceType,
          providerResourceId: input.providerResourceId,
          expected: input.expected,
          observed: input.observed,
          impact: input.impact,
          nextSafeAction: input.nextSafeAction,
          assignedTo: null,
          provenance: input.provenance,
          simulated: input.simulated,
          openedAt: input.now,
          updatedAt: input.now,
          resolvedAt: null,
          correlationId: input.correlationId ?? null,
        };
        state.cases.set(kase.id, kase);
        state.casesByResource.set(resourceKey, kase.id);
        return { case: kase, created: true };
      },
      async get(id: string) {
        return state.cases.get(id) ?? null;
      },
      async findOpenByResource(kind, providerResourceId) {
        const id = state.casesByResource.get(`${kind}:${providerResourceId}`);
        const kase = id ? state.cases.get(id) : undefined;
        return kase && kase.status !== "resolved" ? kase : null;
      },
      async update(id: string, patch: ResolutionCasePatch, updatedAt: Date) {
        const kase = state.cases.get(id);
        if (!kase) throw new Error("Missing case in fixture");
        const updated: ResolutionCase = { ...kase, ...patch, updatedAt };
        state.cases.set(id, updated);
        return updated;
      },
      async list(filter: ResolutionCaseFilter) {
        return [...state.cases.values()]
          .filter(
            (c) =>
              (!filter.kind || c.kind === filter.kind) &&
              (!filter.status || c.status === filter.status) &&
              (!filter.sellerId || c.sellerId === filter.sellerId) &&
              (!filter.provenance || c.provenance === filter.provenance),
          )
          .slice(0, filter.limit);
      },
    },
    actions: {
      async insert(input: NewResolutionAction) {
        const existing = state.actionsByKey.get(input.idempotencyKey);
        if (existing) return { action: existing, created: false };
        const action: ResolutionAction = { ...input };
        state.actionsByKey.set(input.idempotencyKey, action);
        return { action, created: true };
      },
      async get(idempotencyKey: string) {
        return state.actionsByKey.get(idempotencyKey) ?? null;
      },
      async listForCase(caseId: string) {
        return [...state.actionsByKey.values()].filter((a) => a.caseId === caseId);
      },
    },
  };
  return { run: (fn) => fn(repos) };
}

let sequence = 0;
function service(state: State) {
  sequence = 0;
  const coreUow = createCoreUow(state);
  const resolutionUow = createResolutionUow(state);
  return createResolutionService({
    uow: resolutionUow,
    reconcileSeller: createReconciliationService(coreUow),
    clock,
    ids: { case: () => `case_${++sequence}`, action: () => `action_${++sequence}` },
  });
}

function paginated(...pages: ProviderPage[]) {
  let call = 0;
  return async () => ok(pages[Math.min(call++, pages.length - 1)] as ProviderPage);
}

describe("detectResolutionCases", () => {
  it("creates one case per discrepancy kind and is idempotent under repeated detection", async () => {
    const state = createState();
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({
        data: [record("pay_missing", 2500), record("pay_mismatch", 2600)],
        nextCursor: null,
      }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    state.ledger.push({
      runId: RUN,
      sellerId: SELLER_ID,
      accountSide: "seller",
      amount: { amountMinor: 2500, currency: "USD" },
      kind: "payment",
      resourceType: "payment",
      resourceId: "pay_mismatch",
      effectKey: (await import("../../src/effects")).effectKey(
        "payment",
        "pay_mismatch",
        "succeeded",
      ),
      occurredAt: now,
    });
    const first = value(
      await svc.detectResolutionCases({ sellerId: SELLER_ID, provider, provenance: "mock" }),
    );
    expect(first.map((c) => c.kind).sort()).toEqual(["amount_mismatch", "missing_local_payment"]);
    const second = value(
      await svc.detectResolutionCases({ sellerId: SELLER_ID, provider, provenance: "mock" }),
    );
    expect(second.map((c) => c.id).sort()).toEqual(first.map((c) => c.id).sort());
    expect(state.cases.size).toBe(2);
  });

  it("maps a local transfer the provider does not confirm to unconfirmed_transfer", async () => {
    const state = createState();
    state.ledger.push({
      runId: RUN,
      sellerId: SELLER_ID,
      accountSide: "seller",
      amount: { amountMinor: 900, currency: "USD" },
      kind: "transfer",
      resourceType: "transfer",
      resourceId: "tsf_pending_local",
      effectKey: "transfer:tsf_pending_local:completed" as never,
      occurredAt: now,
    });
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({ data: [], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    const cases = value(
      await svc.detectResolutionCases({ sellerId: SELLER_ID, provider, provenance: "sandbox" }),
    );
    expect(cases).toMatchObject([
      { kind: "unconfirmed_transfer", providerResourceId: "tsf_pending_local" },
    ]);
    expect(cases[0]?.provenance).toBe("sandbox");
  });

  it("still detects payment discrepancies when the provider cannot list transfers", async () => {
    const state = createState();
    state.ledger.push({
      runId: RUN,
      sellerId: SELLER_ID,
      accountSide: "seller",
      amount: { amountMinor: 900, currency: "USD" },
      kind: "transfer",
      resourceType: "transfer",
      resourceId: "tsf_local_only",
      effectKey: "transfer:tsf_local_only:completed" as never,
      occurredAt: now,
    });
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({
        data: [
          {
            id: "pay_unposted",
            accountId: ACCOUNT_ID,
            amount: { amountMinor: 2500, currency: "USD" },
            status: "succeeded",
          },
        ],
        nextCursor: null,
      }),
      listTransfers: async () => ({
        ok: false as const,
        error: { kind: "invalid_request" as const },
      }),
    };
    const cases = value(
      await svc.detectResolutionCases({ sellerId: SELLER_ID, provider, provenance: "sandbox" }),
    );
    // The payment side is reported; the local transfer is neither confirmed nor flagged.
    expect(cases.map((c) => c.kind)).toEqual(["missing_local_payment"]);
  });

  it("carries the simulated flag only when the caller requests it", async () => {
    const state = createState();
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({ data: [record("pay_x", 100)], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    const cases = value(
      await svc.detectResolutionCases({
        sellerId: SELLER_ID,
        provider,
        provenance: "mock",
        simulated: true,
      }),
    );
    expect(cases[0]?.simulated).toBe(true);
  });
});

describe("allowedActionsFor", () => {
  it("never allows import or resend for amount_mismatch or unconfirmed_transfer", () => {
    expect(allowedActionsFor("amount_mismatch")).not.toContain("import_confirmed");
    expect(allowedActionsFor("unconfirmed_transfer")).not.toContain("import_confirmed");
    expect(allowedActionsFor("amount_mismatch")).toEqual([
      "refetch",
      "recheck",
      "escalate",
      "note",
    ]);
    expect(allowedActionsFor("unconfirmed_transfer")).toEqual([
      "refetch",
      "recheck",
      "escalate",
      "note",
    ]);
  });
});

function openCase(state: State, overrides: Partial<ResolutionCase> = {}): ResolutionCase {
  const kase: ResolutionCase = {
    id: "case_fixture",
    kind: "missing_local_payment",
    status: "detected",
    sellerId: SELLER_ID,
    orderId: null,
    providerResourceType: "payment",
    providerResourceId: "pay_missing",
    expected: { amountMinor: 2500, currency: "USD" },
    observed: null,
    impact: "fixture",
    nextSafeAction: "refetch",
    assignedTo: null,
    provenance: "mock",
    simulated: false,
    openedAt: now,
    updatedAt: now,
    resolvedAt: null,
    correlationId: null,
    ...overrides,
  };
  state.cases.set(kase.id, kase);
  state.casesByResource.set(`${kase.kind}:${kase.providerResourceId}`, kase.id);
  return kase;
}

describe("runAction: import_confirmed", () => {
  it("rejects import for a kind other than missing_local_payment", async () => {
    const state = createState();
    openCase(state, { kind: "amount_mismatch", providerResourceId: "pay_mismatch" });
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({ data: [], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    const result = await svc.runAction(provider, {
      caseId: "case_fixture",
      action: "import_confirmed",
      idempotencyKey: "k1",
      actorUserId: "operator_1",
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "action_not_allowed",
        action: "import_confirmed",
        caseKind: "amount_mismatch",
      },
    });
  });

  it("posts the ledger exactly once even when the action is retried with the same key", async () => {
    const state = createState();
    openCase(state);
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({ data: [record("pay_missing", 2500)], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    const input = {
      caseId: "case_fixture",
      action: "import_confirmed" as const,
      idempotencyKey: "import_1",
      actorUserId: "operator_1",
    };
    const first = value(await svc.runAction(provider, input));
    expect(first.action.outcome).toBe("succeeded");
    expect(first.case.status).toBe("rechecking");
    expect(state.ledger).toHaveLength(2);
    const second = value(await svc.runAction(provider, input));
    expect(second.action.id).toBe(first.action.id);
    expect(state.ledger).toHaveLength(2);
  });

  it("does not double-post when a webhook for the same payment arrives after the import", async () => {
    const state = createState();
    openCase(state);
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({ data: [record("pay_missing", 2500)], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    value(
      await svc.runAction(provider, {
        caseId: "case_fixture",
        action: "import_confirmed",
        idempotencyKey: "import_1",
        actorUserId: "operator_1",
      }),
    );
    expect(state.ledger).toHaveLength(2);
    // A later payment.succeeded webhook for the same resource computes the identical
    // effectKey and finds it already applied, so it posts nothing further.
    const { effectKey } = await import("../../src/effects");
    const key = effectKey("payment", "pay_missing", "succeeded");
    expect(state.effects.has(key)).toBe(true);
    const applied = await createCoreUow(state).run((r) =>
      r.effects.insert(
        {
          key,
          deliveryId: "webhook_after" as never,
          resourceType: "payment",
          resourceId: "pay_missing",
          transition: "succeeded",
        },
        now,
      ),
    );
    expect(applied).toBe(false);
    expect(state.ledger).toHaveLength(2);
  });

  it("leaves the case untouched when the provider has not confirmed the payment yet", async () => {
    const state = createState();
    openCase(state);
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({ data: [record("pay_missing", 2500, "pending")], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    const result = value(
      await svc.runAction(provider, {
        caseId: "case_fixture",
        action: "import_confirmed",
        idempotencyKey: "import_pending",
        actorUserId: "operator_1",
      }),
    );
    expect(result.action.outcome).toBe("no_change");
    expect(result.case.status).toBe("detected");
    expect(state.ledger).toHaveLength(0);
  });
});

describe("runAction: concurrency and uncertainty", () => {
  it("two concurrent calls with the same idempotency key yield exactly one action row", async () => {
    const state = createState();
    openCase(state, { kind: "amount_mismatch", providerResourceId: "pay_mismatch" });
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({ data: [], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    const input = {
      caseId: "case_fixture",
      action: "note" as const,
      idempotencyKey: "same_key",
      actorUserId: "operator_1",
      note: "checked in",
    };
    const [a, b] = await Promise.all([
      svc.runAction(provider, input),
      svc.runAction(provider, input),
    ]);
    expect(value(a).action.id).toBe(value(b).action.id);
    expect(state.actionsByKey.size).toBe(1);
  });

  it("an inconclusive provider scan leaves case status unchanged with outcome uncertain", async () => {
    const state = createState();
    openCase(state);
    const svc = service(state);
    // Every page reports a next cursor with no data, so the bounded scan never resolves --
    // the same page_limit condition reconcileSeller itself treats as inconclusive.
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: async () => ok({ data: [], nextCursor: "always_more" }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    const result = value(
      await svc.runAction(provider, {
        caseId: "case_fixture",
        action: "refetch",
        idempotencyKey: "refetch_1",
        actorUserId: "operator_1",
        maxPages: 2,
      }),
    );
    expect(result.action.outcome).toBe("uncertain");
    expect(result.case.status).toBe("detected");
  });
});

describe("runAction: recheck and resolve", () => {
  it("records actual imported ledger gross and provider amounts while preserving detection evidence", async () => {
    const state = createState();
    const original = openCase(state, {
      expected: null,
      observed: { amountMinor: 2400, currency: "USD" },
    });
    const svc = service(state);
    const provider = {
      listPayments: paginated({ data: [record("pay_missing", 2500)], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    value(
      await svc.runAction(provider, {
        caseId: original.id,
        action: "import_confirmed",
        idempotencyKey: "import_projection",
        actorUserId: "operator_1",
      }),
    );
    expect(state.ledger.map((entry) => entry.amount.amountMinor)).toEqual([2300, 200]);
    const result = value(
      await svc.runAction(provider, {
        caseId: original.id,
        action: "recheck",
        idempotencyKey: "recheck_projection",
        actorUserId: "operator_1",
      }),
    );
    expect(result.case.status).toBe("resolved");
    expect(result.case.expected).toBeNull();
    expect(result.action.detail).toMatchObject({
      currentAmounts: {
        local: { amountMinor: 2500, currency: "USD" },
        provider: { amountMinor: 2500, currency: "USD" },
        matches: true,
      },
    });
  });

  it("keeps a missing-payment case open when import reveals a different local amount", async () => {
    const state = createState();
    openCase(state);
    state.ledger.push({
      runId: RUN,
      sellerId: SELLER_ID,
      accountSide: "seller",
      amount: { amountMinor: 2300, currency: "USD" },
      kind: "payment",
      resourceType: "payment",
      resourceId: "pay_missing",
      effectKey: "payment:pay_missing:succeeded" as never,
      occurredAt: now,
    });
    const svc = service(state);
    const result = value(
      await svc.runAction(
        {
          listPayments: paginated({ data: [record("pay_missing", 2500)], nextCursor: null }),
          listTransfers: paginated({ data: [], nextCursor: null }),
        },
        {
          caseId: "case_fixture",
          action: "recheck",
          idempotencyKey: "wrong_amount",
          actorUserId: "operator_1",
        },
      ),
    );
    expect(result.case.status).toBe("investigating");
    expect(result.action.action).toBe("recheck");
    expect(result.action.detail).toMatchObject({
      currentAmounts: {
        local: { amountMinor: 2300, currency: "USD" },
        provider: { amountMinor: 2500, currency: "USD" },
        matches: false,
      },
    });
  });

  it.each(["pending", "reserve", "failed", "absent"] as const)(
    "does not resolve a missing-payment case with provider status %s",
    async (status) => {
      const state = createState();
      openCase(state);
      state.ledger.push({
        runId: RUN,
        sellerId: SELLER_ID,
        accountSide: "seller",
        amount: { amountMinor: 2500, currency: "USD" },
        kind: "payment",
        resourceType: "payment",
        resourceId: "pay_missing",
        effectKey: "payment:pay_missing:succeeded" as never,
        occurredAt: now,
      });
      const result = value(
        await service(state).runAction(
          {
            listPayments: paginated({
              data: status === "absent" ? [] : [record("pay_missing", 2500, status)],
              nextCursor: null,
            }),
            listTransfers: paginated({ data: [], nextCursor: null }),
          },
          {
            caseId: "case_fixture",
            action: "recheck",
            idempotencyKey: "unconfirmed",
            actorUserId: "operator_1",
          },
        ),
      );
      expect(result.case.status).toBe("investigating");
      expect(result.action.action).toBe("recheck");
      expect(result.action.outcome).toBe("no_change");
    },
  );

  it("does not count a concurrent import that happened after the recheck ledger snapshot", async () => {
    const state = createState();
    openCase(state);
    const svc = service(state);
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const pendingRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const canReturn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = {
      listPayments: paginated({ data: [record("pay_missing", 2500)], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    const checking = svc.runAction(
      {
        ...provider,
        listPayments: async () => {
          entered();
          await canReturn;
          return provider.listPayments();
        },
      },
      {
        caseId: "case_fixture",
        action: "recheck",
        idempotencyKey: "before_import",
        actorUserId: "operator_1",
      },
    );
    await pendingRead;
    value(
      await svc.runAction(provider, {
        caseId: "case_fixture",
        action: "import_confirmed",
        idempotencyKey: "concurrent_import",
        actorUserId: "operator_1",
      }),
    );
    release();
    const first = value(await checking);
    expect(first.case.status).toBe("investigating");
    expect(first.action.detail).toMatchObject({ currentAmounts: { local: null, matches: false } });
    const second = value(
      await svc.runAction(provider, {
        caseId: "case_fixture",
        action: "recheck",
        idempotencyKey: "after_import",
        actorUserId: "operator_1",
      }),
    );
    expect(second.case.status).toBe("resolved");
    expect(second.action.detail).toMatchObject({
      currentAmounts: { local: { amountMinor: 2500, currency: "USD" }, matches: true },
    });
    expect(state.ledger).toHaveLength(2);
  });

  it("resolves only after a recheck confirms the discrepancy is gone, storing the action as resolve", async () => {
    const state = createState();
    openCase(state);
    const svc = service(state);
    // Once the payment shows up locally too, reconcileSeller's own logic no longer reports
    // it as missing -- this is the fresh evidence recheck depends on, not a status flip on
    // the click itself.
    state.ledger.push({
      runId: RUN,
      sellerId: SELLER_ID,
      accountSide: "seller",
      amount: { amountMinor: 2500, currency: "USD" },
      kind: "payment",
      resourceType: "payment",
      resourceId: "pay_missing",
      effectKey: "payment:pay_missing:succeeded" as never,
      occurredAt: now,
    });
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({ data: [record("pay_missing", 2500)], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    const result = value(
      await svc.runAction(provider, {
        caseId: "case_fixture",
        action: "recheck",
        idempotencyKey: "recheck_1",
        actorUserId: "operator_1",
      }),
    );
    expect(result.action.action).toBe("resolve");
    expect(result.action.outcome).toBe("succeeded");
    expect(result.case.status).toBe("resolved");
    expect(result.case.resolvedAt).not.toBeNull();
  });

  it("a recheck that still finds the discrepancy stores a plain recheck row and does not resolve", async () => {
    const state = createState();
    openCase(state);
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({ data: [record("pay_missing", 2500)], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    const result = value(
      await svc.runAction(provider, {
        caseId: "case_fixture",
        action: "recheck",
        idempotencyKey: "recheck_2",
        actorUserId: "operator_1",
      }),
    );
    expect(result.action.action).toBe("recheck");
    expect(result.action.outcome).toBe("no_change");
    expect(result.case.status).toBe("investigating");
  });
});

describe("runAction: amount_mismatch never auto-balances", () => {
  it("has no action that writes to the ledger for an amount_mismatch case", async () => {
    const state = createState();
    openCase(state, { kind: "amount_mismatch", providerResourceId: "pay_mismatch" });
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({ data: [record("pay_mismatch", 2600)], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    for (const action of allowedActionsFor("amount_mismatch")) {
      await svc.runAction(provider, {
        caseId: "case_fixture",
        action,
        idempotencyKey: `mismatch_${action}`,
        actorUserId: "operator_1",
      });
    }
    expect(state.ledger).toHaveLength(0);
  });
});

describe("runAction: escalate and note", () => {
  it("escalate assigns the operator and sets status escalated", async () => {
    const state = createState();
    openCase(state);
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({ data: [], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    const result = value(
      await svc.runAction(provider, {
        caseId: "case_fixture",
        action: "escalate",
        idempotencyKey: "escalate_1",
        actorUserId: "operator_9",
      }),
    );
    expect(result.case.status).toBe("escalated");
    expect(result.case.assignedTo).toBe("operator_9");
  });

  it("note records the operator's text without changing status", async () => {
    const state = createState();
    openCase(state);
    const svc = service(state);
    const provider: Pick<ReconciliationProvider, "listPayments" | "listTransfers"> = {
      listPayments: paginated({ data: [], nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
    };
    const result = value(
      await svc.runAction(provider, {
        caseId: "case_fixture",
        action: "note",
        idempotencyKey: "note_1",
        actorUserId: "operator_1",
        note: "waiting on seller reply",
      }),
    );
    expect(result.action.detail).toEqual({ note: "waiting on seller reply" });
    expect(result.case.status).toBe("detected");
  });
});

describe("injectSimulatedFault", () => {
  it("is rejected without demo mode", async () => {
    const state = createState();
    const result = await injectSimulatedFault(
      {
        uow: createResolutionUow(state),
        provider: {
          listPayments: paginated({ data: [record("pay_demo", 500)], nextCursor: null }),
          listTransfers: paginated({ data: [], nextCursor: null }),
        },
        clock,
        ids: { case: () => "case_demo" },
        demoMode: false,
      },
      { sellerId: SELLER_ID, paymentId: "pay_demo", provenance: "mock" },
    );
    expect(result).toEqual({ ok: false, error: { kind: "demo_mode_required" } });
  });

  it("opens a labeled simulated case without ever posting the withheld ledger effect", async () => {
    const state = createState();
    const result = value(
      await injectSimulatedFault(
        {
          uow: createResolutionUow(state),
          provider: {
            listPayments: paginated({ data: [record("pay_demo", 500)], nextCursor: null }),
            listTransfers: paginated({ data: [], nextCursor: null }),
          },
          clock,
          ids: { case: () => "case_demo" },
          demoMode: true,
        },
        { sellerId: SELLER_ID, paymentId: "pay_demo", provenance: "mock" },
      ),
    );
    expect(result.simulated).toBe(true);
    expect(result.kind).toBe("missing_local_payment");
    expect(state.ledger).toHaveLength(0);
  });

  it("refuses to simulate a fault for a payment the provider does not actually confirm", async () => {
    const state = createState();
    const result = await injectSimulatedFault(
      {
        uow: createResolutionUow(state),
        provider: {
          listPayments: paginated({ data: [record("pay_demo", 500, "pending")], nextCursor: null }),
          listTransfers: paginated({ data: [], nextCursor: null }),
        },
        clock,
        ids: { case: () => "case_demo" },
        demoMode: true,
      },
      { sellerId: SELLER_ID, paymentId: "pay_demo", provenance: "mock" },
    );
    expect(result).toEqual({ ok: false, error: { kind: "payment_not_confirmed" } });
  });
});

describe("repeatable demo faults", () => {
  function setup() {
    const state = createState();
    let sequence = 0;
    const records = [record("pay_existing", 2500)];
    const seeded: string[] = [];
    const provider = {
      listPayments: async () => ok({ data: records, nextCursor: null }),
      listTransfers: paginated({ data: [], nextCursor: null }),
      seedDemoPayment: async (accountId: typeof ACCOUNT_ID, key: string) => {
        expect(accountId).toBe(ACCOUNT_ID);
        const id = value(whopPaymentId(`pay_mock_${key}`));
        seeded.push(key);
        if (!records.some((item) => item.id === id)) records.push(record(id, 2500));
        return ok({ id, raw: {} });
      },
    };
    const deps = {
      uow: createResolutionUow(state),
      provider,
      clock,
      ids: { case: () => `case_${++sequence}`, action: () => `action_${++sequence}` },
      demoMode: true,
    };
    return { state, deps, seeded };
  }

  it("rejects a resolved upsert result without reopening it or changing history or ledger", async () => {
    const { state, deps } = setup();
    const input = { sellerId: SELLER_ID, paymentId: "pay_existing", provenance: "mock" };
    const first = value(await injectSimulatedFault(deps, input));
    await deps.uow.run((r) =>
      r.cases.update(first.id, { status: "resolved", resolvedAt: now }, now),
    );
    const before = structuredClone(state);
    expect(await injectSimulatedFault(deps, input)).toEqual({
      ok: false,
      error: { kind: "case_resolved", caseId: first.id },
    });
    expect(state).toEqual(before);
  });

  it("retries one run without another case and seeds a separate payment for a new run", async () => {
    const { state, deps, seeded } = setup();
    const input = { sellerId: SELLER_ID, provenance: "sandbox", runId: "run_first" };
    const first = value(await injectSimulatedFault(deps, input));
    const retry = value(await injectSimulatedFault(deps, input));
    expect(retry.id).toBe(first.id);
    expect(first.providerResourceId).toBe("pay_mock_run_first");
    expect(first.provenance).toBe("mock");
    await deps.uow.run((r) =>
      r.cases.update(first.id, { status: "resolved", resolvedAt: now }, now),
    );
    expect(await injectSimulatedFault(deps, input)).toEqual({
      ok: false,
      error: { kind: "case_resolved", caseId: first.id },
    });
    const next = value(
      await injectSimulatedFault(deps, {
        ...input,
        runId: "run_second",
        fresh: true,
        paymentId: "pay_existing",
      }),
    );
    expect(next.providerResourceId).toBe("pay_mock_run_second");
    expect(next.id).not.toBe(first.id);
    expect(state.cases.size).toBe(2);
    expect(state.actionsByKey.size).toBe(2);
    expect(state.ledger).toEqual([]);
    expect(seeded).toEqual(["run_first", "run_first", "run_first", "run_second"]);
  });

  it("requires an explicit payment without a seeder", async () => {
    const { deps, state } = setup();
    const { seedDemoPayment: _, ...provider } = deps.provider;
    const result = await injectSimulatedFault(
      { ...deps, provider },
      { sellerId: SELLER_ID, provenance: "mock", runId: "run_first" },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "payment_required", message: expect.any(String) },
    });
    expect(state.cases.size).toBe(0);
  });

  it.each([undefined, "invalid", "run_"])(
    "rejects invalid fresh run %s before seeding",
    async (runId) => {
      const { deps, seeded } = setup();
      expect(
        await injectSimulatedFault(deps, {
          sellerId: SELLER_ID,
          provenance: "mock",
          ...(runId === undefined ? {} : { runId }),
        }),
      ).toMatchObject({
        ok: false,
        error: { kind: "run_required" },
      });
      expect(seeded).toEqual([]);
    },
  );
});
