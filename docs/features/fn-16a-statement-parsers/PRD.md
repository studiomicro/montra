# FN-16a Deterministic e-statement parsers — PRD

Catalog entry: `docs/FEATURES.md` › FN-16 (line 188-203) — **FN-16a is the deterministic, no-AI subset of FN-16**:
text-based PDF, CSV and XLS(X) e-statements read by a parser, never a model. Scanned/image PDFs and receipt
photos still need FN-16's AI path (`docs/FEATURES.md:191-192`), which stays blocked on the on-hold Anthropic key
(`docs/TASKS.md:100-101`). A one-line note is added to `docs/FEATURES.md` FN-16 marking this split (see
Tracker impact). Tracker: `docs/TASKS.md` › Phase 2 › "`- [ ] **Claude** — FN-15 Receipt · FN-16 Statement ·
FN-17 Spreadsheet (blocked by AI Gateway key for Pass level).`" (`docs/TASKS.md:59`) — this PRD is the part of
that line that does **not** need the key. Risk tier: **Large** (new external input — an uploaded PDF/CSV/XLS file
parsed server-side — per `.claude/commands/build-feature.md:15`).

Owner request (2026-10-08): "test also the OCR and e-statement compatibility" → chosen option: build the
non-AI e-statement parsers plus a compatibility harness now; receipt OCR stays on hold for the Anthropic key. The
owner will drop real, redacted statement PDFs/CSVs and receipt photos into the local, git-ignored
`.superpowers/ref/samples/statements/` and `.../receipts/` (confirmed empty and covered by the blanket
`.superpowers/` ignore, `.gitignore:33`) — never committed, never copied into the repo or fixtures, never sent to
any external service.

Depends on FN-18 (`docs/features/fn-18-csv/PRD.md`), already built: `import_batches`
(`src/lib/server/db/schema.ts:308-342`), the `transactions` columns it added
(`src/lib/server/db/schema.ts:353-424`), `src/lib/server/imports/{repo,csv-import,csv-export,validation,messages}.ts`,
`src/lib/shared/csv.ts`, and the `/impor` route (`src/routes/(app)/impor/+page.server.ts`,
`src/routes/(app)/impor/+page.svelte`). **No migration.** `import_batches.source` already allows `'statement'`
(`src/lib/server/db/schema.ts:315,334-336`, `src/lib/shared/csv.ts:16`) and `transactions.source` already allows
`'statement'` (`src/lib/server/db/schema.ts:414-416`) — both schema-ready and unused until this pass, the same
precedent FN-18's own PRD names for `dedupe_key` (`docs/features/fn-18-csv/PRD.md:266-267`). The `/impor` page
already carries the placeholders this feature fills in: a disabled "Baca dengan AI" button with
"Pembacaan mutasi dengan AI belum dikonfigurasi. Untuk sekarang gunakan CSV." (`src/routes/(app)/impor/+page.svelte:380-387`)
and an empty "Pekerjaan membaca terbaru" card with "Mutasi PDF dan gambar akan dibaca di sini setelah pembacaan AI
dikonfigurasi." (`src/routes/(app)/impor/+page.svelte:629-636`) — this feature adds the PDF/CSV/XLS **upload**
section next to those, not a new top-level route.

## Goal

FN-16's own "Tinjau impor" review, balance check and dedupe flow (`docs/FEATURES.md:194-201`) does not need AI for
every statement — many Indonesian bank and e-wallet exports are already plain, selectable text (a text-layer PDF)
or a spreadsheet, and MONTRA's own shared CSV reader (FN-18) already does exact, auditable parsing with no model
in the loop. Shipping that deterministic path now, ahead of the Anthropic key, lets a real user import a BCA or
BRI e-statement (the two institutions confirmed below to offer a text/CSV export) the same day FN-18 CSV ships,
reuses every dedupe/undo/masking guarantee already built, and gives the owner a working compatibility harness to
point real redacted statements at before any AI spend is approved — "money is never invented" extends to never
guessing a bank's column layout either.

## Scope

### Institution formats (researched, not guessed — cited; prioritised by Indonesian market share per the brief)

Column layouts are **not** claimed here — only the export mechanism and file format, from each bank/e-wallet's own
help page or a third-party report of it. Per-institution column mapping is written and tested only once a real,
redacted sample exists in `.superpowers/ref/samples/statements/<institution>/`; until then the harness reports
"tidak ada sampel" for that institution rather than a guessed mapping.

| # | Institution | Export confirmed | Format | Source |
| - | - | - | - | - |
| 1 | **BCA** | Yes — myBCA › e-Statement, monthly period, PDF download | **PDF (text-layer)** | [BCA e-Statement](https://www.bca.co.id/id/Individu/layanan/e-banking/mybca/e-statement), [BCA how-to](https://www.bca.co.id/id/informasi/Edukatips/2023/11/01/07/10/cara-mudah-mengecek-informasi-e-statement-di-mybca) |
| 2 | **Mandiri** | Partial — Consolidated Statement e-mailed monthly (format not stated by the bank in what we found); Livin' "Status Transaksi" exports a per-transaction receipt, not a statement | **Unconfirmed** | [Mandiri e-Statement FAQ](https://www.bankmandiri.co.id/faq-layanan-e-statement) |
| 3 | **BRI** | Yes — BRImo › Mutasi › e-Statement tab, period + **document type chosen by the user, PDF or CSV** | **PDF or CSV (user's choice)** | [BRImo e-Statement steps, IDXChannel](https://www.idxchannel.com/banking/nasabah-baru-jangan-bingung-begini-cara-melihat-mutasi-bri-di-hp-dan-atm) |
| 4 | **BNI** | Not found in BNI's own mobile-banking pages or help content we could reach | **Unconfirmed** | [BNI Mobile Banking](https://bni.co.id/en-us/e-banking/bni-mobile-banking) (feature list has no statement export) |
| 5 | **CIMB Niaga** | Yes — OCTO Mobile › Rekening Saya › Laporan, "unduh" for **PDF** or "e-mail" to send it; no CSV/XLS mentioned | **PDF only** | [CIMB Niaga mutasi guide (official)](https://www.cimbniaga.co.id/id/inspirasi/perencanaan/manfaat-cek-mutasi-secara-rutin-dan-caranya-yang-mudah) |
| 6 | **Bank Jago** | Not found for the personal app (the business web app has a download, consumer app does not document one) | **Unconfirmed** | — (no official consumer-app page found) |
| 7 | **SeaBank** | e-Statement menu exists (period selectable); download/print format not confirmed in what we found | **Unconfirmed** | [SeaBank mutasi guide](https://www.idxchannel.com/banking/cara-cek-mutasi-rekening-seabank-mudah-dan-praktis-hanya-lewat-hp/all) |
| 8 | **GoPay / Gojek** | Yes, but only for Gojek **order history** (Profil › Pesanan › unduh, ≤1 year) — a PDF of ride/food orders, not a GoPay wallet ledger; in-app GoPay merchant payments are not covered by this export per the same source | **PDF (orders only, not a full wallet statement)** | [Gojek order history export](https://economy.okezone.com/read/2023/09/01/622/2875360/cara-mudah-melihat-riwayat-transaksi-di-gojek) |
| 9 | **OVO** | Not found — no export/download feature surfaced for OVO's transaction history in what we could reach | **Unconfirmed / likely none** | — |
| 10 | **DANA** | Not found — DANA's own history screen is filterable but no export/e-mail feature surfaced | **Unconfirmed / likely none** | — |
| 11 | **ShopeePay** | Not found — history is in-app only (filter by type/date), no export surfaced | **Unconfirmed / likely none** | — |

**Reading of the table (owner decision, see below):** only **BCA** (PDF text) and **BRI** (PDF text or CSV) have a
confirmed, bank-documented export this pass builds a real per-institution column mapping for — and only once the
owner's redacted sample for that institution exists; without a sample the parser is not written blind. Every other
institution gets **detection only** (so the compatibility harness can report "terdeteksi, belum ada parser" instead
of silently failing) until either a sample arrives or the owner confirms the export exists. CIMB Niaga's confirmed
PDF-only export, Mandiri's e-mailed Consolidated Statement and GoPay's order-history PDF are strong candidates for
the next institution added once a sample confirms their actual column layout; this pass does not promise them.

### PDF text extraction (server only, in the app Worker)

- **Library: `unpdf`** (npm, pin the exact version at implementation time — `1.8.x` was current as of this
  research; verify with `npm info unpdf version` before adding it). It ships a pre-bundled, Workers-targeted build
  of Mozilla's PDF.js (`pdfjs-serverless`, ~1.6 MB minified) with no Node-only API, and exposes a short
  `getDocumentProxy()` + `extractText()` pair purpose-built for this runtime
  ([unpdf README via jsdelivr](https://cdn.jsdelivr.net/npm/unpdf@1.8.0/README.md)). **Justification over a
  hand-rolled minimal PDF tokenizer:** a correct PDF text-extraction parser (cross-reference table, object streams,
  `FlateDecode`, font encoding/ToUnicode maps) is exactly the class of bug-prone, security-sensitive code this repo
  should not reinvent; `unpdf` is the one option found that is explicitly built and tested for Cloudflare Workers
  rather than adapted from a Node-only library. **Caveat to verify before relying on it (not confirmed by this
  research):** whether `unpdf`'s `getDocumentProxy()` passes through PDF.js's native `password` option. The
  engineer must check `unpdf`'s current README/source first; if it does not expose a password path, FN-16a still
  detects an encrypted PDF (PDF.js throws a password exception) and shows "PDF berkata sandi belum didukung di
  sini — gunakan Impor mutasi AI setelah tersedia" rather than silently failing or passing the file through
  unread (criterion 14). This never collects or stores the password either way, consistent with FN-16's own
  password handling (`docs/FEATURES.md:191`: "used once and never stored") even though this pass cannot fulfil
  the "ask for the password" half.
- `src/lib/server/statements/pdf-text.ts` (new, server-only — not added to the client bundle; no client-side PDF
  preview exists this pass, unlike FN-18's instant CSV preview, because loading a 1.6 MB PDF.js build into the
  browser bundle for every page is not justified for this feature alone): `extractPdfText(bytes: Uint8Array):
  { ok: true; pages: string[] } | { ok: false; reason: 'encrypted' | 'too_many_pages' | 'corrupt' | 'no_text' }`.
  `'no_text'` is a scanned/image-only PDF (every page's extracted text is empty or below a short-word threshold) —
  this is FN-16a's explicit hand-off to FN-16's AI path (criterion 8), not a bug.
- Bounds (owner decision B): file size cap **15 MB** (mirrors FN-16's own 20 MB mirror ceiling,
  `docs/FEATURES.md:191`, reduced slightly because this pass never offloads the read to a Workflow — it is one
  request); page cap **200 pages** (a WIB-month bank statement is a handful of pages; 200 covers a worst-case
  multi-year PDF without an unbounded CPU-time read, checklist › "Bounded work").

### CSV / XLS(X) e-statement reading

- **CSV-shaped exports** (confirmed so far: BRI's CSV option) reuse `src/lib/shared/csv.ts`'s existing RFC
  4180-style `parseCsv`/`headerIndex` reader unchanged — a bank CSV is just a third header shape next to FN-18's
  `template`/`money_manager` ones, detected the same way (`detectCsvFormat`-style, extended per institution).
- **XLS/XLSX:** no institution on this list is confirmed (by this research) to export one; the architecture adds
  the reading capability without shipping it live for any institution this pass, so FN-17 (spreadsheet import,
  still blocked on the AI key for its own mapping step) can reuse the same reader later rather than two Workers
  picking two different libraries. **Library: SheetJS Community Edition (`xlsx`, pin the exact current version at
  implementation — verify with `npm info xlsx version`)**, read via `XLSX.read(bytes, { type: 'array' })` — never
  `XLSX.readFile`, which is Node-only (confirmed by SheetJS's own Workers guidance: pass bytes to `read()`,
  [SheetJS JSR mirror doc](https://jsr.io/@mirror/xlsx/doc)). **Justification:** it is the de-facto standard
  spreadsheet reader with documented Workers/Deno/Bun support and no native dependency, versus any Node-only
  alternative (`exceljs` pulls in Node stream internals not vetted here). **Not wired to any route this pass** —
  it ships as `src/lib/server/statements/xlsx-read.ts` with its own fixture test, inert until a real XLS(X)
  statement sample proves which institution needs it (same "ship the capability, use it nowhere yet" posture as
  FN-18's `import_batches.source` check already carrying unused values).

### Detection and per-institution mapping

- `src/lib/shared/statements/detect.ts` (new, pure, shared): `detectStatementFormat(bytes | text): 'pdf_text' |
  'pdf_scanned' | 'csv' | 'xlsx' | 'unknown'` (by magic bytes/extension plus, for PDF, whether `pdf-text.ts`'s
  extraction found readable text); `detectInstitution(text: string): Institution | 'unknown'` — a small, explicit
  keyword/letterhead table per institution (bank name, known header phrases from a real sample), **never** a guess
  from a column count or a generic heuristic; an institution only appears in this table once a sample has proven
  a stable detection phrase for it.
- `src/lib/shared/statements/<institution>.ts` (one small module per institution **that has both a confirmed
  export mechanism and a sample on disk** — this pass expects to write `bca.ts` and `bri.ts`; others are added
  the same way, later, as samples arrive): each exports `parseRows(pages: string[] | string[][]): MappedRow[]`
  returning the **same `MappedRow`/`RawCsvTransaction` shape FN-18 already defined**
  (`src/lib/shared/csv.ts:202-216,333-335`) — a statement row is a CSV row with a different reader in front of it,
  never a second intermediate type. Opening/closing balance lines, running-balance columns and header/footer noise
  are recognised and excluded from the row set, not mis-read as transactions (criterion 6); amounts go through
  `parseMoneyAmount` (FN-14a) exactly as FN-18's mappers already do — never a second amount tokenizer.
- `src/lib/server/statements/statement-import.ts` (new) mirrors `src/lib/server/imports/csv-import.ts`'s
  `prepare`/`classify`/`previewStatement`/`importStatement` shape almost exactly (same dedupe-key prefix pattern,
  same "possible duplicate" query, same `db.batch` all-or-nothing write), but:
  - takes raw file bytes plus the detected/chosen institution and format, runs the matching extractor
    (`pdf-text.ts` or `xlsx-read.ts` or the shared CSV reader) then the institution's `parseRows`;
  - computes the **balance check** the FN-16 mirror promises (`docs/FEATURES.md:195`: "balance check (opening +
    rows = closing, else warn that rows may be missing)") when the statement prints an opening and closing
    balance (every row's signed amount summed against `closing − opening`); prints only pass/fail plus the gap in
    rupiah, never a row's own account/description text in that message;
  - writes with `source: 'statement'` (already a valid `transactions.source`/`import_batches.source` value, no
    migration) and `dedupeKey = 'statement:<sha256 of the raw bytes>:<row index>'`, parallel to FN-18's
    `csv:<hash>:<index>` scheme (`src/lib/server/imports/csv-import.ts:98-99`);
  - reuses, unchanged: `findOrCreateWalletByName`/`findOrCreateCategoryByName` (FN-18's additive exports on the
    FN-04/06 repos), `capturedTransactionInput` (FN-05's validator), `insertTransactions`, `createImportBatch`,
    `undoImportBatch`, `maskAccountNumbers` (account numbers in a statement's own description column masked to the
    last 4 digits before storage, same as FN-18's extras).
- **No new amount parser, no new dedupe scheme, no second validator** — every one of FN-18's "reuse, do not
  duplicate" rules (`docs/features/fn-18-csv/PRD.md:285-294`) applies unchanged to statements.

### `/impor` UI additions

- A new section "Impor mutasi (PDF/CSV)" on `src/routes/(app)/impor/+page.svelte`, next to the existing CSV
  section, sharing the same wallet picker and "Riwayat impor"/"Urungkan" list (batches of every source already
  render there by `import_batches.id`, `src/routes/(app)/impor/+page.svelte:544`): a file picker
  (`accept=".pdf,.csv,.xls,.xlsx"`), an institution `Segmented`/`PickerSheet` with "Deteksi otomatis" plus the
  confirmed institutions (mirrors FN-16's own "Deteksi otomatis" pattern, `docs/FEATURES.md:190`), a "Pratinjau"
  step showing the balance check line and possible-duplicate list (identical UI pattern to the CSV preview already
  built, `src/routes/(app)/impor/+page.svelte:447-470`), and "Impor N transaksi".
- A scanned/image PDF, an unrecognised institution, or an XLS(X) file with no institution match answers the same
  honest "perlu dibaca AI" state already stubbed in the sidebar card (`src/routes/(app)/impor/+page.svelte:629-636`)
  — this pass replaces that card's static text with a real state driven by what the upload action actually found
  ("Berkas ini perlu dibaca AI (pembacaan AI belum dikonfigurasi)." / English), never a silent failure or a
  best-effort guess at a scanned page's content.
- i18n: every new Indonesian phrase ("Impor mutasi (PDF/CSV)", "Pilih institusi", "Deteksi otomatis",
  "Saldo cocok", "Saldo tidak cocok, mungkin ada baris yang hilang", "PDF ini perlu dibaca AI",
  "PDF berkata sandi belum didukung di sini", a `trf()` balance-gap template) added to
  `src/lib/shared/i18n.ts`/`i18n-en.ts`.

### Compatibility harness (owner's explicit ask)

- **`npm run compat:statements`** → `scripts/compat-statements.ts` (new, same "plain `node` script" pattern as
  `scripts/migrate-local.ts`/`seed-local.ts`, local-only, guarded by the existing `assertLocalOnly` helper so it
  can never target a remote D1): walks every file under `.superpowers/ref/samples/statements/**` (skipped
  entirely, with a one-line notice, when the folder does not exist or is empty — this never fails CI, which has
  no samples), runs `detectStatementFormat` → `detectInstitution` → the matching extractor and parser (or, for a
  scanned PDF or an institution with no parser yet, records that outcome instead of attempting one), and prints a
  matrix to stdout only:

  ```
  institution       format      rows parsed   rows rejected (reasons)         balance check
  bca               pdf_text    42             3 (unparseable_amount: 2,      pass (Rp0 gap)
                                                   missing_date: 1)
  bri               csv         18             0                              no closing balance printed
  mandiri           pdf_text    —              — (no parser for this inst.)   —
  jago              unknown     —              — (institution not detected)   —
  <scanned.pdf>     pdf_scanned —              — (perlu dibaca AI)            —
  ```

  **Never prints** an account number, a row's description/title, a file name beyond the institution folder name
  given to it (the owner's own folder layout, e.g. `.../statements/bca/2026-09.pdf`), or any other row content —
  only counts, typed rejection reasons and the balance-check pass/fail (criterion 20). Exits 0 always (a
  compatibility report, not a test gate); a non-empty "unsupported" column is the point of running it, not a
  failure.
- Receipt photos: the harness also walks `.superpowers/ref/samples/receipts/**` and prints one line per file:
  `<institution-or-unknown folder>  needs OCR (FN-15, blocked on key)` — it never attempts to read a receipt image
  (no OCR library, no AI call) this pass; this satisfies the owner's ask to "test" receipt compatibility by
  recording that they exist and are counted, honestly deferred, rather than silently ignored.
- **Synthetic fixtures (committed, clearly fictional)**: `test/fixtures/statements/<format>/*.{pdf,csv}` — one
  small, hand-built fixture per supported format (`pdf_text` for BCA's confirmed shape once a real sample has
  taught the parser its header phrases and column order; `csv` for BRI's shape likewise; plus edge-case fixtures
  per Acceptance criterion 10-18 below: malformed PDF, password-protected PDF stub, huge/zip-bomb-shaped PDF
  stream, multi-page, year rollover, Windows-1252-encoded CSV) — every fixture amount, date, name and account
  number is invented and obviously fictional (e.g. "PT Contoh Fiktif", account `1234•••• 5678`, amounts that are
  round numbers), run in CI via Vitest, never the owner's real samples (which are never committed).

## Out of scope

- **Any institution's real column mapping without a real sample.** The nine institutions in the table without a
  confirmed export, and even BCA/BRI's exact column order/date format, are written from the owner's redacted
  sample, not from this research's prose descriptions of app screens (which never show a column header). Until a
  sample exists for an institution, FN-16a ships detection-and-honest-refusal for it, not a parser.
- **Receipt OCR (FN-15)** and **AI-read scanned/image statements (FN-16's AI half)** — both stay behind the
  on-hold Anthropic key; this feature's only connection to them is the harness's honest "needs OCR"/"perlu dibaca
  AI" labels and the shared `import_batches`/review-flow plumbing FN-16's AI half will also use.
- **Spreadsheet `.xlsx` import as a user-facing feature (FN-17)** — the XLSX reader this pass adds is dormant
  infrastructure; FN-17's own column-mapping UI and AI-assisted layout detection are not built here.
- **Password-protected PDF support**, beyond detecting one and refusing with a clear message, unless `unpdf` is
  confirmed (during implementation) to pass a password through — FN-16's full "ask for the password, used once,
  never stored" flow (`docs/FEATURES.md:191`) is not delivered this pass if that confirmation fails.
- **"Mungkin duplikat" across a statement and a CSV/Gmail import of the same period** reuses FN-18's existing
  same-space exact-match query (date + type + amount + title) unchanged; no new cross-source matching heuristic is
  built here.
- **Editing a parsed row before import** (same posture as FN-18: fix in Riwayat after, or undo the whole batch).
- **Gmail look-back import (FN-19)** and **Workflows-based long-running statement reads** — this pass's parsing is
  fast and synchronous in the app Worker (a text extraction, not an AI call), so no Queue/Workflow is introduced;
  FN-16's own AI half may need one later for its 10-60 s AI read, out of scope here.

## Acceptance criteria

**Detection and format**

1. Given a text-layer PDF whose extracted text matches a known institution's detection phrase, when uploaded, then
   `detectInstitution` returns that institution and the matching parser runs; given no match, the UI offers the
   manual institution picker rather than guessing one.
2. Given a scanned/image-only PDF (no extractable text on any page, or every page below the short-word threshold),
   when uploaded, then the result is `pdf_scanned` and the UI shows "perlu dibaca AI" — never an empty or
   zero-row "import" result presented as success.
3. Given a password-protected PDF, when uploaded, then it is detected as encrypted and refused with a clear
   message naming the limitation — never a crash, never a silently empty read.
4. Given a CSV file matching a known institution's bank-statement header shape (as opposed to FN-18's
   `template`/`money_manager` shapes), when uploaded, then it is read by that institution's CSV mapper, not
   misdetected as a FN-18 template file (and vice versa — a FN-18 template CSV is never misdetected as a bank
   statement).
5. Given an XLS/XLSX file, when uploaded, then `xlsx-read.ts` successfully reads its sheets into rows (fixture
   test) even though no institution routes to it live this pass — the reader itself is proven working, not routed.
6. Given a real institution's statement containing an opening-balance line, a closing-balance line and/or a
   running-balance column, when parsed, then those lines are excluded from the transaction row set (never written
   as a transaction) and, when both an opening and closing balance are printed, used only for the balance check.

**Parsing correctness (per confirmed institution, from a real sample)**

7. Given the BCA fixture (built from a real, owner-provided, redacted sample before this parser ships), every row's
   date, debit/credit direction, amount and description map correctly, and every amount round-trips through
   `parseMoneyAmount` (FN-14a) to the same integer minor units as the fixture's known-good values — no second
   amount tokenizer exists (a code-search confirms one call site).
8. Given the BRI fixture (PDF and, separately, the CSV variant, both built from a real sample), both produce the
   same set of transactions for the same statement period (date, amount, direction, description) — proving the
   PDF and CSV readers agree with each other for the same institution.
9. Given a multi-page statement (fixture spans at least 3 pages), every page's rows are read and concatenated in
   statement order — no page silently dropped, no row duplicated at a page boundary.
10. Given a statement whose period crosses a year boundary (e.g. a December-into-January period, fixture), every
    row's resolved WIB date falls in the correct calendar year — the year is taken from the statement's own
    printed period, never assumed from "this year."
11. Given a CSV statement in a non-UTF-8 encoding a real export is known to use (e.g. Windows-1252, fixture), the
    file is either read correctly (BOM/encoding sniffed) or refused with a clear "re-save as UTF-8" message
    (FN-18's existing `FILE_NOT_TEXT` posture) — never silently mojibake'd into wrong amounts or dates.

**Robustness and refusal (checklist › "Capture and AI", "Access and privacy", malformed input)**

12. Given a malformed/corrupt PDF (fixture: truncated byte stream, invalid xref table), the upload is refused with
    a clear message and a 400 — never a 500, never a worker crash, never a partial/garbled transaction written.
13. Given a PDF crafted to decompress to a very large size from a small file (a "zip-bomb"-shaped `FlateDecode`
    stream, fixture) or an XLSX whose inner ZIP entries decompress far beyond the uploaded byte size, the read is
    bounded (a decompressed-size cap enforced during extraction, not after) and refused with a clear message —
    never an unbounded-memory or unbounded-CPU read in the Worker.
14. Given a file larger than the 15 MB cap, the upload is refused before any parsing begins (400), mirroring
    FN-18's `FILE_TOO_LARGE` pattern exactly.
15. Given a PDF with more than the 200-page cap, parsing stops at the cap and the result states how many pages
    were not processed — never an unbounded per-request read (checklist › "Bounded work").
16. Given a crafted `defaultWalletId` naming a wallet from a different space, the import action is refused with
    the uniform `requireSpaceAccess`/FN-04 not-found/forbidden response — never a 500, never a row against
    another space's wallet (identical to FN-18 criterion 18).
17. The server-side import re-parses the raw uploaded bytes from scratch — it never accepts a client-computed row
    list as the source of truth for amounts or dates (there is no client-side PDF/XLS preview this pass, so this
    is the only parse that ever happens).
18. Raw file bytes and any extracted page text are processed only in the Worker's request handling and never
    written to R2, D1 or a log; only the derived `transactions` rows and the `import_batches` summary row persist
    — a grep in the hand-off confirms no write of raw bytes or extracted text outside that one request (CLAUDE.md
    › uploads rule; checklist › "No upload persistence").
19. User-facing error text never contains a file path, stack trace, row index or internal identifier (same bar as
    FN-18 criterion 35).

**Balance check, dedupe, undo, export parity**

20. Given a statement printing both an opening and closing balance, when imported, then the balance check (opening
    + Σ signed rows = closing) passes or reports the rupiah gap, matching the FN-16 mirror's own wording
    (`docs/FEATURES.md:195`); given no closing balance printed, the check is simply omitted, never guessed.
21. Given the exact same statement file uploaded and imported twice, every row's `dedupeKey`
    (`statement:<sha256>:<row index>`) collides with the first import's rows; the second import reports every row
    as "already imported," creates zero new transaction rows, and never errors.
22. Given a live, not-yet-undone `import_batches` row with `source = 'statement'`, "Urungkan" tombstones every
    transaction it wrote and sets `undone_at`, in one `db.batch` — identical behaviour to a CSV batch's undo
    (`undoImportBatch` is not forked per source).
23. Every imported row's `transactions.source = 'statement'` and `import_batch_id` points at the new batch; every
    row's description/payment-reference text is masked to the last 4 digits via `maskAccountNumbers` before
    storage, identical to FN-18's extras handling.
24. A CSV- or XLSX-shaped bank export whose institution is not yet supported, when uploaded, answers the same
    "institution not recognised, pick manually" refusal as an unrecognised PDF — never a guessed generic mapping.

**Harness**

25. Given an empty or missing `.superpowers/ref/samples/statements/` folder (the state at hand-off, and in CI),
    `npm run compat:statements` prints a one-line notice and exits 0 — it never fails the gate and is never part
    of `npm run gates`.
26. Given at least one sample file under `.superpowers/ref/samples/statements/<institution>/`, the harness's
    printed matrix contains no account number, no row description/title and no filename beyond the given folder
    path — a review of its stdout against the sample's own content confirms nothing from the file's rows leaked.
27. Given a file under `.superpowers/ref/samples/receipts/`, the harness prints exactly one "needs OCR (FN-15,
    blocked on key)" line for it and performs no image decode, no OCR call, no AI call.

**Cross-cutting**

28. Every load and action this feature adds under `/impor` resolves the space through `requireSpaceAccess`/
    `currentSpaceScope` using `event.locals.user` — never a client-supplied `spaceId` (identical to FN-18
    criterion 27).
29. A pre-handoff cross-space probe (crawl every new action as a non-member and a removed member of a space owning
    a batch/wallet id) returns nothing and never 200s.
30. A pre-handoff concurrency probe (20 concurrent imports of the same statement file) ends with each row created
    exactly once — never a double-insert, never a 500 (same guarantee as FN-18 criterion 29, proven again for
    `source = 'statement'`).
31. `{#each}` lists in the new UI key by `batch.id`/a stable row index, never by filename or description text.
32. Every Indonesian phrase this feature adds has an English entry in `i18n-en.ts`; `npm run test`
    (`src/lib/shared/i18n.test.ts`) fails if one is missing.
33. Currency display uses `formatMoney`; dates shown convert to/from WIB through `src/lib/shared/dates.ts`
    (identical bar to FN-18 criterion 33).
34. `npm run gates` (check, lint, test, build) is clean; every new regression test (PDF text extraction, CSV bank
    mapper, XLSX reader, balance check, dedupe, malformed/oversized/zip-bomb-shaped/password-protected PDF
    refusal, cross-space probe) is shown failing on the unfixed code first (checklist › "Fail-before proof").

## Architecture notes

**Modules touched / added**

- `src/lib/shared/statements/` (new, pure, shared like `csv.ts`): `types.ts` (re-exports FN-18's `MappedRow`/
  `RawCsvTransaction`, adds nothing new), `detect.ts`, one module per supported institution (`bca.ts`, `bri.ts`
  this pass; others added the same way later).
- `src/lib/server/statements/` (new, server-only): `pdf-text.ts` (wraps `unpdf`), `xlsx-read.ts` (wraps `xlsx`),
  `statement-import.ts` (mirrors `src/lib/server/imports/csv-import.ts`'s shape), reusing `src/lib/server/imports/
  repo.ts`'s `createImportBatch`/`undoImportBatch` unchanged (no new repo — `source: 'statement'` is just the
  other already-valid value of the same column).
- `src/lib/server/wallets/repo.ts` / `src/lib/server/categories/repo.ts` — no change; FN-18's additive
  find-or-create exports are reused as-is.
- `src/routes/(app)/impor/+page.server.ts` / `+page.svelte` — extended with the new upload section and actions
  (`?/previewStatement`, `?/importStatement`), sharing the existing wallet picker, batch list and i18n patterns.
- `package.json` — new script `"compat:statements": "node scripts/compat-statements.ts"`; new dependencies
  `unpdf` and `xlsx` (exact versions pinned at implementation, per `npm info <pkg> version`).
- `scripts/compat-statements.ts` (new), reusing `scripts/local-guard.ts`'s `assertLocalOnly` pattern.
- `test/fixtures/statements/` (new, committed, synthetic) — per Scope.
- `src/lib/shared/i18n.ts`/`i18n-en.ts` — new phrases per Scope.
- **No migration.** `import_batches.source` and `transactions.source` already accept `'statement'`
  (`src/lib/server/db/schema.ts:315,334-336,371,414-416`).
- Worker: app Worker only. PDF/CSV/XLS text extraction and parsing for a single uploaded file completes within one
  request (bounded by the page/byte caps above) — no Queue or Workflow is introduced; FN-16's own AI read (10-60 s
  per `docs/FEATURES.md:191`) is a separate, later concern for `workers/jobs`.

**Reuse / do not duplicate**

- `parseMoneyAmount` (FN-14a) is the only amount tokenizer for statement rows too.
- `MappedRow`/`RawCsvTransaction` (FN-18) is the only intermediate row shape; a statement parser produces it, it
  never invents a second one.
- `createImportBatch`/`undoImportBatch`/`insertTransactions`/`capturedTransactionInput` are reused unchanged;
  statements write through the exact same `db.batch` all-or-nothing path CSV imports already use.
- `maskAccountNumbers`/`cleanText` (shared text helpers) mask every statement description/reference the same way
  FN-18's extras already are.

## Prerequisites

- **No AI Gateway/Anthropic key needed for this pass** — that is the entire point of the split. Every "Belum
  dikonfigurasi"/"perlu dibaca AI" state this feature shows for a scanned PDF or a receipt photo is the honest,
  already-established pattern (`src/lib/ui/photos/AiUnavailable.svelte`, `docs/features/fn-14-voice/PRD.md:96`)
  for the AI-only remainder of FN-16, not a new placeholder invented here.
- **New npm dependencies** `unpdf` and `xlsx` — no account, no API key, no secret; both run entirely in-Worker on
  uploaded bytes.
- **Real, redacted sample statements** (`.superpowers/ref/samples/statements/<institution>/…`) — the owner's own
  item, gitignored and never committed; the BCA/BRI parsers in Scope are written only once a matching sample
  exists; every other institution stays detection-only (or undetected) until one arrives.

## Tracker impact

- Add a one-line note to `docs/FEATURES.md` under FN-16 (after line 203, before the FN-17 heading): "**FN-16a**
  (`docs/features/fn-16a-statement-parsers/PRD.md`) is the deterministic, no-AI subset: text-based PDF/CSV/XLS(X)
  statements read by a parser, not a model; scanned/image PDFs and receipt photos stay FN-16's AI path."
- Closes the statement-parser half of `docs/TASKS.md` › Phase 2: "`- [ ] **Claude** — FN-15 Receipt · FN-16
  Statement · FN-17 Spreadsheet (blocked by AI Gateway key for Pass level).`" (`docs/TASKS.md:59`) — recommend
  splitting that line into "FN-16a done" and "FN-15/FN-16 AI half/FN-17 still blocked" once this lands.
- Moves `docs/ACCEPTANCE.md` rows:
  - "Statement PDF (password) → balance check → duplicates excluded → import → undo" (Required journey table) —
    stays **Not run** for the password half (out of scope unless `unpdf` confirms password pass-through) but the
    non-password balance-check/duplicate/import/undo half moves to **Automated** once criteria 7-9, 20-23 pass on
    the BCA/BRI fixtures.
  - "Integer minor units; slang and locale vectors parse exactly" (Money and dates table) — a second real-save-path
    caller of FN-14a's parser, like FN-18 before it (criterion 7).
  - "Uploaded files never written to R2 or D1; partner copy deleted" (Security and privacy table) — this feature
    is a second, non-AI proof point for the file-bytes half of that row (criterion 18); the "partner copy
    deleted" half stays FN-16 AI/FN-21's to close.

## Owner decisions

- **A. Only BCA and BRI get a real column-mapping parser this pass; every other institution in the brief is
  detection-and-honest-refusal until a sample exists.** *Trade-off:* most institutions on the owner's priority
  list are not actually importable this pass — but every institution researched here either has no confirmed
  export mechanism at all (BNI, Jago, OVO, DANA, ShopeePay — likely none exists to parse) or a confirmed one this
  pass has not yet been handed a sample for (Mandiri, CIMB Niaga, SeaBank, GoPay). Proposed default: ship this way;
  add each remaining institution the moment its sample lands, one PRD-free follow-up per institution (same shape
  as this one's BCA/BRI module) rather than reopening this PRD.
- **B. Bounds: 15 MB file size, 200 PDF pages, a decompressed-size cap enforced during PDF/XLSX stream reading.**
  *Trade-off:* a very long multi-year statement needs splitting; proposed default matches FN-18's existing
  "reasonable bound, split the file" posture (`docs/features/fn-18-csv/PRD.md` owner decision B).
- **C. No client-side PDF/XLS preview this pass (server-only parse, one round trip for preview, one for import).**
  *Trade-off:* slightly slower perceived feedback than FN-18's instant client-side CSV summary, in exchange for
  not shipping a 1.6 MB PDF.js build to every phone that opens `/impor`. Proposed default: accept the trade-off;
  revisit only if a later feature needs client-side PDF reading for an unrelated reason.
- **D. Password-protected PDFs are refused with a clear message unless `unpdf` is confirmed, during
  implementation, to pass a password through to PDF.js.** *Trade-off:* FN-16's own "password used once, never
  stored" promise is not delivered for the deterministic path if that confirmation fails — proposed default:
  ship the honest refusal either way; do not block this whole feature on finding or building a different PDF
  library just for the password case, since FN-16's AI path will need its own password handling regardless.
- **E. The compatibility harness never fails CI and is never part of `npm run gates`.** *Trade-off:* a
  regression in a specific institution's parser is caught only by its own fixture-based Vitest, not by the
  harness; the harness's job is reporting against the owner's real, non-committed samples on demand, not gating
  a push. Proposed default: keep it this way — a gate that silently does nothing when the owner's samples folder
  is empty (the CI state, always) would give false confidence.
