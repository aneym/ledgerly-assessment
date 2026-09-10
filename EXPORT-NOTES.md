# Export boundary

Prepared from the reviewed source snapshot identified in the external review manifest. This folder contains source files only and has no private Git history. A new repository must start with this content as a fresh initial commit.

Included: web application and tests, core/database/provider/demo/evidence libraries, migration SQL and journal, exact workspace dependency lockfile and Next patch, local runtime scripts, synthetic catalog and webhook test vectors, required evidence schemas, approved debugging prose and third-party notices.

Excluded: `.workflow`, private ledgers and worklogs, root evidence archives, original assessment attachment, provider response captures, live credential helper scripts, recording/screenshot archives, review-hub, historical decks, original Git data, configured environment files and personal/real-provider identifiers. The original assessment attachment is omitted because it is not required at runtime and redistribution permission is not established.

Privacy adaptations: reserved test-domain emails; synthetic provider IDs in seeds and matching assertions; loopback origin examples; fictional initial-letter SVG avatars; private handoff pages replaced with an export notice; minimal local deck landing page; one captured earnings-response test changed to an explicitly synthetic response. Account suspension behavior retains a synthetic example rather than the original provider identity. Captured-provider contract suites, private deck/media tests and two capture-dependent payout-session suites are omitted. SDK boundary/refusal tests remain; the vendored-byte test is omitted because the bundle itself is not redistributed.

These adaptations define a smaller source distribution, not a claim that omitted checks passed. The private application, its recorded evidence, current deployment and Linux CI status have separate acceptance records. This export is not a reproduction of its public media packet.

The public fake signing value in `tests/qa/fixtures/webhook_vectors.json`, test-only passwords, adversarial secret detector strings and invalid authentication examples are intentional fixtures. The ordinary local launcher generates ephemeral signing values instead. No captured provider payload is included.

No GitHub repository has been created by this preparation lane. Proposed name: `aneym/ledgerly-assessment`. Publication requires review of this exact content and the owner-controlled license disposition.

## 2026-09-09 refresh: new content, drift repair, deny list

### New files added (disposition `unchanged`)

- `docs/readme/**` (21 files: 20 PNG screenshots plus `index.json`). These are binary images; the text-based secret scan (`rg`) does not meaningfully inspect them. They were not separately reviewed frame-by-frame in this pass and are added on the strength of team direction, not an independent image review. Flag for a human visual check before publish if that hasn't happened elsewhere.
- `docs/lanes/final-closeout/**` (273 files). Already secret-scanned by the integrator per team direction; rescanned again here regardless (see Secret scan section below), which surfaced 9 hits, all reviewed and documented in `export-scan-allowlist.json`.
- `docs/answers/README.md`, `docs/answers/dx-findings.md`, `docs/answers/improvements.md`. Note: `docs/answers/debug.md` was already present in the manifest from an earlier export pass (disposition `unchanged`); it was not added by this refresh and was not reviewed as part of it.
- `apps/web/scripts/reconcile.ts`, `apps/web/scripts/reconcile-format.ts`, `apps/web/test/scripts/reconcile-format.test.ts`.
- The sweep fix files (`packages/whop/src/sandbox-adapter.ts`, `packages/core/src/services/transfers.ts`, and their tests `packages/whop/test/sandbox-adapter.test.ts`, `packages/core/test/services/transfers.test.ts`) were already in the manifest (disposition `unchanged`) before this refresh; no manifest change was needed for them, they refresh automatically.

Because `package.json` now ships `apps/web/scripts/reconcile.ts`, the `reconcile` script entry in the exported `package.json` (previously stripped) is restored — see below.

### Drift review of the 8 previously "adapted" files

All 8 had drifted (private source content differs from the `source_sha256` recorded at last export). Each was investigated by locating the historical source commit whose content matches the recorded hash, diffing that against the untouched export copy to recover the exact transformation, then re-deriving from the CURRENT private source. Findings:

**No content change needed** (transformation output is invariant to the drift, or the drift is immaterial):
- `.gitignore` — current source only removed two trailing lines (`.local-runtime/` and its comment) relative to the version the export was built from. The exported `.gitignore` never carried those lines either way; no update needed.
- `apps/web/src/app/(storefront)/handoff/engineering/page.tsx` and `.../handoff/evidence/page.tsx` — both are `export { default } from "../page"`. The transformation replaces the entire private page with this re-export regardless of what the private page contains, so further drift in the private source cannot change the output.
- `apps/web/src/app/(storefront)/handoff/page.tsx` — replaced wholesale with a fixed, generic handoff-notice stub, for the same reason: the transformation discards the private page's content entirely rather than editing it.
- `docs/presentation/final/index.html` — replaced wholesale with a fixed minimal landing stub, same reasoning.

**Important discrepancy from the brief this refresh was scoped against:** the instruction to refresh these files described the handoff-page transformation as "the aneym/ledgerly private links; re-point them to the matching path in aneym/ledgerly-assessment where the file exists in the export, else drop the link text." That is not what the actual export does. Three of the four handoff pages (`handoff/page.tsx`, `handoff/engineering/page.tsx`, `handoff/evidence/page.tsx`) are wholesale-replaced generic stubs, not link-rewritten copies of the original evidence-heavy pages, which currently run to roughly 800+ lines of private QA evidence content each. Mechanically applying the described link-rewrite to the current private source would republish substantial private evidence content that the actual export has never shipped. This refresh preserved the safer, actually-shipping behavior (wholesale stub, no content change) instead of the literally-described one. Flagging this rather than guessing which was intended.

**Content regenerated from current source** (mechanical transformation reapplied):
- `apps/web/next.config.ts` — current source's `allowedDevOrigins` line is unchanged from the version the export was built from (only two unrelated comments were reworded elsewhere in the file). Refreshed the file to current source wording throughout, then reapplied the existing redaction: `studio.tailf266ac.ts.net` and `100.107.143.41` (the private tailnet host/IP) replaced with a second `localhost`/`127.0.0.1` pair, matching the pattern already used in the shipped export.
- `package.json` — current source's only change from the version the export was built from was adding the `reconcile` script. Refreshed to current source's `scripts` block, removed `verify:docs` and `whop:sync-docs` (not published, per the existing adaptation policy), kept `reconcile` (now appropriate since `reconcile.ts` ships in this refresh), and kept the export's existing `dev:mock` entry (`node scripts/local-runtime/start.mjs`, which points at the already-exported local-runtime scripts).
- `apps/web/src/app/(storefront)/handoff/scenarios/page.tsx` — current source re-added a `DemoVideo` import and an `asc-recording` section (a video walkthrough) plus changed the simulation-limits sentence to reference "Sandbox records ... evidence record". Reapplying the existing transformation (drop the `DemoVideo` import and `asc-recording` section; replace the sentence with "Private provider captures are excluded from this source export. See the evidence limits.") produced a file byte-identical to what was already exported, since the parts of the page the transformation preserves (nav, header, metadata) had not changed. No file edit was ultimately required; `source_sha256` in the manifest was updated to the current source hash so future drift detection has a fresh baseline.

For all 8 files, `EXPORT-MANIFEST.json`'s `source_sha256` was updated to the current private-source hash, whether or not the exported content itself changed, so the drift check in `export.sh` reflects today's review rather than re-flagging content already accounted for.

**Note on `app-ui-fixes` being a live worktree:** between the drift review above and the second dry run, `handoff/page.tsx` and `handoff/evidence/page.tsx` changed again in the private source (another session actively edits this worktree; `handoff/page.tsx` grew to a ~780-line page with real seller IDs, payment IDs, and readback paths, confirming the "800+ lines of private evidence content" estimate above). The exported files were re-checked against this newer content: both are still the wholesale generic stub (`handoff/page.tsx`) or re-export (`handoff/evidence/page.tsx`), unchanged and still correct for the same invariance reason. Only `source_sha256` was bumped again to the latest hash. Because the source worktree can keep moving under a rerun, a future run may report the same two paths as drifted again; that is expected and does not by itself mean the export needs new content, only a re-check that the shipped stub is still the right call.

### Deny list

`export.sh` now hard-codes `DENY_PREFIXES` (`fixtures/`, `tests/qa/e2e/`, `.workflow/`) and asserts on every run that no manifest entry sits under one of those prefixes unless it is in an explicit `GRANDFATHERED_PATHS` list. This is a guard against a *new* subdirectory or file slipping in automatically (via a future manifest edit or a directory becoming "known" some other way), not a retroactive purge: the 4 pre-existing, individually reviewed `fixtures/demo/*.json` entries (`catalog.json`, `display-names.json`, `sellers.json`, `test-users.json`) are grandfathered and continue to refresh normally. The "new candidates" report also now labels anything under a denied prefix as `DENIED` (never auto-added, no review path) instead of `NEW` (not copied, but reviewable).

### Secret scan allowlisting

`export.sh`'s secret scan now checks every hit against two reviewed sources before failing:
1. `tests/qa/fixtures/secret_scan_allowlist.json` in the private source tree (exact fixture values/prefixes; this file itself is not exported, so it's read from `SOURCE_REPO`, not the export). It covers 4 of the 41 hits found in this run.
2. `export-scan-allowlist.json`, new, next to `export.sh`. It documents the other 37 hits from the main scan plus the 9 hits found in `docs/lanes/final-closeout/**`, each with the file, the exact matched substring, and a one-line reason.

`docs/lanes/evidence/redaction-allowlist.json` was reviewed for reuse per the original brief but not wired in as a scan-ignore source: it documents non-secret ID prefixes and the secret *patterns* the evidence recorder must never emit (a must-catch reference), not a list of values a scanner may ignore. It's cited for context in `export-scan-allowlist.json`'s header instead.

Any hit not covered by either source still fails the scan and blocks staging.
