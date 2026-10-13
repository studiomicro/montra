# FN-17 Spreadsheet import (Excel / Google Sheets export)

Slug `fn-17-spreadsheet` · branch `feat/fn-17-spreadsheet` · risk tier **Large** (new external file input, parsed
untrusted ZIP/XML, money values, optional AI call). Follows common spreadsheet-import behaviour (`docs/FEATURES.md`), with Montra's own brand and copy.

## Goal

Let a user who keeps their money in Excel or Google Sheets bring it into Montra: upload a `.xlsx` on the existing
Impor screen, confirm how the columns map, review the rows exactly like a CSV import (FN-18), and save with undo.
Every number and date is copied by code from the file; a model never touches values. A heuristic mapper reads the
common layouts first. The user's own Anthropic key (BYOK, FN-41) may only suggest a column mapping from the headers
and a few sample rows when the heuristics fail, and the user always confirms it. Without a key, a manual column
picker works. Fits the main journey step "import a statement" for people who never get a bank PDF.

## Current behaviour (cited)

- XLS/XLSX is refused today: `sniffStatementFile` detects `PK\x03\x04` as `xlsx` and the OLE header as `xls`
  (`src/lib/shared/statements/detect.ts:24-30`); `documentOf` returns `spreadsheet_unsupported`
  (`src/lib/server/statements/read.ts:162`), shown as "Berkas XLS/XLSX belum didukung..."
  (`src/lib/server/imports/messages.ts:38-40`, mapped at `src/routes/(app)/impor/+page.server.ts:82`).
- No XLSX/zip dependency exists (`package.json` deps: `@noble/hashes`, `drizzle-orm`, `postal-mime`, `unpdf`, `zod`).
  `docs/features/fn-16a-statement-parsers/PRD.md:108-114` proposed SheetJS and left it "dormant"; nothing shipped
  (`grep xlsx src` finds only refusal code and copy). This PRD **replaces** that library choice (see Architecture).
- CSV pipeline to reuse: `MappedRow`/`RawCsvTransaction` (`src/lib/shared/csv.ts:201-216,333-335`), `PreparedRows`
  with `source` and `keyPrefix` (`src/lib/server/imports/csv-import.ts:94-107`), dedupe key
  `<source>:<hash>:<row index>` (`csv-import.ts:109-110`, prepare at `:113-135`), `previewRows`
  (`csv-import.ts:235-250`), `importRows` (`csv-import.ts:353+`), batch row `createImportBatch`
  (`src/lib/server/imports/repo.ts:48-56`), undo `undoImportBatch` (`repo.ts:92-153`), caps `CSV_MAX_BYTES` 5 MB,
  `CSV_MAX_ROWS` 5000, `CSV_MAX_COLUMNS` 50 (`src/lib/shared/csv.ts:19-26`).
- **CSV creates missing categories and wallets** (`csv-import.ts:384-440`: `plannedId('c:...')`, `newCategories`,
  `categoryRoom`); FN-18 mirror says so (`docs/FEATURES.md:219-224`). **FN-17 mirror says never create categories**
  (`docs/FEATURES.md:215`). Reconciled: spreadsheet rows never create a category or a wallet; see AC 14.
- Statement upload path to copy for the guards: per-user attempt throttle `overUserAttemptLimit(..., 'statement-upload',
  STATEMENT_UPLOADS_PER_WINDOW)` (`+page.server.ts:217-225`), bounded body `readFormBody` with total/idle timeouts
  (`+page.server.ts:226-231`, `src/lib/server/statements/validation.ts:18-23`), in-isolate reader slot
  `reservePdfRead` + 503 `Retry-After` (`+page.server.ts:182-200`), one creating action per import
  `overTransactionCreateLimit` (`+page.server.ts:~270`), content-free D1 failure `guardedDb` (`+page.server.ts:~240`).
- Impor page: one 1352-line `+page.svelte` with section cards: CSV "Impor mutasi" (`:431`), statement (`:614`), export
  (`:848`), history (`:888`), other ways (`:949`), jobs (`:986`).
- BYOK plumbing: `resolveAnthropicKey(db, userId, env)` returns the user's own key or null, never an app key
  (`src/lib/server/ai-keys/lookup.ts:31-48`); gateway URL / config check `anthropicGatewayUrl`, `isAiGatewayConfigured`
  (`src/lib/server/ai-keys/anthropic.ts:35-42`); working call pattern with timeout, gateway headers
  `cf-aig-skip-cache`/`cf-aig-collect-log: false`, JSON-schema `output_config`, zod parse
  (`src/lib/server/receipts/anthropic.ts:29-33,71-105`, `src/lib/server/receipts/schema.ts:27-68`); route use
  (`src/routes/(app)/riwayat/struk/+page.server.ts:2-3,105,190`). Missing key copy: "Tambahkan kunci Anthropic di
  Pengaturan › Integrasi AI" (`lookup.ts:34-35`).
- **Migration check:** `source = 'spreadsheet'` is already allowed in `transactions_source_check`
  (`migrations/0029_receipt_photos.sql:50`), `drafts_source_check` (`0006_drafts.sql:27`) and
  `import_batches_source_check` (`0010_csv_import.sql:19`, still current in `migrations/meta/0029_snapshot.json:2593`).
  `IMPORT_SOURCES` already lists it (`src/lib/shared/csv.ts:25`). Only the TS unions `ImportRowSource`
  (`csv-import.ts:94`) and `NewImportBatch.source` (`repo.ts:34`) must widen. **No migration needed.** If the engineer
  finds one is unavoidable (for example a `format`/mapping column on `import_batches`), it is **0036**, and the finding
  must be reported; the PRD does not expect it (the batch row records counts and filename only).
- OCR branch `feat/fn-16g-ocr` also edits `/impor`. Hence AC 1.

## Scope

1. **Spreadsheet section on Impor**, a new self-contained component `src/lib/ui/impor/SpreadsheetImport.svelte`
   (plus `src/lib/ui/impor/` helpers), mounted in `+page.svelte` by a single `<SpreadsheetImport ... />` line in its
   own `<section id="spreadsheet">`. Its server actions live in a new file `src/routes/(app)/impor/spreadsheet.server.ts`
   (functions exported and registered in `actions` with one spread/line each: `previewSheet`, `suggestMapping`,
   `importSheet`). Existing statement and CSV markup, wording and actions are not edited, except removing nothing:
   the statement path keeps refusing `.xlsx` but its message points to the new section (one line change in
   `messages.ts`, `STATEMENT_SPREADSHEET`).
2. **Flow (same as FN-18 review):** choose wallet (one per import) → pick `.xlsx` (or a hint: Google Sheets users
   download `.xlsx` or `.csv`) → server reads in memory, returns a **layout summary**: tabs found, which tabs are
   used/skipped and why, detected header row and column mapping per tab, 5 sample rows → user confirms or edits the
   mapping (dropdown per column: Tanggal, Keterangan, Kategori, Jumlah, Masuk, Keluar, Tipe, Abaikan; per-tab kind
   and month/year override) → **review** with the same counts (rows, imported, skipped, already imported, possible
   duplicates, not processed) and the same duplicate list/"Lewati yang mungkin duplikat" as CSV → import → history
   entry with undo (`import_batches.source = 'spreadsheet'`).
3. **Shared pure module** `src/lib/shared/spreadsheet/` (runs on Worker; no D1, no DOM): `layout.ts` (tab/header/
   column detection, synonyms), `rows.ts` (cells → `MappedRow[]`), `dates.ts` (Excel serial to WIB date), `types.ts`.
   Output feeds the existing `PreparedRows` (`source: 'spreadsheet'`, `format: null`,
   `keyPrefix: spreadsheet:<hash>:`) so `previewRows`/`importRows` are reused. Row index in the key is stable:
   `tabIndex * 100000 + rowIndexInTab` (or equivalent stable scheme the engineer documents), never the post-filter
   position, so changing the confirmed mapping or skip toggles does not re-key rows (hash is over the file bytes).
4. **Server XLSX reader** `src/lib/server/spreadsheet/xlsx-read.ts` (see Architecture for the library decision) with
   all guards of AC 6-9. Returns a bounded in-memory grid per sheet: `{ name, state, cells[][] }` of typed cells
   (`number | string | boolean | error | empty`, plus a flag when the cell has a date number format) and the
   workbook `date1904` flag. Cached values only.
5. **Heuristic layout mapper** (deterministic, first): Indonesian + English header synonyms (Tanggal/Tgl/Date,
   Keterangan/Uraian/Deskripsi/Catatan/Description/Note/Merchant, Kategori/Category, Jumlah/Nominal/Nilai/Amount/Total
   per row, Pemasukan/Masuk/Kredit/Income/In/Credit, Pengeluaran/Keluar/Debit/Expense/Out, Tipe/Jenis/Type, Saldo/
   Balance as ignore) normalised with the existing `cleanText` and ASCII-lowercase. Type inference: separate in/out
   columns; else amount + type column (Masuk/Pemasukan/Income/CR/K → income; Keluar/Pengeluaran/Expense/DB/D →
   expense); else tab name hints ("Pemasukan", "Income" tab = income; "Pengeluaran", "Expense" = expense); else
   amount sign (negative = expense, positive = income) only when both signs occur; otherwise ask the user.
6. **AI mapping suggestion (optional, BYOK):** `src/lib/server/spreadsheet/ai-mapping.ts` calls Anthropic via the
   AI Gateway like `readReceiptImage`, only when heuristics returned no confident date + amount mapping for a tab
   and the user pressed "Sarankan pemetaan dengan AI". Input: the header row text and at most 5 sample rows (each
   cell capped, control/zero-width stripped, numbers shown as-is, text truncated), tab name; never the rest of the
   file. Output schema (zod, strict): per column index → one of the role enums above, plus `headerRow` index and
   `kind` (`expense|income|both`). Invalid output, out-of-range index, duplicate single roles, or timeout → "Saran AI
   tidak bisa dipakai, pilih kolom manual" and the manual picker stays. The suggestion only pre-fills the picker; the
   import action recomputes everything from the file bytes plus the confirmed mapping (zod-validated, never a client
   row list). Without a key: button shows "Tambahkan kunci Anthropic di Pengaturan › Integrasi AI" with a link to
   `/pengaturan/integrasi`; gateway not configured: "Belum dikonfigurasi".
7. **i18n:** every new Indonesian phrase and `trf()` template via `msg()`/`tr()` with an English entry
   (`src/lib/shared/i18n.ts`, `i18n-en.ts`); server messages in a new `src/lib/server/spreadsheet/messages.ts`.
8. **Tests:** unit tests for dates, layout detection, row mapping, guards; an integration test with a 3,000-row
   fixture; one e2e spec (AC 25). Fixtures are generated in test code (writing a minimal xlsx with the same zip
   library) from fictional data; no real bank data, no real names.

## Out of scope

- Legacy `.xls`, `.xlsm` (macros), `.xlsb`, `.ods`, `.numbers`: refused with a message to save as `.xlsx` or `.csv`.
- Google Sheets API/OAuth. Users download `.xlsx` or `.csv` from Sheets (UI says so, AC 2).
- Evaluating formulas, resolving external links, pivot tables, charts, images, comments, hidden-sheet content.
- Creating categories or wallets from the sheet (AC 14); multi-currency (non-IDR rows are counted as foreign, as in
  CSV: `CsvCounts.foreignCurrency`, `csv-import.ts:67-82`); text amounts such as "25rb" (AC 13).
- Reading budget, asset or net-worth sheets as transactions (AC 12); transfer detection (skipped like CSV).
- Storing the file, rows, mapping or AI output server-side; sealing results (nothing is stored, FN-21 not needed).
- AI reading values, AI categorisation of rows, AI fixing dates; AI use beyond the mapping suggestion.
- Per-user saved mappings/templates ("remember this layout").
- Client-side parsing (decision below), a new queue/Workflow, a new table.
- Changes to the CSV or statement sections beyond the one message line, and anything in FN-16g's OCR section.

## Acceptance criteria

Verification level in brackets: **Automated** (vitest), **Browser** (e2e or manual browser), **Mocked** (stubbed AI).

Placement and UI
1. Impor changes are contained: one new section component mounted by one line in `+page.svelte`, server logic in
   `spreadsheet.server.ts`, shared markup helpers under `src/lib/ui/impor/`; diff of `+page.svelte` is only the
   import + mount (+ optional anchor link); diff of `+page.server.ts` is only action registration. [review]
2. The section shows "Impor spreadsheet (.xlsx)" with the copy "Dari Google Sheets: Berkas > Unduh > Microsoft Excel
   (.xlsx) atau CSV." and English equivalent; accepts `.xlsx`; a `.csv` chosen here points to the CSV/statement
   section instead of failing silently. [Browser]
3. Loading, empty (no file), reading, mapping, review, saving, success, error states exist; success shown only after
   the server confirms the write ("Lihat di Riwayat", history row, undo). 360 px layout, 44 px touch targets,
   no horizontal scroll, focus returns to the opener, light + dark. [Browser]
4. Works without JavaScript for the upload → preview → import path (plain form actions; AI button is the only JS-
   enhanced extra). [Browser]
5. The statement section's `.xlsx` refusal message now tells the user to use the spreadsheet section. [Automated]

Security and guards (XLSX reader)
6. Given a ZIP bomb (small file, huge expansion) or a file over caps, when uploaded, then it is refused with a clear
   message before full inflation: caps on compressed size (5 MB, same as `CSV_MAX_BYTES`), total uncompressed size,
   per-entry uncompressed size, entry count, and compression ratio; the engineer sets values, documents them in
   code and tests each boundary (cap-1 passes, cap+1 refused). Decompression is streamed/limited so memory is bounded;
   only the entries the reader needs (`[Content_Types].xml`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`,
   `xl/sharedStrings.xml`, `xl/worksheets/*.xml`, `xl/styles.xml`) are inflated, others are never read. [Automated]
7. Given an XML part with `<!DOCTYPE`/`<!ENTITY` (billion laughs, XXE), when read, then the file is refused; no
   entity expansion, no network or file access ever. [Automated]
8. Given `.xlsm`/macro content (`xl/vbaProject.bin`, macro-enabled content type), `.xls` (OLE magic), encrypted
   OOXML (OLE container), or a ZIP that is not a workbook, then it is refused with a distinct clear message.
   External links (`xl/externalLinks/`) are ignored, never fetched. Formulas: the cached `<v>` value is used, the
   formula text is never evaluated and never shown; a formula cell without cached value counts as empty. [Automated]
9. Given a sheet with more than the row cap (default aligned to `CSV_MAX_ROWS` 5000 data rows total across tabs)
   or more than 50 columns (`CSV_MAX_COLUMNS`), or a declared dimension far larger than its content (sparse
   `<dimension ref>` attack), then rows past the cap are counted "not processed" (like CSV) and columns past the cap
   are refused with a message; reader CPU/time is bounded (parse is incremental, abort after a work budget). Max
   tab count capped (default 40). Hidden and very-hidden sheets are skipped. [Automated]
10. The file is processed in memory only: grep of the diff shows no R2/D1/KV/log write of file bytes, cell text,
    sample rows or AI request/response; errors log a fixed line plus `errorLabel` only (`guardedDb` pattern).
    Filename kept only after `cleanText` + `maskAccountNumbers` (`validation.ts:84`). [Automated + review]
11. Same throttles as statements: per-user attempt limit before reading the body (new key `spreadsheet-upload`,
    same window as `STATEMENT_UPLOADS_PER_WINDOW`), `readFormBody` with total + idle timeouts, one in-isolate reader
    slot per isolate/user with 503 + `Retry-After`, `overTransactionCreateLimit` before import, 429/503 content-free
    messages. 20 concurrent uploads by one user: the cap holds exactly. [Automated]

Layout reading and rows
12. Given a workbook whose usable tabs contain only budget (targets/limits) or asset/net-worth tables, or no tab with
    a date and a numeric amount column, when read, then the file is refused with "Berkas ini tampak seperti anggaran
    atau daftar aset, bukan catatan transaksi" (+ EN) and nothing is previewable. Mixed workbooks import only the
    transaction tabs and list the skipped tabs with reasons. [Automated]
13. Amounts must be numeric cells (or numeric text accepted by the shared `parseMoneyAmount`, FN-14a, e.g. "28.000",
    "Rp 28.000,00") but not shorthand like "25rb"/"1,5 jt": those rows are skipped with reason "Jumlah bukan angka"
    and counted. Amounts become integer minor units, never floats: numeric cells are taken from the XML text with
    exact decimal handling (no `parseFloat` on money; reject values with more fractional digits than IDR allows or
    non-finite). Negative amounts follow AC 5-type rules. [Automated; money vectors from the checklist]
14. Categories: a row's sheet category is matched to the space's **visible** categories of the same kind by the
    existing `categoryNameKey` (exact normalised name), then by keyword (`importCategoryFromTitle`/
    `category-keywords.ts` mapped to the preset under its current name, as `categoryNameOf` does, `csv-import.ts:330-341`),
    else the row gets **no category** and shows "Tanpa kategori" (`src/lib/ui/transactions/row-text.ts:28`; engineer
    confirms `capturedTransactionInput` accepts `categoryId: null`, otherwise uses the existing uncategorised path).
    No category and no wallet is ever created by a spreadsheet import (differs from CSV on purpose,
    `csv-import.ts:384-440`; implement as an option on `importRows`, default unchanged for CSV/statement). The review
    shows the match result per distinct sheet category ("Makan -> Makan & Minum", "Tidak cocok -> Tanpa kategori") and
    counts. A hidden category is never a target. [Automated]
15. Layouts (each has a fictional fixture and test): (a) one long table with Tanggal/Keterangan/Kategori/Jumlah;
    (b) one tab per month: month and year from the tab title ("Januari 2026", "Jan 26", "2026-01", "Okt 2026"),
    day-only date column (`1`, `15`, "15 Okt"); a tab whose title has no month/year uses a user-chosen month/year,
    else skipped with a reason; (c) separate Pemasukan/Pengeluaran columns, or Jumlah + Tipe; (d) an income tab next
    to an expense tab (kind from the tab title or the user's per-tab choice); (e) title rows and blank rows above the
    table (header row found within the first 30 rows); (f) header repeated mid-sheet (skipped, not counted as a
    row); (g) total, subtotal, saldo/balance, "Jumlah", "Total" rows and rows with no date are skipped and counted
    separately; a skipped total row's value is never added; (h) merged-looking date cells (date only on the first
    row of a day) are filled down only when the user enables "Isi tanggal kosong dari baris atas" (default off). [Automated]
16. Dates: Excel serial numbers for the 1900 system including the leap-year-1900 quirk (serial 60 does not exist as a
    real date; serials below 61 shift by one) and the 1904 system when `<workbookPr date1904="1">`; fractional time
    part dropped; the result is the WIB calendar date used as `occurred_on` (a serial is a local wall date, no
    timezone shift is applied; test 31 Jan/1 Feb and 31 Dec/1 Jan boundaries). Text dates `2026-10-01`, `01/10/2026`
    (day first), `1 Okt 2026` via the shared date helpers (`src/lib/shared/dates.ts`); ambiguous or invalid dates
    skip the row. A cell is treated as a date when it is a number with a date number format (from `styles.xml`
    `numFmtId` built-in date ids and custom formats containing d/m/y) or sits in the mapped date column with a
    plausible serial range (default 1990-2100). [Automated]
17. Totals: a generated 3,000-row fixture (mixed income/expense, fictional) yields preview and imported totals
    (income sum, expense sum, row counts) identical to sums computed independently from the generator's source data,
    for both `.xlsx` and a tab-per-month variant; the sum of rows listed in Riwayat for the period equals the
    preview. Values are never altered by AI (the AI step is stubbed to fail and to return odd mappings in tests; totals
    unchanged). Acceptance row "Spreadsheet 3,000 rows -> totals identical to the file" (`docs/ACCEPTANCE.md:18`)
    moves to **Automated** with this test name; it moves to Pass only after a real-file run. [Automated]
18. Wallet: exactly one wallet per import, chosen by the user; no per-row wallet; an archived or foreign-space wallet
    id answers the same "not found" as CSV (`WALLET_NOT_FOUND`). [Automated]
19. Idempotency: importing the same file twice writes nothing the second time (`already` count = rows); a row deleted
    or undone is not recreated by the same file (dedupe key stays, as `repo.ts:86-91`); two concurrent identical
    imports end with one set of rows (`IMPORT_BUSY`/retry as CSV). Source on rows and batch is `spreadsheet`;
    possible-duplicate detection (same date/type/amount/title in the space) identical to CSV. [Automated]
20. Access: every load/action runs `currentSpaceScope`; a non-member and a removed member get the same refusal as for
    CSV; the import writes only when the user is a live member (`isLiveMember` in `createImportBatch`). Cross-space:
    a wallet or batch of another space is indistinguishable from a missing one. [Automated]

AI-assisted mapping
21. Heuristics run first; the AI button appears only when a tab has no confident date + amount mapping. With a key and
    gateway configured (stubbed in `npm test`), the request contains the header row and at most 5 sample rows (test
    asserts the serialized body has <= 5 data rows, none of the 3,000, and no cell over the cap); gateway headers
    skip cache and log collection (as `receipts/anthropic.ts`); timeout set. [Mocked]
22. AI output is zod-validated; invalid JSON, wrong types, unknown roles, columns outside the grid, or both an
    amount and in/out columns contradicting each other yield the manual picker with an error, never a crash and
    never a saved row. A valid suggestion only pre-fills; no row is previewed until the user presses "Pakai
    pemetaan ini". The import action ignores any client-sent rows. [Mocked]
23. Without a key (or key unreadable, or gateway not configured) the mapping picker still works fully; the AI button
    is replaced by the key hint. The key never appears in page data, logs, errors or the response. A failed or
    refused AI call costs no import state. Every AI call is rate-limited per user (reuse the attempt-throttle helper,
    small window) because it spends the user's own money; usage is not metered against Montra credits (BYOK). [Automated]

Journeys and trackers
24. Undo: "Urungkan" removes every row of the spreadsheet batch (existing `undoImportBatch`); history row says
    "Spreadsheet" with filename, counts. [Automated + Browser]
25. One e2e spec `e2e/impor-spreadsheet.spec.ts`: sign in, add wallet, upload a small generated `.xlsx`, confirm the
    mapping, see the review counts, import, see rows in Riwayat, undo. No other new e2e specs. [Browser]
26. Checklist items mapped: 100-parameter limit (distinct-category and duplicate lookups use `json_each`, test 101+
    ids), WIB boundaries (AC 16), integer money (AC 13), CSV-injection n/a (no export), untrusted text (cell text
    `cleanText`-ed, length-capped, zero-width stripped, never `{@html}`, keyed `{#each}` by index/id), safe form
    guard (`readFormBody`: 400/415, never 500), i18n (every phrase has EN), truthful state, stale form
    (`updated_at` on undo as today), `npm run gates` clean, fail-before proof for regression tests. [Automated]

## Architecture notes

Touches (new unless noted): `src/lib/shared/spreadsheet/*` (pure), `src/lib/server/spreadsheet/{xlsx-read,
ai-mapping,import,messages,validation}.ts`, `src/routes/(app)/impor/spreadsheet.server.ts` (+ one-line action
registrations in `+page.server.ts`), `src/lib/ui/impor/SpreadsheetImport.svelte`, `src/lib/shared/i18n.ts` +
`i18n-en.ts`, `src/lib/server/imports/csv-import.ts` (widen `ImportRowSource`; add an option so category and wallet
creation can be disabled: `createMissing: false`, default true), `src/lib/server/imports/repo.ts` (widen
`NewImportBatch.source`), `messages.ts` (one line). Worker: app Worker only; no queue, no `workers/jobs` change.
`import_batches.format` is null for spreadsheets (it holds CSV shapes only, as for statements, `csv-import.ts:96-99`).
The preview and the import both re-read the uploaded bytes (the file is re-uploaded with the confirmed mapping as
a short JSON form field, zod-validated; the server never trusts client rows), like CSV and statements do. Work
units stay small; the isolate reader slot bounds concurrent parses.

**XLSX parsing decision (engineer verifies versions and licences against official docs and npm; the PRD pins
nothing).** Options: (A) a full spreadsheet library such as SheetJS; (B) our own minimal reader over a small
zip/inflate library; (C) client-side parsing. Selection criteria: maintained with recent releases, permissive
licence compatible with a closed-source SaaS (MIT/BSD/Apache-2.0), installable from the npm registry at a pinned
exact version, no known unpatched advisories (`npm audit`, GitHub advisories), no Node-only APIs and no `eval`/
`new Function` (blocked on Workers), works within Workers CPU and memory limits (check current limits in the
Cloudflare docs, not from memory), supports streaming/limited inflate so zip-bomb caps are enforceable, small bundle.
**Preferred candidate: B** with `fflate` for unzip (pure JS, small, no Node APIs; use its limited/streaming APIs so
output size is capped) plus our own small XML scanner for `workbook.xml` (sheet names, `date1904`, visibility),
`_rels`, `sharedStrings.xml`, `styles.xml` (date number formats) and sheet `<c>/<v>/<is>` cells. Reason: a
hand-written, DOCTYPE-refusing reader gives us exact control of entity handling, caps and cached-value-only
semantics, and avoids SheetJS concerns (the npm `xlsx` package is not the vendor's current distribution channel, and
its older registry versions carry known advisories, so `docs/features/fn-16a-statement-parsers/PRD.md:108-114`'s
"pin from npm" plan must be re-verified, not assumed). Fall back to (A) only if it passes every criterion above and the
engineer documents why; reject (C): parsing untrusted ZIP/XML in the browser cannot be enforced server-side, the
Worker must re-parse anyway (authoritative import, as CSV does), and CSV's device preview is only a convenience.
Record the chosen package, exact version, licence, advisory check and bundle-size delta in the PR notes and
`docs/RUNBOOK.md`/dependency audit (`docs/features/deps-audit`). Shared-string and sheet XML is scanned with a
non-allocating tokenizer; no DOM parser. Dependency added to `package.json` with an exact version (no `^`).

Layout detection is scored, not first-match: candidate header rows in the first 30 rows scored by synonym hits and
row-below type consistency (date-like, numeric); ties go to the manual picker. Everything the mapper decides is
returned to the UI as data the user can override. The mapping and tab choices are the only user inputs besides the
wallet; they are small zod-validated JSON (bounded array lengths, enums).

## Prerequisites

- None required for the deterministic path and manual mapping.
- Optional AI suggestion: the user's own Anthropic key in `/pengaturan/integrasi` (FN-41, `AI_KEYS_ENCRYPTION_KEY`,
  AI Gateway id as in `.dev.vars.example`; engineer confirms exact names there). Missing key: hint with link to
  `/pengaturan/integrasi`; gateway not configured: "Belum dikonfigurasi". The Anthropic key remains on hold for the
  owner (`docs/TASKS.md:124`), so the AI branch is **Mocked** only until a real-provider test is run and recorded
  separately; the feature is otherwise fully usable.

## Owner decisions (adopted defaults; the owner proceeds automatically)

1. File size cap: **Adopted default** 5 MB `.xlsx` (same as CSV), uncompressed total cap 50 MB, ratio cap 100:1.
2. Row cap per import: **Adopted default** 5000 data rows total (CSV's `CSV_MAX_ROWS`); the rest counted "not processed".
3. Tab cap: **Adopted default** 40 visible tabs read; hidden tabs skipped.
4. Category policy: **Adopted default** never create categories or wallets from a sheet; unmatched rows get
   "Tanpa kategori" (differs from CSV, which creates them).
5. AI mapping: **Adopted default** user's own key only, headers + at most 5 sample rows, one suggestion per tab per
   press, 10 presses per 10 minutes per user, 30 s timeout, model the same family as receipts; no Montra credits charged.
6. Currency: **Adopted default** IDR only; other currency columns/labels are skipped and counted as foreign (as CSV).
7. Day-only date fill-down: **Adopted default** off; user can switch on.
8. Sign inference from amount sign: **Adopted default** only when the sheet has both positive and negative values and
   no type/in-out column; else the user chooses the kind per tab.
9. Parser: **Adopted default** own minimal reader on a small unzip library (fflate preferred), not SheetJS, not
   client-side; engineer verifies version and licence and may switch only per the criteria.
10. Possible duplicates: **Adopted default** same as CSV (left in by default, option to skip).
11. Google Sheets: **Adopted default** no API; download as `.xlsx`/`.csv` guidance in the UI.

## Tracker impact

- `docs/TASKS.md:67` "FN-15 Receipt · FN-16 Statement · FN-17 Spreadsheet (blocked by AI Gateway key for Pass
  level)" stays open for FN-15/16 AI halves; add a line "FN-17 Spreadsheet import (deterministic + manual mapping,
  AI mapping Mocked)" and move it to `docs/HISTORY.md` at ship. FN-16a's "dormant XLSX reader" note
  (`docs/features/fn-16a-statement-parsers/PRD.md:222-223`) is superseded.
- `docs/ACCEPTANCE.md:18` "Spreadsheet 3,000 rows -> totals identical to the file": Not run -> **Automated**
  (named test, AC 17), never Pass without a real-file/Browser run; AI mapping recorded as Mocked.
- `docs/FEATURES.md` FN-17: add an "Ours" note (heuristics first, BYOK mapping suggestion, own XLSX reader, no
  category creation) when shipped. Migration: **none (0036 stays unused unless the engineer reports otherwise).**
