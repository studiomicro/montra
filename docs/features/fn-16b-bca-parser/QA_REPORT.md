# FN-16b BCA e-statement parser — QA report

## Overall verdict: PASS (cycle 1 PASS; cycle 2 PASS after red-team fixes)

## Cycle 1 verdict: PASS

Scope: `src/lib/shared/statements/bca.ts` (new institution module), its fixture
(`test/fixtures/statements/bca.ts`), its unit tests (`bca.test.ts`), registry wiring
(`parsers.ts`, `detect.test.ts`), the integration test additions
(`test/integration/impor-statements.test.ts`) and the e2e BCA journey (`e2e/impor.spec.ts`).
No route, server action or UI markup changed in this diff — the generic "Didukung: {list}" UI and
`compat:statements` harness built in fn-16a already read the parser registry, so BCA appears
automatically. Branch `fn-16b-bca-parser` at `e01a917`, diffed against `main` (base is older than
`main`; judged the diff content only, not the merge-base noise).

## Commands run

- `flock /tmp/montra-heavy.lock npm run check` → `COMPLETED 1746 FILES 0 ERRORS 0 WARNINGS`, exit 0 — real toolchain (svelte-check/tsc), no mocks.
- `flock /tmp/montra-heavy.lock npm run lint` → `All matched files use Prettier code style!`, eslint silent (no findings), exit 0 — real toolchain.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 src/lib/shared/statements test/integration/impor-statements.test.ts` → `Test Files 4 passed (4)`, `Tests 60 passed (60)`, exit 0 — local Vitest, D1 in-memory/local, no external provider.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2` (full suite) → `Test Files 207 passed (207)`, `Tests 2987 passed (2987)`, exit 0 — local Vitest, no external provider.
- `flock /tmp/montra-heavy.lock npm run build` → `✓ built in 1.23s` / service worker built / adapter-cloudflare bundled, exit 0 — real build.
- `FIN_SAMPLES_DIR=<repo> flock /tmp/montra-heavy.lock npm run compat:statements` → real owner PDF, 1 file, format `pdf_text`, institution `bca`, 1 page, 9 rows parsed, 0 rejected, `balance check: pass (Rp0 gap)`, exit 0 — ran against the **real provider file** (the owner's actual redacted BCA PDF), counts/pass-fail only, no row content printed.
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=5461 npx playwright test e2e/impor.spec.ts --workers=1` → `17 passed (33.9s)`, exit 0 — real wrangler dev/workerd local server, no external provider.
- `npm run clean:tmp` → `clean:tmp: removed 169 stale miniflare directories`, exit 0.

No `npm run gates`/`npm test` invoked (RAM rule honored); the above four heavy commands are gates'
exact constituents (`check && lint && test && build`), run individually and all clean, plus the
compat harness and the e2e BCA journey as required by the task brief. Confirmed no lingering
`wrangler dev`/`workerd` processes for this project after the run.

## Checked criteria (fn-16a PRD, BCA-specific slice)

1. **Detection by layout markers only** — PASS. `BCA.detect` requires the literal table header
   `TANGGAL KETERANGAN CBG MUTASI SALDO` (0 without it) and scores 0.9 with a `PERIODE :` line,
   0.6 without one; never a column-count guess. `detectInstitution` picks `bca` only above
   `MIN_DETECT_CONFIDENCE`. Verified against a synthetic fixture (`bca.test.ts` "is detected…",
   "claims less without a period line…") and against the real sample via `compat:statements`
   (`institution: bca`, `format: pdf_text`).
2. **DB/CR handling** — PASS. `AMOUNT_TAIL` reads an optional `DB`/`CR` mark; `DB` → expense,
   unmarked or `CR` → income (`bca.test.ts` "DB debits, unmarked credits…", "an amount marked CR
   is a credit").
3. **Wrapped descriptions** — PASS. `joinWrapped` concatenates a row's continuation lines, joining
   digit-to-digit boundaries with `, ` so a date and a card number never fuse into one number before
   masking (`bca.test.ts` "a date and the card number on the next line stay two numbers…").
4. **Page headers/footers/closing block excluded** — PASS. Only lines after the table header and
   before `SALDO AWAL :`/`SALDO AKHIR :` are rows; the opening `SALDO AWAL <amount>` line and the
   closing block are consumed as balances, never as transactions (`bca.test.ts` "keeps the opening
   line, running balances, page headers, footers and closing block out of the rows" — title text
   asserted not to match `SALDO|Bersambung|REKENING|PERIODE|HALAMAN|MUTASI`). Also proven against
   a hostile line (a transfer remark containing the literal string `SALDO AKHIR :`) which does not
   let a wrong balance through ("a transfer remark imitating the closing block cannot make a wrong
   statement pass").
5. **Year from PERIODE; out-of-month dates rejected not moved** — PASS. `dateInPeriod` resolves the
   year from the printed period only; a December→January rollover fixture resolves each side to its
   own year; a day outside the printed month, an impossible day (29 Feb non-leap) or no period line
   is `unparseable_date`, never silently moved (`bca.test.ts` "BCA year and period" block, 5 cases).
6. **Non-IDR rejected** — PASS. A non-`IDR` `MATA UANG :` line turns every row into
   `unsupported_currency` and the balance check is `omitted` (never computed on a foreign-currency
   misread) (`bca.test.ts` "a non-IDR account is never read as rupiah").
7. **Reconciliation exact in minor units, fixtures and real file** — PASS. `balanceCheck` is
   `opening + Σ signed rows = closing` in integer minor units; synthetic fixture passes exactly
   (`balanceCheck(parse(BCA_SEPTEMBER))` → `{status:'pass'}`), a dropped page reports the exact
   gap (`-2_550_050`), and the **real owner PDF** reconciles exactly per `compat:statements`
   (`pass (Rp0 gap)`, 9/9 rows parsed, 0 rejected) — never printed a figure not backed by the file's
   own rows.
8. **Preview → dedupe → undo through the import flow** — PASS. Integration test
   `test/integration/impor-statements.test.ts` "BCA e-statement (synthetic three-page PDF)":
   `previewStatement` finds 7 rows and a passing balance with zero live rows written; `importStatement`
   writes exactly 7 rows with `source: 'statement'` and `dedupeKey` matching
   `statement:<sha256>:<0-6>`; a second import of the identical bytes reports `imported: 0, already: 7`
   and creates no new rows; `undoImportBatch` tombstones all 7 and `liveRows` returns empty again.
   Also exercised through the actual `/impor` server action (`previewStatement` act with a `File`),
   confirming no statement text/account content reaches `console.error`
   (`expect(inspect(log.mock.calls)).not.toMatch(/CONTOH|FIKTIF|1234567890/)`).
9. **e2e BCA case + whole `e2e/impor.spec.ts`** — PASS. `statement upload: a BCA e-statement is
   detected, reconciles and imports once` passes on both `phone` and `desktop` projects; the full
   spec file (17 tests, both projects) passes (`17 passed (33.9s)`), including the pre-existing
   scanned-PDF/unknown-bank refusal journeys (now reading "Didukung: BCA" instead of "Belum ada
   format bank…", confirming the generic UI correctly reflects the now-non-empty registry).
10. **Fixtures fully synthetic** — PASS. Grepped the whole diff for anything real-looking: every
    name, address, branch and account number is an invented placeholder (`CONTOH FIKTIF`,
    `NAMA NASABAH FIKTIF`, account `1234567890123456`/`1234567890` — an obviously fabricated,
    repeating-pattern number, not a real one), amounts are round, invented figures. No value from
    the real file appears anywhere in the diff, the fixture, or this report.
11. **Bounded parsing time on hostile input** — PASS. `bca.test.ts` "huge input stays bounded and
    linear": 20,000 synthetic rows plus one adversarial 100,000-token line complete in
    `< 2000 ms` and reject cleanly (`missing_amount`), consistent with the parser's single linear
    pass per page with no backtracking regex blow-up. (This exercises the pure parser function
    directly; the server-side 15 MB/200-page/decompression caps are fn-16a's own, unchanged by this
    diff and unaffected.)
12. **Other institutions' detection unaffected** — PASS. `detect.test.ts` still asserts an unrelated
    fictional-bank document is never claimed by `bca` and that `STATEMENT_PARSERS` only lists the
    institutions actually proven (`['bca']`); `bca.test.ts` "does not claim another statement…"
    asserts `BCA.detect` returns 0 on a different institution's fixture lines
    (`FICTIONAL_LINES`), and that an unmatched CSV document never claims `bca`.
13. **Single amount tokenizer / no fabricated figures** — PASS. `grep` of `bca.ts` and
    `src/lib/server/statements/` shows exactly one call site of `parseMoneyAmount`
    (`src/lib/shared/statements/bca.ts:56`), no `parseFloat`/hand-rolled numeric parsing on money.
14. **Masking, source and review-state plumbing (reused, not re-verified structurally)** — PASS by
    inheritance: `source: 'statement'`, `maskAccountNumbers` and `import_batch_id` wiring are
    fn-16a's `statement-import.ts`, unchanged by this diff; the new integration test still asserts
    `rows.every(x => x.source === 'statement')` and masked titles end-to-end for the BCA case.

## Findings

None. No ENGINEERING_CHECKLIST.md violation found in the diff: money parsing goes through the one
shared `parseMoneyAmount` call; `{#each}`/keying is unaffected (no UI changed); no raw bytes or
extracted text are logged (confirmed by the `console.error` spy test); the hostile/huge-input test
demonstrates bounded, linear behaviour; i18n has no new phrases needing an English entry (confirmed
by `npm run test`'s `i18n.test.ts` passing inside the full suite); fixtures are synthetic and the
real sample was touched only via `compat:statements`, counts/pass-fail only, never copied anywhere.

## Notes for the record

- The real owner file was accessed **only** through `FIN_SAMPLES_DIR=<main-repo path> npm run
  compat:statements`, reading from the main checkout's git-ignored `.superpowers/ref/samples/`
  directory (the worktree does not have its own copy of that ignored folder) — no value from it
  was copied into this report, the repo, or any fixture.
- `git diff main...HEAD --stat` shows only test/fixture/parser/e2e files touched; no `src/routes`,
  `src/lib/server/statements/`, or migration changes in this pass — consistent with the PRD's "ship
  one institution module, reuse the already-built generic plumbing" design.

## Cycle 2 (post red-team fix) — Verdict: PASS

Re-checked after `docs/features/fn-16b-bca-parser/SECURITY_REPORT.md` (red team, worktree
`fn-16b-rt`, verdict FAIL at `821ab27`) found M1 (medium: third-party-controlled description text
— sender name, transfer remark, merchant name — could end a row early, forge its amount/direction,
and still pass the balance check; two crafted small transfers that cancel out were shown importing
real-looking income and expense with a green "pass") plus L1–L5 (masking-join over-exposure,
single-page currency check, no per-row amount cap, mask-after-cut, balance check over all parsed
rows instead of imported rows). Branch rebased onto `main@aa10304`; judged `git diff main...HEAD`
and `git show bd0449c` (the cycle-2 commit) directly, since `e01a917..bd0449c` crosses the rebase
and is not meaningful.

**Fixes verified present and effective:**

- **M1 fix** — `bca.ts` no longer treats "the first amount-shaped line in a row" as the amount.
  `amountLine()` requires *exactly one* amount-shaped line among a row's collected text; a second
  one (a forged remark) makes the row `unparseable_amount`, never a guess. On top of that, the
  parser now demands the statement be internally consistent before accepting anything:
  every printed running balance, the printed opening/closing balances, and the `MUTASI CR/DB`
  totals-and-counts must match the computed rows exactly (`consistent()`); any mismatch sets
  `inconsistent: true` and the whole statement is refused (`STATEMENT_INCONSISTENT`, 400), never
  imported with only a warning. Verified: the exact red-team two-transfer reproduction now yields
  `['unparseable_amount','unparseable_amount']` and `inconsistent: true`
  (`bca.test.ts` "two remark-forged transfers that cancel out never import and never pass"); the
  three related variants from the report (merchant name ending in an amount, a remark starting
  `DD/MM`, a remark line containing literal `SALDO AKHIR :`) are each covered and each refused.
  End-to-end: `test/integration/impor-statements.test.ts` "the /impor actions refuse an
  inconsistent BCA statement with 400 and the 'does not match' message" posts the forged PDF
  through the real `previewStatement`/`importStatement` actions and gets 400 with the uniform
  message; zero rows are ever written.
- **L1 fix** (masking over-exposure) — wrapped lines now join with a single space (not `", "`),
  so a card number split across lines masks as one run: `bca.test.ts` "wrapped lines join with a
  space, so a card number split across lines is masked whole" → `••••3456`, not two separately
  masked halves.
- **L2 fix** (currency checked per page) — `CURRENCY` is now matched in `segment()` across every
  page into a `Set`; more than one distinct value (including a non-`IDR` value on a later page, or
  a disagreeing spelling like `RUPIAH` vs `IDR`) rejects every row as `unsupported_currency`.
  Verified: `bca.test.ts` "a non-IDR account is never read as rupiah — on any page, not just the
  first" plants `MATA UANG : USD`/`RUPIAH` on page 2/3 and confirms rejection.
- **L3 fix** (amount cap) — `MAX_AMOUNT_MINOR` (10^13) moved to the shared `money-parse.ts` and is
  now enforced inside `statementRow` (`rows.ts`), so a statement amount above the cap is
  `unparseable_amount`, consistent with manual entry's own cap and keeping `balanceCheck`'s JS sums
  inside `Number.isSafeInteger`. Verified: `rows.test.ts` boundary cases
  (`100.000.000.000,00` → ok at the cap, `...,01` → rejected, `90,071,992,547,409.91` → rejected)
  and `bca.test.ts` "an amount past the one-transaction cap is unreadable, never summed".
- **L4 fix** (mask before cut) — `statement-import.ts`'s `masked()` now cleans, masks, then cuts to
  `NOTE_MAX_LENGTH`, instead of cutting first. Verified end-to-end:
  `test/integration/impor-statements.test.ts` "red team L4: a long description is masked before it
  is cut, so no card-number prefix survives" builds a title where the real card number straddles
  the title length cap and confirms no 5+ digit run and a masked suffix survive in the stored row.
- **L5 fix** (balance check scope) — `read.ts` now runs `balanceCheck` over only the rows actually
  imported (`rows.slice(0, CSV_MAX_ROWS)`), not every parsed row, so a file cut at the row cap
  reports its real gap instead of a false "pass". Verified:
  `src/lib/server/statements/read.test.ts` "red team L5: the balance check covers only the rows
  imported, so a cut file never shows 'pass'" — `CSV_MAX_ROWS + 1` rows yields `notProcessed: 1`
  and `balance: { status: 'gap', gapMinor: 100 }`, not a pass.

**Regression / unaffected-criteria re-check:**

- Other institutions and FN-18 CSV/XLSX import are unaffected: the full Vitest suite (which
  includes `fictional-bank` CSV/PDF fixtures, FN-18's own CSV mapper tests, and `detect.test.ts`'s
  "ships only institutions proven by a real sample" assertion still listing just `['bca']`) passes
  in full (see Commands). `statementRow`/`balanceCheck` in `rows.ts` are shared by every future
  institution parser, not BCA-specific, and their only behavioural change (the amount cap) is
  additive and covered by `rows.test.ts`.
- The synthetic BCA fixture (`test/fixtures/statements/bca.ts`) and all new/changed tests remain
  fully fictional (`CONTOH FIKTIF`, `PENGIRIM`, invented account digits) — re-grepped the cycle-2
  diff, nothing resembling real data.
- Cross-space authorization, dedupe, undo and `source='statement'`/masking plumbing: unaffected by
  this diff's scope (no route/action authorization logic changed beyond wiring one new refusal
  reason through the existing uniform `STATEMENT_REFUSALS` table), re-confirmed passing via the
  full BCA integration describe block (all 6 its, including the original dedupe/undo journey).
- Real owner file (`.superpowers/ref/samples/statements/bca/bca-2026-09.pdf`, accessed only via
  `FIN_SAMPLES_DIR=<main repo> npm run compat:statements`, never copied): still detected
  `bca`/`pdf_text`, 1 page, **9 rows parsed, 0 rejected, balance check pass (Rp0 gap)** — the
  stricter cycle-2 self-consistency check does not break the real statement; it still reconciles
  exactly under the new, stronger rules. No account number, description or filename beyond the
  institution folder printed.
- Full `e2e/impor.spec.ts` (unchanged by the cycle-2 commit) re-run end to end: **17/17 passed**
  (phone + desktop), including the BCA import/dedupe/undo journey and the scanned/unknown-bank
  refusal journeys, confirming the UI-level behaviour the fixes sit underneath is undisturbed.

**Cycle 2 commands run:**

- `flock … npm run check` → `COMPLETED 1768 FILES 0 ERRORS 0 WARNINGS`, exit 0.
- `flock … npm run lint` → prettier clean, eslint silent, exit 0.
- `flock … npx vitest run --maxWorkers=2 src/lib/shared/statements src/lib/server/statements test/integration/impor-statements.test.ts src/lib/server/transactions/validation.test.ts` → `Test Files 7 passed (7)`, `Tests 137 passed (137)`, exit 0.
- `flock … npx vitest run --maxWorkers=2` (full suite) → `Test Files 212 passed (212)`, `Tests 3063 passed (3063)`, exit 0.
- `flock … npm run build` → succeeded, service worker + adapter-cloudflare bundle built, exit 0.
- `FIN_SAMPLES_DIR=<main repo>/.superpowers/ref/samples flock … npm run compat:statements` → real owner PDF: `bca pdf_text 1 9 0 pass (Rp0 gap)`, exit 0 — real provider file, counts/pass-fail only.
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=5461 npx playwright test e2e/impor.spec.ts --workers=1` → `17 passed (37.5s)`, exit 0.
- `npm run clean:tmp` → removed stale miniflare directories; no lingering wrangler/workerd process for this project afterward.

**Cycle 2 findings:** none outstanding. All 1 medium + 5 low red-team findings (M1, L1–L5) have a
verified, tested fix; no new issue found in the cycle-2 diff; no ENGINEERING_CHECKLIST.md
violation in the changed files.
