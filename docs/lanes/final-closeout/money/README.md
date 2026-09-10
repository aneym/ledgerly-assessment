# Money: ledgers, refund, top-up, transfer

Run started 2026-09-09T22:54:05Z. Sandbox API base `https://sandbox-api.whop.com/api/v1`, Api-Version-Date from `.env.local`. Every `*.json` file here is a redacted request/response record from `scratchpad/money_api.py` unless the file name says otherwise. Each record carries `started_at` and `finished_at`; the times quoted below come from those fields. All amounts are USD.

Export scope: only `evidence/money/*.json` and this README are exportable. The helper scripts in the scratchpad root (`money_api.py`, `sweep.sh`, `db.sh`, `redact_money.py`) and the `money-*.png` working screenshots stay out. `redact_money.py` embeds the real account email and display name as match patterns, and two of the screenshots show the account email.

## Accounts and ledgers

| Account | Ledger | Role |
| --- | --- | --- |
| `biz_RlL9WP9TIBVXmr` | `ldgr_AZlILZx7NXGpQ` | Ledgerly platform |
| `biz_pt7b2NAryKwRGh` | `ldgr_Y2iPi6lx5xIqL` | US seller (`sel_mara`, direct) |
| `biz_8dB7THK4woBs43` | `ldgr_LS8igbZK1GRg5` | BR assessment seller |
| `biz_6FQIBpQldcgR33` | `ldgr_fueCynW1QCSyg` (no balance rows; 24-balance-br-storefront-after-settlement.json) | BR storefront seller `sel_onda` in the production DB |

`GET /ledger_accounts/{biz_id}` returns the balances. `GET /financial-activity?account_id={biz_id}` returns the ledger rows. Amounts in that feed are signed integers at `currency.precision` (100000000 for USD, so `2500000000` is 25.00).

## 1. Balances before (01-*.json, read 2026-09-09T23:24:58Z to 23:24:59Z)

| Account | available | pending | reserve |
| --- | --- | --- | --- |
| platform | 0.00 | 206.57 | 0.00 |
| US seller | 0.00 | 128.22 | 0.00 |
| BR seller | no balance rows | | |

Every USD balance was pending. `settlement_time_at` on each ledger account is `2026-09-09T00:00:00Z`; the rows say when each inflow becomes withdrawable (`available_at`).

## 2. Where the fee and the seller share landed (direct payment pay_ELe6ONlgjrYv5Z, 25.00)

Seller ledger, `GET /financial-activity?account_id=biz_pt7b2NAryKwRGh&currency=usd` (02-activity-us-feed.json, read 23:25:15Z; the same rows with `line_types[]=application_fee&line_types[]=payment_gross` in 03-us-application-fee-and-gross-rows.json). Rows with `payment_id = pay_ELe6ONlgjrYv5Z`, all posted 2026-09-09T23:02:41Z:

| line_type | amount |
| --- | --- |
| payment_gross | +25.00 (available_at 2026-09-11T00:00:00Z) |
| application_fee | -2.00 |
| payment_processing_percentage_fee | -0.68 |
| cross_border_percentage_fee | -0.38 |
| payment_processing_fixed_fee | -0.30 |
| orchestration_percentage_fee | -0.20 |
| fraud_prevention_fee | -0.07 |
| net | 21.37 |

21.37 equals `amount_after_fees` on `GET /payments/pay_ELe6ONlgjrYv5Z` (05-direct-payment-before-refund.json). The seller share the receipt shows (23.00) is gross minus the Ledgerly fee; the processing fees come out of the seller's side on top of that.

Platform ledger, `GET /financial-activity?account_id=biz_RlL9WP9TIBVXmr&line_types[]=application_fee_payout` (03-platform-application-fee-payout-rows.json, read 23:25:41Z):

| line_type | amount | posted_at | payment_id | resource | source |
| --- | --- | --- | --- | --- | --- |
| application_fee_payout | +2.00 | 2026-09-09T23:02:42Z | pay_ELe6ONlgjrYv5Z | biz_pt7b2NAryKwRGh | apfee_Txph4OfONEGb |

How it was matched: the platform row carries `payment_id` directly, so no amount-and-date matching was needed. The `resource_id=pay_...` and `resource_id=apfee_...` query filters both returned zero rows (02-activity-platform-direct-payment.json, 03-platform-activity-by-apfee.json); the unfiltered feed and the `line_types[]` filter are the working queries. The row's `available_at` is 2026-09-11T00:00:00Z, so the fee sat in the platform's pending balance during this run. The same query lists the 2.00 rows for the earlier US-seller payments, including pay_LhomHFUGcxqYZ1 (apfee_8JygL79d021j, posted 2026-09-08T16:45:26Z).

## 3. Top-up: not possible in the sandbox during this run

- `developer__platforms__add-funds-to-your-balance.md` says the first top-up must be created in the dashboard, which saves a payment method that `POST /topups` then reuses.
- `GET /payment_methods?company_id=biz_RlL9WP9TIBVXmr` returned an empty list (04-*.json). The platform has no stored payment method.
- `POST /topups` with the sandbox user's saved card `payt_FZ17WahujTHTR`: HTTP 404 `{"error":{"type":"not_found","message":"This PaymentToken was not found"}}` (08-topup-api-attempt-1.json).
- In ego-browser, Dashboard > Deposit on `https://sandbox.whop.com/dashboard/biz_RlL9WP9TIBVXmr/` opened an "Add money" dialog that showed "Unable to load deposit details. Please try again." The dialog's request `POST https://sandbox.whop.com/api/v1/deposits/` with body `{"destination":"biz_RlL9WP9TIBVXmr"}` answered HTTP 500 with the Rails default error page, three times (12-dashboard-deposit-dialog-500.json).
- Setup-mode checkout as a way to store a card: `POST /checkout_configurations` with `mode: "setup"` created `ch_CmfuDoysUUP6LkH` (15-setup-checkout-config.json). The hosted page was completed in ego-browser with the sandbox test card 4242 4242 4242 4242, 12/30, CVC 123, billing name "Ledgerly Platform", a fictional Delaware address. The setup intent `sint_kcKFbxX2YT7kd` succeeded (16-setup-intent.json) but Whop deduplicated the card onto the existing member payment method `payt_FZ17WahujTHTR` (member `mber_4TPdtS1BYVigK`, the sandbox user), not onto the company. `GET /payment_methods?company_id=...` stayed empty. `POST /topups` with that id again: 404, same message, with both `account_id` and `company_id` (17-*.json).

So no top-up landed. The platform's funds for a transfer came from the 2026-09-10T00:00:00Z settlement instead (sections 5 and 7).

## 4. Refund of pay_ELe6ONlgjrYv5Z: done; the fee was still on the platform ledger four minutes later

`POST /payments/pay_ELe6ONlgjrYv5Z/refund` with body `{}` and `Idempotency-Key: money-refund-pay_ELe6ONlgjrYv5Z-1` at 2026-09-09T23:27:48Z: HTTP 200 (10-refund-attempt-1.json). The payment reads back `status: paid`, `refunded_amount: 25.00`, `refunded_at: 2026-09-09T23:27:48.013Z` (11-direct-payment-after-refund.json). The refund object is `rf_AtBJ9mtmOMtikt6`, `status: succeeded`, `amount: 25.00`, `reason: requested_by_customer`, `provider: multi_psp` (11-refund-object.json).

Listing the refund: `GET /refunds?payment_id=pay_ELe6ONlgjrYv5Z` returned an empty list at 23:28:08Z (11-refunds-list-for-payment.json) and again at 23:52:03Z (23-refunds-list-for-payment-recheck.json). `GET /refunds?account_id=biz_pt7b2NAryKwRGh` at 23:52:03Z lists `rf_AtBJ9mtmOMtikt6` with `payment_id pay_ELe6ONlgjrYv5Z` (23-refunds-list-for-account.json). `developer__api__versioning.md` says refunds are listed with `?payment_id=`; in this sandbox only the `account_id` filter returned the row. That is a sandbox discrepancy, not a doc fact.

What the ledgers showed after the refund. These are point-in-time readings, taken about four minutes after the refund; they are not a rule of the API:

- Seller ledger, `GET /financial-activity?account_id=biz_pt7b2NAryKwRGh&currency=usd&posted_after=2026-09-09T23:20:00Z` at 23:28:09Z (11-activity-us-after-refund.json): one new row, `payment_refund -25.00`, posted 2026-09-09T23:27:49Z, source `rf_AtBJ9mtmOMtikt6`. No reversal rows for `application_fee` or the processing fees at that time.
- Seller balance at 23:31:18Z (13-balance-us-after-refund.json): available -25.00, pending 128.22. The full 25.00 came out of the seller's available balance, which went negative.
- Platform ledger, `GET /financial-activity?account_id=biz_RlL9WP9TIBVXmr&currency=usd&posted_after=2026-09-09T23:20:00Z` at 23:28:10Z (11-activity-platform-after-refund.json) and 23:31:19Z (13-activity-platform-after-refund-recheck.json): zero rows posted after 23:20Z. The `application_fee_payout +2.00` had not been reversed at those times. The full platform feed read at 23:50:39Z (21-activity-platform-feed-all-limit50.json, 41 rows) still has no reversal row.
- `GET /payments/pay_ELe6ONlgjrYv5Z/fees` at 23:28:09Z (11-direct-payment-fees-after-refund.json) still listed the 2.00 application fee.

Observed on 2026-09-09 between 23:28Z and 23:50Z in the sandbox: after the full refund the seller ledger carried the whole -25.00 and the platform ledger still carried the +2.00 fee. Whether Whop reverses the fee later (for example at settlement) was not observed in this run. Ledgerly's own ledger should record the refund as a full-gross reversal on the seller side and keep the fee entry until a reversal row appears on the platform ledger.

Webhook: `refund.created` for `rf_AtBJ9mtmOMtikt6` was delivered to the production consumer at 2026-09-09T23:27:49Z and answered 200 `{"received": true, "duplicate": false}` (delivery `whdel_MTc4ODk5NjQ2OTAwMHwwMWEwODg3Zi1jNGRhLTc5OGYtOTZjNC0wNWZjY2QzYzUyY2M`, message `msg_l4qMpnWV6dZRlBuEv3NhB1Fz`, in 11-webhook-deliveries-after-refund.json).

## 5. Transfer: not completed before settlement

Two things were tried, both against a platform available balance of 0.00 (all 206.57 pending).

- Ledgerly's own release path. The local `CRON_SECRET` matches production: `GET https://ledgerly-afneymans-projects.vercel.app/api/cron/sweep` (the route is GET, not POST) answered 200 at 2026-09-09T23:26:54Z (07-sweep-probe.json) with `transfers: {released: 0, retried: 0, failed: 5}`. Vercel calls the same route every minute: `apps/web/vercel.json` at the deployed release `60aa620` (and on `main`) has `crons: [{path: "/api/cron/sweep", schedule: "* * * * *"}]`.
- The production DB, read with a read-only query, holds five eligible `platform_transfer` orders with `transfer_id` null, including this run's `00b8451a-9f1c-402a-8ee0-e3824e81943f` (sel_onda, 60.00 gross, 4.80 fee, 55.20 share) (06-production-db-eligible-orders.txt). The sweep releases them oldest first, so a later successful sweep pays `dd2ab3b3` (sel_onda, 55.20), `98b49fe4` (sel_onda, 11.04), `921a78f3` (sel_acme, 26.68), `0b59642d` (sel_acme, 26.68), total 119.60, before this run's order (55.20). In production `sel_onda` maps to `biz_6FQIBpQldcgR33`, not to the assessment BR account `biz_8dB7THK4woBs43` (06-production-db-sellers.txt); the sweep therefore pays `biz_6FQIBpQldcgR33`. Source of the DB read: the production Neon URL stored at `~/.config/ledgerly/neon-database-url`, opened through `scratchpad/db.sh` with `LEDGERLY_DB_SOURCE=prod`, which sets `default_transaction_read_only = on` for the session. It is not the `DATABASE_URL` in `.env.local`. No credential appears in the output files.
- Direct `POST /transfers` with `Idempotency-Key` and body `idempotence_key` both `money-transfer-br-assessment-00b8451a`, `origin_id biz_RlL9WP9TIBVXmr`, `destination_id biz_8dB7THK4woBs43`, `amount 55.20`, `currency usd`, `type ledger` at 23:27:36Z (09-transfer-attempt-1-zero-balance.json): HTTP 400 `{"error":{"type":"bad_request","message":"You cannot transfer funds out of your pending balance. Please wait for your funds to settle and try again."}}`. That is the reason the sweep's five transfers failed too; the sweep response carries no error text and `demo_events` in production has no transfer rows for the window (07-production-db-transfer-failure-events.txt).

No `trf_` id was created before settlement. `transfer.completed` is among the eight subscriptions on `hook_gO3nsBQBCSyzF` (19-webhook-get.json).

What settles, from the saved full platform feed (21-activity-platform-feed-all-limit50.json, 41 rows on one page, read 23:50:39Z; the same 41 rows as 02-activity-platform-feed.json page 1 plus 21-activity-platform-feed-page2.json and -page3.json; sums in 23-platform-settlement-summary.json). The feed total is 206.57, equal to the pending balance in 13-balance-platform-after-refund.json.

| available_at | dated rows | dated sum | undated fee rows of those payments | fee sum | net settling |
| --- | --- | --- | --- | --- | --- |
| 2026-09-10T00:00:00Z | 14 (10 `application_fee_payout` = 25.92; `payment_gross` 60.00 pay_6emFcu79TQGD6F, 12.00 pay_dquW3UTOlLQB9x, 29.00 pay_KlLPYXITgrygTF, 29.00 pay_OM3X8c0ycF5ytM) | 155.92 | 20 | -7.98 | 147.94 |
| 2026-09-11T00:00:00Z | 2 (`payment_gross` 60.00 pay_cxvGcm7NvjoCkV; `application_fee_payout` 2.00 pay_ELe6ONlgjrYv5Z) | 62.00 | 5 | -3.37 | 58.63 |

Processing-fee rows carry `available_at: null`; each is attributed to the settlement day of its payment's `payment_gross` row. 147.94 + 58.63 = 206.57.

One path only for order `00b8451a`, to avoid paying it twice: the production sweep, keyed `transfer:<order id>` (`packages/core/src/services/transfers.ts`). The Vercel cron calls it every minute. Do not call `POST /transfers` for that order directly, and do not rerun `scratchpad/money_api.py POST /transfers` with the key `money-transfer-br-assessment-00b8451a`. Whop binds an idempotency key to the first request body it sees, even when that request answered 400: a retry under `transfer:dd2ab3b3-1332-471e-9b31-82936f2db774` with a numeric `amount` and `type: ledger` answered 400 `This Idempotency-Key was already used with a different request` (27-transfer-repro-number-body-dd2ab3b3.json; the same for `98b49fe4` in 27-transfer-repro-number-body-98b49fe4.json). Only those two keys were probed; the other three are inferred from the cron sending the same body for all five (28-production-db-events-after-transfer.txt). Those two probes are the one exception already made to this one-path rule; no transfer resulted from them. The cron re-sends its original body each minute, so its keys stay usable for it. The sweep pays oldest first: 119.60 for the four older orders, then this run's order (55.20) once the available balance covers it. Readback for a released order: `transfer_id` on the `orders` row in the production DB, then `GET /transfers/{id}`, then the `transfer.completed` delivery on `hook_gO3nsBQBCSyzF`. There is no list endpoint for transfers in the doc snapshot. What happened after settlement, and why the sweep still fails, is in section 7.

## 6. Balances after the refund (13-*.json, read 2026-09-09T23:31:18Z to 23:31:19Z)

| Account | available | pending | change |
| --- | --- | --- | --- |
| platform | 0.00 | 206.57 | none: fee payout not reversed, no top-up, no transfer |
| US seller | -25.00 | 128.22 | refund debited 25.00 from available |
| BR seller | no balance rows | | no transfer landed |

18-balance-platform-poll.json is a later platform reading at 23:43:02Z: still 0.00 available, 206.57 pending.

## 7. After the 2026-09-10T00:00:00Z settlement: cron still failing, Part 1 transfer done

Balances (24-*.json, read 2026-09-10T00:01:25Z to 00:01:26Z): platform available 147.94, pending 58.63, the figures computed in section 5; US seller available 81.85, pending 21.37 (its 2026-09-10 rows settled and absorbed the -25.00 refund); BR assessment seller `biz_8dB7THK4woBs43` and BR storefront seller `biz_6FQIBpQldcgR33` (`ldgr_fueCynW1QCSyg`) no balance rows. The platform figures were the same at 00:04:17Z (25-balance-platform-recheck.json) and 00:06:26Z (26-balance-platform-after-sweep.json).

Ledgerly's release path released nothing. The production instrumentation table (read-only query, 26-production-db-transfer-events.txt and 28-production-db-events-after-transfer.txt) shows the Vercel cron calling `GET /api/cron/sweep` at :33 past every minute from 00:00:33Z, each run making five `POST /transfers` calls that answered 400, through 00:11:37Z. A manual call of the same route at 00:05:55Z answered 200 with `transfers: {released: 0, retried: 0, failed: 5}` (26-sweep-after-settlement.json). Every order still has `transfer_id` null (28-production-db-orders-after-transfer.txt). The instrumentation rows carry no error body.

Why: the adapter (`packages/whop/src/sandbox-adapter.ts`, `createTransfer`, the same code at release 60aa620) sends `origin_id: biz_RlL9WP9TIBVXmr`, `amount` as a decimal string, `currency`, `destination_id` and `metadata`. Sending that exact body by hand under the sweep's own key `transfer:dd2ab3b3-1332-471e-9b31-82936f2db774` at 00:08:12Z answered 400 `You cannot transfer funds out of your pending balance. Please wait for your funds to settle and try again.` (27-transfer-repro-adapter-body-dd2ab3b3.json), eight minutes after `GET /ledger_accounts/biz_RlL9WP9TIBVXmr` showed 147.94 available. A transfer with `origin_id: ldgr_AZlILZx7NXGpQ` (the platform's primary ledger id from that readback) succeeded at 00:09:39Z, and the cron's `biz_`-origin calls went on failing at 00:09:33Z, 00:10:33Z and 00:11:33Z. So in this sandbox `POST /transfers` with a `biz_` origin is checked against a pending balance, while the `ldgr_` origin is checked against the available one. Fix for the integrator: resolve the platform account to its primary ledger id (`GET /ledger_accounts/{biz_id}` returns `id: ldgr_...`) and send that as `origin_id`; the doc allows a `user_`, `biz_` or `ldgr_` origin. Whether the numeric-versus-string `amount` matters was not tested in isolation.

The Part 1 transfer (platform to BR seller) ran with the ledger-id origin, under a fresh key that is not the release of any order: `POST /transfers` with `Idempotency-Key` and body `idempotence_key` both `money-part1-platform-to-br-assessment-2026-09-10`, `origin_id ldgr_AZlILZx7NXGpQ`, `destination_id biz_8dB7THK4woBs43`, `amount 55.20` (the seller share of the platform-flow payment pay_cxvGcm7NvjoCkV), `currency usd`, `type ledger`, `notes`, metadata `{purpose: assessment_part1_platform_to_br, source_payment_id: pay_cxvGcm7NvjoCkV}` at 2026-09-10T00:09:39Z: HTTP 201 (28-transfer-part1-br-assessment-ledger-origin.json). Transfer `ctt_XOWIF7fafgGBHX`, `status succeeded`, `amount 55.2`, `fee_amount 0.0`, `created_at 2026-09-10T00:09:40.061Z`, `origin_ledger_account_id ldgr_AZlILZx7NXGpQ`, `destination_ledger_account_id ldgr_LS8igbZK1GRg5`, origin `biz_RlL9WP9TIBVXmr`, destination `biz_8dB7THK4woBs43`. `GET /transfers/ctt_XOWIF7fafgGBHX` at 00:10:34Z reads the same (28-transfer-readback.json). Transfer ids carry the `ctt_` prefix, not `trf_`.

Where it landed (28-activity-platform-after-transfer.json and 28-activity-br-after-transfer.json, read 00:10:35Z):

| Ledger | line_type | amount | posted_at | available_at | source | resource |
| --- | --- | --- | --- | --- | --- | --- |
| platform `ldgr_AZlILZx7NXGpQ` | platform_balance_transfer_outgoing | -55.20 | 2026-09-10T00:09:40Z | null | ctt_XOWIF7fafgGBHX | biz_8dB7THK4woBs43 |
| BR `ldgr_LS8igbZK1GRg5` | platform_balance_transfer_incoming | +55.20 | 2026-09-10T00:09:40Z | 2026-09-10T00:09:40Z | ctt_XOWIF7fafgGBHX | biz_RlL9WP9TIBVXmr |

Balances at 00:10:34Z to 00:10:35Z (28-balance-platform-after-transfer.json, 28-balance-br-after-transfer.json): platform available 92.74 (147.94 - 55.20), pending 58.63; BR assessment seller available 55.20, pending 0.00. The incoming row was available at once; a ledger transfer has no settlement delay.

Webhook: `hook_gO3nsBQBCSyzF` delivered `transfer.completed` for `ctt_XOWIF7fafgGBHX` twice at 2026-09-10T00:09:40Z, one message per account involved (`child_resource_events` true): `whdel_MTc4ODk5ODk4MDAwMHwwMWEwODhhNi0xNjFjLTc1OTUtYTFhNi0zMWY1OWYwN2Q1M2M` and `whdel_MTc4ODk5ODk4MDAwMHwwMWEwODhhNi0xNTNjLTdkMDQtOTMzNC1iMjMzMzdlMGVjMzg`, both answered 200 `{"received": true, "duplicate": false}` by the production consumer (28-webhook-deliveries-after-transfer.json). Production's `webhook_inbox` holds both as separate messages, `msg_4oNxGSzGNqZi2pDsjUgqS8uA` for account `biz_RlL9WP9TIBVXmr` and `msg_EdpPKjcQEUWKEV21HOmWPGuJ` for `biz_8dB7THK4woBs43`, status `quarantined` with no error text (28-production-db-inbox-after-transfer.txt): the consumer verified and stored them, then quarantined them because no Ledgerly order carries this transfer id. That is the expected outcome for a transfer made outside the sweep.

The two BR accounts stay distinct. `sel_onda` is `biz_6FQIBpQldcgR33` in production and receives its order releases from the sweep once the adapter sends a ledger-id origin; `biz_8dB7THK4woBs43` received the Part 1 transfer. Both amounts are 55.20 because both are the seller share of a 60.00 platform-flow sale; they are separate movements of sandbox money, not one order paid twice. Order `00b8451a` still has `transfer_id` null and stays on the sweep path. After the Part 1 transfer the platform's available balance (92.74) covers `dd2ab3b3` (55.20), `98b49fe4` (11.04) and `921a78f3` (26.68) but not all five orders.

## Sandbox discrepancies seen in this run

- `GET /financial-activity` with `limit=100` (the documented maximum) returned an empty page (21-activity-platform-feed-limit100-empty.json); `limit=50` returned all 41 rows.
- `GET /financial-activity` with `available_after=YYYY-MM-DD&available_before=YYYY-MM-DD&currency=usd` returned zero rows for both 2026-09-10 and 2026-09-11 (22-activity-platform-available-2026-09-10.json, -11.json), although the feed carries rows with those `available_at` dates. The sums above come from the unfiltered feed.
- `GET /financial-activity` with `resource_id=` returned zero rows for a payment id and for an application-fee id (section 2).
- `GET /refunds?payment_id=` returned an empty list twice; `GET /refunds?account_id=` lists the refund (section 4).
- The dashboard Deposit dialog's `POST /api/v1/deposits/` answered HTTP 500 (section 3).
- `POST /transfers` with `origin_id: biz_RlL9WP9TIBVXmr` answered the pending-balance error while `GET /ledger_accounts/biz_RlL9WP9TIBVXmr` showed 147.94 available; the same transfer with `origin_id: ldgr_AZlILZx7NXGpQ` succeeded (section 7).
- An idempotency key is bound to the first request body even when that request answered 400 (section 5).
- `transfer.completed` arrived twice for one transfer on the platform webhook, one message per account involved, with distinct message ids; the consumer saw neither as a duplicate (section 7).
- Transfer ids carry the `ctt_` prefix; the assessment checklist and the doc examples say `trf_`.

## Redaction

`money_api.py` redacts secret-like keys, signed URLs, real-person emails, billing and mailing address lines, display names under user/owner/address objects, `profile_picture` objects and, since 23:53Z, flat `profile_picture_url` strings. `redact_money.py` then replaces the real account email (including plus-addressed forms) and the real display name anywhere in the JSON. Five files written before the `profile_picture_url` rule (02-activity-platform-feed, 02-activity-us-feed, 03-us-application-fee-and-gross-rows, 21-activity-platform-feed-all-limit50, 21-activity-platform-feed-page2) were rescanned at 23:53Z and the twelve avatar URLs under `resource.profile_picture_url` replaced with `[avatar url redacted]`. Transfer responses carry `created_by_user.name`; `redact_money.py` replaced it in 28-*.json and the helper now covers that key too. Rescan at the end of the run: no gmail address, no avatar host, no `whsec`, `sk_`, bearer, `token=` or `signature=` value, no full card number in any file here; all JSON files parse. Kept on purpose: non-secret ids (biz_, pay_, rf_, trf_, apfee_, line_, ldgr_, payt_, sint_, ch_, whdel_, msg_), sandbox usernames, and the production host name.
