# Browser tests

The workspace uses Playwright test commands for repeatable product checks. Interactive browser QA follows the current user-approved browser tool. Install the pinned workspace with `pnpm install --frozen-lockfile` and use the already installed Chromium, or run `pnpm --filter ledgerly-qa-e2e exec playwright install chromium` in an authorized test environment.

## Run a scenario

```sh
# pnpm 12 forwards a literal -- to scripts. Call the executable so flags are parsed.
pnpm --filter ledgerly-qa-e2e exec playwright test --list
QA_PREVIEW_URL=http://127.0.0.1:4420 pnpm --filter ledgerly-qa-e2e exec playwright test preview-smoke
QA_APP_URL=http://127.0.0.1:3000 QA_MODE=fixture pnpm --filter ledgerly-qa-e2e exec playwright test required-pages ledger-webhook
python3 tests/qa/e2e/check_required.py tests/qa/e2e/artifacts/results.json tests/qa/e2e/required-journeys.json
```

Start the approved local test runtime with:

```sh
node scripts/local-runtime/start.mjs --port 4474 --data-dir /absolute/disposable/path
QA_APP_URL=http://127.0.0.1:4474 QA_MODE=fixture pnpm --filter ledgerly-qa-e2e exec playwright test required-pages ledger-webhook security
python3 tests/qa/e2e/check_required.py tests/qa/e2e/artifacts/results.json tests/qa/e2e/required-journeys.json --group local
```

The local launcher must be present on the integrated revision. It uses real app routes and authentication against isolated PGlite and a mock provider. CI asserts `database:pglite`, `provider:mock`, `local_test:true` from `/api/local-runtime/health` before tests. The runtime's signing secret is the public fixture value, never a provider credential.

A product target needs an allocated database and seeded catalog sellers. A `QA_APP_URL` is not authorization to write to that target. Fixture mode means a local database and mock provider, not a real sandbox payment. Hybrid mode can create real sandbox accounts and checkout configurations. Never target the shared CI database or a deployed app without its owner's allocation.

| Variable | Meaning |
|---|---|
| `QA_APP_URL` | Allocated Ledgerly target; unset means app tests skip, which fails the required checker |
| `QA_PREVIEW_URL` | Docs preview target only |
| `QA_MODE` | `fixture` or `hybrid`, with per-operation provenance asserted separately |
| `QA_SKIP_ACTIONS` | Explicitly unavailable routes; never used to obtain a required pass |
| `QA_WEBHOOK_SECRET_KNOWN=0` | Skip fixture-signed positive webhook cases; required acceptance will fail |
| `QA_OPERATOR_CREDENTIALS_FILE` | Explicitly provided operator identity file outside the repository |
| `QA_SEED_OPERATOR=1` | Use the documented fixture operator, only on an allocated seeded test DB |
| `QA_DEMO_FAULT_SELLER_ID`, `QA_DEMO_FAULT_PAYMENT_ID` | Allocated resolution fixture identifiers |
| `QA_REFUNDABLE_PAYMENT_ID` | Explicitly allocated payment for the optional refund route test |
| `QA_RECORD=all` | Keep trace, video and screenshot for every test instead of failures only |
| `QA_EXPLORATION=1` | Opt into historical exploratory cases, excluded from normal acceptance |

The `parallel`, `serial` and `auth-heavy` projects separate ordinary contexts, `@serial` cases and rate-limited operator/assistant cases. No `test` script is defined here; normal workspace unit tests do not launch browsers.

## Add a scenario

1. Add a spec under `tests/journeys`, or the relevant security/resolution folder. Use role/label locators or existing `data-tour` hooks. Drive the action on the page when claiming browser journey coverage.
2. Create run-scoped test identities/resources. Read back the resulting order, seller or ledger row through the app API and assert its identifiers and amounts. Never replace a failed prerequisite with `test.skip`.
3. Keep provider provenance explicit. A simulated event is not a real payment. Use `writeQaRun` to record assertions and limitations without secrets or credential values.
4. Add the exact title path to `required-journeys.json` when the journey is release-required. Run `--list` to check it matches, then run the spec on the allocated target and run `check_required.py` on the reporter output.
5. For optional functionality, document why it is optional. Do not label a test as refund completion when it only creates a request or does not press the refund control.

## Read a failure

The JSON report is `artifacts/results.json`; screenshots, traces and videos are under `artifacts/test-results`, and the HTML report is under `artifacts/html`. Open it with `pnpm --filter ledgerly-qa-e2e exec playwright show-report artifacts/html` from this package. CI uploads artifacts and app logs for 14 days.

`MISSING` means the manifest did not match an executed test. `NOT PASSED` includes skipped, flaky, expected-to-fail, interrupted and failed attempts. A passing aggregate `expected` status is insufficient if the test was marked expected-to-fail. Missing results or setup errors fail closed. A rate limit after bounded retries is a failed prerequisite, not successful coverage.

The docs smoke group uses `--group fixture`. It proves the docs server, not the product. Full assessment coverage, independently verified Whop outcomes and recording readiness require their own evidence; the required journey list does not claim all 37 assessment requirements passed.
