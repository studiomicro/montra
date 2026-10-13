# QA report: fix-lows-imports (low findings of the import features, 2026-10-13)

**Verdict: PASS** (branch `fix/lows-imports`, head `13cb08f`, 8 commits on main `5a486bc`)

Residual risks, not failures: the OCBC column-position gate and the HEIC `meta` walk are calibrated on fictional/synthetic files only (the owner's sample is password-protected and no real phone HEIC was available), so a real file could be refused (fail closed), never mis-imported.

## Commands run

- `npm run check` : svelte-check 2291 files, 0 errors, 0 warnings; tsc (service-worker, jobs, inbound) clean; exit 0; no provider.
- `npm run lint` : prettier "All matched files use Prettier code style!" + eslint clean; exit 0; no provider.
- `npm run build` : `node scripts/ocr-assets.ts && vite build`, "done", exit 0; no provider.
- Touched Vitest files one at a time (16 files: ocr-assets, forms, pdf-text, read, csv, bank-narratives, image-kind, ocr/lines, bca-csv, bca, ocbc-rekening-koran, ocbc, cocokkan-transfer, impor-statements, imports-move, sign-in): every file "Test Files 1 passed", 0 failed; local D1 (miniflare) and fixtures, no real provider.
- `npm run test` (once) : Test Files 355 passed (355), Tests 5825 passed (5825), exit 0; local D1, fixtures and mocks, no real provider. (Added after the run: `test/integration/fix-lows-imports.qa.test.ts`, run alone: 1 file, 3 tests passed.)
- Regression check by reverting the fix (source file restored from `main`, or the fix line patched out, then `git checkout HEAD --` the file): 13 named tests fail without the fix, listed below; tree clean afterwards.
- `PATH=shim:$PATH E2E_PORT=5409 npx playwright test --workers=1 e2e/impor.spec.ts e2e/impor-ocr.spec.ts e2e/impor-spreadsheet.spec.ts e2e/cocokkan-transfer*` : 59 passed, 4 skipped, 0 failed (1.8m), exit 0; local worker with mocked AI, no real provider. `git checkout -- docs/features/*/shots` run after.

## Findings checked (FIX = fails on the pre-fix code, passes now)

| Finding | Verdict | Evidence |
|---|---|---|
| FN-16a L5 sliding throttle | PASS | Without the fix (counting in the fixed window): `impor-statements` "red team L5" fails (400 instead of 429); `sign-in` "never lets more than max through ... fixed window's edge" fails. Passes now. Reviewed `overUserSlidingLimit`: earlier minute buckets are read (they no longer change), the current minute comes from the guarded `countAttempt` increment, so 40 concurrent attempts count exactly (test: exactly 10 of 40 allowed). Rows are keyed by hash per minute, swept after 1 hour. No lockout of a normal user: my test `fix-lows-imports.qa.test.ts` runs 12 statements x (preview + import) one a minute and a 31-upload burst: none refused until the 31st. Note: a refused attempt still counts, so a user hammering stays locked longer (same as `countAttempt`). Preview and OCR share the `statement-upload` scope (30 per window, same budget as before). |
| FN-16a L4 byte accounting | PASS | With 3 slots and no charge: `impor-statements` "red team L4" and `pdf-text` "holds one upload per user; bytes, not slots" fail; with `charge` calls removed `forms` "charges each buffer growth" fails (expected 200002, got 0). One upload per user stays; a single upload of at most 15 MB + 64 KB fits the budget (3 x that); single uploads in the integration and e2e suites get no 503. Past the budget: 503 + Retry-After 30, released on every exit. |
| FN-16f L1, FN-16h L1 OCBC row start by position | PASS | Reverting `ocbc*.ts`: `ocbc.test` "red team L1" and "L2", `ocbc-rekening-koran.test` "Berita note imitating two rows" fail. `read.test` builds a real positioned PDF through PDF.js: the forged pair is refused, the honest file still reads as OCBC. With no positions (or lengths that do not match) the text decides as before. Layout is a 2% tolerance from the leftmost row start of the file. All fictional OCBC statement fixtures (Konsolidasi and Rekening Koran, unit, integration and e2e "OCBC consolidated statement is detected, reconciled and imported once") give the same rows and totals. Not verifiable here: the owner's real PDF (encrypted). |
| FN-16f L2 / 16h L2 | PASS (partly FIX, rest ACCEPTED) | "red team L2" fails without the fix. Rationale matches the report: structure lines in a remark still refuse the file whole, fail closed. |
| FN-16b, FN-16c L1 BCA | PASS | Without the fix `bca.test` "cycle 2 L1", `bca-csv.test` "red team L1", `csv.test` "literalQuotes" fail. `read.test` "lone quote, many commas or = ..." passes. All BCA PDF/CSV fixtures import the same rows (full suite). |
| FN-16g L4 ocr-assets, L5 HEIC | PASS | Without the fix `ocr-assets.test` "red team L4" and `image-kind.test` "red team L5" fail. `checkOcrFile` has one caller (`OcrImport.svelte`), which now passes the walked `meta` box; the build ran the shortcut cleanly. |
| FN-16j L1, L2 move | PASS | Without the fix `imports-move` "FN-16j red team L1" and "L2" fail. The new `source_archived` refusal answers 409 with `MOVE_SOURCE_ARCHIVED`, and the English entry is in `i18n-en.ts` (the i18n completeness test is in the 355 passing files). The removed-member re-read now includes `isLiveMember`. |
| FN-48A L1 category picking | PASS | Without the fix `bank-narratives.test` "red team L1" fails. I compared the old and new `narrativeTile` over all 569 strings in `test/fixtures/statements/*` and the narrative tests for both kinds (1138 pairs): only 10 differ, all the adversarial vectors (sender notes, merchant names) plus `SWITCHING CR TRF JASA GIRO` income (bunga -> transfer, asserted by the new test). No honest fixture row changed. |
| FN-48A L2 (0037 recovery) | PASS | `docs/RUNBOOK.md` section present; documentation only. |
| FN-48C L3, window sum, `?sebelum` paging | PASS | Without the fix "L3", "pair straddling ... (QA low)" and "every live link stays reachable ... via ?sebelum" fail. Paging is scoped by `space_id` in the query, the cursor is `createdAt.uuid`, a forged cursor reads as page 1, and it is a plain link (works without JavaScript; e2e `cocokkan-transfer` specs pass). My test: A's cursor used on space B returns only B's own rows; a space with exactly 50 links shows no phantom next page; 55 links page 50 + 5 with no duplicates. |
| ACCEPTED items (FN-16a L3 buffer, BNI fail-closed, duplicate flag, FN-17 follow-up, FN-16d/f structure lines, CI install mitigation, FN-17 row-number bound already fixed in cycle 2) | PASS | Each rationale in the "Resolution" note matches what the finding says (accepted, fail-closed, no write, or mitigation lives on `chore/ci-cd`). The `.github` change is out of this branch, as stated. |

## Engineering checklist

No violated item found: no source outside the listed fixes, no new migration, server-side space scoping unchanged on all touched loads/actions (`currentSpaceScope`, `isLiveMember`), no floats, no new user-visible string without an English entry (`source_archived`, "Lihat yang lebih lama", "Kembali ke yang terbaru" covered by the i18n test), loading/empty states unchanged.

## Findings

None failing. Observations (no action required):
1. `SWITCHING CR TRF JASA GIRO` (income) was Bunga and is now Transfer; deliberate and tested.
2. A statement upload refused by the byte budget has already counted one upload in the throttle.
3. 4 e2e tests skip by design (project/viewport conditions); not investigated further.

QA added `test/integration/fix-lows-imports.qa.test.ts` (3 tests, passing). No production code changed.

## Cycle 2 (head `15accec`)

**Verdict: PASS**

Commands run:
- `npm run check` : svelte-check 2292 files, 0 errors, 0 warnings; tsc clean; exit 0; no provider.
- `npm run lint` : prettier clean + eslint clean; exit 0; no provider.
- Touched Vitest files one at a time (sign-in, bank-narratives, ocbc-rekening-koran, fix-lows-imports.qa): each "Test Files 1 passed" (13, 21, 38, 3 tests); local D1/fixtures.
- `npm run test` (once) : Test Files 356 passed (356), Tests 5831 passed (5831), exit 0; local D1, fixtures, mocks.
- `PATH=shim:$PATH E2E_PORT=5409 npx playwright test --workers=1 e2e/impor.spec.ts e2e/impor-ocr.spec.ts e2e/impor-spreadsheet.spec.ts e2e/cocokkan-transfer` : first run 56 passed, 4 skipped, 1 failed (`impor-ocr.spec.ts:207` phone, 30 s timeout waiting for the progress text "Membaca halaman 1 dari 1 (100%)"), 2 did not run (same file, serial); exit 1. Rerun of `e2e/impor-ocr.spec.ts` alone: 5 passed, 4 skipped, exit 0. Cycle 1 passed the same spec with this build; cycle 2 changed no OCR reader code (only the OCBC share-of-width gate), so this is a load-timing flake of an unrelated progress label, not a regression. Local worker with mocked AI, no real provider. `git checkout -- docs/features/*/shots` run after each.
- New tests on the parent (`13cb08f` version of `throttle.ts`, `bank-narratives.ts`, `ocbc-text.ts`, restored after): all three fail there, pass at HEAD.

Checked:
- L1 allowed-only sliding count: PASS. "cycle 2 L1: refused retries are not counted..." fails on the parent, passes now. Reviewed the guarded upsert (`on conflict do update ... where count < room`): refused attempts write nothing, concurrent attempts still counted exactly (the 40-concurrent test still passes), the 30-in-any-window edge test still passes. 12 monthly statements (preview + import, one a minute) still never throttle (`fix-lows-imports.qa.test.ts`, passing).
- L2 narrative allowlist: PASS. "cycle 2 L2" fails on the parent, passes now. Old-vs-new `narrativeTile` over 579 string literals in `test/fixtures/statements/*` plus the narrative tests, both kinds (1158 pairs; the engineer's 587 includes a few more short literals): 22 outputs differ from cycle 1 and every one is in the resolution note or is a cycle-2 test vector or a test title: income `Biaya transfer BI Fast`, `SWITCHING DB BIAYA TXN ...`, `TRSF E-BANKING DB BIAYA TRANSFER`, `BI-FAST DB BIAYA` (transfer -> none), income `Tunggakan Bunga /` and `Overdue Interest` (bunga -> none; these are labels in the OCBC fixture, not interest earned), expense `TRSF ... CR ... BUNGA DEPOSITO`, `SWITCHING CR TRF JASA GIRO`, `BI-FAST CR ... PAJAK` (none/pajak -> transfer, wrong-kind pairs only), and the adversarial vectors of the new test. No honest row of its own kind changed: `BIAYA ADM`, `BUNGA`, `PAJAK BUNGA`, `TARIKAN ATM`, `KARTU KREDIT/PL`, `PEMBAYARAN KARTU KREDIT`, `Biaya transfer BI Fast` (expense) and every transfer prefix keep their tile versus main. Versus main only the already-listed cycle-1 changes (`KARTU DEBIT`/`QRIS` merchant text, sender notes, `JASA GIRO` income via switching) differ.
- L3 per-width OCBC row starts: PASS. "cycle 2 L3" fails on the parent (pages at 1240 and 2480 px), passes now; the honest scaled file reads exactly as from text; forged rows are still refused. All OCBC (Konsolidasi, Rekening Koran, real positioned PDF in `read.test`) tests pass. Still not verified on the owner's real encrypted sample.
- N1 CI OCR cache: PASS (review only, not runnable locally). `ci.yml` restores `.ocr-cache` in `build` and `e2e`, saves it only on a push to main after a miss, actions pinned by SHA; the key follows `assets.ts`; files are hash-checked on use anyway.
- Fictional BCA/BNI/Mandiri/OCBC/CSV/xlsx fixtures import identical rows and totals: PASS (all statement, import and spreadsheet unit/integration/e2e tests pass unchanged).

Findings: none failing. Note: the worktree shows `docs/features/fix-lows-imports/SECURITY_REPORT.md` modified; I did not touch it.
