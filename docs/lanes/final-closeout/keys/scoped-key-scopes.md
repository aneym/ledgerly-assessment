# Scoped platform key: missing permission statements

Key: "Ledgerly minimum scope" (`apik_wk41....9096`), created 2026-09-10, on `biz_RlL9WP9TIBVXmr`.
All probes ran against `https://sandbox-api.whop.com/api/v1` with `Api-Version-Date: 2026-09-06`.
Raw request/response pairs are in `scoped-key-probes/*.json` (secrets and tokens redacted).

## Dashboard granted-statements list: not obtainable

Opening this key's "View" detail (the screen that lists granted permission statements) triggers
a "Verify your identity" security-code challenge on the dashboard. That challenge needs Alex's
own 2FA action. The audit did not attempt it and closed the dialog without proceeding, since
completing a 2FA challenge is outside a read-only audit and outside this agent's authority.
The "Details" menu item on the same row instead reveals a longer prefix of the raw key than the 4+4 mask (not copied here)
in a hover flyout; the audit did not open or screenshot that either, and did not copy the value.

So this file has no independent "granted list" to diff against. The findings below come entirely
from live probes against the sandbox API, which is the authoritative source anyway: each denial
below is the API's own error message naming the missing permission.

Note: `README.md` in this same directory records that an earlier pass in today's assessment did
clear this same "Verify your identity" prompt, for the two older keys, by reading a six-digit
code from Alex's email. This audit's brief did not ask for that step, so it was not repeated here
without a direct instruction. If a dashboard cross-check is still wanted, that is the path: expect
the emailed code from no-reply@whop.com.

## Missing statements, confirmed by exact error text

| Action string | Surfaced by | Evidence file |
|---|---|---|
| `payout:transfer:export` | `POST /account_links` (both `account_onboarding` and `payouts_portal` use cases) | `create-account-link-onboarding-de.json`, `create-account-link-payouts-portal-us.json` |
| `company:authorized_user:read` | `GET /transfers/recipients` | `list-transfer-recipients.json` |
| `payment:dispute:read` | `GET /disputes` | `list-disputes.json` |
| `company:update_child_fees` | `POST /fee_markups` | `create-fee-markup-de.json` |

Exact quoted messages:
- account_links: "This API key is not authorized to scope to the following action: payout:transfer:export. Update your API key permissions to include this action."
- transfers/recipients: "Company API key is not authorized for the company:authorized_user:read scope."
- disputes: "Company API key is not authorized for the payment:dispute:read scope."
- fee_markups: "You do not have permission to perform this action. Required permission: company:update_child_fees"

## Missing statements, denial confirmed but action name not given by the API

Two calls returned a bare 403 "You are not authorized" with no action string. Both operations
appear only once in the 259-row `/api_keys/permissions` catalog fetched by this key
(`list-api-key-permissions.json`), so the single matching action is the most likely gap, but this
is inference, not a quoted error:

| Operation | Error | Best-match candidate action |
|---|---|---|
| `POST /checkout_configurations` | "You are not authorized" | `checkout_configuration:create` |
| `GET /fee_markups` (list) | "You are not authorized" | `company:update_child_fees` (same action as create, above; not a separate gap) |

Treat `checkout_configuration:create` as unconfirmed until Alex adds it and the create call is
retried, or until the dashboard granted-list is read after Alex clears the 2FA gate.

## Statements Alex should add

1. `payout:transfer:export`
2. `company:authorized_user:read`
3. `payment:dispute:read`
4. `company:update_child_fees`
5. `checkout_configuration:create` (unconfirmed; verify by retrying checkout configuration creation after adding it)

## Operations that passed with the current key

All of these returned 200 with the adapter's exact production body/query shape:

- `GET /accounts/{id}` — platform, US, DE, BR sellers, and the probe account created below
- `PATCH /accounts/{id}` — update on the probe account
- `POST /accounts` — create/fetch account (harmless probe)
- `GET /webhooks?company_id=...`, `GET /webhooks/{id}`, `GET /webhooks/{id}/deliveries`
- `GET /payments/{id}`, `GET /payments/{id}/fees`, `GET /payments?account_id=...`
- `GET /ledger_accounts/{id}`
- `GET /transfers?origin_id=...`, `GET /transfers?destination_id=...` (both empty lists, no items to fetch by id)
- `GET /financial-activity?account_id=...` (seller and platform variants)
- `GET /refunds?payment_id=...` (empty list)
- `GET /payouts?account_id=...` (empty list)
- `GET /payout_methods?account_id=...` (empty list)
- `GET /payouts/supported_methods?account_id=...` (empty list)
- `GET /api_keys/permissions` (259-row catalog)
- `POST /access_tokens` — scoped short-lived token, exact production `scoped_actions` array

## Operations that could not be judged

- `POST /transfers` (platform → BR seller): returned 400 "You cannot transfer funds out of your
  pending balance. Please wait for your funds to settle and try again." This is a balance
  business rule, not a scope check, and it fires before any permission is evaluated. Recorded as
  unknown, blocked by balance, per the audit brief.
- `POST /webhooks/{id}/test`: not probed. The Owner-scoped key already fired a test event today;
  a duplicate fire was excluded from this run per instructions.
- `POST /accounts/{id}/suspend`: not probed. Prohibited by the audit brief.
- Account link creation was probed for `account_onboarding` (DE) and `payouts_portal` (US); both
  failed on the same missing `payout:transfer:export` action before reaching any onboarding-specific
  check, so whether a second, narrower onboarding-only permission also exists is unknown until
  `payout:transfer:export` is added and the calls are retried.
- Checkout configuration creation's true action name is unconfirmed (see above).

## Harmless resources created during this audit

- Probe account: `biz_OA3UzgqDoK6bsz`, parent `biz_RlL9WP9TIBVXmr`, email
  `[email redacted]` (Alex's own address plus a fictional tag),
  country updated to US via a follow-up PATCH. Safe to leave or delete; it holds no real data.
- Short-lived access token (15 minutes from issuance, already expired by the time this file was
  written). Token value was never logged; only its expiry timestamp is in the evidence file.
- No fee markup, checkout configuration, account link, or transfer was actually created; all four
  of those write attempts failed with the errors above, so nothing exists to clean up from them.

## Files

- `scoped-key-probes/*.json` — one file per probe, request body + redacted response + status.
- `scoped-key-probes/_summary.json` — all probes in one file.
