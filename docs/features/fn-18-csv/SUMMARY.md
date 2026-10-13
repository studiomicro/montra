# FN-18 CSV import and export — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted; controller-approved deviations: "Mungkin
duplikat" heuristic rows skipped by default; unreadable rows counted and skipped while valid rows + batch are written
all-or-nothing).

- **Built:** migration `0010_csv_import.sql` (import batches); `/impor` with template CSV and Money Manager formats,
  device parsing + server re-validation through FN-05's validator, preview with duplicate flags, dedupe key
  `csv:<sha256(file)>:<row>`, all-or-nothing import via `insertTransactions`, whole-batch undo (content-free), caps
  (6 MB, 5.000 non-blank rows, 50 columns), 12:00 WIB default time, non-IDR rows skipped; streamed export (BOM,
  1.000 rows/page, membership re-checked per page, demo and transfer rows excluded) with formula guard incl. fullwidth
  and leading whitespace and a symmetric quote round trip; account/card numbers masked to the last 4 digits before
  storage and export (NFKC, any script, separators) — dates and dot-grouped amounts kept; `handleError` that never logs
  messages or bodies; e2e `impor.spec.ts`.
- **QA:** PASS 36/36. **Red team:** PASS; Lows fixed over cycles 2–3. Known gaps: `123.456.789`-style account numbers
  read as amounts stay unmasked; digits split across fields are not joined; guest import needs FN-02.
