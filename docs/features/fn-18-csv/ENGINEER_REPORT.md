# FN-18 CSV import and export — engineer report (cycle 1)

Branch `fn-18-csv`, rebased onto `main` 9c77de9 (FN-13 PWA + FN-14 voice merged). Migration `0010_csv_import`
(no collision; chained to 0009's snapshot id).

## What works

- `/impor` replaces the stub (`src/params/stub.ts` keeps only `tanya`; `STUBS` = `/tanya`; nav/param tests updated).
  The Tambah sheet "Mutasi" row stays "Segera hadir" (statements are FN-16).
- **Impor CSV.** File picker → the device reads the file (strict UTF-8, 5 MB cap) and runs the shared
  `readCsv` for an instant summary (rows, format, ready/transfer/unreadable/non-IDR, rows over the cap), then
  auto-requests the server **Pratinjau** (`?/preview`, writes nothing): server counts plus the "Mungkin duplikat"
  list (max 20 shown, count covers all). **Impor** (`?/import`) re-uploads the raw file; the server re-parses it
  from scratch with the same `src/lib/shared/csv.ts` functions, never a client row list. Format override
  (`Segmented`: Otomatis / Template / Money Manager); "Format tidak terdeteksi, pilih manual" when neither header
  matches; a wallet picker for rows naming no wallet (JS: only when needed; no-JS: always shown); a "Lewati baris
  yang mungkin duplikat" checkbox (default on). Result line `Diimpor {imported} · Dilewati {skipped} · Sudah pernah
  diimpor {already}` plus non-IDR, possible-duplicate and not-processed lines, all from server counts.
- **Write path.** Each ready row: wallet = `wallet_source` → `payment_method` → chosen wallet; category = its name
  (Money Manager: part before `/`) → `Lainnya` (expense) / `Pemasukan Lain` preset (income). Missing wallets
  (`lainnya`, IDR) and categories (`lain` tile) are created by bulk guarded find-or-create
  (`findOrCreateWalletsByName`, `findOrCreateCategoriesByName`, case-insensitive like SQLite `lower()`, within the
  50/100 caps, all-or-none, membership re-checked). Every row then passes FN-05's `capturedTransactionInput` and is
  written through FN-05's one insert path `insertTransactions` (source `csv`, dedupe key
  `csv:<sha256(file)[0..32]>:<record index>`, `import_batch_id`, extras), chunked 250 rows per statement, in **one
  `db.batch`** with the `import_batches` row and a `batchAssert` that every row landed (all or nothing). A unique
  violation from a concurrent import of the same file re-counts and retries (max 3, else "busy").
- **Riwayat impor.** Last 50 batches with counts; **Urungkan** (`?/undo`, stale-`updated_at` guarded) tombstones
  every live row of the batch content-free (shared `TOMBSTONE_CONTENT`, also used by `deleteTransaction`) and sets
  `undone_at` in one `db.batch`; a second undo answers "Impor ini sudah diurungkan." (no-op, not an error).
- **Ekspor CSV.** Plain GET form → `/impor/ekspor?from&to` (works without JS; with JS a fetch shows "Mengekspor…"
  then downloads). `listTransactionsForExport` (aggregate.ts, same `filterWhere` and the now-shared `keysetAfter`
  keyset) streams 1,000-row pages through a `ReadableStream`; no transfers, no `Data demo` rows; template column
  order; every cell guarded (`= + - @ tab CR` → leading `'`) then RFC 4180-quoted; UTF-8 BOM. Missing/reversed range
  → back to `/impor?ekspor=salah` with a message; range > 1 year → back with the range cut to a year and a note.
  `/impor/templat` serves the header plus one fictional example row.
- States: skeleton on the batch list while navigating, `ErrorState` + retry on a failed load, "Belum ada impor.",
  disabled/spinner buttons while a request runs, success lines only after the server answers. 360 px checked.

## Files

- New: `src/lib/shared/csv.ts` (+ `csv.test.ts`), `src/lib/server/imports/{repo,csv-import,csv-export,validation,
  messages}.ts`, `src/routes/(app)/impor/{+page.server.ts,+page.svelte,ekspor/+server.ts,templat/+server.ts}`,
  `migrations/0010_csv_import.sql` (+ snapshot/journal), `test/integration/impor.test.ts`, `e2e/impor.spec.ts`.
- Changed: `db/schema.ts` (`import_batches`; `transactions` + `import_batch_id`, `payment_method`, `recurrence`,
  `tag`, `reference`, index `(space_id, import_batch_id)`), `transactions/repo.ts` (`NewTransaction.importBatchId/
  extras`, `TOMBSTONE_CONTENT`), `transactions/aggregate.ts` (`keysetAfter`, export page), `wallets/repo.ts`,
  `categories/repo.ts` (bulk find-or-create), `spaces/spaces.ts` (`importBatches` in `SPACE_SCOPED_TABLES`, after
  `transactions`), `shared/text.ts` (`asciiLowerKey`), `i18n-en.ts` (51 entries), nav/stub + tests.
  `readFormBody(request, max)` from main is reused with `UPLOAD_BODY_MAX_BYTES` (5 MB + 64 KiB).

## Decisions taken (own recommendation, recorded)

1. **Possible-duplicate flag (caller brief) vs PRD decision F.** Added the "Mungkin duplikat" heuristic (same WIB
   date, type, IDR amount and case-insensitive title as a live real row) in the server preview, with a
   default-on "skip" checkbox; no per-row review screen. Exact replay stays the dedupe key.
2. **All-or-nothing (brief) vs PRD criterion 13.** Unreadable/invalid rows are skipped and counted before the
   write; the write of all valid rows plus the batch row is one asserted batch.
3. Undo keeps the dedupe keys (CLAUDE.md: a deleted capture is never recreated), so re-importing the identical file
   after undo reports "Sudah pernah diimpor"; a corrected file (new hash) imports. Created wallets/categories stay.
4. A batch row is written only when at least one row is imported (nothing to undo otherwise).
5. `import_batches` also carries `deleted_at` and `seq` (CLAUDE.md user-data convention); `created_by_user_id` is
   nullable `ON DELETE SET NULL` (account deletion keeps shared-space history).
6. `parseCsv` returns `{ ok, rows, more } | { ok:false, error }` instead of `string[][]` (caps and refusals);
   unterminated quote / >50 columns / empty refuse the whole file. Dates: ISO or `DD/MM/YYYY`, optional trailing
   time ignored (Money Manager). Amount sign or DB/CR never flips the type (absolute value). Template `currency`
   other than IDR/Rp/empty is skipped like Money Manager non-IDR (owner decision D).
7. Imported rows have no time: `occurred_at` = 12:00 WIB on the row date.
8. Bulk find-or-create (one statement each) instead of per-name calls, to stay bounded in queries per request.
9. Hidden categories are not reused (FN-05 forbids writing to one): a hidden name gets a new visible category.
10. Export excludes `Data demo` rows; the importer strips a leading `'` before `= + - @ tab CR` so exported titles
    round-trip.

## Tests

- `src/lib/shared/csv.test.ts` (26): delimiters, quotes/newlines/escaped quotes, BOM, CR-only, caps and refusals,
  format detection, dates, both mappers (transfer skip, wallet fallback, MM category split, non-IDR), FEATURES
  amount vectors via `parseMoneyAmount`, formula guard and un-guard, amount formatting.
- `test/integration/impor.test.ts` (21, real local D1): creation of categories/wallets, case-insensitive matching,
  idempotent re-import, bad rows counted, chosen wallet + cross-space wallet refusal, possible duplicates,
  5,003-row cap with exact totals, 20 concurrent imports, removed member → `gone`, Money Manager non-IDR, format
  refusals, undo (stale, ok, already, content-free tombstones, no recreation), cross-space undo, export (formula
  vectors incl. tab/CR, transfers/demo excluded, round trip into an empty space, multi-page newest-first), route
  actions (preview/import/undo), refusals (missing/empty/non-UTF-8/unterminated/unknown/bad format → 400 with
  message; oversized → 400; text/plain → 415), export redirects and signed-out redirect.
- `e2e/impor.spec.ts` (3 × phone/desktop): upload via `setInputFiles`, device summary + server preview, import,
  re-import "already", overlapping file flagged "Mungkin duplikat" and skipped, Riwayat shows rows, export download
  with `'=SUM(1+1)`, undo removes rows from Riwayat; unknown header + broken file inline at 360 px; no-JS import and
  export.
- Fail-before (mutation) runs: formula guard removed → 2 failed; dedupe pre-check removed → 3 failed; row cap
  removed → 1 failed; cross-space wallet check removed → 2 failed (files restored after each run).

## Gates and e2e

- `npm run gates`: check `COMPLETED 1192 FILES 0 ERRORS 0 WARNINGS`; prettier "All matched files use Prettier code
  style!"; eslint clean; `Test Files 91 passed (91)`, `Tests 1302 passed (1302)`; build `✓ built` ×3.
  (Two earlier `npm run test` runs under load average 20–35 from other worktrees had workerd "other side closed"
  startup failures in unrelated files; `--maxWorkers=6` and the final `npm run gates` were green.)
- e2e (`E2E_PORT=8844`): `e2e/impor.spec.ts` 7 passed (incl. setup). Full suite `--workers=4`: 187 passed,
  15 skipped, 5 failed — all in `riwayat.spec.ts` on wrangler-dev "Network connection lost / Broken pipe" drops;
  `riwayat.spec.ts` re-run alone: 15 passed. Earlier full runs at default workers under the same load failed
  widely on timeouts; every failing file re-run alone or at 3 workers passed (beranda 12, riwayat+ruang 27,
  tabungan/suara/pwa/accounts/kotak-masuk/laporan/security 89).

## Pre-handoff probes (live `wrangler dev` :8824, local D1, then stopped)

- 3,000-row file: `imported 3000`; file out 266997972900 / in 33292677100 = export out/in, 3000 rows → identical: true.
- Malformed: unterminated quote → 400 "Berkas CSV rusak…"; 51 columns → 400; unknown header → 400 "Format tidak
  terdeteksi, pilih manual"; empty → 400; non-UTF-8 → 400; 6 MB body → 400; text/plain → 415.
- BOM + semicolon + quoted `;`/`""`/newline fields: preview `template`, rows 2 / ready 2; import imported 2.
- Formula injection: exported line `…,"'=HYPERLINK(""http://x"")",…,'+cmd,'-2,Tunai,'@SUM(A1)`; any cell starting
  with = + - @ → false.
- Re-import same 3,000-row file: imported 0, already 3000.
- Cross-space: undo of A's batch by B → 404 "Impor tidak ditemukan."; export as B → 0 rows, none of A's;
  signed-out export → 303 `/masuk?next=…`; removed member (integration) → `gone`, nothing written.
- Undo: integration + e2e (rows leave Riwayat and totals; second undo no-op).
- Concurrency: 20 concurrent imports of one 30-row file → 30 rows, one `Tunai` wallet, one `Belanja` category.
- 360 px: `/impor` with format control and export range has no horizontal scroll (e2e phone).
- No-JS: import result and export download work as plain form posts (e2e).
- User copy: refusal messages contain no path, row id or internal identifier (route tests assert exact strings).
- Upload persistence grep: raw text only reaches `readCsv`/`sha256Hex` in-request; no R2/D1/log write of file bytes
  (only `console.error` on a failed load, no file content).

## Checklist items applied

D1 100-param (JSON `json_each` binds), concurrent writes (guarded inserts in one batch + concurrency test), bounded
work (5 MB / 5,000 rows / 50 columns / 1-year export, 1,000-row pages), migrations (new 0010 only), integers only
(shared money parser, string amount formatting), one currency per sum (IDR only), WIB dates, one access rule
(`currentSpaceScope` → `requireSpaceAccess` + `isLiveMember` in every write), untrusted text (`cleanText`), idempotent
capture (file hash + row index), one validator (`capturedTransactionInput`, server re-parse), tombstones
(content-free, shared constant), no upload persistence, form bodies (cap 400/415), keyed lists (batch id, line
number), CSV export guard, i18n (51 EN entries), currency display (`formatMoney`), truthful state, no inline
styles, `.ts` relative imports in shared, fail-before proof.

## Gaps / not done

- Guest/offline save (PRD decision A, needs FN-02). Statement/spreadsheet readers (FN-16/17) not built.
- Extras (`payment_method`, `recurrence`, `tag`, `reference`) are not shown or editable in the manual forms (PRD
  out of scope); they round-trip through export.
- Undo does not remove wallets/categories the import created.
- No real-provider involvement (none needed); no remote D1 touched.

## Cycle 2 (red team L1–L6; QA and red team reports cherry-picked)

- **L1 (fixed):** `maskAccountNumbers` (`src/lib/shared/text.ts`) reduces every run of 8 or more digits and every
  card-style `1234 5678 9012 3456` to `••••` + the last 4 digits. It is applied before storage to `reference`,
  `payment_method`, `tag`, `recurrence`, auto-created wallet names and the stored file name, and again on export to
  the same columns plus the wallet name. Dates, amounts and short numbers are left alone. Tests: unit cases plus
  integration import → D1 → export (full numbers absent, `••••3456` present).
- **L2 (fixed):** import and preview database work runs through `guardedDb`. On failure it logs
  `impor: <what> failed` plus `errorLabel(e)` (error and cause class name and code only, never the message or
  params) and answers 503 `IMPORT_FAILED`. The load also logs `errorLabel` only. `handleError` in
  `src/hooks.server.ts` logs only route id and `errorLabel` for unknown errors (app/framework errors are not logged)
  and keeps SvelteKit's default response. Test: failing D1 proxy whose message and cause hold row data → the
  printed console output contains none of it; `handleError` same.
- **L3 (fixed):** existing wallets and categories are read once, new names get planned ids, and rows are
  validated first. Only names used by rows that pass are inserted (`insertImportedWallets`,
  `insertImportedCategories`: guarded batch items with membership, not-exists and the cap), inside the same
  asserted `db.batch` as the batch row and transactions. A race on the same name leads to re-planning (max 3
  attempts). The old find-or-create functions are removed. Tests: all-refused file creates nothing; a mixed file
  creates only the used wallet and category; a removed member's import is `gone` and leaves nothing behind.
- **L4 (fixed):** `FORMULA_START = /^(?:[\t\r\n]|\s*[=+\-@＝＋－＠])/`. The import un-guard uses the
  same pattern. Tests: fullwidth, LF and space-led vectors.
- **L5 (fixed):** `listTransactionsForExport` takes the `SpaceScope` and adds `isLiveMember` to every page's
  WHERE. The stream has `highWaterMark: 0`, so it reads one page per pull. Test: after page 1, the member is
  removed and the export ends at 1,000 rows; the owner still gets all 1,500.
- **L6 (fixed):** `parseCsv` drops blank records before the cap and the "not processed" count. Record positions
  now count non-blank records. Tests: unit test plus an integration file with 5,010 blank lines before 2 rows →
  rows 2, notProcessed 0.
- **Fail-before (mutation, files restored):** L1 masking off → 2 failed; L2 raw error logged → 1 failed; L3
  create-before-validate → 1 failed; L4 old guard → 2 failed; L5 no per-page membership → 1 failed; L6 blanks
  counted → 2 failed.
- **Rebase:** main is still 9c77de9 (the cycle 1 base), so nothing to rebase. Migration `0010_csv_import`
  unchanged.
- **Checks:**
  - `npm run db:reset:local`: exit 0, 11 migrations applied.
  - `npm run gates`: check 0 errors, lint clean, build ✓. Tests flaked under load average 30–60: the last run
    had 5 files fail on workerd "other side closed" / hook timeouts. Those 5 files re-run alone: 50/50 passed.
    `npm run test -- --maxWorkers=4`: 91 files, 1313/1313 passed.
  - e2e `E2E_PORT=8844 --workers=2`: 192 passed, 15 skipped, 0 failed (no rerun needed).

## Cycle 3

- **L1 bypasses (fixed):** `maskAccountNumbers` now NFKC-normalises first (fullwidth digits become ASCII) and
  matches `\p{Nd}` with the `u` flag (Arabic-Indic and other scripts). It masks any digits joined by single
  spaces, dots or dashes once the run holds 8 or more digits (`1234 5678`, `12345 67890`, `1234.5678.9012`,
  `123-456-7890`). Pieces shaped like a date (`2026-10-08`, `08-10-2026`, `08.10.2026`) or a dot-grouped amount
  (`1.250.000`) stay intact, and break a run into separate pieces (`2026-10-08 1234 5678 9012` →
  `2026-10-08 ••••9012`). Known gaps: a dot-grouped number such as `123.456.789` is read as an amount and stays
  unmasked; digits split across separate fields are out of scope.
- **Formula round trip (fixed):** `needsGuard` checks for a formula start behind any leading `'`. Export prefixes
  `'` in that case and import strips exactly one, so `=x`, `'=x`, `'-5`, `-5`, `''+1` and `'hello` round-trip
  exactly.
- **Tests first:** 4 new tests failed on the cycle 2 code (two masking, two round trip) and pass now.
- **Machine note:** `/tmp` (12 GB tmpfs) was 100 % full of stale `/tmp/miniflare-*` directories (2,890 of them).
  Earlier workerd "other side closed" / `SQLITE_FULL` test failures came from this, not from load alone. I
  removed my own entries older than 60 minutes; `/tmp` is now at 36 %.
- **Checks:**
  - `npm run gates`: check 0 errors, prettier and eslint clean, 91 files / 1317 tests passed, build ✓.
  - `e2e/impor.spec.ts` (`E2E_PORT=8844`): 7 passed.
