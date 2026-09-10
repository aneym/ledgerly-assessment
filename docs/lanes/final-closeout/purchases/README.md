# Purchases: two fresh sandbox payments through the production storefront

Screenshots for this item are in `../runs/purchases/`; the repo docs verifier keeps lane captures under `runs/`.

Run started 2026-09-09T22:54:05Z. Storefront https://ledgerly-afneymans-projects.vercel.app on release `60aa620`. Evidence revised 2026-09-09T23:20Z after review: PII redaction, buyer framing, production proof, card wording.

## Who paid

Two identities took part. Both matter.

- Ledgerly side: a fictional Better Auth account, `sample-buyer-20260909230135@example.com`, name "Sample Buyer". It was created on `/signup` because `/demo/profile/buyer` answered 404 on release `60aa620`. This session owns the two orders, the receipts and the library.
- Whop side: Alex's own sandbox Whop user, `user_Q0IiqCqFWa8vo` (username `aneyman`). The hosted checkout on sandbox.whop.com ran inside the logged-in ego-browser session, so Whop attached both payments to that user. Both payments used that user's saved payment method `payt_FZ17WahujTHTR` (Visa, last4 4242). See `payment_method_id` and `payment_instrument` in `11-*.json` and `13-*.json`.

The test card number from the docs was not typed in. The checkout page offered the saved card as the default and the run accepted it (`04-*.png`, `08-*.png`).

## Card

`docs/sources/whop/developer__guides__sandbox.md` lists 4242 4242 4242 4242 as the sandbox test card. The saved card on the sandbox user is a Visa with last4 4242. No card number was entered in this run.

## What ran

1. ego-browser opened the storefront (`00-storefront.png`).
2. `/demo/profile/buyer` answered 404. The buyer signed up on `/signup` (`02-signup-filled.png`). A Dashlane prompt covered the button; the form was submitted with Enter. `03-after-signup.png` and `04-direct-checkout-embed.png` are the same capture: the signup returned the buyer to the checkout, which redirected to the hosted page.
3. Direct flow: Grain & Gradient, seller `sel_mara` (Whop account `biz_pt7b2NAryKwRGh`, policy direct). Order `e3dd80b7-f01a-4501-b318-04cbfab646e7`, checkout `ch_pD0KKu5fXqlnS6X`, payment `pay_ELe6ONlgjrYv5Z`, 25.00 USD. `/payments/pay_ELe6ONlgjrYv5Z/fees` shows an `application_fee` line of 2.00 USD.
4. Platform flow: Onda Drum Library, seller `sel_onda` (BR, policy platform_only). Charge on the platform account `biz_RlL9WP9TIBVXmr`. Order `00b8451a-9f1c-402a-8ee0-e3824e81943f`, checkout `ch_kT3ZyYS6Jc8ehfz`, payment `pay_cxvGcm7NvjoCkV`, 60.00 USD, no application fee at charge time.
5. Both receipts render "paid" with the 8% split (`05`, `06`, `09` PNGs). GET `/api/orders/<id>` with the buyer session returns `status: paid` and the payment id for both (`07-*.json`, `10-*.json`).
6. Sandbox readbacks: GET `/payments/{id}` and `/payments/{id}/fees` for both, GET `/checkout_configurations/{id}` for both (`11`..`16`). Summary in `18-sandbox-readback-summary.json`.
7. GET `/webhooks/hook_gO3nsBQBCSyzF/deliveries?first=100` returned 48 deliveries. The two `payment.succeeded` deliveries for these payments reached the production URL and the consumer answered 200 `{"received": true, "duplicate": false}` (`19-webhook-deliveries-for-purchases.json`).
8. The buyer's library lists both purchases (`20-library.png`).
9. Revision pass: GET `/` on the production host (`22-production-home-headers.txt`, `22-production-home.html`).

## Production proof

The screenshots show no URL bar and carry a DEV pill. Do not cite them for the word "production". Cite these:

- `15-direct-checkout-config.json` and `16-platform-checkout-config.json`: `redirect_url` is `https://ledgerly-afneymans-projects.vercel.app/receipt/<orderId>` for both orders. Only the app running on that host writes that value.
- `01-webhook-get.json`: `hook_gO3nsBQBCSyzF` posts to `https://ledgerly-afneymans-projects.vercel.app/api/whop/webhook`. `19-*.json`: both `payment.succeeded` deliveries for these payments answered 200 from that URL.
- `22-production-home-headers.txt`: GET `/` on the production host at 2026-09-09T23:13:49Z answered 200 with `server: Vercel` and an `x-vercel-id`. The body (`22-production-home.html`) contains the same DEV pill markup as the screenshots.

## Why the DEV pill renders on release 60aa620

- `apps/web/src/components/shell.tsx` at `60aa620` mounts `DevPanelMount` on every storefront and buyer page.
- `apps/web/src/components/dev/dev-panel-mount.tsx` renders the pill when `process.env.DEMO_MODE === "1"` or `NODE_ENV === "development"`.
- Vercel builds with `NODE_ENV=production`. The Vercel project sets `DEMO_MODE=1` for Production, Preview and Development (`vercel env ls production` shows the variable name only, not its value, read 2026-09-09; `.env.example` at `60aa620` documents the flag). The value `1` is an inference: the gate renders only when `DEMO_MODE === "1"` or `NODE_ENV === "development"`, and the pill renders on the Vercel host where `NODE_ENV` is production.
- So the pill marks demo mode, not a dev server. main (`3c569de`) keeps the same gate.

## Observations

- Release `60aa620` redirects the buyer to the hosted checkout on sandbox.whop.com. The in-app embedded checkout is on main only. The hosted page returned the buyer to `/receipt/<orderId>` with the payment id in the query.
- The checkout-configuration readback shows `application_fee_amount: null` for the direct order. The fee is visible on `/payments/pay_ELe6ONlgjrYv5Z/fees` as an `application_fee` line of 2.00 USD. Cite the fees line, not the configuration.
- Of the 48 listed deliveries, 12 `account.updated` deliveries answered 500. They predate this run and are not from these purchases.

## Not done

- No transfer to the BR seller. The platform_transfer order is paid and waits for the transfer job.
- No refund on either payment.
- The buyer session cannot read `/api/sellers`, so `sel_onda`'s own Whop account id was not read back here.

## Redaction

- Keys named secret, signature, token, authorization, api key or signing: `[redacted]`. Signed URL queries are stripped.
- Real-person emails: `[email redacted]` in JSON. In `03`, `04` and `08` PNGs a grey box covers the Email field of the hosted checkout.
- `billing_address.*` except `country`: `[redacted]` in `11`, `13`, `17`, `19` (21 addresses, every payment payload in the raw list, not only this run's two).
- `user.name` and `owner.name`: `[name redacted]` (15 values).
- `profile_picture.url` (an avatar-generator URL that carries the name in its query): `[avatar url redacted]` (52 values).
- Kept on purpose: `user.id` `user_Q0IiqCqFWa8vo` and `username` `aneyman`, the sandbox account handle named above. Non-secret ids (biz_, pay_, payt_, ch_, plan_, prod_, mem_, whdel_, msg_) stay. The fictional example.com buyer address stays.
- Script: `scratchpad/redact_pii.py`. Rescan for name, street, city, postal code and avatar host after the pass: no hits.
