# FN-16h OCBC Rekening Koran — QA Report (cycle 1)

## Verdict: PASS

## Commands run

- `npm ci --no-audit --no-fund` — 277 packages installed, exit 0 (no provider, local install).
- `npm run gates` (full: check, lint, test, build) — exit 1 on first pass: `Test Files 1 failed | 318 passed (319)`, `Tests 1 failed | 5018 passed (5019)`; sole failure `test/integration/net-worth.test.ts > snapshot fairness and partial days (red team M1, L2) > 105 more spaces … within ceil(105/100) + 1 hourly ticks` — `Error: Test timed out in 30000ms` (fixture only, unrelated to this diff; scale/timing test under load, as the engineer flagged).
- `npx vitest run test/integration/net-worth.test.ts` (rerun alone, per instructions) — `Test Files 1 passed (1)`, `Tests 16 passed (16)`, exit 0. Confirms the gates failure is the pre-existing flaky scale test, not a regression from this diff (diff touches only `src/lib/shared/statements/ocbc*.ts` and its tests; `check`, `lint`, and `build` were clean in the same run).
- `npx vitest run src/lib/shared/statements/ocbc-rekening-koran.test.ts src/lib/shared/statements/ocbc.test.ts src/lib/shared/statements/detect.test.ts test/integration/impor-statements.test.ts` — `Test Files 4 passed (4)`, `Tests 118 passed (118)`, exit 0 (fixtures only, no real provider).
- Fail-before proof (temporary files, written then deleted, no production code changed): copied `d4a7933`'s `ocbc.ts` to a scratch module, ran its `detect()`/`parse()` against the new `RK_JULY` fixture — `Test Files 1 passed (1)`, `Tests 1 passed (1)`: pre-fix code returns `detect() === 0` (institution_unknown) and `parse().inconsistent === true` on the Rekening Koran shape, proving the bug report reproduces and criterion 21's fail-before requirement is met.
- `git diff d4a7933..75fa558 --stat / -- <paths>` — inspected; confirms no migration, no change to `detect.ts`, `sections.ts`, `types.ts`, `i18n*.ts`, or any `src/lib/server/statements/*`/`/impor` route file; `ocbc.test.ts` (Konsolidasi) byte-for-byte unchanged.
- No real-provider/owner-sample run performed by me (I don't have the password and was told not to re-run `compat:statements` or read the sample); orchestrator's prior real-sample run is taken as given per the task.

## Checked criteria (PRD `docs/features/fn-16h-ocbc-rekening-koran/PRD.md`)

1. PASS — `OCBC Rekening Koran detection … is claimed at letterhead confidence and auto-detected as OCBC (the bug report: institution_unknown)` (`ocbc-rekening-koran.test.ts`).
2. PASS — `claims nothing without the bank line, the title, the branch or the account label` (same file); also the letter-spaced-legal-text case is explicitly proven not to be an anchor.
3. PASS — `ocbc.test.ts` diff is empty (unmodified); `the Konsolidasi layout is still claimed and read by its own path` passes.
4. PASS — `detect.test.ts`: `OCBC Rekening Koran letterhead lines planted in another bank's remarks, and the reverse, make two claims (FN-16h)` — both directions proven; `detect.ts` untouched.
5. PASS — `reads one section per currency … IDR importable, SGD listed only (the bug report: inconsistent)`; `RK_JULY_ROWS` match exactly, `balanceCheck` → `pass`.
6. PASS — `RK_JULY`'s 20/07 row (`wrap: ['customer acct']`, amount on the second line) reads to the correct two-line description and amount in `RK_JULY_ROWS`.
7. PASS — 02/07 row (`Berita :` + plain continuation `KOTA FIKTIF`) both appended in order, next row read separately; explicit test `a note line shaped like an amount line, after or before the real one…` also proves ordering.
8. PASS — 12/07 row's note (`['Berita : NASABAH FIKTIF/-']`) is the first line of page 2 and is correctly merged into the *previous* row's description in `RK_JULY_ROWS`; a dedicated cut-at-page-boundary test (criterion 16) also exercises this path.
9. PASS — IDR/SGD both sections, same `accountLast4` ('0300'), SGD `refusal: 'unsupported_currency'`, zero rows contributed.
10. PASS — `a currency closes on its own-currency summary balance, never the IDR column or the rate`: re-rating the SGD own-currency balance's IDR column to a different (but internally consistent) value still passes; mutating the rate makes the own-currency check fail off-by-one and refuses the whole file, proving the IDR column/rate are never load-bearing.
11. PASS — `refuses the whole file when the summary total is not its IDR column`.
12. PASS — `refuses a wrong running balance by one unit, or a wrong closing balance`.
13. PASS — same test, closing-balance branch.
14. PASS — `a note line shaped like an amount line, after or before the real one, makes the row unreadable`.
15. PASS — `forged structure in a row's note` `it.each` (14 cases: Beginning Balance, duplicate/new currency block, bare currency code, table header, legal text, page title, branch line, period line, page counter, account label, summary row/total, bank line) plus a forged block at table end and a forged legal text with nothing after it.
16. PASS — `refuses a row cut at a page end whose next page never supplies its amounts`.
17. PASS — `refuses the whole file when pages disagree on the period, or one prints none`.
18. PASS — running index `[0,1,2,3,4,5,6]` across both sections in the main reading test.
19. PASS — integration test imports the IDR section once, then re-imports the same PDF: `counts: { imported: 0, already: 6 }`, row count stays 6.
20. Not independently re-run by me (no password, told not to); accepted as already evidenced by the orchestrator's real-sample run (ocbc, 4 pages, 21 rows, 0 rejected, balance pass Rp0 gap, SGD section listed as not-IDR) per task brief.
21. PASS — `npm run gates`: check/lint/build clean; test suite 5018/5019 passing, sole failure is the pre-existing unrelated net-worth scale flake (passes alone, see Commands run); fail-before proof re-demonstrated independently (see Commands run).
22. PASS — cross-space tests unmodified and still passing: `another space's wallet is not found…`, `cross-space: …non-members and removed members write nothing there` (both pre-existing, generic, pass in the 5018-test run); `/impor` route/action files untouched in the diff.
23. PASS — `i18n.ts`/`i18n-en.ts` diff empty; no new `StatementRefusal` introduced (`unsupported_currency`/`inconsistent` both pre-existing).
24. PASS — `amountOf` is `parseMoneyAmount` only (shared with Konsolidasi via `ocbc-text.ts`), no second tokenizer; `slashDate` reads the printed `DD/MM/YYYY` directly, no "this year"/upload-date fallback.

## End-to-end `/impor` flow (integration, fictional fixtures)

`test/integration/impor-statements.test.ts` → `describe('OCBC Rekening Koran (synthetic single-account PDF, FN-16h)')`:
- Section picker shows `[{ label: 'Tabungan Fiktif IDR', importable: true }, { label: 'Tabungan Fiktif SGD', importable: false }]` both on auto-detect and on manual `institution: 'ocbc'` pick — matches "section picker shows IDR importable and SGD listed".
- Picking the SGD section (`section: 1`) for `importStatement` is refused `section_unsupported`, no rows written — matches "wrong-institution/wrong-section pick refused" for this layout's own non-importable section.
- Re-import of the same PDF dedupes: `{ imported: 0, already: 6 }`, row count stays 6 — matches "re-import dedupes".
- A second test proves three forged variants (note-embedded second amount line, note-embedded forged currency block, forged summary total) are all refused `inconsistent` with zero rows/batches written.
- `Berita`/continuation text is verified intact end to end via `RK_JULY_ROWS` (used by both the unit test and this integration test), e.g. `'Pos Sales Debit/Post Sales Debit Berita : 0001 TOKO CONTOH FIKTIF KOTA FIKTIF'` — never truncated or discarded.

I did not find or need to add a "wrong-institution pick refused" case specific to picking a *different bank's* parser for an RK file beyond what's already exercised: `OCBC.detect()` returns 0 for every other bank's fixture (unaffected, untouched `detect.ts`/other parsers), and the existing generic `institution_mismatch` path (proven for BNI/BCA in the same file) is untouched code this PRD does not touch. Risk here is negligible; no new test was needed.

## Engineering checklist (`docs/ENGINEERING_CHECKLIST.md`)

No violations found in the diff:
- Integers only: `amountOf` → shared `parseMoneyAmount`; no `parseFloat`.
- One currency per sum: foreign (SGD) balance never summed into the IDR section; own-currency closing balance only (never the IDR-converted column), per criterion 10's test.
- Bounded work: `OCBC_MAX_SECTIONS` (20) reused and enforced, tested with 21 blocks.
- Fail-before proof: independently reproduced (see Commands run).
- Gates: clean except the pre-existing, unrelated net-worth scale flake (passes alone).
- No migration, no new npm dependency, no route/UI/i18n/server file touched — matches the PRD's "Out of scope"/"Architecture notes" exactly.

## Findings

None. No FAIL criteria.
