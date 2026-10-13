# FN-16a — Engineer report, cycle 1 (infrastructure)

Branch `fn-16a-statement-parsers` (worktree `.claude/worktrees/fn-16a`, from `main` 751d774). Owner defaults A–E
accepted. The owner's samples folder `.superpowers/ref/samples/statements/` was **empty**, so no BCA/BRI row
parser was written (PRD owner decision A: never from a guessed layout). Everything around those parsers is built:
upload path, PDF text extraction, detection registry, balance check, dedupe/undo through FN-18, harness, tests.

## What was built

- **Upload on `/impor`** — new section "Impor mutasi (PDF/CSV)" (`#mutasi`) with its own form posting to
  `?/previewStatement` and `?/importStatement`; shares the wallet picker sheet, the "Mungkin duplikat" list
  (now a snippet used by both sections) and "Riwayat impor"/"Urungkan". Optional "Sandi PDF (jika ada)" field.
  The sidebar card "Pekerjaan membaca terbaru" shows "Berkas ini perlu dibaca AI (pembacaan AI belum
  dikonfigurasi)." when the last upload was a scan. Statement batches are labelled "Mutasi" in the history.
- **Caps** — 15 MB file (`STATEMENT_MAX_BYTES`, 400 before any parsing; body cap 15 MB + 64 KB, 60 s total /
  15 s idle), 200 pages (`PDF_MAX_PAGES`, the rest reported as not read), 40 MiB total inflated Flate output
  (`PDF_MAX_INFLATED_BYTES`, enforced while inflating), 2 M characters of text, 20 s per read.
- **PDF text** — `unpdf` pinned **1.8.1** (`npm view unpdf version` → 1.8.1, 2026-10-08), loaded with a dynamic
  `import()` so the PDF.js bundle is not evaluated at Worker startup. Workers support per the README
  (https://github.com/unjs/unpdf#readme, "serverless environments like Cloudflare Workers"; bundle built from
  PDF.js v5.6.205). **Verified in workerd** (wrangler `unstable_startWorker`, compatibility date 2026-10-01):
  text PDF read, password needed / wrong / right, scan → `no_text`, 205 pages read 200, zip bomb → refused,
  garbage → `corrupt`.
- **Password-protected PDFs are supported, not just refused** — `getDocumentProxy(data, options)` takes PDF.js's
  `DocumentInitParameters` (README › API › `getDocumentProxy`) and spreads them into `getDocument`
  (`node_modules/unpdf/dist/index.mjs` › `getDocumentProxy`), which includes PDF.js's `password`. The password
  is used for that one read; never stored, logged or echoed back (no-JS re-render shows an empty field).
- **Decompression budget** — `src/lib/server/statements/pdf-streams.ts`: every Flate stream (images included) is
  inflated only to count its output, in 4 KiB slices with a concurrent reader, stopping past the cap; exact
  `/Length` (direct or `N G R`) with the PDF.js-style `endstream` fallback for a lying length; LZW, RunLength,
  filter chains around Flate and indirect `/Filter` refused; an invalid Flate stream in an unencrypted file →
  `corrupt`. Found in workerd testing: workerd's `DecompressionStream` rejects trailing bytes before emitting
  output (Node does not) — junk-trailed bombs are therefore refused as `corrupt` there; never passed to PDF.js.
- **Registry** — `src/lib/shared/statements/types.ts` (`StatementParser`: `id`, `label`, `formats`,
  `detect(doc) → 0..1`, `parse(doc) → { rows: MappedRow[], openingBalanceMinor, closingBalanceMinor }`),
  `parsers.ts` (`STATEMENT_PARSERS = []`), `detect.ts` (magic-byte sniffing, BOM-aware strict decoding,
  `detectInstitution` with a 0.5 threshold and tie → unknown, counts-only hints), `rows.ts` (`statementRow` —
  the one place a statement amount is read, through `parseMoneyAmount`; `dateInPeriod` — year from the printed
  period; `balanceCheck`). Adding BCA = one file `bca.ts` + one line in `parsers.ts`.
- **Import** — `src/lib/server/statements/{read,statement-import,validation}.ts`. FN-18's
  `src/lib/server/imports/csv-import.ts` was refactored (not forked): `previewRows`/`importRows`/
  `fallbackWalletOf` are the shared core; `importCsv`/`previewCsv` are thin wrappers with unchanged behaviour
  (FN-18 suite green). `createImportBatch` takes `source` and a nullable `format`; `listImportBatches` returns
  `source`. Statement rows: source `statement`, key `statement:<sha256(bytes)[:32]>:<row>`, title/notes/wallet
  name cleaned then masked to the last 4 digits. **No migration** (both `source` checks already allow
  `statement`; `format` is null for statement batches).
- **Harness** — `npm run compat:statements` (`scripts/compat-statements.ts`, plain Node, `assertLocalOnly`,
  `--samples=<dir>` or `FIN_SAMPLES_DIR`; PDF password from `FIN_SAMPLE_PDF_PASSWORD`, never argv). Matrix:
  folder (masked), format, institution, pages, rows parsed, rows rejected (typed reasons), balance check. Never a
  file name, account number or row text; receipts → `<folder>  needs OCR (FN-15, blocked on key)`, no decode.
  Exit 0 always; empty/missing folder → one-line notice. Run against the owner's (empty) folder: "No statement
  samples … (tidak ada sampel)." / "No receipt samples …", exit 0.

## Not built, and why

- **XLSX/XLS reader (SheetJS)** — left out. No institution is confirmed to export XLS(X) (PRD table), the PRD
  ships it "inert, used nowhere" (dead code, against "no code for later"), and npm's `xlsx` is stuck at
  **0.18.5** (`npm view xlsx version`), which npm's advisory database flags high twice:
  GHSA-4r6h-8v6p-xvw6 (prototype pollution, < 0.19.3) and GHSA-5pgg-2g8v-p4x9 (ReDoS, < 0.20.2); fixed SheetJS
  builds are distributed only from the SheetJS CDN, not npm. XLS/XLSX uploads are detected by magic bytes and refused:
  "Berkas XLS/XLSX belum didukung. Unduh mutasi sebagai PDF atau CSV." Criterion 5 is therefore **not met**.
- **BCA/BRI parsers, their fixtures and criteria 7–8** — wait for redacted samples.
- **`docs/FEATURES.md` FN-16a note** — tracker edit, left for `/ship`.

## Acceptance criteria

| # | Status | Evidence |
| - | - | - |
| 1 | Built; real institutions wait for samples | `detect.test.ts` (threshold, tie, formats); `read.test.ts` fictional-bank detection; picker shown only when a parser exists |
| 2 | Met | scan → `needs_ai` (`pdf-text.test.ts`, `read.test.ts`, route test, e2e light/dark + no-JS) |
| 3 | Met, and exceeded (password supported) | `pdf-text.test.ts` encrypted/wrong/right; route test `needsPassword` |
| 4 | Met | FN-18 template/Money Manager CSV → `financer_csv`; bank CSV never read by FN-18 mappers (separate section/action) |
| 5 | **Not met** (XLSX left out, see above) | XLSX/XLS refused by magic bytes (`read.test.ts`, route test) |
| 6 | Built in the fictional parser; real lines wait for samples | `read.test.ts` (balance lines never rows) |
| 7 | Waits for BCA sample | one amount path: `statementRow` → `parseMoneyAmount` (`rows.test.ts` vectors) |
| 8 | Waits for BRI sample | PDF/CSV agreement proven on the fictional bank (`read.test.ts`) |
| 9 | Met (fictional) | 3-page fixture, statement order, no boundary duplicate |
| 10 | Met | `dateInPeriod` Dec→Jan, Feb 29, month edges (`rows.test.ts`); fictional statement rollover |
| 11 | Met | UTF-8 (BOM), UTF-16 LE/BE read; Windows-1252 refused with the re-save message |
| 12 | Met | malformed/truncated/broken-xref → typed refusal, 400, never a throw |
| 13 | Met for PDF (residual below); XLSX n/a | `pdf-streams.test.ts`, `pdf-text.test.ts` (fail-before shown) |
| 14 | Met | 15 MB + 1 byte → 400 message; body past cap → 400 |
| 15 | Met | 205 pages → 200 read, 5 not processed (unit + workerd) |
| 16, 28, 29 | Met | route cross-space test: other space's wallet → 404 uniform; non-member/removed member write nothing |
| 17 | Met | no client parse exists; actions read raw bytes |
| 18 | Met | see "No upload persistence" probe below |
| 19 | Met | route test asserts no file name/path/id in any refusal |
| 20 | Met (fictional) | pass / gap (minor units) / omitted |
| 21, 22, 23 | Met | `impor-statements.test.ts` (twice → already; undo; source/batch/masking) |
| 24 | Met | unknown CSV/PDF → "Format mutasi ini belum didukung." + counts-only hints |
| 25, 26, 27 | Met | `compat-statements.test.ts` (empty folder, no leak, masked folder, receipts line, plain Node exit 0) |
| 30 | Met | 20 concurrent imports → 4 rows, 1 batch |
| 31 | Met | keyed by `dup.line`, `batch.id`, option value, index |
| 32 | Met | i18n coverage test green |
| 33 | Met | `formatMoney` for gap and duplicates; dates via `formatDayLabel` |
| 34 | See gate lines | fail-before: budget disabled → 3 bomb/broken tests fail |

## Residual risks (for QA / red team)

- **Truly encrypted PDFs**: their streams cannot be measured before decryption (that would need our own PDF
  security handler). A crafted encrypted bomb is bounded only by the 20 s deadline and the Worker's 128 MB
  memory limit — the request could die with a platform 1102 instead of a 400. A bare `/Encrypt` marker in an
  unencrypted file does not switch the budget off (PDF.js's `EncryptFilterName` must confirm); cross-reference
  streams are always measured.
- Image codecs (DCT/JPX/JBIG2/CCITT) on a stream used as page content are not measured.
- CPU: inflating up to 40 MiB plus PDF.js parsing needs the Workers Paid CPU limit (Free is 10 ms;
  https://developers.cloudflare.com/workers/platform/limits/#cpu-time).

## Checklist items applied

One access rule (`currentSpaceScope`, wallet via `getWallet` in the space, batch insert guarded by
`isLiveMember`); Masking (`maskAccountNumbers` after `cleanText` on title/notes/wallet name, filename, harness
folder); Untrusted text (`cleanText`, never rendered as HTML); Integers only (`parseMoneyAmount`, minor units);
WIB dates (`occurred_on` from the printed period, noon WIB instant as FN-18); Idempotent capture (file hash + row
index); Concurrent writes (FN-18's guarded `db.batch` reused); Bounded work (byte/page/inflate/text/time/row
caps); Form bodies (`readFormBody` with cap and timeouts: 400/408/415); No upload persistence; Svelte keyed
lists; i18n; Currency display; Truthful state (success lines only from the server's answer); No-JS forms;
Fail-before proof; Fixtures (all synthetic, invented in test code — no real sample touched).

## Pre-handoff probes

- Concurrency: 20 concurrent `importStatement` of one file → 4 rows, 1 batch, every result ok (`impor-statements.test.ts`).
- Cross-space: other space's wallet → 404 "Dompet tidak ditemukan."; non-member naming another space id → own
  space only, other space 0 rows / 0 batches; removed member → 404, shared space 0 rows / 0 batches.
- Money vectors (statement path): `Rp 1.250.000`, `1.250.000,50`, `Rp 28.000,00`, `IDR 1,250,000.00`, DB/CR
  suffixes, negative refund → `rows.test.ts` green (slang vectors stay covered by `money-parse.test.ts`).
- Month boundaries: `dateInPeriod` 30/09 and 01/10, Dec→Jan rollover, Feb 29 → green.
- 360 px: e2e phone project light + dark, `expectNoHorizontalScroll` passed; screenshots reviewed.
- No-JS forms: statement refusal shows from a plain post (e2e phone + desktop).
- User copy: route test asserts no file name / path / id in any refusal.
- No upload persistence: `grep -rnE "FILES|\.put\(|console\.|CACHE|STATS" src/lib/server/statements
  src/lib/shared/statements` → none; the route's only logs are the existing fixed lines + `errorLabel`; D1 writes
  only via FN-18 `importRows` (counts-only batch row + masked transactions).
- Two tabs / stale forms: undo reuses FN-18's `updated_at` check (unchanged). Two devices: n/a (no sync change).

## Gate lines (each step separately under the heavy lock; `npm run gates` not run per RAM rule)

- `npm run check` → `COMPLETED 1621 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, tsc steps clean.
- `npm run lint` → `All matched files use Prettier code style!`, eslint clean, exit 0.
- `npx vitest run --maxWorkers=2` → `Test Files 1 failed | 186 passed (187)`, `Tests 1 failed | 2625 passed
  (2626)`; the one failure was `money-parse.test.ts › module boundary` pinning `'./money-format'` (I added `.ts`
  for plain-Node loading); expectation updated, re-run of that file → `Tests 205 passed (205)`. The full suite
  was not re-run after that one-line test change.
- `npm run build` → exit 0. `wrangler deploy --dry-run --outdir <scratch>` → `Total Upload: 5560.34 KiB / gzip:
  1192.14 KiB` (limit 64 MiB uncompressed, https://developers.cloudflare.com/workers/platform/limits/#worker-size);
  PDF.js (`unpdf/dist/pdfjs.mjs`, 1,676,063 bytes) is in the server bundle only, none in `.svelte-kit/output/client`.
- `npx playwright test e2e/impor.spec.ts --workers=1` (port 8861) → `15 passed (42.1s)`, 4 FN-18 journeys unchanged.
- Fail-before: measurement disabled → `Tests 3 failed | 9 passed (12)` in `pdf-text.test.ts`; restored.
- `npm run compat:statements -- --samples=<owner folder>` → "No statement samples … (tidak ada sampel)." exit 0.

## Cycle 2 — decompression bound (QA criterion 13, red team H1/H2/M1/L1/L2)

**Approach (the preferred option): the budget lives inside PDF.js.** `scripts/pdfjs-bounded.ts` patches the
pinned `unpdf/dist/pdfjs.mjs` (unpdf 1.8.1 bundles PDF.js 6.1.200) at build time. It changes three places:

- `DecodeStream.prototype.ensureBuffer`: every PDF.js decoder (Flate, LZW, RunLength, Predictor,
  ASCII85/Hex, CCITT, and the decryption stream) grows its output buffer only here. Each growth is charged
  before the allocation.
- `DecodeStream.prototype.asyncGetBytesFromDecompressionStream`: PDF.js 6 inflates Flate and Brotli through
  the platform's `DecompressionStream`, not through `ensureBuffer`. A first attempt that patched only
  `ensureBuffer` still let all six bombs through. Each native chunk and the final joined copy are now charged
  too.
- The four `decodeImage` methods (JPEG, JPX, JBIG2): they refuse while a read is running, because text
  extraction never needs pixels.

When the budget is exceeded, PDF.js throws (`FINANCER_PDF_DECODE_BUDGET`) and the read answers `too_complex`.
The charge happens where the bytes are produced, so it works the same after decryption, inside object
streams, and behind any filter chain or name escape.

The patch is applied in three places:

- the app build and dev server: a Vite plugin, with `ssr.noExternal: ['unpdf']`;
- Vitest: the same plugin, plus `server.deps.inline`;
- the compatibility harness: a `node:module` `registerHooks` load hook.

Each anchor must match exactly once, so a PDF.js upgrade fails the build (`scripts/pdfjs-bounded.test.ts`).
`pdf-text.ts` refuses every PDF if the loaded module lacks `financerDecodeBudget`, so an unpatched build fails
closed. The cycle 1 regex pre-scan (`pdf-streams.ts`) is deleted. Because the budget is enforced, encrypted
PDFs stay supported, including empty passwords.

**Other fixes**

- **M1:** text is read with `page.streamTextContent()`. The character cap (2 M), item cap (200 k) and
  15 s wall budget are checked per chunk, not per page. When a cap fires, `task.destroy()` stops PDF.js.
  Cancelling the reader instead caused unhandled "Controller is already closed" rejections. A new throttle
  scope, `statement-upload`, allows 30 uploads per user per 10 minutes, counted before the body is read; a
  breach gets 429 "Terlalu banyak unggahan mutasi. Coba lagi dalam beberapa menit.". PDF reads run one at a
  time per isolate, so each budget belongs to exactly one document.
- **L1:** `getDocument` is called directly, and `loadingTask.destroy()` runs on every exit, including
  timeouts. A test shows the next read works after a timeout.
- **L2:** there is no regex scan string any more, and no `bytes.slice()`. PDF.js receives the upload's
  buffer itself (zero-copy; the buffer is detached afterwards, verified). The dedupe hash is therefore
  computed before the read.

**Regression tests.** All files are fictional and built in code by `test/helpers/pdf.ts`; the bombs are
deflated in 1 MiB steps. Each must answer `too_complex`. Peak growth of heap + ArrayBuffers was sampled every
1 ms, as the red team did; the samples vary between runs, and each must stay under 128 MiB.

| Case | File | Result | Peak growth (Node, runs 1 / 2) | workerd (128 MB isolate) |
| - | - | - | - | - |
| 46 KB → 45 MiB, plain Flate | 46 KB | too_complex | 72 / 109 MiB | too_complex, 146 ms |
| `/Flate#44ecode` 300 MB | 307 KB | too_complex | 19 / 69 MiB | too_complex, 222 ms |
| comment between `>>` and `stream` | 307 KB | too_complex | 49 / 31 MiB | too_complex, 172 ms |
| nested `/DecodeParms << /Filter … >>` first | 307 KB | too_complex | 31 / 34 MiB | too_complex, 146 ms |
| `/Filter` > 4 KiB before `stream` | 312 KB | too_complex | 20 / 19 MiB | too_complex, 142 ms |
| RC4, empty user password, 300 MB | 307 KB | too_complex | 45 / 18 MiB | too_complex, 162 ms |
| RunLength via `#44` escape, ≈ 90 MB | 1.4 MB | too_complex | — | — |
| M1 Form XObject drawn 60,000× | < 20 KB | too_complex, ≈ 1.0 s wall / 1.2 s CPU (was 13.8 s CPU) | — | too_complex, 947 ms |

For comparison, the red team measured about 651–680 MB before this fix.

- **workerd:** the same isolate served a normal text PDF after all the bombs (`text-after` ok), so it was
  never killed. The harness under plain Node, with one 300 MB `#44` bomb plus one text PDF, gave max RSS
  164 MB for the whole process, and the bomb was refused.
- **Fail-before:** with the budget lifted (`maxDecodedBytes: Infinity`), the same 45 MiB `#44` file is decoded
  and read (`pdf-text.test.ts`). The first attempt above, before the native-path patch, failed all six shapes.
- **Honest files still read:** an 8 MiB Flate page reads. A page with a declared 60000×60000 JPEG logo reads
  its text, because the image is never decoded. Password PDFs, scans, and the 205-page cap behave as in
  cycle 1.

**Residual.** Allocations that are not decode output are not counted: the PDF.js object graph, font parsing,
and text items. Those are bounded by the 15 MB input, the caps above, and the per-isolate serialisation.

### Cycle 2 gate lines (each step on its own under the heavy lock)

- `npm run check` → `COMPLETED 1621 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, exit 0.
- `npm run lint` → `All matched files use Prettier code style!`, eslint clean, exit 0.
- `npx vitest run --maxWorkers=2` → `Test Files 187 passed (187)`, `Tests 2635 passed (2635)`, exit 0.
- `npm run build` → exit 0. The patched PDF.js chunk is `.svelte-kit/output/server/chunks/pdfjs.js`, and
  there is none in the client. `wrangler deploy --dry-run` → `Total Upload: 5769.19 KiB / gzip: 1201.59 KiB`,
  and `financerDecodeBudget`/`__finCharge` are present in `_worker.js`.
- `npx playwright test e2e/impor.spec.ts --workers=1` → `15 passed (42.3s)`.
- `npm run clean:tmp` done; no dev servers left.

## Cycle 3: allowlist and workerd bound (red team re-check N1/N2/N3)

**What changed in the patch (`scripts/pdfjs-bounded.ts`).** It applies only while a statement is being read:

- **Filter allowlist.** In `Parser.makeFilter`, a content, object, font or xref stream may use only these
  filters: Flate, ASCIIHex, ASCII85, RunLength, or none. An image stream may also name DCT, JPX, JBIG2 or
  CCITT. That means Subtype Image, or an inline image with `W`/`Width`. Image streams are never decoded:
  the image decoders refuse to run, and PDF.js already drops image streams from page contents. Any other
  filter, such as Brotli, LZW, Crypt, an unknown name, or an image codec on a content stream, poisons the
  budget. The document then answers "too complex".
- **No native decompression.** `isAsync` is false on `FlateStream` and `BrotliStream`, so Flate always
  runs through PDF.js's JavaScript decoder. That decoder grows only through the charged `ensureBuffer`. This
  was the cause of N1: workerd's `DecompressionStream` inflates eagerly, before any charge can stop it.
- **Per-page cap.** Decoded bytes are charged against a per-page cap of 8 MiB and a per-document cap of
  40 MiB, before allocation. Each reference to a stream is decoded and charged again.
- **Content-reference cap.** A `/Contents` array with more than 64 entries poisons the budget.
- **Tighter text caps.** The text caps are now 1 M characters and 100 k items.

**N2: limits checked before the body is read.** A user's statement upload holds a lane place from before the
request body is read until the action ends, via `reservePdfRead`. Each isolate allows at most 3 lane places,
and each user at most 1. When no place is free, the action answers 503 with `Retry-After: 30` and "Sedang
membaca mutasi lain. Coba lagi dalam setengah menit." (an English entry is added); the body is never read. The
reader queue answers `reader_busy` (same 503) when the reader's turn does not come within 10 s.
`task.destroy()` is bounded at 2 s.

**N3.** The Vite plugin's `buildStart` resolves `unpdf/pdfjs`. If it is not `dist/pdfjs.mjs`, the build
fails (tested).

**Proof in workerd, not Node.** `npm run test:pdf-workerd` (`scripts/pdf-bound-workerd.ts`) works like this:

- It bundles `pdf-text.ts` with the same patch.
- It runs each fictional file in a fresh `workerd serve` process (`@cloudflare/workerd-linux-64` 2026-10-06).
- It warms up with one small PDF, then reads VmHWM before and after posting the file.
- It asserts the verdict, and that peak growth stays under 64 MiB.
- Every process is SIGKILLed, and the harness exits 1 on any miss.

The table below is the final run, under the heavy lock.

| File (fictional) | Size | Verdict | Baseline RSS | Peak growth | Time |
| - | - | - | - | - | - |
| honest 3-page statement | 1.7 KB | ok | 86 MiB | 1.6 MiB | 5 ms |
| honest, password-protected | 1.1 KB | ok | 86 MiB | 1.0 MiB | 3 ms |
| honest, JPEG logo 60000×60000 | 0.9 KB | ok | 87 MiB | 1.0 MiB | 3 ms |
| Flate ≈ 30 MB (cycle 2 N1) | 30.8 KB | too_complex | 86 MiB | 10.4 MiB | 31 ms |
| 46 KB → 45 MiB (QA) | 45.7 KB | too_complex | 86 MiB | 10.4 MiB | 33 ms |
| /Flate#44ecode 300 MB (H1.1) | 299.5 KB | too_complex | 86 MiB | 10.3 MiB | 34 ms |
| comment before stream 300 MB (H1.2) | 299.5 KB | too_complex | 86 MiB | 10.4 MiB | 34 ms |
| nested DecodeParms first 300 MB (H1.3) | 299.5 KB | too_complex | 86 MiB | 10.3 MiB | 34 ms |
| /Filter > 4 KiB before stream 300 MB (H1.4) | 304.4 KB | too_complex | 86 MiB | 11.1 MiB | 34 ms |
| RC4 empty password 300 MB (H2) | 299.7 KB | too_complex | 86 MiB | 2.2 MiB | 12 ms |
| Brotli 64 MB (N1) | 0.9 KB | too_complex | 86 MiB | 0.2 MiB | 2 ms |
| LZW content stream | 2.8 KB | too_complex | 87 MiB | 0.2 MiB | 2 ms |
| RunLength#44 ≈ 90 MB | 1368.0 KB | too_complex | 85 MiB | 12.4 MiB | 41 ms |
| /Contents 50 refs × 30 MB (N1) | 31.1 KB | too_complex | 86 MiB | 11.2 MiB | 22 ms |
| Form XObject × 60,000 (M1) | 1.8 KB | too_complex | 86 MiB | 21.7 MiB | 424 ms |
| Form XObject × 300,000 (M1 re-check) | 4.2 KB | too_complex | 86 MiB | 22.9 MiB | 429 ms |

For comparison, the red team re-check measured these peak RSS values on cycle 2:

- `#44` bomb: 434 MB
- Brotli: 687 MB, and it was read
- 50 references: 1,645 MB
- 300 k draws: 204 MB

In Node (`pdf-text.test.ts`), peak growth was 9–17 MiB for every shape. Fail-before: with both caps lifted, the
same 45 MiB `#44` file decodes and reads.

### Cycle 3 gate lines (each step on its own under the heavy lock)

- `npm run check` → `COMPLETED 1622 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, exit 0.
- `npm run lint` → `All matched files use Prettier code style!`, eslint clean, exit 0.
- `npx vitest run --maxWorkers=2` → `Test Files 187 passed (187)`, `Tests 2649 passed (2649)`, exit 0.
- `npm run build` → exit 0. The patched `chunks/pdfjs.js` contains `__finFilterOk`/`__finCharge`, and the
  client has none.
- `npm run test:pdf-workerd` → `pdf-bound-workerd: all passed`, exit 0.
- `npx playwright test e2e/impor.spec.ts --workers=1` → `15 passed (41.8s)`.
- `npm run clean:tmp` done. Every workerd I started was killed, and no dev server is left.
