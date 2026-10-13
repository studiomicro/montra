# FN-16d BNI mutasi PDF parser — QA report

**Verdict: PASS**

Scope: `git diff main...HEAD` at `9410e81` in worktree `fn-16d-bni` (branch `fn-16d-bni-parser`). Contract:
`docs/features/fn-16a-statement-parsers/PRD.md`; self-check pattern per `docs/features/fn-16b-bca-parser/SUMMARY.md`.
Adds `src/lib/shared/statements/bni.ts` (BNI "Laporan Mutasi Rekening" text-PDF reader), registered as a second
entry in `STATEMENT_PARSERS` (`parsers.ts`) alongside the existing `bca` id; a `.pdf-password`-file password path
for `npm run compat:statements` (`scripts/compat-statements.ts`); unit tests, a synthetic three-page fixture, two
integration tests and one e2e journey (password wrong/correct, preview, import, undo, forged-statement refusal,
manual institution pick). No migration, no new route/action, no new i18n strings (reuses the generic password UI,
messages and `/impor` upload section already shipped by FN-16a's infrastructure, driven dynamically off
`STATEMENT_PARSERS`).

## Commands run

- `flock /tmp/montra-heavy.lock npm run check` → `COMPLETED 1816 FILES 0 ERRORS 0 WARNINGS`, exit 0.
- `flock /tmp/montra-heavy.lock npm run lint` → `prettier --check .` clean, `eslint .` clean, exit 0.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 src/lib/shared/statements scripts/compat-statements.test.ts test/integration/impor-statements.test.ts` → `Test Files 6 passed (6)`, `Tests 105 passed (105)`, exit 0; local D1/miniflare, no real provider.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2` (full suite) → `Test Files 223 passed (223)`, `Tests 3236 passed (3236)`, exit 0, 211.58 s; local D1/miniflare only, no real provider. This run includes `test/integration/privacy.test.ts`, which passed — see Flake note below.
- `flock /tmp/montra-heavy.lock npm run build` → svelte-kit + vite + service-worker build, Cloudflare adapter, "✔ done", exit 0.
- `flock /tmp/montra-heavy.lock node scripts/compat-statements.ts --samples=<repo>` → hit the owner's real files (not a mock): `bca pdf_text bca 1 page 9 rows parsed 0 rejected pass (Rp0 gap)`; `bni pdf_text bni 12 pages 170 rows parsed 0 rejected pass (Rp0 gap)` — the password was read only from the sibling git-ignored `.pdf-password` file, never passed on the command line or printed; `csv-1`/`mandiri` stayed `institution not detected` (unchanged, no parser for them). No account number, row description or filename beyond the owner's own folder name appeared in the output.
- `flock /tmp/montra-heavy.lock npm run test:pdf-workerd` → `pdf-bound-workerd: all passed` (17 fictional shapes in workerd, every bomb `too_complex`, every honest file — including a password-protected one — `ok`), exit 0.
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=5612 flock /tmp/montra-heavy.lock npx playwright test --workers=1 e2e/impor.spec.ts` → `19 passed (39.4s)`, exit 0; local miniflare dev server, not a real provider. Includes the new BNI password journey on both `[phone]` and `[desktop]`.
- `npm run clean:tmp` → `removed 0 stale miniflare directories`; confirmed no lingering process on port 5612 after the run.

### Flake investigation (engineer's note on `test/integration/privacy.test.ts`)

The engineer reported one failure of `privacy.test.ts` in a full run, attributed to the export rate-limit test. I
reran the full `vitest` suite once, in isolation under the heavy lock (no other vitest process holding it at the
same time): all 223 files including `privacy.test.ts` passed, with no retries. **Conclusion: flake, not a real
regression** — most likely a shared in-process rate-limit counter colliding across test files when many workers
or runs compete for the same small window, consistent with the machine's heavy concurrent load from other agents
observed throughout this session (several other worktrees' `flock`-guarded `vitest`/`playwright`/`build` runs were
queued behind and ahead of mine on `/tmp/montra-heavy.lock`). This diff does not touch
`privacy.test.ts`, its rate limiter, or the export path.

## Checked criteria (fn-16a PRD, BNI-reading subset; fn-16b SUMMARY self-check pattern)

1. Detection by layout (title `Laporan Mutasi Rekening`, bank line `PT Bank Negara Indonesia (Persero) Tbk.`, table
   header `Tanggal & Waktu Rincian Transaksi Nominal (IDR) Saldo (IDR)`), never a guess — PASS (`bni.test.ts`
   "BNI detection": 0.9 with all three, 0.6 without the title, 0 without the header or for a CSV; confirmed against
   the real sample: `bni pdf_text bni` with 170/170 rows read).
2/3. Scanned PDF → `pdf_scanned`/"perlu dibaca AI"; password-protected PDF → detected and refused with the
   existing message, never silent — PASS: this diff adds no new refusal path (shared `pdf-text.ts`/`read.ts`
   unchanged); exercised end-to-end by the new e2e test (`PDF ini dikunci sandi.` then `Sandi PDF salah.` then
   success) and the integration test (`needsPassword: true`, `Sandi PDF salah. Periksa lalu coba lagi.`), and
   against the real, genuinely password-protected sample via `compat:statements`.
4. CSV bank shape vs FN-18 template/money_manager never cross-misdetected — PASS: BNI ships `formats: ['pdf_text']`
   only; `BNI.detect` on a CSV document returns 0 (`bni.test.ts` "claims less… never a CSV").
6. Opening/closing/running-balance/page-counter/notes lines excluded from rows, used only for the balance check —
   PASS (`bni.test.ts` "keeps headers, the summary, opening/closing rows, counters and notes out of the rows";
   titles never match `/Saldo|Laporan|Periode|OJK|dari|Informasi|TAPLUS|WIB|NASABAH/`).
7. Every row's date/direction/amount/description maps correctly; amount through `parseMoneyAmount` only (one call
   site, `statementRow`, unchanged shared helper) — PASS (`BNI_JUNE_ROWS` fixture, exact integer minor units
   asserted; cents vector `+1,234.56` → `123_456` exact).
9. Multi-page: 3-page fixture read and concatenated in order, no page dropped or duplicated — PASS (`bni.test.ts`
   "reads every row across three pages in order"; a dropped page makes the file `inconsistent` via the page-counter
   check). Confirmed again on the real 12-page sample (170 rows, 0 rejected).
10. Year-across-New-Year: `bniPeriod` takes the start month/year from the end, or the previous year for a
    December→January range — PASS (`bniPeriod` unit tests for `16 Desember - 15 Januari 2027`, `1 Desember 2025 -
    31 Januari 2026`; a row-level test parses `20 Des 2026`/`5 Jan 2027` into `2026-12-20`/`2027-01-05`).
12-15. Malformed/zip-bomb/oversized/page-cap PDFs — PASS by inheritance: this diff adds no new PDF-reading code;
    `pdf-text.ts`/`read.ts`/`pdf-bound-workerd.ts` are unchanged and `npm run test:pdf-workerd` (17 cases, including
    a password-protected honest file) all passed in this run, exercising BNI's own reader path through the shared
    extractor.
16/28/29. Space authorization: no new load/action added (BNI reuses `/impor`'s existing `?/previewStatement`/
    `?/importStatement`, `statement-import.ts`, `currentSpaceScope`); the pre-existing cross-space wallet probe and
    manual-institution-pick behaviour (`impor-statements.test.ts` "picking BNI by hand reads it; picking BCA for a
    BNI file is refused, never guessed") exercise this unchanged code path with BNI's own fixtures, and pass.
17. Server re-parses raw bytes from scratch, no client row list — PASS by inheritance (unchanged `statement-import.ts`
    `prepare()` hashes and re-reads the uploaded bytes every time); confirmed indirectly by the no-password/
    wrong-password/correct-password integration test sequence all reading the same uploaded bytes server-side.
18. No upload persistence — PASS: diff adds no R2/D1/log write of raw bytes or extracted text; the integration test
    asserts `console.error` spy output never contains the statement text or the password after a full
    preview→import→undo cycle.
19. No file path/stack trace/row index/internal id in user text — PASS: all BNI error messages reuse FN-16a's
    existing, already-reviewed strings (`PDF ini dikunci sandi…`, `Sandi PDF salah…`, the whole-file
    "Isi mutasi ini tidak cocok dengan saldo yang tercetak…" refusal); no new string was added by this diff.
20. Balance check (opening + Σ signed rows = closing) — PASS (`balanceCheck(parse)` returns `{status:'pass'}` on
    `BNI_JUNE`; confirmed on the real sample, `pass (Rp0 gap)`).
21. Same file imported twice: dedupe collides, second import reports every row "already imported", zero new rows,
    no error — PASS (`impor-statements.test.ts` "with the password: … imported once … then undone", the repeated
    `importStatement` call returns `{counts:{imported:0, already:7}}`).
22/23. Undo tombstones the whole batch in one `db.batch`; every row's `source='statement'`, title masked to the
    last 4 digits — PASS (same test: `undoImportBatch` → `'ok'`, `liveRows` empty after; row titles compared against
    the fixture with `8808123456789012`→`••••9012` and `1234567890123`→`••••0123` applied, exact match).
24. Unsupported institution/format still answers the existing "pick manually" refusal — PASS by inheritance
    (unchanged `read.ts`/`validation.ts`; BNI only adds a new accepted id to the existing picker list, exercised by
    the manual-pick integration test above and the e2e "Didukung: BCA, BNI" assertion).
25/26. Harness: empty-samples still exits 0 with a notice (pre-existing, unaffected by this diff; confirmed
    structurally — `compat-statements.ts`'s own diff only adds password lookup, not the empty-folder path); run
    against the owner's real samples printed only counts/format/institution/balance — no account number, row text
    or filename beyond the given folder — verified directly against the stdout above.
27. Receipt samples: unaffected, no receipts present this run (`No receipt samples…`), unchanged code path.
31. `{#each}` lists keyed by id/index — N/A to this diff (no UI markup changed; `data.statementInstitutions` list
    already keyed appropriately by the pre-existing `/impor` page, confirmed unchanged in the diff).
32. i18n — PASS: no new Indonesian string was added (`git diff` shows no change to `i18n.ts`/`i18n-en.ts`); the BNI
    section text ("Didukung: BCA, BNI") is produced by the existing `trf('Didukung: {list}', …)` template rendering
    the now-two-entry `STATEMENT_PARSERS` list.
33. Currency/date display — N/A to this diff (no new display code; shared `formatMoney`/`dates.ts` paths unchanged).
34. Forged/adversarial rows — PASS, mirroring the BCA M1 fix directly in BNI's first version rather than needing a
    fix cycle: merchant text holding a signed amount+balance never decides the real amount (ambiguous → refused
    whole file when it collides with the real line); a remark imitating the table-closing/opening row is text while
    a row is open and only ends/starts the table between rows (never silently drops a row); a date-shaped remark
    splitting a row is `missing_amount` and the file is `inconsistent`; a page counter/period/currency forged
    *inside* a row's detail text is ignored (the header line decides) — all covered by
    `bni.test.ts`'s "BNI forged rows" describe block (6 tests) and the integration test's dedicated forged-statement
    case, both passing.
34 (gates). `npm run gates`-equivalent (check/lint/test/build run individually per the RAM constraint, plus the
    harness and `test:pdf-workerd` which are not part of `gates` but are named in this task) — PASS, see Commands.

## Findings

None blocking. One flake investigated and resolved (see above, not a code defect).

Carried over as informational-only (pre-existing, not introduced or reopened by this diff; BNI's own self-check
design already incorporates the fix pattern from FN-16b's cycle-2 report, e.g. its header/closing-row state machine
is page-scoped and only re-enters table state once per page, which structurally avoids the BCA C2-L1 "fake header
mid-row" class of bug rather than needing a later fix):

- Same class as FN-16b's L5/C2-L3: a hand-made file with no `Mata Uang` line would currently read as IDR by
  default elsewhere in the codebase, but BNI's own `CURRENCY` regex requires the line to be present in each page's
  header block and any disagreement (including an absent line when currency checking) feeds into `consistent()`'s
  `only(printed.currencies) !== 'IDR'` check, which requires a single agreed currency per statement — a real BNI
  statement always prints `Mata Uang: IDR`.
- Not independently re-verified by QA: ReDoS/perf on hand-rolled extreme inputs beyond the included
  `bni.test.ts` "BNI on hostile input" test (100k-repeat lines parsed in <3s, included and passing) — no separate
  scratchpad probe was run since the regexes mirror BCA's already-reviewed, anchored/linear shapes almost exactly
  and the hostile-input test already exercises the same classes (long repeated lines, huge repeat counts).

## Engineering checklist cross-check

Money through `parseMoneyAmount`/`statementRow` only (one call site, shared and unchanged): confirmed. Integer
minor units, no floats: confirmed (`amountMinor` is always an integer; cents fixture `123_456` exact). One currency
per sum: confirmed (`consistent()` refuses any file where `printed.currencies` is not a single `IDR`). WIB dates:
confirmed — `bniPeriod`/`rowDate` build plain `YYYY-MM-DD` WIB calendar strings from the printed period and day/month/
year, never a UTC conversion. Untrusted text capped/masked before storage: confirmed (`maskRow`/`statement-import.ts`,
unchanged shared helper, exercised by the integration test's exact masked-title comparison). No upload persistence:
confirmed, this diff adds no R2/D1/log write of raw bytes or extracted text (grep of the diff shows no such write;
the integration test's console-spy assertion corroborates). Access rule: confirmed, no new load/action, reuses
`currentSpaceScope`/the existing `/impor` actions unchanged. Svelte keyed lists / CSP: N/A, no UI markup changed.
Fail-before proof: not independently re-derived by QA (this is the engineer's first version of this parser, not a
fix cycle); the test suite's "BNI forged rows" and "BNI self-checks" blocks demonstrate the refusal paths hold
against the adversarial vectors they encode.

## Privacy note

The owner's real sample at `.superpowers/ref/samples/statements/bni/bni-2026-06.pdf` and its sibling
`.pdf-password` file were read only through `npm run compat:statements --samples=…`'s printed matrix (folder name,
format, institution, page/row counts, balance pass/fail) — never opened directly, copied, or quoted in this report,
the repo, or any tool output. The password itself was never printed, echoed, or placed on a command line; it was
read by the harness from the git-ignored `.pdf-password` file next to the sample, exactly as the engineer's new
`samplePassword()` helper is designed to do, and is not reproduced anywhere in this report.
