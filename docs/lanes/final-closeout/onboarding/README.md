# Onboarding evidence: DE seller biz_fuyI21F4iaNTDu

Screenshots for this item are in `../runs/onboarding/`; the repo docs verifier keeps lane captures under `runs/`.

Run started 2026-09-09T22:54:05Z. All calls went to https://sandbox-api.whop.com/api/v1 with Api-Version-Date 2026-09-06. Result: partial. The hosted flow stopped after the Sumsub document upload step. The operator saw Sumsub move to step 2 of 3 (liveness) and a browser camera permission prompt; no screenshot captured that state.

## What ran

| # | Time (UTC) | Call or action | Status | Result |
|---|---|---|---|---|
| 1 | 22:58:01 | GET /accounts/biz_fuyI21F4iaNTDu | 200 | verification.individual null; required action verify_identity with empty blocked_capabilities; payouts and transfer inactive. File 01-before-DE. |
| 1 | 22:58:09 | GET /accounts/biz_pt7b2NAryKwRGh (US control) | 200 | verification.individual null; verify_identity blocks six capabilities. File 01-before-US. |
| 2 | 22:58:42 | POST /account_links {account_id, use_case account_onboarding, return_url, refresh_url} | 200 | url plus expires_at 23:58:42Z. The signed URL is withheld from evidence. File 02. |
| 3 | 22:59 | Browser: opened the link. Page "Verify identity", step "Personal details". | | step-01-landing.png |
| 3 | 23:00 | Browser: filled fictional data. Country Germany changed the form: SSN became "Tax identification number", Address line 2 appeared. Phone picker set to DE (+49). Clicked Continue. In step-02 a Dashlane browser-extension popup ("Unlock Dashlane to log in") covers part of the Country and Address line 1 fields. It is not Whop UI. "Germany" and "Musterstrasse" are still legible beside it. | | step-02-personal-details-filled.png, step-03-after-continue.png |
| 4 | 23:01:06 | GET /accounts/biz_fuyI21F4iaNTDu | 200 | verification.individual became {status: pending}. required_actions title changed to "Complete your identity verification" and blocked_capabilities filled with standard_payout, instant_payout, crypto_payout, transfer, bank_deposit, card_issuing. payment_controls.undated_pending_reason went from null to kyc_incomplete. capabilities unchanged. File 03. |
| 5 | 23:01 | Browser: Sumsub WebSDK iframe (host api.sumsub.com). Consent dialog "Agree and continue", then "Start verification". The Sumsub ID switch needs an email when on; turned it off (operator narrative, no screenshot shows that switch). | | step-04-sumsub-consent.png, step-05-sumsub-first-step.png |
| 6 | 23:02 | Browser: Sumsub step 1/3, issuing country Germany, document type Passport, Continue. Upload page accepts JPG, PNG, HEIC, WEBP up to 50 MB. | | step-06-sumsub-document-upload.png |
| 7 | 23:03 | Browser: attached test-doc-placeholder-fictional.png (plain grey card, no text). Sumsub rejected it before upload: "Something went wrong. The details in your document are difficult to read." | rejected | step-07-sumsub-file-selected.png |
| 7 | 23:03:25 | GET /accounts/biz_fuyI21F4iaNTDu | 200 | no change. File 04. |
| 8 | 23:04 | Browser: attached test-doc-specimen-fictional.png (block letters SPECIMEN, NOT A REAL DOCUMENT, empty photo box). Sumsub showed "Uploaded" and a Continue button. | accepted at upload | step-08-sumsub-specimen-selected.png |
| 8 | 23:04:46 | GET /accounts/biz_fuyI21F4iaNTDu | 200 | no change; still pending. File 05. |
| 9 | 23:05 | Browser: clicked Continue. The operator saw Sumsub move to step 2 (liveness) and the browser raise a camera permission prompt. ego-browser handed control to the user. No screenshot of this state exists. The last screenshot (step-08) shows Sumsub step 1/3 with the document marked Uploaded and a Continue button. The step-2 claim rests on the operator's narrative only. | stopped | none |
| 10 | 23:05:04 | GET /verifications?account_id=biz_fuyI21F4iaNTDu | 200 | identity profile idpf_FQ3ePvAVNSXzz, kind individual, status pending, the fictional name, DOB, address and phone as entered, requested_information empty, session_url at in.sumsub.com/websdk/p/sbx_... (redacted). File 06. |
| 11 | 23:05:21 | GET /accounts/biz_pt7b2NAryKwRGh (US control) | 200 | verification, required_actions and capabilities equal to step 1. Other fields changed: total_earned_usd 125.0 to 150.0, total_usd and balance.balance 106.85 to 128.22, and a second pending settlement of 21.37 dated 2026-09-11 appeared. This run made no call against the US seller other than the two GETs. A concurrent item (the direct charge on the US seller) most likely caused it. File 07. |

transitions.json holds the per-step verification, required_actions and capabilities snapshots with the diff list.

## What changed on the DE account

- verification.individual: null, then {status: "pending"} after the personal-details form. It stayed pending through the document steps.
- required_actions: one verify_identity action throughout. After the form, its title changed and blocked_capabilities went from [] to six entries. This is the same shape the US seller had from the start.
- capabilities: no change. accept_card_payments, accept_bank_payments, crypto_deposit, card_deposit and run_ads active; standard_payout, instant_payout, crypto_payout, transfer, bank_deposit, card_issuing, accept_bnpl_payments inactive.

## The wall

Sumsub step 2 of 3 is a webcam liveness check. It needs a real camera stream and a browser camera permission grant. The CLI cannot drive it. A person must open the tab (ego-browser space 4, page p1) or the seller's hosted session and finish liveness, then step 3 (personal information, already prefilled). Only after Sumsub approval can verification.individual move past pending. Whether standard_payout and transfer then activate in sandbox is not known: docs/sources/whop/developer__guides__sandbox.md lists "Payouts - Payout functionality isn't available yet" under sandbox limitations. Those capabilities may stay inactive in sandbox even after approval. The platform account biz_RlL9WP9TIBVXmr does show them active, so activation is possible, but that account's path is not on record here.

## What the sandbox accepted and rejected

- Sumsub runs a readability pre-check on the document image at selection time. A blank card was rejected. A card with legible block text was accepted at the upload step. This shows the check reads the image; it is not a sandbox that accepts any file.
- The Sumsub session permalink from the Verifications API has the form in.sumsub.com/websdk/p/sbx_... The sbx_ prefix is not a sandbox signal: docs/sources/whop/developer__verification__overview.md shows the same prefix in its production (api.whop.com) example. The embedded SDK loaded from api.sumsub.com and showed no sandbox banner. No test applicant, magic value or auto-approve path was found in docs/sources/whop. Nothing observed says whether this Sumsub session is a test or a production applicant.
- The Whop form defaults to United States and shows an SSN field even for a DE account until the country is changed.
- required_actions[].cta points at whop.com, not sandbox.whop.com.

## Files

- 01-before-DE-biz_fuyI21F4iaNTDu.json, 01-before-US-biz_pt7b2NAryKwRGh.json
- 02-create-account-link-DE.json (url redacted)
- 03-after-personal-details-DE.json, 04-after-doc-rejected-DE.json, 05-after-document-uploaded-DE.json
- 06-verifications-readback-DE.json (session_url redacted)
- 07-final-US-control-biz_pt7b2NAryKwRGh.json
- transitions.json
- step-01 to step-08 PNG screenshots
- test-doc-placeholder-fictional.png, test-doc-specimen-fictional.png (the two images offered to Sumsub)

Redactions, four kinds:
- response.email in the six account readbacks (01-before-DE, 01-before-US, 03, 04, 05, 07) is replaced with "[REDACTED email]". The originals were a real person's plus-addressed emails.
- owner.profile_picture.url (a query-string URL) is replaced in every account readback.
- response.url in 02-create-account-link-DE.json (the signed onboarding link) is replaced; only the host remains.
- session_url in 06-verifications-readback-DE.json (the Sumsub session permalink) is replaced; only host and path prefix remain.

No API key, bearer token, signed onboarding URL or real-person email is in this directory.

Fictional identity used: Testfirst Fictionalseller, born 1990-01-15, Musterstrasse 1, 10115 Berlin, phone +49 15123456789, website https://ledgerly-afneymans-projects.vercel.app. No real person.
