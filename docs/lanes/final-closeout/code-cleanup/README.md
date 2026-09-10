# code-cleanup evidence

Run started 2026-09-09T22:54:05Z. Worktree `/Volumes/StudioExt/repos/ledgerly-worktrees/final-code-cleanup`, branch `work/final-code-cleanup`, based on main `3c569de`. Commit `6bc47ab94c941569552ee006311574ec187e7feb`.

## Surfaces read

- `apps/web/src/app/(storefront)/handoff/**` (page, evidence, lab, engineering, scenarios, media loader, SandboxBalance, SandboxPortal, ProductGallery, source-links)
- `apps/web/src/app/present/[[...path]]/route.ts` and `apps/web/src/lib/present.ts` (serves `docs/presentation/<path>`)
- `apps/web/public/present-assets/v2/shots/**` (PNG only, not linked from /handoff or /present/final)
- `docs/presentation/final/*` (the deck at /present/final)
- Older decks under `docs/presentation/v2`, `v2r`, `v3` are not linked from /handoff. Not touched.

## Recordings that exist and play

All three final clips are on disk under `apps/web/public/demo-clips/final/`, marked `verified` in `manifest.json`, with all five checks passed and matching SHA-256. The built app served each as `video/mp4` with HTTP 200 (see `link-check.txt` and the media section below). They stay:

- `/demo-clips/final/T01-tour.mp4` (88 s)
- `/demo-clips/final/OP01-operator-recovery.mp4` (45 s)
- `/demo-clips/final/LAB01-integration-lab.mp4` (34 s)
- `/handoff/sandbox-balance/actual-sandbox-balance.mp4` (25 s, real sandbox)
- `/demo-clips/assessment-scenarios/assessment-scenarios.mp4` (56 s, scenarios page)

## Removed placeholders and narration

| File | Removed | Reason |
| --- | --- | --- |
| `handoff/page.tsx` | "Alex's walkthrough" section with `data-loom-src=""` and "I will add that soon." | Loom slot. Replaced with one line: "Customer walkthrough video: coming later." |
| `handoff/page.tsx` | `Clip` pending branch: "Recording pending verification" box and the manifest `reason` text | Placeholder slot for unverified recordings. All three clips are verified; a clip that is not ready now renders nothing. |
| `handoff/page.tsx` | "Recording source and review notes" details under each clip (manifest `notes` with TTY/stdin chatter, app and manifest revisions) | Process narration. Caption line kept. |
| `handoff/page.tsx` | "How I built it, with the dated build snapshot" block: lanes, 331 commits, 85 subagent transcripts, snapshot timestamp, stats.json link | Process narration; not product evidence. TOC entry now points to /handoff/engineering. |
| `handoff/page.tsx` | Section 4: "In local mock testing on candidate 90bedac, both embedded and hosted payout buttons returned a visible local-demo refusal..." | Worker narration. Replaced with: "The balance widget and hosted portal below render against the real sandbox balance. Sandbox payouts cannot complete; withdrawals and portal history remain unverified." |
| `handoff/page.tsx` | "These are the assessment accounts in run e... intentionally keep the assessment IDs." | Internal run naming. Shortened. |
| `handoff/page.tsx` | Testing: "passed on candidate 571a082", "PGlite/mock browser results", "Viewer and Compare checks also passed on the earlier app b2f0331", "Those changes still need acceptance on the integrated runtime." | Candidate SHAs and lane acceptance narration. |
| `handoff/page.tsx` | Checklist: "Alex's Loom pending" | Replaced with "Video coming later." |
| `handoff/page.tsx` | "What remains": "or production acceptance" | Lane wording. |
| `handoff/page.tsx` | Three scenario captions shortened to one sentence each | Mock disclaimer copy. The `Mock` tag on links stays. |
| `SandboxBalance.tsx` | "capture guard", capture source SHA `6d0fe08...`, "unchanged-speed excerpt from seconds 20 through 45", "does not display an available-zero row", "does not establish hosted portal readiness" | Worker narration. Kept: real sandbox, USD 106.85 pending, read-only operator page, token scope, image host blocked, one-line limit "Sandbox payouts cannot complete; no withdrawal was made." |
| `SandboxPortal.tsx` | "capture guard blocked ... four attempts because its pagination cursor was outside the allowed request shape", "public scripts came from inspected, pinned copies", capture source SHA `fe70d1a...` | Worker narration. Kept: balance rendered, withdrawals and history not verified, withdraw controls not clicked, screenshot only because video export failed. |
| `evidence/page.tsx` | "Alex's Loom is pending" | Replaced with "The walkthrough video comes later." No other change; the page is factual. |
| `lab/page.tsx` | "12 browser sessions and 251 distinct displayed frames... midpoint seeking all passed"; "required suite on candidate 55d153b ... 21 passes and four failures with a failed checker"; "checker and before/after health and clean-checkout checks exited 0"; "Mobile and payout-button refusal passed on 90bedac...; Desktop ... passed on b5d54b8...; five passing cases across two revisions"; "final LAB01 acceptance"; run-record filenames (`lab-viewer-actual-801aca3.md`, `required25-acceptance-571a082.md`, ...) and "pending media review" | Candidate SHAs, run-record names and lane acceptance narration. Kept: the four-run table, the five-test run id and revision, the 25-journey result, the earlier failed run, the local PGlite/mock limit. |
| `engineering/page.tsx` | `sources` report filenames per case and the "Source reports" list; test-count narration ("238 tests passed", "core 174, database 160 and Whop 243", "104 tests across nine files", "109 tests in five files", "candidate df5a24a passed workspace typecheck and build"); "Independent source review cleared both changes"; the "Media contract source" paragraph and details; "Source repairs independently reviewed." | Worker and review-lane narration. Kept: each defect, before/after, repair, proof, named test files, repair revision. |
| `scenarios/page.tsx` | Banner sentence about the September 9 readback; "Additional" label; "This does not prove provider settlement or signed webhook processing." | Mock disclaimer copy. Kept one line: "These results are simulations. They do not complete identity checks, move funds, or prove Whop delivered an event." |
| `docs/presentation/final/index.html` | Fallback text "Waiting for the verified connected seller and buyer take" / "operator recovery take" / "Lab take" (three slots) | Placeholder wording for takes that now exist. Fallback now reads "The recording did not load." and only shows if the manifest or file fails. |
| `docs/presentation/final/index.html` | Presenter cues: "T01 needs one continuous 60–75 second capture... Existing C01–C05b fragments are not a substitute"; "Replacement target is about 30 seconds... Older C08 is a dated security run"; "Do not claim production follows release until root verifies routing and current CI"; "The sandbox business id is retained from the supplied opening brief" | Worker recording instructions. Evidence limits kept as one line each. |
| `docs/presentation/final/final.js` | Presenter note appended per clip: manifest `notes` (TTY/stdin chatter) plus "Manifest reports verified; media bytes are not checked by this deck"; failure text "Its outcome remains unverified here." | Process narration. Now: caption plus app revision. |

Not removed, on purpose: status labels (Recorded, partial; Incomplete; Partial), the sanitized readback excerpts, the source-record SHA-256 lists on /handoff/evidence, the CI screenshot on deck slide 8 (Alex's own point in the talk), and the `Mock` tags.

## Tests changed

- `apps/web/test/handoff-lab.test.ts`: dropped assertions for "21 passes and four failures", "a failed checker", "251 distinct displayed frames", "final LAB01 acceptance". Added: "Its report remains a failed result" and a negative match for `pending media review|candidate|.md<`.
- `apps/web/test/handoff-sandbox-balance.test.ts`: dropped the capture-guard and capture-source SHA assertions. Added: "Sandbox payouts cannot complete; no withdrawal was made" and "image host was blocked during capture".

## Checks that ran

| Check | Command | Result | Log |
| --- | --- | --- | --- |
| Install | `pnpm install --frozen-lockfile --prefer-offline` | exit 0 | `pnpm-install.log` |
| Typecheck | `pnpm typecheck` (workspace) | exit 0 | `typecheck.log` |
| Vitest | `pnpm exec vitest run` in apps/web | 98 files, 1029 tests passed, exit 0 | `vitest.log` |
| Biome | `pnpm exec biome check` in apps/web | exit 0, 17 warnings, all pre-existing CSS specificity warnings in `handoff.css` and `globals.css` (untouched). Two touched files were formatted with `biome format --write`. | `biome.log` |
| Build | `DEMO_MODE=1 WHOP_MODE=mock pnpm build` | exit 0 | `build.log` |
| Link check | `next start -p 4471` on the build, curl of every `href` on /handoff | see below | `handoff.html`, `handoff-hrefs.txt`, `link-check.txt`, `next-start.log` |

Biome note: passing the `(storefront)` paths directly makes biome treat the parentheses as a glob and ignore them, so the check ran over all of apps/web instead. `docs/presentation/final/final.js` is outside biome's `includes`; it was not linted.

## Link check on /handoff

- 12 in-page anchors: all target ids present.
- Internal routes with HTTP 200: `/handoff/evidence`, `/handoff/evidence#latest`, `/handoff/engineering`, `/handoff/lab`, `/handoff/scenarios`, `/present/final/`, `/brand/ledgerly-mark.svg`, both `published-477a6a0` screenshots, both sandbox-balance files, both sandbox-portal files.
- `/` and `/admin` returned HTTP 500 from the bare `next start` because that process had no `DATABASE_URL` (`next-start.log`: "Error: Missing DATABASE_URL"). Both routes exist in the build route table (`build.log`). Not a missing route.
- External GitHub links: 7 to the public export `aneym/ledgerly-assessment` at pinned revision `f65ca2a`, 24 to the private `aneym/ledgerly` (labelled " · private" on the page). Not fetched.
- Media served with `video/mp4` and HTTP 200: T01, OP01, LAB01, the sandbox balance clip, and the scenarios clip. `/demo-clips/final/manifest.json` served 200.
- The rendered /handoff contains no "Recording pending", "I will add that soon", "Loom", "candidate", "run e", "Subagent" or "lanes" outside the private GitHub href paths.
- The rendered /present/final/ contains no "Waiting for", "root verifies" or "C01–C05b".

## Not done

- No browser render of the pages after the edit; the check was server HTML plus asset status codes.
- `/` and `/admin` were not rendered with a database.
- README.md and docs/answers were not touched, per the brief.
