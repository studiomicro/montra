# FN-48 Part B (statement continuity per wallet) — QA_REPORT_PART_B

**Verdict: PASS**

Scope: `git diff c50fa17..2d6bd03` (worktree detached at 2d6bd03, base main c50fa17). Risk tier Large
(migration 0041 + balance logic). QA added tests only (one integration test in
`test/integration/continuity.test.ts`, two e2e tests in `e2e/impor.spec.ts`); no file under `src/`, `workers/`
or `migrations/` was touched.

## Commands run

- `npm ci --no-audit --no-fund` — installed, exit 0, no network provider involved (npm registry only).
- `npm run gates` (check, lint, test, build) — clean, exit 0; build step reached and finished, which only
  happens if check/lint/test all passed first (`&&` chain in the script).
- `npm run db:reset:local` (wipe local D1 state, migrate 0000→0041, seed) — clean, exit 0, against a fresh
  local D1 (mock/fixture provider, no real Cloudflare account).
- `npx wrangler d1 execute montra --local --command "pragma table_info(import_batches)"` — confirms
  `wallet_id`, `period_from`, `period_to`, `opening_balance_minor`, `closing_balance_minor` present on a
  freshly migrated local D1.
- `npx vitest run test/integration/migration-0041.test.ts src/lib/server/statements/continuity.test.ts` — 2
  files, 10 tests passed, exit 0 (local D1 fixture, migrated to 0040 then 0041 applied in-test).
- `npx vitest run test/integration/continuity.test.ts` — 1 file, 19 tests passed (18 engineer's + 1 QA-added),
  exit 0, local D1 fixture.
- `npm run test -- --reporter=dot` (full Vitest suite) — 325 files, 4 tests failed on first run
  (`net-worth.test.ts` ×2, `recurring.test.ts` ×2, both timeouts, both untouched by this diff) /5210 passed;
  rerun alone: `npx vitest run test/integration/net-worth.test.ts` 16/16 passed, `npx vitest run
  test/integration/recurring.test.ts` 35/35 passed — confirmed load-flake, not a regression.
- `E2E_PORT=9081 npx playwright test e2e/impor.spec.ts --workers=1` (macOS `flock` no-op shim on PATH) — 31
  tests passed (27 engineer's + 4 QA-added: phone 360 px + desktop × JS-on continuity journey and no-JS
  `closeGap` form post), exit 0, against the local dev Worker + local D1 (fixture, not a real provider).

## Checked criteria (Part B, AC-41 – AC-48, plus the gap-closing/concurrency/access vectors in the task)

| # | Criterion | Result | Evidence |
|---|---|---|---|
| AC-41 | First statement whose Saldo Awal = wallet balance before it: no warning | PASS | `continuity.test.ts` "AC-41" |
| AC-42 | Owner's real figures: gap Rp 10.000.000,00 before 1 July, never silent | PASS | `continuity.test.ts` "AC-42", exact figures matched |
| AC-43 | Reverse-order import still compared by date | PASS | `continuity.test.ts` "AC-43" |
| AC-44 | Exactly one FN-37 adjustment, dated day before gap, visible/undoable | PASS | `continuity.test.ts` "AC-44", e2e "Catat selisihnya closes it" |
| AC-45 | Declining still imports; gap re-shown until resolved | PASS | `continuity.test.ts` "AC-42" (`imported`, gap re-listed) |
| AC-46 | No claim on missing opening/closing | PASS | `continuity.test.ts` "AC-46"; unit test `statementSpan` drops closing on truncation |
| AC-47 | Undone batch excluded as if never imported | PASS | `continuity.test.ts` "AC-47" |
| AC-48 | Per-wallet only, never per-space | PASS | `continuity.test.ts` "AC-48" |
| Comparison by statement date not import order | PASS | "AC-43", unit test `byRecency` ties |
| First statement vs wallet balance before its first day | PASS | "AC-41", "AC-42" (`kind: 'wallet'`) |
| Rows dated between statements | PASS | `walletWindowSql` window excludes the matched batch's own rows, included via the window sum; "a gap between two months" test |
| No-claim: missing printed balance | PASS | "AC-46" |
| No-claim: overlap | PASS | "overlapping statements are never compared" test, plus new QA test below |
| No-claim: cut-off file | PASS | `statementSpan` unit test (`truncated` drops closing) |
| No-claim: no wallet | PASS | "AC-46" (`previewStatement` with `walletId: null`) |
| Demo/undone/deleted batches excluded | PASS | "Data demo rows never count…", "AC-47"; `deleted_at`/`undone_at` filtered in every query |
| Two wallets, two spaces, removed member | PASS | "AC-48" (two wallets); "a removed member cannot close a shared space's gap"; "/impor load" cross-account test (404) |
| Adjustment written once under 20 concurrent confirms | PASS | "20 concurrent confirmations write one adjustment" |
| Stale page 409 | PASS | "a page showing another gap is stale…"; route test `stale.status === 409` |
| Deleting the adjustment brings the gap back | PASS | "deleting the adjustment undoes it…" |
| Engineer's PRD deviation: period spans all readable rows (incl. skipped-as-duplicate) | **Judged correct, not a defect** | See below; QA added a regression test proving it |
| Every parser returns opening/closing and gets continuity | PASS | BCA PDF/CSV, BNI, Mandiri, OCBC both layouts all set `openingBalanceMinor`/`closingBalanceMinor` (pre-existing FN-16 code, unchanged); wired generically through `statementSpan`/`createImportBatch`, exercised end to end by the BCA e2e fixture |
| Migration fresh D1 + seeded at 0037→0041, `import_batches` rows preserved | PASS | `migration-0041.test.ts` (seeded 0040-shape rows survive byte-for-byte); `npm run db:reset:local` fresh-D1 run also clean |
| i18n | PASS | every new Indonesian phrase in `i18n-en.ts` has an English entry (gates' i18n-completeness test is part of `npm run test`, which passed) |
| 360 px | PASS | Playwright `phone` project (360×780) ran both new e2e tests, `expectNoHorizontalScroll` |
| No-JS route | PASS | new e2e test "without JavaScript: 'Catat selisihnya' closes a continuity gap as a plain form post" |

## The engineer's PRD deviation, judged

The Architecture notes say `period_from`/`period_to` should come from "the batch's own written rows — the
min/max `occurred_on` actually imported". The code (`continuity.ts` `statementSpan`) instead spans **every
readable row, written or not** (its own doc comment states this explicitly and why: "the printed Saldo Awal is
the balance before the statement's first row even when that row was left out as a duplicate").

This is correct and should stand as written, for two reasons, both verified with a new test (`continuity.test.ts`,
"QA: a leading row skipped as a possible duplicate still counts toward the period, catching an overlap"):

1. **Correctness of the balance check itself.** A printed Saldo Awal reconciles against the balance immediately
   before the file's *first* row, not before the first row this particular import happened to write. If a
   leading row is skipped as an already-recorded duplicate, narrowing the period to the first newly-written row
   would shift `period_from` forward by that row's date — comparing the printed opening balance against the
   wrong day and manufacturing an off-by-one-row gap (or masking a real one).
2. **Overlap detection.** The new QA test imports July, then imports a second file whose first row is the same
   1 July row (by date/title/amount — flagged and skipped as a possible duplicate) plus one new 5 August row.
   Using only written rows would give this batch a period of `2026-08-05–2026-08-05`, which does **not** overlap
   July's `…–2026-07-20` — silently treating two statements that in fact share a day as sequential, and risking
   a wrong pass/gap claim built on a window that double-reads 1 July. With the implementation as written, the
   period is `2026-07-01–2026-08-05`, correctly overlapping July, and the check makes no claim (`status:
   'overlap'`) instead of a wrong one. Test passed.

Net: the deviation is a deliberate, documented, and verified improvement over the literal architecture note. No
finding raised; recommend the PRD's Architecture note be corrected to match the code at merge time (a documentation
follow-up, not a code change).

## Other findings

None blocking. Two minor, non-blocking observations for the red team's attention, not raised as QA findings
because neither affects what gets written or shown:

- `closeContinuityGap`'s `GAP` regex allows up to 16 digits, one digit past `Number.MAX_SAFE_INTEGER`'s safe
  range; `Number(gap)` is used only for the staleness comparison (never for the amount actually written — that
  always comes from the server's own recomputed `expectedMinor`/`openingMinor`), so a precision-lossy value can
  at worst cause a spurious "stale" answer, never a wrong write. Not reachable with any real IDR amount.
- `import_batches.deletedAt` is filtered everywhere in `continuity.ts` but is never set by any current write
  path (pre-existing, not introduced by this diff) — defensive-only today.

## Engineering checklist

Checked `docs/ENGINEERING_CHECKLIST.md` against the diff: bound parameters (JSON via `json_each`, ≤20 items),
no LIKE/GLOB, bounded work (`CONTINUITY_BATCH_MAX`/`CONTINUITY_LIST_MAX`), concurrent writes via one guarded
statement (proved with 20 concurrent), one access rule (`currentSpaceScope` on load and the new `closeGap`
action, unknown/removed-member/other-account all answer 404), i18n complete, shared money formatter, truthful
post-write state, keyed `{#each}` by `batchId`, migration re-runnable and documented as such. No violation found.

## Files touched by QA (not committed)

- `<repo>-worktrees/fn-48b-qa/test/integration/continuity.test.ts` — added one
  regression test (duplicate-skipped leading row still sets the period, catching an overlap).
- `<repo>-worktrees/fn-48b-qa/e2e/impor.spec.ts` — added two e2e tests (JS-on
  gap-close journey; no-JS plain-form-post gap close), run on both `phone` (360 px) and `desktop` projects.
