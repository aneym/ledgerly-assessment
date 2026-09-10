# Webhooks evidence: hook_gO3nsBQBCSyzF

Run started 2026-09-09T22:54:05Z. All calls went to `https://sandbox-api.whop.com/api/v1` with the platform key and `Api-Version-Date: 2026-09-06`. No code changed. The consumer under test is production: `https://ledgerly-afneymans-projects.vercel.app/api/whop/webhook`.

## What ran

| Step | Call | Result |
| --- | --- | --- |
| 1 | `GET /webhooks/hook_gO3nsBQBCSyzF` | 200. Config saved in `01-webhook-get.json`. |
| 2 | `POST /webhooks/hook_gO3nsBQBCSyzF/test`, once per required type (8 calls) | 8 x 200, `success: true`. Consumer answered 200 `{"received":true,"duplicate":false,"decoded":false}` each time. Files in `test-events/`. |
| 3 | `GET /webhooks/hook_gO3nsBQBCSyzF/deliveries?first=100` (before, three polls after the tests, after the replays, one late recheck) | 44 deliveries before. Still 44 at 22:58:31Z, 22:59:27Z and 23:00:39Z. 47 at 23:03:33Z after the replays. 48 at 23:14:30Z. Test sends never appeared in this list. |
| 4 | `POST .../deliveries/whdel_MTc4ODkxNjc0MTAwMHwwMWEwODNiZi0zNzdjLTcyMGQtODk0Yy03ZDE2ODExYTFiYjM/replay` with `{"regenerate_id":false}` | 200. Consumer answered `{"received":true,"duplicate":true}`. |
| 5 | Same delivery, `{"regenerate_id":true}` | 200. Consumer answered `{"received":true,"duplicate":false}`. New inbox row, zero new ledger effects. |

Production inbox rows come from read-only `psql` sessions (`SET default_transaction_read_only = on`) against the production Neon database. The `.env.local` `DATABASE_URL` points at a different Neon branch that holds none of the production deliveries.

## 1. Webhook config

From `01-webhook-get.json`:

- `id`: hook_gO3nsBQBCSyzF, `resource_id`: biz_RlL9WP9TIBVXmr (platform account)
- `url`: https://ledgerly-afneymans-projects.vercel.app/api/whop/webhook
- `enabled`: true, `consecutive_failures`: 0, `failing_since`: null, `created_at`: 2026-09-08T16:58:04.725Z
- `api_version`: v1, `api_version_date`: 2026-09-06
- `child_resource_events`: true
- `events` (8): payment.succeeded, payment.failed, refund.created, dispute.created, transfer.completed, payout.created, payout.updated, account.updated
- `webhook_secret`: null on GET (the API shows it once, at create time)
- `testable_events`: 84 unique names, all 8 subscriptions included

## 2. Test events

One `POST /webhooks/{id}/test` per type, each with its own `Idempotency-Key`. Whop returned 200 with `success: true`, `status: 200` and the consumer's body for every type.

| Event | Sent at (UTC) | Whop request id | Consumer body | Envelope id | Inbox status |
| --- | --- | --- | --- | --- | --- |
| payment.succeeded | 22:58:19.359 | 08dc5495-cf62-4de7-b6bb-67f87db5d20a | received, not duplicate, decoded:false | msg_BzJGsDcg5lg12dXhUqcwpnIj | failed |
| payment.failed | 22:58:19.777 | f52c809a-6150-42fb-b9f6-a564c8651bf0 | same | msg_HkFVFjI4BprpXA2V7iUDpReC | failed |
| refund.created | 22:58:20.096 | ebad4817-418e-42cc-91b2-df5fd0e4aaca | same | msg_VZksQWeai7eixvWu62NjThX4 | failed |
| dispute.created | 22:58:20.470 | 9cb8f6c8-0fc9-410b-af25-16eef5cd92b8 | same | msg_MqE0UQjnUGN2OR0R8Cl5dCA8 | failed |
| transfer.completed | 22:58:20.810 | 47b03f1b-a41c-46fc-abb4-4b86465aa059 | same | msg_O32tOkpFQ4i6ProKmYxDbIjY | failed |
| payout.created | 22:58:21.262 | 1cd719df-8209-4a8d-b79a-32162053dccd | same | msg_A2U0aQeQHckSm4B7xNVhdUCU | failed |
| payout.updated | 22:58:21.668 | b52cb017-a37f-46c9-89aa-dc4b44cd7e4b | same | msg_SjJ5evoUFEHWKc8pBaH8vJxF | failed |
| account.updated | 22:58:21.979 | bd5a256e-1ec1-4888-8440-54a7ae33327e | same | msg_zg9TJbDfxE4ArEsRcDxPuSDT | failed |

Every inbox row carries the same stored error: `account_id: Missing account_id for this version`. Section 5 explains it.

## 3. Payloads, one per event type

Directory `payloads/`. Each file holds the source, the envelope and the full `data` object. Redacted fields show `[REDACTED]`; emails show `[REDACTED_EMAIL]`. `client_secret` was already null in every sandbox payload. In `billing_address` objects the `name`, `line1` and `postal_code` fields are redacted for every buyer; `city`, `state` and `country` stay. The same rule was applied to the delivery lists in `02-deliveries-before.json` and `08-deliveries-after-replay.json`. The `user.name` and `owner.name` fields still carry the sandbox account owner's display name; no street address remains anywhere in this directory.

| File | Source | Test-generated |
| --- | --- | --- |
| `payment.succeeded.json` | Real delivery whdel_MTc4ODkxNjc0MTAwMHwwMWEwODNiZi0zNzdjLTcyMGQtODk0Yy03ZDE2ODExYTFiYjM, pay_OM3X8c0ycF5ytM, sent 2026-09-09T01:19:01Z | No |
| `account.updated.json` | Real delivery whdel_MTc4ODkwNTIxMjAwMHwwMWEwODMwZi00YjE5LTcwOGEtYmIxMC1mMmNhZTU0OWE0NDk, biz_8dB7THK4woBs43 (BR seller), sent 2026-09-08T22:06:52Z, carries `previous_attributes` | No |
| `payment.failed.json` | Production inbox row for the test send | Yes |
| `refund.created.json` | Production inbox row for the test send | Yes |
| `dispute.created.json` | Production inbox row for the test send | Yes |
| `transfer.completed.json` | Production inbox row for the test send | Yes |
| `payout.created.json` | Production inbox row for the test send | Yes |
| `payout.updated.json` | Production inbox row for the test send | Yes |

`payloads/test/` keeps all 8 test bodies, including the test versions of payment.succeeded and account.updated, so the real and test shapes can be compared side by side.

Whop's `GET /deliveries` did not record the test sends at any of the polls after the sends: 22:58:31Z, 22:59:27Z and 23:00:39Z (`03-deliveries-polls-after-tests.json`), 23:03:33Z (the `08-deliveries-after-replay.json` snapshot, five minutes after the sends) and a late recheck at 23:14:30Z (`10-deliveries-late-poll.json`, 16 minutes after the sends). The late recheck searched the full list for all 8 test envelope ids and for placeholder `_xxxxxxxxxxxxxx` ids and found none. The test bodies therefore come from the consumer's own `webhook_inbox` table, where the signed body is stored verbatim as `raw_body`.

No real sandbox deliveries exist for the other six types on this webhook. The sandbox has produced only payment.succeeded and account.updated events for this platform so far.

## 4. Replay

Target: the real payment.succeeded delivery for pay_OM3X8c0ycF5ytM (envelope msg_I4sXXdsA4Pgqohb57xWuRdBH), processed by the consumer on 2026-09-09T01:19:02Z.

Before (`04-replay-before-state.txt`, 23:03:19Z): one inbox row (processed), one business effect `payment:pay_OM3X8c0ycF5ytM:succeeded`, two ledger entries (payment 2668 USD seller side, fee 232 USD platform side).

Replay A, keep the original id (`05-replay-keep-id.json`, 23:03:20Z): Whop re-sent the exact body under the same `webhook-id` msg_I4sXXdsA4Pgqohb57xWuRdBH. Whop recorded delivery whdel_MTc4ODk5NTAwMDQ3NXwwMWEwODg2OS01OTM1LTc1MzktOTcxYi02YjQ4ZWU4YmQ2OGI with `replayed_from` set. The consumer answered 200 `{"received":true,"duplicate":true}`. The inbox insert hit the existing primary key. Nothing was reprocessed.

Replay B, `regenerate_id: true` (`06-replay-regenerate-id.json`, 23:03:24Z): Whop re-sent the same body under a fresh `webhook-id` msg_4aSWcAouYIxCsoKDTgEic9uo, in both the envelope and the signed headers. Whop recorded delivery whdel_MTc4ODk5NTAwNDAwOXwwMWEwODg2OS02NzQ1LTdhNzItYmJkYS1lNTZmNzRkMjhlNGQ. The consumer answered 200 `{"received":true,"duplicate":false}`, stored a second inbox row and processed it at 23:03:24.809Z.

After (`07-replay-after-state.txt`, 23:03:32Z): two inbox rows, both processed. Still one business effect. Still two ledger entries. The effect key `payment:pay_OM3X8c0ycF5ytM:succeeded` is the primary key of `business_effects`, so the second decode of the same payment applied nothing to the ledger.

Difference in one line: the same-id replay is dropped at the delivery layer (`duplicate: true`); the regenerated-id replay passes the delivery layer (`duplicate: false`) and is dropped at the effect layer (no new ledger rows). Both layers held on production.

`09-replay-delivery-records.json` holds Whop's two delivery records for the replays.

## 5. Why the consumer answers `decoded: false` for test payloads

Code read: `apps/web/src/lib/service-http.ts`, `packages/whop/src/envelope.ts`, `packages/whop/src/webhooks.ts`, `packages/core/src/services/inbox.ts`.

What the test body looks like (`payloads/test/*.json`): top-level keys are `api_version`, `api_version_date`, `data`, `id`, `timestamp`, `type`. There is no `account_id` and no `company_id`. The `data.id` values are placeholders such as `pay_xxxxxxxxxxxxxx`, `rf_xxxxxxxxxxxxxx`, `dspt_xxxxxxxxxxxxxx`, `ctt_xxxxxxxxxxxxxx`, `wdrl_xxxxxxxxxxxxxx`, `biz_xxxxxxxxxxxxxx`. A real delivery on this pin carries `account_id: biz_...` at the top level (see `payloads/payment.succeeded.json` and `payloads/account.updated.json`), which matches the envelope documented in `developer__guides__webhooks.md` for pins from 2026-08-14.

What the consumer does, in order:

1. `verifyStandardWebhook` checks the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers against the raw body with the `ws_` secret. The test sends pass this check. A failed signature would have returned 401 `{"error":"signature"}` and Whop would have reported `success: false`.
2. `decodeEnvelope` parses the JSON and validates it with `envelopeSchema`. The schema's `superRefine` picks the account field by pin: `account_id` when `api_version_date >= 2026-08-14`, `company_id` otherwise. The webhook is pinned 2026-09-06, the test body has no `account_id`, so validation fails with issue `account_id: Missing account_id for this version`. The error carries paths and messages only, never values.
3. `receiveWebhook` in `inbox.ts` handles a signed but undecodable body by inserting an inbox row with status `failed` and the value-free error string, then returns `{ decoded: false }`. The comment in that branch names Whop's dashboard test event as the expected case.
4. `handleWebhook` maps that to HTTP 200 `{"received":true,"duplicate":false,"decoded":false}`. The `decoded` field is only present on this path. It does not schedule `processInbox`, and `processInbox` skips any row whose status is not `received`, so a failed row is terminal.

Is this correct for synthetic test bodies? Yes.

- The consumer routes every event to a seller by the envelope's account. Without `account_id` there is no seller to route to, and the placeholder `data.id` values match no order, payment, transfer or payout. Decoding and processing these bodies could only produce quarantined rows or false ledger writes.
- The 200 tells Whop the endpoint is reachable and the signature verified, which is what the test endpoint measures. A 4xx would show as a failed test and, on a real delivery, would trigger Whop's retry schedule for a body that can never succeed.
- The row is kept, so the exact body Whop generated is inspectable later. That is how this README obtained the test payloads.
- The response says `decoded: false` explicitly, so a reader of Whop's delivery log or the test result can tell a stored-but-unprocessed test body from a processed real one.

Limit of the test path: a test send proves signature verification, storage and acknowledgement. It does not exercise decode, seller routing or ledger effects. The real payment.succeeded and account.updated deliveries, and the two replays in section 4, cover those.

## Other observations

- Whop's `GET /deliveries` does not list test sends. Only real deliveries and replays appear there. The test endpoint returns the consumer's status and body inline instead.
- The delivery history holds 12 failed attempts (HTTP 500, `Invalid JSON response`) between 2026-09-08T16:58Z and 17:09Z, before the consumer was live. Whop's retries and four earlier replays (one on 2026-09-08T17:39Z with `duplicate: false` because the original had failed, three with `duplicate: true`) then succeeded. Not part of this run.
- Unrelated real deliveries arrived during this run from other lanes: payment.succeeded for pay_ELe6ONlgjrYv5Z at 23:02:54Z and another at 23:04:57Z. The consumer processed both.
- Production inbox counts at 23:05Z: processed 13, failed 11, quarantined 18. The 11 failed rows are the 8 test sends from this run plus 3 earlier undecodable deliveries. Other lanes were still producing payments, so the processed count moves.

## Files

- `01-webhook-get.json`: webhook config readback.
- `02-deliveries-before.json`: full delivery list before the tests (44 rows, redacted).
- `03-deliveries-polls-after-tests.json`: counts from the before poll, the three polls after the tests and the after-replay snapshot.
- `04-replay-before-state.txt`, `07-replay-after-state.txt`: production inbox, effect and ledger rows for pay_OM3X8c0ycF5ytM around the replays.
- `05-replay-keep-id.json`, `06-replay-regenerate-id.json`: replay calls and Whop's responses.
- `08-deliveries-after-replay.json`: full delivery list after the replays (47 rows, redacted).
- `09-replay-delivery-records.json`: Whop's delivery records for the two replays.
- `10-deliveries-late-poll.json`: counts from the late recheck at 23:14:30Z. The raw list was not kept.
- `test-events/<type>.json`: the 8 test calls and Whop's responses.
- `payloads/<type>.json`: one payload per required type. `payloads/test/<type>.json`: all 8 test bodies.
