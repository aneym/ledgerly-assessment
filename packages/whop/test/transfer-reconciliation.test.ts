import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  createReconciliationProvider,
  createReconciliationService,
  parseEffectKey,
  type Result,
  runId,
  sellerId,
  whopAccountId,
} from "@ledgerly/core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { createPgliteUnitOfWork } from "../../db/src/repos/unit-of-work";
import { createSandboxAdapter, createWhopClient } from "../src/index";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

// Local PGlite plus the real HTTP adapter. All HTTP replies here are explicit
// documentation-shaped examples, not recorded successful provider transfers.
it("compares paginated transfer drift through the real adapter without writing the ledger", async () => {
  const database = new PGlite();
  try {
    await migrate(drizzle(database), {
      migrationsFolder: fileURLToPath(new URL("../../db/drizzle", import.meta.url)),
    });
    const uow = createPgliteUnitOfWork(database);
    const accountId = value(whopAccountId("biz_contract_seller"));
    const parent = value(whopAccountId("biz_contract_parent"));
    const owner = await uow.run(async (r) => {
      const owner = await r.sellers.createOrFetch(
        {
          runId: value(runId("assessment-transfer-contract")),
          externalId: "isolated",
          email: "isolated@example.invalid",
          country: "BR",
        },
        value(sellerId("assessment-transfer-seller")),
      );
      await r.sellers.attach(owner.id, accountId);
      const effectKey = value(parseEffectKey("assessment-transfer-effect"));
      await r.ledger.append([
        {
          sellerId: owner.id,
          runId: owner.runId,
          accountSide: "seller",
          kind: "transfer",
          resourceType: "transfer",
          resourceId: "ctt_contract_mismatch",
          effectKey,
          amount: { amountMinor: 2200, currency: "USD" },
          occurredAt: new Date("2026-09-09T00:00:00Z"),
          provenance: "mock",
        },
      ]);
      return owner;
    });
    const before = await uow.run((r) => r.ledger.forSeller(owner.id));
    function summary(id: string, amount: number, status = "succeeded") {
      return {
        id,
        amount,
        status,
        object: "transfer",
        currency: "usd",
        created_at: "2026-09-09T00:00:00Z",
        origin_ledger_account_id: "ldgr_contract_origin",
        destination_ledger_account_id: "ldgr_contract_destination",
      };
    }
    const records = [
      summary("ctt_contract_mismatch", 23),
      summary("ctt_contract_missing", 10),
      summary("ctt_contract_pending", 5, "processing"),
    ];
    const requests: string[] = [];
    const adapter = createSandboxAdapter({
      parentAccountId: parent,
      client: createWhopClient({
        baseUrl: "https://sandbox.invalid/api/v1",
        apiKey: "contract-only",
        apiVersionDate: "2026-09-06",
        fetch: async (input, init) => {
          expect(init?.method).toBe("GET");
          const url = new URL(String(input));
          requests.push(url.pathname + url.search);
          const page = (data: unknown[], next: string | null = null) => ({
            data,
            page_info: { end_cursor: next, has_next_page: next !== null },
          });
          if (url.pathname === "/api/v1/payments") return Response.json(page([]));
          if (url.pathname === "/api/v1/transfers") {
            expect(url.searchParams.get("destination_id")).toBe(accountId);
            expect(url.searchParams.has("origin_id")).toBe(false);
            return Response.json(
              url.searchParams.has("after")
                ? page(records.slice(1))
                : page(records.slice(0, 1), "page2"),
            );
          }
          const record = records.find((row) => url.pathname === `/api/v1/transfers/${row.id}`);
          if (!record) throw new Error("Unallocated request; real network forbidden");
          return Response.json({
            ...record,
            origin: { id: parent, typename: "Company" },
            destination: { id: accountId, typename: "Company" },
          });
        },
      }),
    });
    const report = value(
      await createReconciliationService(uow)({
        sellerId: owner.id,
        provider: createReconciliationProvider(adapter),
      }),
    );
    expect(report.transfersUnavailable).toBeUndefined();
    expect(report.amountMismatch).toEqual([
      {
        local: {
          resourceType: "transfer",
          resourceId: "ctt_contract_mismatch",
          amount: { amountMinor: 2200, currency: "USD" },
        },
        provider: {
          resourceType: "transfer",
          resourceId: "ctt_contract_mismatch",
          amount: { amountMinor: 2300, currency: "USD" },
        },
      },
    ]);
    expect(report.missingLocally).toEqual([
      {
        resourceType: "transfer",
        resourceId: "ctt_contract_missing",
        amount: { amountMinor: 1000, currency: "USD" },
      },
    ]);
    expect(report.pendingOrReserve).toEqual([
      {
        resourceType: "transfer",
        resourceId: "ctt_contract_pending",
        amount: { amountMinor: 500, currency: "USD" },
        status: "pending",
      },
    ]);
    expect(report.missingAtProvider).toEqual([]);
    expect(requests.filter((path) => path.startsWith("/api/v1/transfers?"))).toEqual([
      "/api/v1/transfers?destination_id=biz_contract_seller",
      "/api/v1/transfers?destination_id=biz_contract_seller&after=page2",
    ]);
    expect(await uow.run((r) => r.ledger.forSeller(owner.id))).toEqual(before);
  } finally {
    await database.close();
  }
}, 30000);
