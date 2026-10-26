# QA report: FN-55a / FN-55b credit cards (cycle 1)

**Verdict: FAIL** (gates are clean and every acceptance criterion has a passing automated check, but three Playwright specs that the PRD scope touches fail on this branch and pass on main 9414412: two stale `kekayaan.spec.ts` tests and one `cocokkan-transfer.spec.ts` test. Small test-side fixes; no production defect found.)

Worktree `<repo>-worktrees/fn-55-credit-cards`, HEAD 53defaf. FN-55c (real issuer parsers) out of scope, no samples exist.

## Commands run

- `npm run check` -> `svelte-check found 0 errors and 0 warnings` (2337 files), 3 tsc projects clean, exit 0 (local, no provider)
- `npm run lint` -> prettier "All matched files use Prettier code style!", eslint clean, exit 0
- `npm run build` -> `✔ done`, exit 0 (adapter-cloudflare, local)
- `npm run test` -> `Test Files 373 passed (373), Tests 6159 passed (6159)`, exit 0 (local D1 via miniflare, fictional fixtures, no provider)
- Touched Vitest, each file alone, all passed: compat-statements 9, export/tables 6, net-worth/sections 3, transfers/match 5, wallets/validation 14, shared/cards 9, statements/card-rows 24, statements/catalogue 6, WalletForm 7, card-statements 27, cocokkan-transfer 27, credit-cards 24, kekayaan-page 9, migration-0027 6, 0029 4, 0037 6, 0040 3, 0041 4, 0047 4 (local D1, fixtures)
- `FIN_PERSIST_TO=<scratch>/fresh npm run db:migrate:local` -> 0000-0047 all applied, 0047 `✅` (fresh local D1, exit 0); rerun -> `No migrations to apply!`
- `sqlite3 <fresh db> "PRAGMA foreign_key_check"` -> empty output (card_statements has 0 rows)
- `npx drizzle-kit check` -> `Everything's fine`
- `npx vitest run test/integration/migration-0047.test.ts` -> 4 passed: upgrade from 0046 with a card and a bank wallet, every existing wallet column identical, three new columns null, CHECKs, re-run stops at "duplicate column" harmlessly
- `npx vitest run test/integration/fn55-qa.test.ts` (new, QA-written) -> `Tests 3 passed (3)` (local D1)
- `npx playwright test kartu-kredit dompet kekayaan period-reports impor cocokkan-transfer riwayat --workers=1` (E2E_PORT=5431, wrangler dev, local) -> `6 failed, 10 skipped, 123 passed (4.1m)`, exit 1. Failures: kekayaan.spec:125, kekayaan.spec:295, cocokkan-transfer.spec:80, each on phone and desktop projects
- Baseline on main 9414412 (E2E_PORT=5432, phone project, `cocokkan-transfer.spec kekayaan.spec`) -> `13 passed (37.8s)`; cocokkan-transfer alone on main rerun -> `3 passed`; on branch rerun -> fails again (deterministic)
- fn-53 screenshots modified by the e2e run were restored with `git checkout -- docs/features/fn-53-period-reports/shots`; `git status` shows only the new QA test file. No screenshots taken by QA.

Not run: remote migration, any real provider, any real card statement (none exists; FN-55c, AC 48 stays not run).

## Checked criteria

PASS means a named passing test or command above; "Browser" = the e2e specs in `e2e/kartu-kredit.spec.ts` (3 tests, passed on both projects).

- AC 1 card form with sen, reload: PASS (`credit-cards.test` "AC 1 ... survive a reload"; e2e kartu-kredit "add a card ... debt drops after the server saved it"; no-JS plain post keeps sen).
- AC 2 card fields on a Bank refused: PASS (`AC 2`, plus no-JS e2e).
- AC 3 day/limit vectors, "" clears, nothing rounded: PASS (`AC 3`, validation.test).
- AC 4 type lock with live statements, Bank to card allowed: PASS (`AC 4`, repo `card_locked`, migration CHECK).
- AC 5 available credit, over limit, no limit, credit balance, no percent: PASS (`AC 5`, cards.test; grep of the diff finds no percent display).
- AC 6 paid / remaining / unbilled strictly after statement date, vector 125000050 - 100000000 = 25000050: PASS (`AC 6/7`).
- AC 7 reconciliation line with exact gap, nothing written: PASS (`AC 6/7`).
- AC 8 due-day clamping 28/29, "today", "Lewat N hari", WIB 23:30 vs 00:30: PASS (cards.test x4, `AC 8`).
- AC 9 card page 404s identical (other space, archived, bank, malformed), removed member 404 on page and action: PASS (`card page ... (AC 9, 36)`, two tests). Removed-member import: PASS (QA test `a removed member cannot import a card statement`).
- AC 10 "Bayar tagihan" is a transfer, totals unchanged, both balances move: PASS (`AC 10`; e2e).
- AC 11 WIB purchase dates (23:30 on 10-31 in October, 00:30 on 11-01 in November): PASS (`AC 11`).
- AC 12 card debt on Utang, total unchanged, balance >= 0 stays in wallets: PASS (`net worth ... (AC 12)`, FN-53 snapshot classes test, sections.test). Extra QA vector: a USD card without a rate stays in `unconverted`, total unchanged, never mixed with IDR: PASS.
- AC 13 hidden amounts on /dompet, card page, /kekayaan: PASS (kartu-kredit e2e sets the hidden cookie at 360 px; kekayaan e2e passed except the two stale tests below).
- AC 14 card-pair merge, tombstone with dedupe key kept, undo restores exactly: PASS (`AC 14`).
- AC 15 window -1/+3 days, 4 days no pair, ambiguity shown whole, one sen apart no pair: PASS (`AC 15`).
- AC 16 no card wallet means no proposal, non-card credit keeps the old +-1 rule: PASS (`AC 16`).
- AC 17 fee/interest/refund rows: PASS (`AC 17`; card-statements class mapping to `biaya-bank`, `pajak`, `transfer`).
- AC 18 foreign purchase in note only, USD card takes cents, import refused IDR-only: PASS (`AC 18`, `card_currency` test).
- AC 19 fictional statement import figures (-200000000 / -132500050, balance `pass`, one `card_statements` row, card page shows it): PASS.
- AC 20 four separate fail-closed cases write nothing: PASS (card-rows.test lines 102-117 and card-statements "fail closed").
- AC 21 forged structure cases refuse the file: PASS (`untrusted text`, `institution_conflict` test).
- AC 22 description cannot change amount/direction/date: PASS.
- AC 23 year rule (28/12, 02/01, 29/02 refused, posting date order, 10-31 stays October): PASS.
- AC 24 money vectors and grep gate against float parsing: PASS (`money vectors`, `no float parsing` test).
- AC 25 wallet-kind gate both ways, last-4 mismatch, wallet last 4 never written: PASS.
- AC 26 statement-level dedupe, different bytes and same bytes both `card_already_imported`: PASS. After undo, a different download imports again: PASS. The exact same bytes after undo return `ok, batchId null` (rows stay tombstoned, no new `card_statements`): see Finding 4.
- AC 27 card duplicate rule 2 days flagged, 4 days not, other wallet not: PASS.
- AC 28 continuity statement to statement (pass, one-sen gap with both figures, "Catat penyesuaian" closes with one row, first statement `none`): PASS.
- AC 29 more than one printed card refused with the "belum didukung" answer: PASS.
- AC 30 passwords (encrypted / wrong / right, stored nowhere): PASS.
- AC 31 undo tombstones rows and statement together; move to another IDR card carries the row; bank wallet, other currency, other space refused: PASS.
- AC 32 `category_source = 'auto'` and class tiles: PASS.
- AC 33 row cap refused not truncated (existing PDF bounds and throttle reused): PASS (row-cap test; 200-page bound is the existing one).
- AC 34 picker shows planned issuers (BCA, Mandiri, BRI, BNI, CIMB Niaga, OCBC) disabled "waiting for sample"; fictional issuer absent from `STATEMENT_PARSERS`; `parsers.ts` untouched in the diff: PASS.
- AC 35 compat harness prints counts and pass/fail only: PASS.
- AC 36 space authorization on every touched load/action, two users two spaces: PASS (card page, edit action, import, pairing cross-space "missing", `/impor` foreign wallet id, `ke=` of another space prefills nothing).
- AC 37 persistence after reload: PASS (e2e reload checks, D1 reads in integration tests).
- AC 38 states and no-JS: PASS (e2e no-JS card form and card page; ErrorState/Skeleton/empty copy present in the card page source).
- AC 39 concurrency: PASS (20 concurrent imports give 1 batch and 1 statement; 20 concurrent pair confirms merge once; stale card edit "changed meanwhile").
- AC 40 D1 limits: PASS (ids bound once with `json_each`, 101+ ids test; no `inArray` or `LIKE` in the added code; sums via BigInt and `safeMinor`).
- AC 41 migration: PASS (fresh apply, no-op rerun, 0046 upgrade, `foreign_key_check` empty, `drizzle-kit check`, RUNBOOK note present in the diff).
- AC 42 masking: PASS (`a card number in a description is kept as its last 4 only`).
- AC 43 no advice or invention: PASS (copy review of the added `i18n-en.ts` entries: no "should", no percent, no interest projection; minimum shown only as "(tertera)").
- AC 44 formatter and WIB: PASS (money through `formatMoney`; vectors above).
- AC 45 demo rows excluded: PASS (`demo rows never count`).
- AC 46 i18n and layout: i18n PASS (`i18n.test` in the full run); 360 px no horizontal scroll PASS on the card page and wallet form (e2e); but see Findings 1-3 for the failing e2e.
- AC 47 gates: `check`, `lint`, `test`, `build` PASS. Fail-before proof for each regression test was not re-created by QA.
- AC 48 real sample: not run, as the PRD says (no sample exists).
- Owner decisions (refunds as income, -1/+3 pairing window, card debt on Utang with total unchanged, foreign amount in note, cicilan as monthly line with marker in note, fill chips, push reminder deferred, supplementary cards refused): all PASS as listed above.

Engineer decisions judged:
1. Card amounts accept sen (IDR `1.250.000,50`) unlike other IDR forms: acceptable, AC 1 requires it. Side effect in Finding 5.
2. Fill chips with sen shown as text only: acceptable (never rounds a printed figure), same side effect.
3. A re-downloaded copy imports again after undo, the same bytes do not: acceptable and consistent with the project rule that a deleted capture is not recreated from the same source; see Finding 4 for the UX note.

## Findings

1. FAIL (test, blocks PASS) `e2e/kekayaan.spec.ts:125` "edit to a negative balance; a second tab's stale save is refused". Input: add a wallet of type "Kartu kredit" with balance `0`. Expected: the spec's `getByLabel('Saldo awal')` fills. Actual: choosing Kartu kredit switches the form to card wording ("Tagihan berjalan sekarang (utang)" / on edit "Utang awal ..."), there is no "Saldo awal" label, the test times out at 30 s. The intended behaviour changed; the spec was not updated. Fix: adapt the spec to the card wording (and the "Saldo minus" checkbox, which is gone in card mode). Passes on main.
2. FAIL (test) `e2e/kekayaan.spec.ts:295` "FN-39 quick picks ...". Input: open "Tambah dompet". Expected 4 links in the group named "Isi cepat e-wallet". Actual 5: the new "Kartu kredit" chip was added inside that group. Fix: update the count, or move the card chip out of the group named for e-wallets (also an accessibility labelling nit: a card chip under an "e-wallet" group label).
3. FAIL (test) `e2e/cocokkan-transfer.spec.ts:80` (360 px touch). Expected "Urungkan" height >= 44, got 40, deterministic on branch, passes on main. Cause found with a debug copy of the spec: `matchMedia('(pointer: coarse)')` is `true` on the review page and `false` right before the confirm click; the only step between is `page.screenshot({ fullPage: true })`. The branch adds a paragraph to the review page (card-payment help text) that makes the page taller than the 780 px viewport, so the full-page screenshot resizes the emulated viewport and drops touch emulation in Chromium; the `sm` button then renders at its non-touch 40 px. This is a test artefact, not a product defect (a real coarse pointer keeps 44 px), but the spec is red. Fix: take the screenshot with a clip or viewport-only, or assert the height before the screenshot.
4. Note (not blocking) AC 26 wording. After "Urungkan", the exact same PDF bytes return `ok` with `batchId null` ("all rows already imported") and store no `card_statements` row, because the undone rows keep their dedupe keys. Only a different download of the statement imports again. A user who undid by mistake with the same file must use "Pindahkan" or download again. Consistent with bank statements; consider a clearer message in the preview ("Tagihan ini pernah diimpor lalu diurungkan"). Test: `test/integration/fn55-qa.test.ts` documents it.
5. Note (not blocking) "Bayar tagihan" cannot record sen. The transfer form takes whole rupiah for IDR, so a bill printed as `1.250.000,50` is paid in the app as `1.250.000` or `1.250.001`; `credit-cards.test` AC 10 itself ends at a remaining debt of 50 sen. The card page then shows a 50 sen "Sisa tagihan" and a reconciliation line pointing to "Sesuaikan saldo". Real statements mostly print `,00`; an owner decision whether the transfer form should accept sen for card payments.
6. Note: engineering checklist skim of the diff found no `inArray`, `LIKE`, float parsing, secret in a loader, or `console.log` of statement content; the only new `console.error` logs an error label.

## What changed in QA

Added `test/integration/fn55-qa.test.ts` (3 tests: removed member cannot import a card statement, the same-bytes-after-undo behaviour, USD card debt does not mix with IDR). No production code touched.

## To reach PASS

Fix findings 1-3 (spec-only changes), rerun `npx playwright test kekayaan cocokkan-transfer --workers=1`; findings 4-5 need an owner or engineer decision but do not block.

# Cycle 2 (HEAD 550be5d, rebased on main 9b01add with FN-54)

**Verdict: PASS.** Findings 1-3 of cycle 1 are fixed; notes 4-5 stay open as non-blocking.

## Commands run

- `npm run check` -> `COMPLETED 2368 FILES 0 ERRORS 0 WARNINGS`, exit 0
- `npm run lint` -> prettier clean, eslint clean, exit 0
- `npm run build` -> `✔ done`, exit 0
- Touched Vitest, one file at a time, all passed: card-rows 26, CardStatementSummary 3, WalletForm 8, card-statements 28, fn55-qa 3, credit-cards 24, cocokkan-transfer 27, migration-0047 4 (local D1, fixtures)
- Fail-before: with `src/lib/server/imports/repo.ts`, `src/lib/shared/statements/card-rows.ts` and `src/lib/ui/wallets/WalletForm.svelte` set back to 5d21cfd, `card-rows.test` (red team L1 period) 1 failed, `card-statements.test` (L2 bank batch moved to a card) 1 failed, `WalletForm.test` (card chip in its own group) 1 failed; files restored to 550be5d afterwards (tree clean)
- `npm run test` -> `Test Files 1 failed | 382 passed (383), Tests 1 failed | 6500 passed (6501)`; the one failure, `transaction-rate-limit.test.ts` (untouched, FN-05, concurrency under load), passed alone on rerun: `Tests 4 passed (4)`
- New QA test `test/integration/fn55-calendar-qa.test.ts` -> `Tests 1 passed (1)` (local D1)
- `npx playwright test kartu-kredit kekayaan cocokkan-transfer impor beranda-hero kalender dompet --workers=1` (E2E_PORT=5431, shim, wrangler dev local) -> `10 skipped, 109 passed (2.0m)`, exit 0; no tracked files changed by the run (no shot restore needed)

## Re-verified

- Finding 1 (kekayaan.spec:125): PASS, rewritten to card wording and `/dompet?ubah=<id>`; passes on phone and desktop.
- Finding 2 (kekayaan.spec:295): PASS, the card chip is in its own group "Atau mulai sebagai kartu kredit"; the e-wallet group holds 4 links again (WalletForm.test also asserts it, fails on 5d21cfd).
- Finding 3 (cocokkan-transfer.spec:80): PASS, viewport-only screenshot plus an explicit `(pointer: coarse)` assertion; "Urungkan" is 44 px.
- Period check on card rows (red team L1): a row whose posting date (else its only date) lies outside the printed period refuses the whole file; test fails on 5d21cfd, passes now. It uses the posting date, so a purchase dated in the previous cycle that posts in this one still reads (AC 28 test still passes).
- Bank batch moved to a card (red team L2): refused with its own message "Impor ini mutasi rekening..." in both the pre-check and the SQL guard; nothing changes. CSV batches are not affected (only `source = 'statement'`).
- Masked `CardStatementSummary`: renders the preview through the shared component, with `feesAndInterestMinor` summed in BigInt; component test passes; Impor e2e passes.
- All AC 1-47 still hold: the cycle 1 suites (credit-cards, card-statements, card-rows, migration-0047, cocokkan-transfer, kekayaan-page) pass unchanged.
- FN-54 with card wallets: Beranda hero, feature tiles and nav icons do not read wallet types (`FeatureTiles.svelte` has no wallet logic) and `beranda-hero` e2e passed. `/kalender` reads the FN-05 expense aggregates: QA test shows a 23:30 WIB card purchase on 31 Oct counts on 31 Oct, a 00:30 WIB one on 1 Nov, and the bank-to-card bill payment (a transfer) counts on no day; the favourite card sets the hero currency only. `kalender` e2e passed.

## Open notes (unchanged, non-blocking)

Same-bytes re-import after undo returns "already imported" without a new statement (note 4); "Bayar tagihan" cannot record sen (note 5).

# Cycle 3 (HEAD 59a5b9e)

**Verdict: PASS.** Both red team fixes verified; all earlier criteria hold.

## Commands run

- `npm run check` -> exit 0; `npm run lint` -> exit 0 (prettier and eslint clean)
- Touched Vitest, one file at a time, all passed: card-rows 31, card-statements 29, fn55-calendar-qa 1, fn55-qa 3, credit-cards 24, wallets/validation 14, WalletForm 8, migration-0047 4 (local D1, fixtures)
- Fail-before: with `wallets/repo.ts` and `shared/statements/card-rows.ts` set back to 550be5d, `card-rows.test` 5 failed (period/posting bound, two shifted-column vectors, the 60-day lag import, no-period bound) and `card-statements.test` 1 failed (retype with a live bank batch); restored to 59a5b9e, tree clean
- `npm run test` -> `Test Files 384 passed (384), Tests 6508 passed (6508)`, exit 0
- `npx playwright test kartu-kredit kekayaan impor --workers=1` (E2E_PORT=5431, shim, local) -> `10 skipped, 81 passed (1.7m)`, exit 0; no tracked files changed (no shots to restore)

## Verified

- Card row date bounds: the date that put the row on the statement (posting date, else its only date) must lie in the printed period, or in the 60 days before the statement date when no period is printed; the transaction date may be at most 60 days before the window start. Shifted-column vectors `30/10 01/10` and `01/11 01/10` are refused; `20/09` posted `27/09` into a period starting later still imports (AC 28 continuity cases pass unchanged).
- Retype refusal: a wallet with a live account-statement import (`source = 'statement'`, not undone, no card statement) cannot become a card; the answer is `bank_statements_locked`, status 409, with Indonesian and English messages (`i18n.test` passes in the full run). After undo the retype succeeds. A wallet already a card is unaffected (SQL clause lets `type = 'kartu_kredit'` through); card to bank with live card statements is still `card_locked`.
- Open notes 4 and 5 from cycle 1 unchanged and non-blocking.
