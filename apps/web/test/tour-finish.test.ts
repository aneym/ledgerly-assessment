import { describe, expect, it } from "vitest";
import { createTourFinishHandler, type TourFinishDeps } from "@/lib/tour-finish";

const identity = {
  userId: "user_1",
  demoRunId: "run_owned",
  email: "demo-buyer+run_owned@ledgerly.test",
  expiresAt: new Date("2026-09-10T00:00:00Z"),
};
function deps(over: Partial<TourFinishDeps> = {}): TourFinishDeps {
  return {
    enabled: () => true,
    identity: async () => identity,
    listEvents: async () => [],
    allowlist: { paths: ["/deck"] },
    now: () => new Date("2026-09-09T00:00:00Z"),
    ...over,
  };
}
function request(query = "", headers: Record<string, string> = {}) {
  return new Request(`https://example.invalid/demo/finish?return=/deck&run=run_owned${query}`, {
    headers,
  });
}
describe("persisted tour finish authorization", () => {
  it("returns partial rather than trusting client completed/skipped metadata", async () => {
    const result = await createTourFinishHandler(deps())(
      request("&completed=true&skipped=C01,C02,C03,C04,C05,C06,C07"),
    );
    expect(result.status).toBe(303);
    expect(result.headers.get("location")).toContain("demo=partial");
  });
  it("lets matching buyer and seller profiles leave an incomplete run honestly", async () => {
    for (const profile of ["buyer", "seller", "operator"]) {
      const result = await createTourFinishHandler(
        deps({
          identity: async () => ({ ...identity, email: `demo-${profile}+run_owned@ledgerly.test` }),
        }),
        true,
      )(request());
      expect(result.status).toBe(303);
      expect(result.headers.get("location")).toContain("demo=skipped");
    }
  });
  it.each([
    { email: "demo-operator+run_foreign@ledgerly.test" },
    { email: "real-operator@example.com" },
    { expiresAt: new Date("2026-09-08T00:00:00Z") },
  ])("rejects foreign, ordinary and expired identities %j", async (over) => {
    const result = await createTourFinishHandler(
      deps({ identity: async () => ({ ...identity, ...over }) }),
    )(request());
    expect([401, 403]).toContain(result.status);
    expect(result.headers.get("location")).toBeNull();
  });
  it("rejects missing sessions and disabled demo mode", async () => {
    expect(
      (await createTourFinishHandler(deps({ identity: async () => null }))(request())).status,
    ).toBe(401);
    expect((await createTourFinishHandler(deps({ enabled: () => false }))(request())).status).toBe(
      404,
    );
  });
  it.each([
    { cookie: "ledgerly_demo_run=run_foreign" },
    { "x-demo-run": "run_foreign" },
    { cookie: "ledgerly_demo_run=%XX" },
  ])("rejects conflicting run input %j", async (headers) => {
    expect(
      (
        await createTourFinishHandler(deps())(
          request(
            "",
            Object.fromEntries(
              Object.entries(headers).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            ),
          ),
        )
      ).status,
    ).toBe(403);
  });
  it("rejects unapproved return targets", async () => {
    const result = await createTourFinishHandler(deps())(
      new Request("https://example.invalid/demo/finish?run=run_owned&return=https://evil.invalid"),
    );
    expect(result.status).toBe(400);
  });
});

import { classifyTourRoute, projectTourResponse } from "@/lib/tour-response-proof";
import {
  mapTourInstrumentation,
  type PersistedInstrumentationRow,
} from "../../../packages/demo-runtime/src/instrumentation";

import { reduceTour } from "../../../packages/demo-runtime/src/tour";

async function completedHistory(): Promise<PersistedInstrumentationRow[]> {
  const rows: PersistedInstrumentationRow[] = [];
  async function call(
    method: string,
    path: string,
    body: unknown,
    support: { db?: string; provider?: string } = {},
  ) {
    const correlationId = `corr_${rows.length}`;
    const append = (extra: Partial<PersistedInstrumentationRow>) =>
      rows.push({
        id: `evt_${rows.length}`,
        seq: rows.length + 1,
        correlationId,
        runId: "run_owned",
        source: "app_api",
        phase: "end",
        method,
        path,
        status: 200,
        provenance: "app",
        safeIds: {},
        summary: "Observed operation",
        at: "2026-09-09T00:00:00Z",
        ...extra,
      });
    if (support.db) append({ source: "db", path: support.db, status: "ok", provenance: "pglite" });
    if (support.provider) append({ source: "whop", path: support.provider, provenance: "mock" });
    append({
      safeIds: {
        ...(await projectTourResponse(method, path, Response.json(body))),
        tour_step: classifyTourRoute(method, path) ?? "",
      },
    });
  }
  await call(
    "POST",
    "/api/sellers",
    { id: "seller_1", provenance: "mock" },
    { db: "sellers", provider: "/accounts" },
  );
  await call("POST", "/api/sellers/seller_1/onboarding-link", {}, { provider: "/account_links" });
  await call("POST", "/api/products", { id: "product_1", seller_id: "seller_1" });
  await call(
    "POST",
    "/api/checkouts",
    { order_id: "order_1" },
    { db: "orders", provider: "/checkout_configurations" },
  );
  await call("GET", "/api/orders/order_1", {
    id: "order_1",
    seller: { id: "seller_1" },
    product: { id: "product_1" },
    status: "paid",
    payment_id: "pay_1",
  });
  await call("GET", "/api/sellers/seller_1/earnings", {
    rows: [
      {
        item: "payment",
        status: "settled",
        provider_resource_id: "pay_1",
        gross: { currency: "USD", amountMinor: 1000 },
        fee: { currency: "USD", amountMinor: 80 },
        net: { currency: "USD", amountMinor: 920 },
      },
    ],
  });
  await call("POST", "/api/sellers/seller_1/payouts/simulation", {
    source: "mock",
    kind: "ready",
    payouts: [],
  });
  await call("POST", "/api/sellers/seller_1/payouts/simulation", {
    source: "mock",
    kind: "ready",
    payouts: [
      { id: "wdrl_mock_1", status: "requested", amount: { currency: "USD", amountMinor: 1000 } },
    ],
  });
  const issue = {
    id: "case_1",
    seller: { id: "seller_1" },
    provenance: "mock",
    subject: { provider_resource_id: "pay_fault" },
  };
  await call("POST", "/api/admin/issues/demo-fault", issue);
  await call("POST", "/api/admin/issues/case_1/actions/refetch", {
    ...issue,
    history: [{ action: "refetch", outcome: "succeeded" }],
  });
  await call("POST", "/api/admin/issues/case_1/actions/import_confirmed", {
    ...issue,
    history: [{ action: "import_confirmed", outcome: "succeeded" }],
  });
  await call(
    "POST",
    "/api/admin/issues/case_1/actions/recheck",
    {
      ...issue,
      status: "resolved",
      amounts: {
        local: { currency: "USD", amountMinor: 1000 },
        provider: { currency: "USD", amountMinor: 1000 },
      },
      history: [{ action: "resolve", outcome: "succeeded" }],
    },
    { db: "resolution_run" },
  );
  return rows;
}

describe("persisted tour finish replay", () => {
  it("completes only the real classified response chain and preserves pagination", async () => {
    const history = await completedHistory();
    const fillers = Array.from(
      { length: 500 },
      (_, i): PersistedInstrumentationRow => ({
        id: `filler_${i}`,
        seq: i + 1,
        correlationId: `ignored_${i}`,
        runId: "run_owned",
        source: "app_api",
        phase: "end",
        path: "/api/unrelated",
        method: "GET",
        status: 200,
        provenance: "app",
        safeIds: {},
        summary: "Unrelated read",
        at: "2026-09-09T00:00:00Z",
      }),
    );
    const all = [...fillers, ...history.map((row) => ({ ...row, seq: row.seq + 500 }))];
    const pages: number[] = [];
    const response = await createTourFinishHandler(
      deps({
        listEvents: async ({ afterSeq, limit }) => {
          pages.push(afterSeq);
          return all.filter((row) => row.seq > afterSeq).slice(0, limit);
        },
      }),
    )(request());
    expect(response.headers.get("location")).toContain("demo=completed");
    expect(pages).toEqual([0, 500]);
  });
  it("does not complete missing or failed steps", async () => {
    const history = await completedHistory();
    for (const rows of [
      history.filter((row) => row.safeIds?.tour_step !== "C04"),
      history.map((row) => (row.path.endsWith("/recheck") ? { ...row, status: 500 } : row)),
    ]) {
      const response = await createTourFinishHandler(deps({ listEvents: async () => rows }))(
        request(),
      );
      expect(response.headers.get("location")).not.toContain("demo=completed");
    }
  });
  it("rejects foreign, nonmonotonic and wrongly classified persisted rows", async () => {
    const history = await completedHistory();
    if (!history[0] || !history[2]) throw new Error("Missing fixture rows");
    for (const rows of [
      [{ ...history[0], runId: "run_foreign" }],
      [{ ...history[0], seq: 0 }],
      [{ ...history[2], safeIds: { tour_step: "C07" } }],
    ]) {
      expect(
        (await createTourFinishHandler(deps({ listEvents: async () => rows }))(request())).status,
      ).toBe(503);
    }
  });
  it("does not combine a correlation reused across chapters", async () => {
    const rows = (await completedHistory()).map((row) => ({
      ...row,
      correlationId: "forged_shared",
    }));
    const response = await createTourFinishHandler(deps({ listEvents: async () => rows }))(
      request(),
    );
    expect(response.headers.get("location")).not.toContain("demo=completed");
  });
  it("rejects a truncated or unavailable history instead of calling it complete", async () => {
    const history = await completedHistory();
    if (!history[0]) throw new Error("Missing fixture row");
    const first = history[0];
    const rows = Array.from({ length: 501 }, (_, i) => ({ ...first, seq: i + 1 }));
    expect(
      (await createTourFinishHandler(deps({ listEvents: async () => rows }))(request())).status,
    ).toBe(503);
    expect(
      (
        await createTourFinishHandler(
          deps({
            listEvents: async () => {
              throw new Error("unavailable");
            },
          }),
        )(request())
      ).status,
    ).toBe(503);
  });
});

describe("persisted retry recovery", () => {
  it("completes a 503 then evidenced seller retry without client boundaries", async () => {
    const clean = await completedHistory();
    const failed = {
      ...required(clean[2]),
      id: "failed",
      correlationId: "failed_attempt",
      status: 503,
      safeIds: { tour_step: "C01" },
    };
    const rows = [failed, ...clean].map((row, i) => ({ ...row, seq: i + 1 }));
    const before = JSON.stringify(rows);
    const events = mapTourInstrumentation(rows, "run_owned");
    expect(reduceTour(events).steps.map((step) => step.status)).toEqual(Array(7).fill("passed"));
    expect(reduceTour(events, undefined, { retryAfter: { C01: 1 } }).outcome).toBe("completed");
    const response = await createTourFinishHandler(deps({ listEvents: async () => rows }))(
      request(),
    );
    expect(response.headers.get("location")).toBe(
      "/deck?demo=completed&run=run_owned#closing-completed",
    );
    expect(JSON.stringify(rows)).toBe(before);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing test fixture value");
  return value;
}

function ordered(rows: PersistedInstrumentationRow[]): PersistedInstrumentationRow[] {
  return rows.map((row, i) => ({ ...row, seq: i + 1 }));
}
function failedRequest(row: PersistedInstrumentationRow): PersistedInstrumentationRow {
  return {
    ...row,
    id: `failed_${row.id}`,
    correlationId: `failed_${row.correlationId}`,
    status: 503,
    safeIds: { tour_step: row.safeIds?.tour_step ?? "" },
  };
}
async function finishRows(rows: PersistedInstrumentationRow[], query = "") {
  return createTourFinishHandler(
    deps({
      listEvents: async ({ afterSeq, limit }) =>
        rows.filter((row) => row.seq > afterSeq).slice(0, limit),
    }),
  )(request(query));
}

describe("retry evidence boundaries", () => {
  it("recovers failures at every chapter operation using the subsequent real response chain", async () => {
    const history = await completedHistory();
    for (const response of history.filter((row) => row.source === "app_api")) {
      const index = history.findIndex((row) => row.correlationId === response.correlationId);
      const rows = ordered([
        ...history.slice(0, index),
        failedRequest(response),
        ...history.slice(index),
      ]);
      const result = await finishRows(rows);
      expect(result.headers.get("location"), response.path).toContain("demo=completed");
      expect(
        reduceTour(mapTourInstrumentation(rows, "run_owned"), undefined, {
          retryAfter: { [required(required(response.safeIds).tour_step)]: index + 1 },
        }).outcome,
        response.path,
      ).toBe("completed");
    }
  });
  it("requires fresh correlated DB and provider success after a seller failure", async () => {
    const history = await completedHistory();
    const seller = required(history.find((row) => row.path === "/api/sellers"));
    for (const support of [
      [],
      [required(history[0])],
      [required(history[1])],
      [required(history[0]), { ...required(history[1]), status: 503 }],
      [required(history[0]), { ...required(history[1]), status: null }],
      [{ ...required(history[0]), status: "error" as const }, required(history[1])],
    ]) {
      const rows = ordered([
        ...history,
        failedRequest(seller),
        ...support.map((row) => ({ ...row, correlationId: "retry" })),
        { ...seller, correlationId: "retry" },
      ]);
      expect(
        (
          await finishRows(
            rows,
            "&completed=true&outcome=completed&retryAfter[C01]=999999&skipped=C01",
          )
        ).headers.get("location"),
      ).toContain("demo=partial");
    }
  });
  it("recovers persisted provider and DB failures only with fresh successful effects", async () => {
    const history = await completedHistory();
    for (const failed of [
      { ...required(history[0]), status: "error" as const },
      { ...required(history[1]), status: 503 },
    ]) {
      const failedAttempt = [failed, failedRequest(required(history[2]))].map((row) => ({
        ...row,
        correlationId: "failed_attempt",
      }));
      const rows = ordered([...failedAttempt, ...history]);
      expect((await finishRows(rows)).headers.get("location")).toContain("demo=completed");
      const state = reduceTour(mapTourInstrumentation(rows, "run_owned"));
      if (failed.source === "whop")
        expect(
          required(state.steps[0]).proof.provider.some((item) => item.http_status === 503),
        ).toBe(true);
    }
  });
  it("retains late failures and rejects another response from the failed correlation", async () => {
    const history = await completedHistory();
    for (const response of history.filter((row) => row.source === "app_api")) {
      const failed = failedRequest(response);
      const retry = history
        .filter((row) => row.correlationId === response.correlationId)
        .map((row) => ({ ...row, correlationId: failed.correlationId }));
      for (const rows of [ordered([...history, failed]), ordered([...history, failed, ...retry])]) {
        expect((await finishRows(rows)).headers.get("location"), response.path).toContain(
          "demo=partial",
        );
      }
    }
  });
  it("does not recover from a foreign run or a response carrying another seller identity", async () => {
    const history = await completedHistory();
    const failed = failedRequest(required(history[2]));
    const retry = history.slice(0, 3).map((row) => ({ ...row, correlationId: "retry" }));
    const foreign = ordered([
      ...history,
      failed,
      ...retry.map((row) => ({ ...row, runId: "run_foreign" })),
    ]);
    expect((await finishRows(foreign)).status).toBe(503);
    expect(required(reduceTour(mapTourInstrumentation(foreign, "run_owned")).steps[0]).status).toBe(
      "failed",
    );
    const wrongSeller = ordered([
      ...history,
      failed,
      ...retry.map((row) =>
        row.source === "app_api"
          ? { ...row, safeIds: { ...row.safeIds, tour_seller_id: "seller_other" } }
          : row,
      ),
    ]);
    expect((await finishRows(wrongSeller)).headers.get("location")).toContain("demo=partial");
  });
  it("keeps C07 partial when a late recheck fails and the retry is unresolved", async () => {
    const history = await completedHistory();
    const recheck = required(history.at(-1));
    const retry = history.slice(-2).map((row) => ({
      ...row,
      correlationId: "recheck_retry",
      safeIds: { ...row.safeIds, tour_issue_resolved: "false", tour_terminal: "true" },
    }));
    const rows = ordered([...history, failedRequest(recheck), ...retry]);
    expect((await finishRows(rows)).headers.get("location")).toContain("demo=partial");
    expect(
      required(reduceTour(mapTourInstrumentation(rows, "run_owned")).steps[6]).proof.missing,
    ).toContain("confirmed resolved-case");
  });
  it("ignores client step.passed and arbitrary retry boundaries when a failure has no recovery", async () => {
    const history = await completedHistory();
    const rows = ordered([...history, failedRequest(required(history[2]))]);
    const events = mapTourInstrumentation(rows, "run_owned");
    events.push({
      ...required(events.at(-1)),
      seq: rows.length + 1,
      kind: "step.finished",
      state: "passed",
      request: null,
    });
    expect(reduceTour(events, undefined, { retryAfter: { C01: 999999 } }).outcome).not.toBe(
      "completed",
    );
    expect(
      (await finishRows(rows, "&completed=true&retryAfter=999999&skipped=C01")).headers.get(
        "location",
      ),
    ).toContain("demo=partial");
  });
});

describe("trusted finish identity binding", () => {
  it.each([undefined, "", "run_foreign"])(
    "rejects absent or conflicting verified run %s",
    async (demoRunId) => {
      const response = await createTourFinishHandler(
        deps({
          // Exercise legacy callers at the boundary as well as typed current sessions.
          identity: async () =>
            ({ ...identity, demoRunId }) as unknown as Awaited<
              ReturnType<TourFinishDeps["identity"]>
            >,
          listEvents: async () => {
            throw new Error("History must not be read without verified run binding");
          },
        }),
      )(request());
      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
    },
  );
});

import { fileURLToPath } from "node:url";
import { createCreateSellerHandler } from "@/app/api/sellers/route";
import { correlatedEmitter, instrumented, setInstrumentationEmitter } from "@/lib/instrument";
import { runId, sellerId, whopAccountId } from "../../../packages/core/src/ids";
import type { Emitter } from "../../../packages/core/src/instrumentation";
import { createOnboardingService } from "../../../packages/core/src/services/onboarding";
import { PGlite } from "../../../packages/db/node_modules/@electric-sql/pglite";
import { drizzle } from "../../../packages/db/node_modules/drizzle-orm/pglite";
import { migrate } from "../../../packages/db/node_modules/drizzle-orm/pglite/migrator";
import {
  createSellerIdentityLookup,
  createSellerLookup,
} from "../../../packages/db/src/repos/orders";
import { createPgliteUnitOfWork } from "../../../packages/db/src/repos/unit-of-work";
import { createWhopClient } from "../../../packages/whop/src/client";
import { createSandboxAdapter } from "../../../packages/whop/src/sandbox-adapter";

it("finishes an actual durable onboarding retry without repeating account creation", async () => {
  const client = new PGlite();
  const db = drizzle(client);
  const rows: PersistedInstrumentationRow[] = [];
  const emitter: Emitter = correlatedEmitter({
    emit: (event) => {
      rows.push({ ...event, id: `actual_${rows.length}`, seq: rows.length + 1 });
    },
  });
  setInstrumentationEmitter(emitter);
  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url)),
    });
    const run = runId("run_owned");
    const seller = sellerId("seller_1");
    const parent = whopAccountId("biz_platform");
    if (!run.ok || !seller.ok || !parent.ok) throw new Error("Invalid test identifiers");
    const calls: string[] = [];
    let linkFailed = false;
    const provider = createSandboxAdapter({
      parentAccountId: parent.value,
      client: createWhopClient({
        baseUrl: "https://provider.invalid/api/v1",
        apiKey: "fixture-only",
        apiVersionDate: "2026-08-21",
        onEvent: emitter.emit,
        fetch: async (url, init) => {
          const path = new URL(String(url)).pathname.replace("/api/v1", "");
          calls.push(`${init?.method} ${path}`);
          if (path === "/account_links") {
            if (!linkFailed) {
              linkFailed = true;
              return Response.json({ error: "fixture link failure" }, { status: 503 });
            }
            return Response.json({ url: "https://provider.invalid/onboarding" });
          }
          if (path === "/accounts" || path === "/accounts/biz_durable")
            return Response.json({ id: "biz_durable" });
          throw new Error(`Unexpected provider request ${path}`);
        },
      }),
    });
    const uow = createPgliteUnitOfWork(client, emitter);
    const onboardSeller = createOnboardingService({
      uow,
      provider,
      clock: { now: () => new Date() },
      ids: { seller: () => seller.value },
      apiVersionDate: "2026-08-21",
      returnUrl: "https://example.invalid/return",
      refreshUrl: "https://example.invalid/refresh",
    });
    const lookup = createSellerLookup(db);
    let attachFailed = false;
    const handler = instrumented(
      createCreateSellerHandler({
        getSession: async () => ({ userId: "user_1", role: "buyer" }),
        onboardSeller,
        attachSellerOwner: async () => {
          if (!attachFailed) {
            attachFailed = true;
            throw new Error("fixture owner attachment failure");
          }
        },
        setRole: async () => {},
        runId: () => run.value,
        getSeller: async () => lookup.get(seller.value),
        getAccount: provider.getAccount,
        getSellerByIdentity: createSellerIdentityLookup(db).getByIdentity,
        env: { WHOP_MODE: "sandbox" },
        getDisplayName: async () => null,
        setDisplayName: async () => {},
      }),
    );
    const send = (correlation: string) =>
      handler(
        new Request("https://example.invalid/api/sellers", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-demo-run": "run_owned",
            "x-ledgerly-correlation-id": correlation,
          },
          body: JSON.stringify({
            externalId: "alice",
            email: "alice@example.invalid",
            country: "US",
          }),
        }),
      );
    expect((await send("first_attempt")).status).toBe(500);
    expect((await lookup.get(seller.value))?.whopAccountId).toBe("biz_durable");
    const cutoff = rows.length;
    expect((await send("retry_attempt")).status).toBe(201);
    expect(calls).toEqual([
      "POST /accounts",
      "POST /account_links",
      "POST /account_links",
      "GET /accounts/biz_durable",
    ]);
    expect(
      rows
        .slice(cutoff)
        .some((row) => row.source === "whop" && row.path === "/accounts" && row.method === "POST"),
    ).toBe(false);
    const rest = (await completedHistory()).filter((row) => row.correlationId !== "corr_0");
    const complete = ordered([...rows, ...rest]);
    expect((await finishRows(complete)).headers.get("location")).toContain("demo=completed");
    for (const invalid of [
      complete.map((row) =>
        row.correlationId === "retry_attempt" && row.source === "app_api" && row.phase === "end"
          ? { ...row, safeIds: { ...row.safeIds, tour_seller_account_readback: "biz_foreign" } }
          : row,
      ),
      complete.filter(
        (row) =>
          !(row.correlationId === "retry_attempt" && row.source === "whop" && row.method === "GET"),
      ),
      complete.filter((row) => !(row.correlationId === "retry_attempt" && row.source === "db")),
      complete.map((row) =>
        row.source === "whop" && row.path === "/accounts"
          ? { ...row, correlationId: "unrelated_attempt" }
          : row,
      ),
    ]) {
      expect((await finishRows(ordered(invalid))).headers.get("location")).toContain(
        "demo=partial",
      );
    }
    // The same replay on the browser must agree after its presentation-only Retry boundary.
    expect(
      reduceTour(mapTourInstrumentation(complete, "run_owned"), undefined, {
        retryAfter: { C01: cutoff },
      }).outcome,
    ).toBe("completed");
  } finally {
    setInstrumentationEmitter({ emit() {} });
    await client.close();
  }
}, 30000);
