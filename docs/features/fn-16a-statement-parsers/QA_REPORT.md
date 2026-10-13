# FN-16a statement parsers — QA report (cycle 1)

## Verdict: FAIL

`npm run check`/`lint`/full `vitest run`/`build` and the Playwright `impor`/`riwayat` journeys are all clean, and
every criterion that has test coverage is independently confirmed (including a live run of
`npm run compat:statements` against self-made fictional samples in a temp folder, outside the repo). But
criterion 13 ("the read is bounded... never an unbounded-memory... read") is **not actually met**: the Flate
decompression-budget scanner (`src/lib/server/statements/pdf-streams.ts`) can be bypassed by a crafted PDF, so a
small uploaded file can still make PDF.js inflate hundreds of megabytes in the Worker. This matches, and is
independently confirmed by source inspection against, `docs/features/fn-16a-statement-parsers/SECURITY_REPORT.md`
(red team, same cycle, verdict FAIL), which I read but did not modify. Checklist item "Bounded work" is violated.
Everything else checked is PASS; criteria 7, 8 are correctly "waiting" (no owner sample), not failed.

## Commands run

- `flock /tmp/montra-heavy.lock npm run check` → `COMPLETED 1621 FILES 0 ERRORS 0 WARNINGS`, exit 0, no provider.
- `flock /tmp/montra-heavy.lock npm run lint` → `All matched files use Prettier code style!`, eslint clean, exit 0, no provider.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2` (full suite) → `Test Files 187 passed (187)`, `Tests 2626 passed (2626)`, exit 0, mocked AI/local D1 (no real provider).
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 src/lib/shared/i18n.test.ts` → `12 passed (12)`, exit 0, no provider.
- `flock /tmp/montra-heavy.lock npm run build` → `vite build` + service worker build succeeded, `wrangler-compatible` output produced, exit 0, no provider.
- `grep -rl "pdfjs" .svelte-kit/output/client` → no match (PDF.js not in the client bundle), exit 1 (grep "not found"), no provider.
- `flock /tmp/montra-heavy.lock npm run clean:tmp` (x2) → `removed 0 stale miniflare directories`, exit 0, no provider.
- `LD_LIBRARY_PATH=... E2E_PORT=8875 flock ... npx playwright test e2e/impor.spec.ts e2e/riwayat.spec.ts --workers=1` → `31 passed (1.6m)`, exit 0, local wrangler dev (mock/local, no real provider).
- `npm run compat:statements` (no samples dir) → "No statement samples ... (tidak ada sampel)." / "No receipt samples ...", exit 0, no provider.
- `npm run compat:statements -- --samples=/tmp/.../fn16a-qa-samples` (self-made fictional PDFs/CSVs, outside repo, deleted after) → printed matrix matched expectations (see Checked criteria 2, 3, 12, 13, 25, 26, 27), exit 0, fixtures only, no provider.
- `grep -rnE "FILES|\.put\(|console\." src/lib/server/statements src/lib/shared/statements` → no match, no provider.
- Source review of `pdf-streams.ts`, `pdf-text.ts`, `statement-import.ts`, `read.ts`, `detect.ts`, `rows.ts`, i18n files — no provider, static only.

## Checked criteria

1. PASS — `detectInstitution` requires ≥0.5 confidence and no tie (`detect.ts`); `STATEMENT_PARSERS` is empty in production (`parsers.ts`), confirmed live: harness run against a fictional PDF/CSV both reported "institution not detected", never a guess.
2. PASS — live harness run: a hand-built image-only PDF (`buildPdf([{content:'', image:true}])`) → `pdf_scanned` / "perlu dibaca AI (FN-16)".
3. PASS — live harness run: a hand-built RC4-password PDF → "password-protected (set FIN_SAMPLE_PDF_PASSWORD)" without the password, `pdf_text` + institution path once `FIN_SAMPLE_PDF_PASSWORD` was set (password used only for that read, never stored — grep confirms no persistence).
4. PASS — `src/lib/shared/statements/detect.ts` / `statementHints` route FN-18's own CSV shapes (`financerCsv`) separately from bank-statement detection; e2e `impor.spec.ts` cases 2–5 exercise both sections without cross-contamination; `grep` of `read.ts` shows the FN-18 mappers and the statement detector are disjoint code paths.
5. FAIL by informed decision, not a bug — `xlsx` left out of `package.json`/`package-lock.json` (verified: no `xlsx` entry in either); XLS/XLSX is detected by magic bytes and refused with "Berkas XLS/XLSX belum didukung..." (`read.ts:94`, `detect.test.ts`). This matches the known, owner-relevant trade-off (npm `xlsx` 0.18.5 carries two high advisories, fixed builds only on SheetJS's own CDN) — correctly reported as not met rather than silently claimed done.
6. PASS (fictional parser) — `fictional-bank.ts`/`read.test.ts` exclude `SALDO AWAL`/`SALDO AKHIR` lines from the row set; confirmed again live: my own PDF with those exact lines produced a balance-check-eligible read with zero of those lines as transaction rows (not independently re-verified row-by-row from the harness output, which prints counts only by design — trusted from `read.test.ts`, which is in the green full-suite run).
7. WAITING — no BCA sample in `.superpowers/ref/samples/statements/`; `STATEMENT_PARSERS` empty; one amount call site confirmed (`rows.ts:57`, `statementRow` → `parseMoneyAmount`), consistent with the PRD's no-guessed-layout rule.
8. WAITING — same reason, no BRI sample.
9. PASS (fictional) — covered by `read.test.ts` per engineer report, inside the green full-suite run (2626/2626).
10. PASS — `dateInPeriod` (`rows.ts:23`) takes the year from the printed period, iterating from the period's first to last year and only accepting a date inside the range; read, logic is correct for a Dec→Jan period and Feb 29; covered by `rows.test.ts` in the green suite.
11. PASS — `decodeStatementText` (`detect.ts:39`) accepts UTF-8 (BOM dropped) and UTF-16 LE/BE (BOM-selected), strict-decodes, and returns `null` (→ re-save-as-UTF-8 refusal) for anything else, including Windows-1252 and NUL-containing binary; covered by `detect.test.ts` in the green suite.
12. PASS — live harness run: a truncated (half-length) hand-built PDF → `unknown` format / "corrupt PDF", never a throw, never a 500 (route-level 400 asserted by `read.test.ts`/route tests in the green suite).
13. **FAIL** — see Findings. The cap exists and is enforced for the straightforward case (confirmed live: a 46 KB PDF with a correctly-declared `/Filter /FlateDecode` stream inflating to 45 MiB → "too complex (cap/timeout)", bounded, fast), but source review of `pdf-streams.ts` confirms the same bypasses the red team reports (hex-escaped filter name, comment before `stream`, nested dictionary, >4 KiB dictionary window, RC4-encrypted-with-empty-password) are real in this code, not theoretical. XLSX n/a (no reader shipped).
14. PASS — `STATEMENT_MAX_BYTES` enforced by `readFormBody` before any parsing (`+page.server.ts:157`), 400; consistent with FN-18's `FILE_TOO_LARGE` pattern; in the green full-suite run.
15. PASS — `PDF_MAX_PAGES = 200` (`pdf-text.ts:14`), `pagesNotProcessed = totalPages - read` returned and surfaced; covered by `pdf-text.test.ts` (205→200+5) in the green suite.
16. PASS — `importStatement` checks `fallbackWalletOf` before reading the file (`statement-import.ts:136`); route cross-space test in `impor-statements.test.ts` asserts the uniform not-found; in the green suite.
17. PASS — no client-side PDF/CSV/XLS parse exists in `+page.svelte` (grep of the diff shows only form posts); server actions read `request.formData()`/raw bytes from scratch.
18. PASS — `grep -rnE "FILES|\.put\(|console\."` over `src/lib/server/statements` and `src/lib/shared/statements` returns nothing; only derived `transactions`/`import_batches` rows persist, confirmed by reading `statement-import.ts`/`csv-import.ts`'s `importRows` path.
19. PASS — route-level test in `impor-statements.test.ts` (green suite) asserts no file name/path/row index/internal id in a refusal; spot-checked the harness and `messages.ts`/i18n strings referenced from `read.ts` by hand, all fixed, content-free text.
20. PASS (fictional) — `balanceCheck` (`rows.ts:89`) computes `closing − opening − Σsigned`, integer minor units, `pass`/`gap`/`omitted`; matches FN-16's documented wording; in the green suite.
21–23. PASS — `impor-statements.test.ts` (green suite): re-upload of the same bytes reports every row already imported, zero new rows; undo tombstones in one `db.batch` (`undoImportBatch` unforked); `source='statement'`, `import_batch_id` set, title/notes/wallet-name masked via `maskAccountNumbers(cleanText(...))` (`statement-import.ts:48-61`).
24. PASS — live harness run: an unrecognised CSV ("unknownbank" fictional export, its own header shape) → "institution not detected", same family of refusal as an unrecognised PDF, never a guessed generic mapping.
25. PASS — live run, no samples dir at all: `npm run compat:statements` → "No statement samples ... (tidak ada sampel)." / "No receipt samples ...", exit 0.
26. PASS — live run against my own fictional samples containing an account number (`1234567890`), a second account number in a folder name (`rek-1234567890123456`), and descriptive text ("PEMBAYARAN TOKO CONTOH FIKTIF", "TERIMA DANA DARI BUDI", "Pembelian Fiktif Toko ABC"): none of that text appeared in stdout; the folder name itself was masked to `rek-••••3456`; only counts/typed reasons/balance status printed, matching the PRD's example matrix shape.
27. PASS — live run against a fictional "receipt" file under `receipts/toko-contoh/` → exactly one line, "toko-contoh  needs OCR (FN-15, blocked on key)", no image decode attempted (script source confirms no decode call on the receipts path).
28, 29 — PASS — both new actions resolve the space via `currentSpaceScope(locals)` (grep of `+page.server.ts`); `impor-statements.test.ts` cross-space probe (non-member, removed member, 20 concurrent writes) in the green suite.
30. PASS — `impor-statements.test.ts` 20-concurrent-import case in the green suite (engineer reports 4 rows/1 batch for a 4-row fixture; consistent with "each row created exactly once").
31. PASS — spot-checked `+page.svelte` diff: `{#each}` lists keyed by `dup.line`, `batch.id`, option value, or index, never filename/description.
32. PASS — `src/lib/shared/i18n.test.ts` passed (12/12) standalone and inside the full green suite; every PRD-named phrase ("Impor mutasi (PDF/CSV)", "Pilih institusi", "Deteksi otomatis", "Saldo cocok", "Saldo tidak cocok...", "PDF berkata sandi belum didukung...") has an `i18n-en.ts` entry, confirmed by direct grep.
33. PASS — `formatMoney` used for the balance-check gap and duplicate amounts (grep of `+page.svelte`); dates through the existing WIB formatter, unchanged from FN-18.
34. Partially PASS — `check`/`lint`/full `vitest`/`build` all independently re-run clean in this cycle (the engineer's one unresolved item — "full suite not re-run after a late fix" — is now resolved: 187/187 files, 2626/2626 tests). Fail-before proof for most regressions is credible (consistent code shapes, i.e. caps checked at the right place) but criterion 13's fail-before proof did not catch the real bypasses (see Findings) — the unit tests exercise the cap's happy path, not an adversarial PDF dictionary.

## Findings

1. **(High, carried from `SECURITY_REPORT.md`, independently confirmed by source review) Criterion 13 is not met: the Flate decompression-budget scanner can be bypassed, allowing unbounded-memory PDF reads.**
   - `src/lib/server/statements/pdf-streams.ts:94` `filtersOf()` uses `/\/[A-Za-z0-9]+/` to read a filter name — a PDF name with a `#xx` hex escape (e.g. `/Flate#44ecode`, legal PDF name syntax) is read by this regex as `Flate`, which is in neither `FLATE` nor `UNMEASURED`, so the stream is silently skipped (not measured, not refused) while PDF.js correctly decodes the escape to `FlateDecode` and inflates it.
   - `:114` the stream-start marker regex `/>>\s*stream(?:\r\n|\r|\n)?/g` does not allow a comment between the dictionary's closing `>>` and the `stream` keyword; PDF.js does, so a stream hidden behind `>>\n%c\nstream` is never found by the scanner.
   - `:26` `DICT_WINDOW = 4096`: a `/Filter /FlateDecode` entry placed more than 4 KiB before `stream` (e.g. behind a large `/Pad (...)` entry) falls outside the window the scanner looks in and is treated as having no filter.
   - `:132` (and `pdf-text.ts:133-134`): an encrypted file's unmeasurable streams are accepted once PDF.js reports `EncryptFilterName` — but PDF.js opens an RC4-encrypted PDF with an empty/default user password without asking for one, so an attacker can encrypt a zip-bomb-shaped stream with no real password, pass the "really encrypted" check, and skip measurement entirely.
   - Source inspection confirms every one of these four shapes is reachable with the code as written; this is not a theoretical gap. Input → a ~300 KB crafted PDF (plain Flate stream of repeated bytes, hidden by any one of the four tricks above) uploaded to `?/previewStatement` or `?/importStatement`. Expected (PRD criterion 13): refused with a clear message, bounded memory. Actual: `measureFlateStreams` returns `{status:'ok'}`, and PDF.js then inflates the full stream (hundreds of MB) inside the Worker's 128 MB memory limit, risking an isolate crash that can drop other in-flight requests (no statement-upload rate limit exists).
   - This also means the engineer's own "Residual risks" note ("bounded only by the 20 s deadline and the Worker's 128 MB memory limit") is not a real bound for the encrypted case, and the other three shapes are not mentioned there at all.

2. **(Medium, carried from `SECURITY_REPORT.md`) `maxTextChars` is enforced only after a whole page's `getTextContent()` resolves, not while it accumulates.** A tiny file using a reused Form XObject (`/X1 Do` many times in one content stream) can force PDF.js to build a very large in-memory text-item array and burn CPU roughly linearly in the number of draws before `pdf-text.ts`'s post-page check ever runs, so the 2,000,000-character cap does not bound that page's own processing cost. Not independently re-run by me this cycle (trusted from the security report's description, which matches the code shape at `pdf-text.ts:143-150`), but plausible and consistent with the checked source.

3. Criteria 7–8 (BCA/BRI real parsers) are correctly reported as **waiting**, not failed: `.superpowers/ref/samples/statements/` does not exist in this worktree, and `STATEMENT_PARSERS` is empty in `src/lib/shared/statements/parsers.ts`, matching PRD owner decision A.

4. Criterion 5 (XLS/XLSX reading) is correctly reported as **not met by decision**: no `xlsx` dependency exists in `package.json`/`package-lock.json`; XLS/XLSX files are detected by magic bytes and refused with a clear message. This is an honest, documented trade-off (open high npm advisories on the only npm-distributed build), not a silent gap.

5. No violation found of: one access rule, masking, untrusted text, idempotent capture, concurrent writes (`db.batch`), form-body guards, no-upload-persistence, Svelte keyed lists, i18n, currency display, truthful state, no-JS forms. `npm run gates`'s four steps (run separately, per the RAM rule) are all clean, and the one previously-unverified item (full `vitest` suite re-run after the engineer's late one-line fix) is now confirmed clean (2626/2626).

## Notes on method

- All fictional statement/receipt/PDF samples used to drive `npm run compat:statements` and to probe detection/refusal states were generated in `<scratchpad>` (outside the repository) using the project's own `test/helpers/pdf.ts` builder, and deleted after use; none were committed, none are real.
- `SECURITY_REPORT.md` (red team, same cycle) was read for context and cross-checked against the source directly; it was not modified, and this report's Finding 1 stands on my own independent reading of `pdf-streams.ts`, not merely on citing the other report.
