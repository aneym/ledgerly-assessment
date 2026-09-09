# Local PGlite runtime

Run from the reviewed repository checkout:

```sh
node scripts/local-runtime/start.mjs --port 4474 --data-dir /absolute/disposable/ledgerly-runtime
```

The launcher binds only `127.0.0.1`. It runs Next development mode with Webpack, real Better Auth, persistent PGlite, and a shared mock provider. It rejects hosted markers, production NODE_ENV and dotenv files. The child gets an allowlisted environment with generated, in-memory authentication and webhook secrets. It does not read provider credentials or connect to Neon.

The fictional catalog is seeded using onboarding and product repositories. `/demo/profile/buyer`, `/demo/profile/seller` and `/demo/profile/operator` use the existing demo session flow. The operator profile remains the restricted demo role. `/api/local-runtime/operator` creates and signs in a dedicated fictional true operator, with a server-side role grant behind the local-only guard. It redirects to `/admin/sellers`. Public signup cannot request that role.

`POST /api/local-runtime/checkout` accepts `{ "orderId": "..." }` only for the authenticated owner and exact origin. It creates a mock payment, signs its event with the in-memory secret, receives it through the real inbox, processes that exact delivery, and verifies the persisted paid state. The visible button is `data-tour="checkout.simulation.complete"`. Refunded orders cannot be completed again. No route writes a forced paid status.

`GET /api/local-runtime/health` reports `database: pglite`, `provider: mock`, `local_test: true`, and `persistent: true`. `source_revision` is a full Git SHA only when the checkout was clean at launch and remains clean at the same commit. Dirty development launches return null. The intended final QA must run the combined current candidate, not this lane's older standalone baseline.

The database and mock provider snapshots survive a normal stop/restart. Provider IDs, idempotency records, refunds, balances and deferred states are restored; a saved zero balance stays zero. A missing provider snapshot for an existing database or an interrupted provider call refuses startup. Preserve that directory for inspection and select a fresh disposable directory. No automatic reset or stale-lock deletion occurs.

Authentication secrets are not saved. On restart, old cookies expire and the current integrated secure profile handler creates a fresh run and fresh fictional identities. Historical financial rows remain. The runtime retains the application's signed profile binding and trusted `demoRunId` implementation.

`GET` and `POST /api/local-runtime/events` bind the constrained signed-event helper to an actual issued buyer profile. It uses the trusted session run, owning order, and exact persisted delivery readback. Synthetic refunds require a platform-transfer order. A durable local claim excludes that payment from ordinary provider refunds and ordinary inbox refunds for the rest of its lifetime. Both provider/simulator exports share the guard, and every server inbox processor captures the guarded unit of work. Private synthetic delivery authorization checks the signature, exact order/run/payment and body hash inside the inbox transaction. Ordinary direct refunds remain available through the provider; direct synthetic injection returns 409. The route is for labelled local tests, never provider proof.

For the repository signed HTTP fixture suite, add `--webhook-fixture 1`. This selects the checked-in fake signing value, only after the same local/hosted guards. Ordinary local launches retain an ephemeral signing secret. No real signing credential is loaded or exposed.
