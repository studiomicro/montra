# FN-16c BCA mutation CSV — QA report

**Verdict: PASS**

Scope: `git diff main...HEAD` at `41c9436` in worktree `fn-16c-bca-csv`. Adds `src/lib/shared/statements/bca-csv.ts`
(KlikBCA/myBCA CSV mutation reader) wired into the existing `bca` parser id (`bca.ts`: `formats: ['pdf_text','csv']`),
with unit tests, a synthetic fixture, integration tests and one e2e journey. No migration, no new route/action, no
new i18n strings (reuses the `/impor` UI and messages already shipped in FN-16a/FN-16b).

## Commands run

- `flock /tmp/montra-heavy.lock npm run check` → `0 ERRORS 0 WARNINGS` across 1816 files, exit 0.
- `flock /tmp/montra-heavy.lock npm run lint` → `prettier --check .` clean, `eslint .` clean, exit 0.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2` → Test Files 223 passed (223), Tests 3225 passed (3225), exit 0; no real provider, local D1/miniflare only.
- `flock /tmp/montra-heavy.lock npm run build` → svelte-kit + vite + service-worker build, Cloudflare adapter, exit 0.
- `flock /tmp/montra-heavy.lock npm run compat:statements` (via a temporary symlink of `.superpowers` into the worktree, removed immediately after) → read the owner's real `.superpowers/ref/samples/statements/csv-1/sample.csv`: `csv-1  csv  bca  8 rows parsed  0 rejected  balance pass (Rp0 gap)`; also exercised the existing `bca` PDF sample (`9 rows parsed, pass (Rp0 gap)`) and the two password-protected PDF samples (`bni`, `mandiri`, correctly refused as `unknown`/needs password). No account number, description or filename beyond the folder name printed — verified against stdout directly, no raw file content was read or copied. This hits the real file, not a mock.
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=5571 flock /tmp/montra-heavy.lock npx playwright test --workers=1 e2e/impor.spec.ts` → 19 passed (phone + desktop), exit 0; local dev server (miniflare), not a real provider.
- `npm run clean:tmp` → removed 0 stale miniflare directories (post-run cleanup, no lingering server).

## Checked criteria (fn-16a PRD, CSV-reading subset; fn-16b SUMMARY self-check pattern)

1. Detection by layout markers (column row `Tanggal,Keterangan,Cabang,Jumlah,,Saldo` + header labels), never a guess — PASS (`bca-csv.test.ts` "BCA CSV detection"; confidence 0.9 with labels, 0.6 without, 0 without the exact column row).
4. CSV bank statement vs FN-18 `template`/`money_manager` shapes never cross-misdetected — PASS (`bca-csv.test.ts` "never claims a FN-18 template, another institution's CSV, or a column row far below the top"; `read.ts`'s existing `montra_csv` hint path untouched).
6. Opening/closing/running-balance and footer lines excluded from rows, used only for the balance check — PASS (`bca-csv.ts` footer/label handling; "never puts the header, the account number, the name or the footer into a row").
7. Every row's date/direction/amount/description maps correctly; amount through `parseMoneyAmount` only (one call site, `statementRow`) — PASS (`BCA_CSV_SEPTEMBER_ROWS` fixture, exact integer minor units asserted).
9/`'` stripping/DD-MM-YYYY/strict amounts — PASS (`cellOf` strips the leading `'`; `DATE` regex is strict `DD/MM/YYYY`; `AMOUNT` regex rejects negatives, bare integers without decimals, Indonesian-style grouping, and is length-bounded before the regex runs).
11. Encoding: CRLF, BOM, semicolon delimiter, quoted cells, comma-grouped amounts all read identically — PASS ("reads the same with CRLF, a BOM, semicolons, quoted cells and comma-grouped amounts").
12/Robustness: whole-file `inconsistent` refusal — PASS for every named case: dropped row, wrong running balance, wrong closing/credit/debit total, missing/repeated/unknown footer label, row after the footer, stray record, `PEND` date, impossible/short-year date, unknown DB/CR mark, non-numeric/negative/zero/over-cap amount, missing/second/non-IDR currency (`bca-csv.test.ts` "self-checks" + "hostile remarks" describe blocks; red team M1 repros re-asserted).
17. Forged-row attempts (line-break smuggling a footer line, quoted footer/header text, cancel-out amount pairs) stay description text or refuse the whole file, never alter another row's amount — PASS (hostile-remarks tests + `integration` "forged or non-IDR file" test).
CSV export formula prefixing — PASS: `=HYPERLINK(...)`, `+1+1`, `-1+1`, `@SUM(1)` stored as plain `title` text and re-exported through the unchanged FN-18 `csvCell`/formula guard with a leading `'` (`bca-csv.test.ts` + integration "formula-looking descriptions" test).
Masking — PASS: a card number inside a description is masked to `••••3456` before storage (integration test, exact row-by-row comparison against the fixture with the same mask applied).
Dedupe/undo through the import flow — PASS: `statement:<sha256>:<row index>` collides on a byte-identical re-upload (`already: 7`, zero new rows, no error); a byte-different (semicolon) re-encoding of the same rows is flagged "possible duplicate", never silently merged; `undoImportBatch` tombstones all 7 rows in one batch (integration test).
Shared `bca` id reads both `pdf_text` and `csv` — PASS: same parser module (`BCA.formats = ['pdf_text','csv']`); the pre-existing BCA PDF fixture test and e2e journey were re-run unmodified-passing (`bca.test.ts`, `e2e/impor.spec.ts:286`), confirming the CSV addition did not regress the PDF path.
25/26/27 Harness — PASS: empty-samples exit 0 with notice (also observed before the symlink was added); run against the owner's real `csv-1` sample printed only counts and a pass/fail balance line, no account/description/filename content.
28/29/30 Cross-cutting authorization/concurrency — PASS by inheritance: this diff adds no new load/action (reuses the existing `/impor` `?/previewStatement`/`?/importStatement` actions and `statement-import.ts`); the pre-existing cross-space probe (`impor-statements.test.ts:546`, 404 for another space's wallet, non-member, removed member) and 20-concurrent-import probe (`impor-statements.test.ts:253`) already exercise that exact code path, which is untouched by this diff, and both tests still pass in the full vitest run.
31/32/33 Keyed lists/i18n/currency formatting — N/A to this diff (no UI/strings changed); pre-existing tests for `/impor`'s UI unaffected and still green.
34. `npm run gates`-equivalent clean (check/lint/test/build run individually per the RAM constraint) — PASS, see Commands.

## Findings

None blocking. Carried over from the red team's `SECURITY_REPORT.md` (cycle 1, verdict PASS) as informational-only, not re-litigated here since no money/authorization impact:
- L1/L2 (low): if a real BCA CSV ever contains an unescaped quote or raw line break inside a remark, a statement could become unimportable (availability only) or, in a narrow case, a sender could rewrite their own row's date/description (amounts/directions cannot change without breaking the footer totals). Flagged for confirmation against a real sample with such remarks; the owner's real `csv-1` sample used in this run did not exhibit either case (it parsed and reconciled cleanly).
- L3 (low, pre-existing design, not new to this feature): a re-downloaded or cross-format (PDF vs CSV) duplicate statement is flagged "possible duplicate" rather than hard-blocked — same as FN-16a/b.

## Engineering checklist cross-check

Money through the shared `parseMoneyAmount` only (one call site, `statementRow`), integer minor units, no floats: confirmed. Untrusted text capped/masked before storage: confirmed (`maskRow`, unchanged shared helper). No upload persistence: confirmed, this diff adds no R2/D1/log write of raw bytes or extracted text. CSV export formula guard: confirmed exercised, unchanged shared code. Svelte keyed lists / CSP / i18n: not applicable, no UI or string changes in this diff. Fail-before proof: not independently re-derived by QA (engineer/red-team report this); red team's own probe table (`SECURITY_REPORT.md`) corroborates the self-check refusal paths were exercised against crafted adversarial input, all held.

## Privacy note

The owner's real sample at `.superpowers/ref/samples/statements/csv-1/sample.csv` was read only via `npm run compat:statements`'s printed matrix (counts and pass/fail only); it was never opened directly, copied, or quoted in this report or committed to the repo. The temporary symlink used to make the gitignored `.superpowers/` folder visible inside this worktree was removed immediately after the harness ran.
