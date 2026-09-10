# code-reconcile evidence

Branch `work/final-code-reconcile`, commit `91fb7e7`, worktree
`/Volumes/StudioExt/repos/ledgerly-worktrees/final-code-reconcile`, based on main `3c569de`.

## What landed

- `pnpm reconcile --seller <sellerId|biz_...> [--json] [--max-pages N] [--env-file PATH]`
  runs `createReconciliationService` for one seller against the sandbox Whop adapter and
  the Neon database. It prints one summary line, one line per discrepancy, then the
  `ReconciliationReport` as JSON. `--json` prints one JSON document only.
- `pnpm reconcile --mock` runs the same job against the mock adapter and a seeded PGlite
  seller. No credentials.
- Files: `apps/web/scripts/reconcile.ts`, `apps/web/scripts/reconcile-format.ts`,
  `apps/web/test/scripts/reconcile-format.test.ts`, `package.json`, `apps/web/package.json`
  (adds `tsx` 4.23.13 as a dev dependency), `pnpm-lock.yaml` (three lines).
- Commit 873e4b1 was already in main. No cherry-pick.

## Checks that ran

| Check | Result | Log |
| --- | --- | --- |
| `pnpm typecheck` | exit 0, six packages Done | typecheck.log |
| packages/core vitest | 194 passed | vitest-core.log |
| packages/whop vitest | 295 passed, 10 skipped | vitest-whop.log |
| packages/db vitest | 237 passed | vitest-db.log |
| apps/web reconcile-format test | 11 passed | vitest-web-reconcile-format.log |
| biome check on the three TS files and apps/web/package.json | 4 files checked, no diagnostics | biome-repo.log |
| biome check on root package.json | not covered: biome.json `files.includes` is apps/** and packages/**, biome exits 1 with "No files were processed" | biome-repo.log |
| `biome check .` repo-wide | exit 0, 537 files, 17 pre-existing CSS warnings (10 in apps/web/src/app/globals.css, 7 in apps/web/src/app/(storefront)/handoff/handoff.css), none in the reconcile files | biome-repo.log |

## Mock run

`pnpm --silent reconcile --mock` exited 0. Seller `reconcile-mock-seller`, account
`biz_mock_1`: 3 compared, 1 matched, 1 missing locally, 1 missing at provider. The
activity comparison shows 0 matched because the mock only records a `payment_gross` line;
it has no fee lines. Files: mock-run.txt, mock-run.json.

## Sandbox run

`pnpm --silent reconcile --seller biz_pt7b2NAryKwRGh --env-file <.env.local>` exited 0
at 2026-09-09T23:07:47Z. Read-only. The CLI captured no HTTP trace. The three GET paths
listed in summary.json are inferred from the route table in
`packages/whop/src/sandbox-adapter.ts` (listPayments, listTransfers,
listFinancialActivity) and from the report shape; the statuses and query strings there are
not observed values. Neon reads: sellers.byAccount, sellers.get, ledger.forSeller. Files:
sandbox-run.txt, sandbox-run.json, summary.json.

Result for local seller `sel_mara` (biz_pt7b2NAryKwRGh):

- 6 payments at the provider. `pay_LhomHFUGcxqYZ1` (25.00 USD) matches the ledger.
- 5 payments are missing locally, each 25.00 USD. Posted times come from the
  `postedAt` field of their activity lines in sandbox-run.json:
  - pay_ELe6ONlgjrYv5Z at 2026-09-09T23:02:41Z (five minutes before this run)
  - pay_tJABaxIlZo6FJ9 at 2026-09-09T00:08:43Z
  - pay_8f4MKyKfuGvUNy at 2026-09-09T00:08:43Z
  - pay_1EBdxGtWCu54K0 at 2026-09-08T23:37:18Z
  - pay_p2qLHIfZbpL57Z at 2026-09-08T23:29:46Z
  Four of the five predate this run by about a day. This evidence does not show who or
  what created them. The ledger behind the `.env.local` DATABASE_URL has no rows for them.
- 0 transfers listed for the seller as destination. `transfersUnavailable` is absent.
- 42 financial-activity lines, 0 matched. The provider net per payment is 21.37 USD
  (25.00 gross minus application fee 2.00 and processing fees 1.63). The ledger's
  seller-side row is 23.00 USD (gross minus the 8% fee). The service compares those two
  numbers, so every activity comparison reports a mismatch. This is the existing service
  semantics, not a CLI defect.

## Not done

- No README.md edits in the repo, per the brief.
- Not merged to main. The integrator owns that.
- The service's activity comparison (seller share vs provider net) was not changed.
- No sandbox run was made from process.env alone. This worktree has no `.env.local`, so
  both sandbox runs used `--env-file` pointing at the app-ui-fixes `apps/web/.env.local`.
