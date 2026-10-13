# QA report: fn-17-spreadsheet (cycle 1)

**Verdict: PASS**

Reviewed `git diff 6093a3f..09f7a4f`. No migration added (confirmed: none in the diff). Engineer's full `npm run gates` on 09f7a4f (check 0 errors, lint clean, 270 files / 4074 tests, build) was accepted and not rerun, per instruction.

## Commands run

- `npm run check` -> `1955 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, then the three `tsc -p` projects clean (local, no provider).
- `npx vitest run src/lib/shared/spreadsheet src/lib/server/spreadsheet test/integration/impor-spreadsheet.test.ts test/integration/impor-statements.test.ts test/integration/impor-csv test/integration/transactions src/lib/server/imports src/lib/server/transactions` -> `Test Files 13 passed (13), Tests 223 passed (223)` (local D1 + fixtures; AI provider stubbed).
- `npx vitest run test/integration/impor-spreadsheet-qa.test.ts src/lib/server/spreadsheet/xlsx-qa.test.ts` -> `Test Files 2 passed (2), Tests 13 passed (13)` (QA-added tests; local D1, stubbed provider).
- `npx vitest run test/i18n-coverage.test.ts src/lib/shared/i18n.test.ts` -> `Test Files 2 passed (2), Tests 15 passed (15)`.
- `E2E_PORT=8821 npx playwright test e2e/impor-spreadsheet.spec.ts` -> `3 passed (28.8s)` (setup + phone + desktop; local wrangler server, no real provider). No process left on 8821.
- `npx prettier --write` + `npx eslint` on the two new test files -> clean.

## Checked criteria

1. Impor changes contained: PASS. `+page.svelte` diff = import, one `<SpreadsheetImport>` mount, history label branch; `+page.server.ts` = import + 3 action lines.
2. Section title, Google Sheets hint (PRD wording), EN entry `i18n-en.ts:2463`; `.csv` pointer: PASS (e2e asserts hint; integration "refusals: CSV here").
3. States, 360 px no horizontal scroll (phone project asserts), 44 px targets (CSS), focus to result box: PASS by e2e + DOM/CSS inspection. Dark mode and focus-return-to-opener only read in CSS/code, not screenshotted.
4. No-JS path: PASS by design (plain form actions, `use:enhance` progressive; integration drives actions as plain posts).
5. Statement `.xlsx` refusal points to the new section: PASS (`messages.ts` STATEMENT_SPREADSHEET; impor-statements test updated).
6. Zip bomb / caps: PASS. Boundaries tested in `xlsx-read.test.ts`: file bytes, entry count, per-part, total, ratio, lying declared size, inflate is streamed (`Inflate`), only needed parts read.
7. DOCTYPE/ENTITY: PASS. Existing test covered workbook.xml only; QA added `xlsx-qa.test.ts` covering styles, sharedStrings, rels, content types, sheet, lower-case `<!doctype`, bare `<!ENTITY`, and DOCTYPE after a comment. All refused.
8. .xlsm/vbaProject/macro content type, .xls, encrypted OLE, non-workbook zip, external links ignored, cached `<v>` only: PASS (xlsx-read tests + integration refusals).
9. Row/column/tab caps, sparse dimension, hidden sheets: PASS.
10. In-memory only, fixed log line + `errorLabel`, filename `cleanText` + `maskAccountNumbers`: PASS (grep of diff: no R2/KV/put; `guarded` logs fixed string; integration asserts `keuangan ••••0123.xlsx` and content-free 503).
11. Throttles: PASS. Key `spreadsheet-upload`, 429 before body read (`bodyUsed` false), reader lane 503 + `Retry-After: 30`, `overTransactionCreateLimit` before import, 20+ concurrent counts hold exactly 30.
12. Budget/asset-only refused with message; mixed workbook lists skipped tabs: PASS (rows.test, integration refusals).
13. Amounts exact integers, "25rb"/"1,5 jt" skipped as not a number, no float parsing: PASS (amounts.test, rows.test; grep finds no `parseFloat` on money).
14. Categories never created, hidden never a target, "Tanpa kategori", review shows match per sheet category: PASS (3000-row test asserts wallet/category counts unchanged and unmatched rows null; hidden category test).
15. Layouts (a)-(h): PASS, one rows.test block per layout including title rows, repeated header, total/saldo/dateless rows counted apart and never summed, fill-down default off.
16. Dates: PASS. 1900 leap quirk, boundaries, fraction dropped, text dates, plausible range in dates.test. 1904 was only unit-tested at `serialToDate`; QA added end-to-end 1904 (file flag -> reader -> row) for 31 Jan/1 Feb/31 Dec/1 Jan and the negative case.
17. 3,000 rows: PASS. `AC 17: 3,000 generated rows, totals identical to the file` for long-table and tab-per-month; preview, import and Riwayat (`periodTotals`) equal the generator's independent sums; AI stubbed to fail/odd mapping leaves totals unchanged. ACCEPTANCE row to be "Automated", not Pass.
18. One wallet; foreign/archived wallet = WALLET_NOT_FOUND 404: PASS.
19. Idempotency: PASS. Same file twice -> `already = rows`; undone rows not recreated; 20 concurrent imports -> one set; source `spreadsheet` on rows and batch.
20. Access: PASS. Non-member / removed member import 404/nothing written (existing). QA added: removed member and stranger naming the shared space on `previewSheet`/`suggestMapping` are answered in their own space (same as CSV), shared space untouched.
21. AI sees header + <=5 sample rows only (3,000-row tab; ai-mapping.test + QA test asserting rows #10 and #2999 absent from the body), gateway headers `cf-aig-skip-cache: true`, `cf-aig-collect-log: false`, abort signal set: PASS. Button only for tabs with no confident mapping; QA added a 400 for a tab already mapped, no provider call.
22. AI output zod-validated; invalid JSON, out-of-range index, contradictions -> manual picker with error; valid output only pre-fills (`review: null`), import re-reads file: PASS.
23. No key / gateway missing -> hint and "Belum dikonfigurasi", manual picker works; key absent from response (`inspect` check): PASS. AI budget (10 per window, key `spreadsheet-ai`) had no test; QA added: 11th press makes no provider call and says so, other users keep their own budget. PASS.
24. Undo removes the batch; history label "Spreadsheet": PASS (integration + e2e).
25. One e2e spec, passes on phone and desktop: PASS.
26. Checklist mapping (json_each 100-param, untrusted text, safe form guard 400/415, i18n): PASS; i18n coverage tests pass with the new EN entries. Real-file/Browser run of the 3,000-row case is still not done (stays "Automated").

## Findings

No FAIL. Minor, not blocking:

1. Trackers not updated in the diff: `docs/ACCEPTANCE.md` row "Spreadsheet 3,000 rows" still says `Not run` (PRD: set to Automated with the test name `AC 17: 3,000 generated rows, totals identical to the file`); `docs/TASKS.md` and `docs/FEATURES.md` notes likewise. Do this at ship.
2. Removed-member reads on `previewSheet`/`suggestMapping` answer 200 in the member's own space rather than 404 (CSV behaves the same; nothing of the shared space is read or written). Documented in the QA test; matches AC 20 ("same refusal as CSV").
3. Visual checks of dark mode and focus return to the opener were not screenshotted (e2e checks no horizontal scroll and flow only).

## Tests added (test files only)

- `src/lib/server/spreadsheet/xlsx-qa.test.ts`: DOCTYPE/ENTITY in every inflated part; 1904 system end to end.
- `test/integration/impor-spreadsheet-qa.test.ts`: read paths for non-members; AI per-user budget; gateway request headers/sample bound; AI refused for an already mapped tab.

## Re-check (cycle 2)

Reviewed `git diff a56c53e..ed847fd` (7 files: `xml.ts`, `xlsx-read.ts`, `ai-mapping.ts`, `types.ts` and tests). Full gates accepted from the engineer at ed847fd, not rerun.

Targeted run: `npx vitest run src/lib/server/spreadsheet src/lib/shared/spreadsheet test/integration/impor-spreadsheet.test.ts test/integration/impor-spreadsheet-qa.test.ts`
Result: **10 files, 141 tests, all pass** (5.6 s). Covers the new `xlsx-cpu.test.ts` (M1 repros under 1 s, attribute reading unchanged, format cap 512 accepted / 513 refused, 2 000-format cap, normal dates and foreign amounts still classified, row above 1 048 576 refused and the last Excel row read), the L3 `mappingPrompt` masking test and the L2 dedupe-key test. The earlier cycle 1 tests (reader, QA, integration) still pass, so there is no regression for the generated real-shape workbooks.

Verdict: **PASS**. Not covered: a real Excel or Google Sheets file with a `sqref` over 32 KB (see SECURITY_REPORT L5).
