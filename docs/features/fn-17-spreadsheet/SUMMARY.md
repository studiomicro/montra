# FN-17 Spreadsheet import: summary

Status: **complete** (2026-10-10, branch `feat/fn-17-spreadsheet`; not merged, not deployed).

- Goal (PRD): import `.xlsx` workbooks (Excel, or a Google Sheets download as .xlsx/.csv; there is no Google API) on
  the same Impor screen and review flow as CSV. Code copies every number; a model never rewrites one.
- Layouts:
  - One long table, or one tab per month (month and year from the tab title, a day-only date column).
  - Separate in/out columns, or amount + type. An income tab can sit next to an expense tab.
  - Titles above the table and repeated headers are handled. Excel date serials work in both the 1900 and 1904
    systems.
  - Total, subtotal and balance rows are skipped, and so are rows without a date.
- Categories match the space's own by name or keyword, else "Tanpa kategori". No categories or wallets are ever
  created (`createMissing: false`). There is one wallet per import, and shorthand amounts ("25rb") are refused.
- Mapping:
  - Deterministic header synonyms (ID/EN) and type inference come first, and the user confirms the mapping.
  - With the user's own Anthropic key (FN-15/FN-41 plumbing), the AI may suggest a mapping. It sees the header plus
    at most 5 masked sample rows, and its answer passes a zod schema. Limit: 10 presses per 10 minutes.
  - Manual mapping works without a key.
- Reader: our own minimal XLSX reader on `fflate` 0.8.3 (MIT, exact pin), processed in memory and never stored.
  - The zip is capped: 5 MB file, 50 MB uncompressed, 100:1 ratio, plus caps on entries, rows (5,000) and tabs (40).
  - DOCTYPE/entities are refused. Tag length (32 KB), format-code length (512) and format count (2,000) are capped,
    and attributes are scanned linearly.
  - Formulas use cached values only. External links are ignored. `.xls`, `.xlsm`, `vbaProject.bin` and encrypted
    files are refused.
- Imports use source `spreadsheet`, the same dedupe and undo as CSV, and the `spreadsheet-upload` / `spreadsheet-ai`
  throttles.
- Files:
  - New `src/lib/shared/spreadsheet/*` and `src/lib/server/spreadsheet/*`.
  - New `src/routes/(app)/impor/spreadsheet.server.ts`, `src/lib/ui/impor/SpreadsheetImport.svelte` and
    `sheet-view.ts`.
  - Small edits to `+page.svelte`/`+page.server.ts` (a mount line, the history label), `imports/csv-import.ts`,
    `imports/repo.ts`, `transactions/{repo,validation}.ts` (null category for spreadsheet rows only),
    `auth/throttle.ts` and `i18n-en.ts`.
- Migrations: none (`spreadsheet` was already allowed by the CHECKs in 0006/0010/0029).
- Tests:
  - Unit tests for dates, amounts, layout/rows, the XLSX reader, the XML guards, the CPU caps, AI mapping and
    validation.
  - `test/integration/impor-spreadsheet{,-qa}.test.ts`, including the 3,000-row identical-totals test.
  - `e2e/impor-spreadsheet.spec.ts`.
  - Fixtures are generated in code with `fflate.zipSync`, and all data is fictional.
- QA: PASS (cycle 1). Red team: FAIL in cycle 1 (M1, CPU blowup from a crafted XLSX), fixed in cycle 2 (ed847fd), then
  PASS on re-check.
- Open lows (`SECURITY_REPORT.md`):
  - L1: peak memory of about 80 MB per read, against the 128 MB isolate.
  - L4: reader slots are held during the body read and the AI call.
  - L5: an open tag over 32 KB refuses the whole file.
- Not verified: a real Anthropic call for the mapping suggestion (mocked only), and a real Excel or Google Sheets
  export from a user. Dark mode and focus return were not screenshotted.
