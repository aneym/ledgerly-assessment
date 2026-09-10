# Keys evidence (read-only dashboard capture, 2026-09-09)

Screenshots for this item are in `../runs/keys/`; the repo docs verifier keeps lane captures under `runs/`.

Source: Alex's logged-in sandbox.whop.com session through ego-browser, two passes (22:57Z to 23:05Z and 23:09Z to 23:15Z). No key was created, rotated, revealed or deleted. Every edit dialog was closed with Close; Save stayed disabled. No icon button in a key dialog was clicked. Details are in `keys-evidence.json`. Category lists were dumped from the dialog DOM into `13-de-key-all-categories.json` and `15-ledgerly-key-all-categories.json`.

## Platform key Ledgerly uses

The platform account biz_RlL9WP9TIBVXmr holds two Company API keys: `full` (apik_uUar....409d) and `ledgerly` (apik_f6to....de0b). A script matched the configured WHOP_API_KEY to `ledgerly` by masked prefix and suffix; the value was not printed. The dashboard's key id is a prefix of the secret, so it is not recorded.

The `ledgerly` key inherits permissions from the Owner role. The edit dialog lists 53 permission categories after "Show 42 more categories". Every category shows all statements granted: 231 of 231 (for example Payment 14/14, Payout 12/12, Company 15/15, Developer 7/7, Webhook Receive 32/32). It never expires and has no IP allow-list. The `full` key is also Owner; only the top of its list was captured (screen 12). So the "minimum scopes" claim is not true for the key in use today. Screens: 01, 02, 03, 04, 15-01 to 15-09 (the full list scrolled top to bottom). DOM dump: `15-ledgerly-key-all-categories.json`.

## Per-seller key

The DE seller biz_fuyI21F4iaNTDu carries one key, `ledgerly seller DE (scoped, run-2026-09-08d)` (apik_HawA....0c8b). The dashboard shows it under the banner "You are viewing a connected account of ledgerly". Its permission mode is Custom. Of 231 statements in 53 categories, four are checked: `payment:basic:read` (screen 08), `company:balance:read` and `company:basic:read` (screen 13), `company:basic:read` and `company:create_child` (screen 14). Every other category reads 0/n. DOM dump: `13-de-key-all-categories.json`. Screens: 05, 06, 07, 08, 09, 13, 14.

The key was minted from the DE seller user's own session on 2026-09-08, not by API and not from the platform-owner session; see `docs/answers/dx-findings.md` items 7 and 22 and `packages/whop/fixtures/run-2026-09-08d/seller-key-dashboard-permission-error.json`.

## Reveal and copy controls

The DE key dialog has three icon buttons next to the masked key: rotate, copy, trash. No eye icon. The platform key dialogs (`ledgerly`, `full`) have four: rotate, crossed eye, copy, trash. So the dashboard offers a reveal control on the platform keys and not on the DE key. No icon was clicked. What the eye shows and what the copy button copies (id or secret) were not tested.

## Isolation curls

Not run on 2026-09-09. The DE key's secret cannot be obtained from its dialog without rotating it, and the brief only allowed creating a key when none existed. The committed evidence from run-2026-09-08d is on `main` (worktree /Volumes/StudioExt/repos/ledgerly-worktrees/app-ui-fixes, HEAD 3c569de, fixtures committed in 0cdf4eb) under `packages/whop/fixtures/run-2026-09-08d/`:

- `seller-key-scoped-accounts-de.json`: GET /accounts/biz_fuyI21F4iaNTDu, 200
- `seller-key-scoped-accounts-br.json`: GET /accounts/biz_8dB7THK4woBs43, 404 "Account not found"
- `seller-key-scoped-accounts-platform.json`: GET /accounts/biz_RlL9WP9TIBVXmr, 404 "Account not found"
- `seller-key-scoped-accounts-nested-post.json`: POST /accounts with parent_company_id biz_fuyI21F4iaNTDu, 400 "A connected account cannot create its own connected accounts"
- `seller-key-accounts-de.json`: the same GET with a two-statement key (payment:basic:read, company:basic:read), 403 "not authorized for the company:balance:read scope"
- `seller-key-accounts-nested-post.json`: POST /accounts with the two-statement key, 403 "not authorized for the company:create_child scope"

Authorization headers in those fixtures read `Bearer <redacted>`. Prose summaries: `docs/answers/dx-findings.md` items 8 and 22, `docs/lanes/architecture/sandbox-matrix.md` BUILD-06 and BUILD-21.

## Verified state

Verifications & access: personal account Verified (United States); Individual Whop Card, Virtual bank account and Payouts (Individual) Active are unlocked; company verification not started. Screen 10. The verified individual's legal name line is blacked out in the PNG; the unredacted capture was overwritten. Do not copy an earlier copy into the repo, the public export or the README.

Payments settings: 3DS challenge disabled, PayPal not set up, auto-respond and early dispute alert sections present, settings index says "1 payment protection enabled". Screen 11.

## Identity check

Opening a key's View prompts "Verify your identity" with an emailed six-digit code. One code was entered per pass (emails from no-reply@whop.com at 22:59:25Z and 23:11:01Z, per Gmail metadata; not screenshotted). Codes are not stored. Later key views within a pass did not re-prompt. The ego-browser spaces (3, then 5) were finished with `task.finish({ keep: [] })`; the finish result is in the tool log only, not in this directory.
