# FN-16e Mandiri consolidated e-statement parser — QA report

**Verdict: PASS**

Reviewed `git diff main...HEAD` (head `60874ca`, "wip(fn-16e): cycle 3") in the worktree
`.claude/worktrees/fn-16e-mandiri`. No production code was changed; this report and no test file were added (every
criterion already has a covering test — see below).

Spec used: `docs/features/fn-16a-statement-parsers/PRD.md` (the shared parser contract) plus the FN-16e specifics
given in the task (consolidated statement with several accounts, section picker, duplicate-account/cut-section/
two-letterhead refusal, hand-picked-bank mismatch). Security history reviewed:
`docs/features/fn-16e-mandiri-parser/SECURITY_REPORT.md` (cycle 2 PASS, M1/L1/L2 fixed, L3 open) and the cycle-3
diff (`git diff 579ca18..60874ca`) which fixes L3 (`institution_conflict`).

## Commands run

1. `cd .claude/worktrees/fn-16e-mandiri && flock /tmp/montra-heavy.lock npm run check` — `svelte-check`: 1826 files,
   0 errors, 0 warnings; `tsc` (service worker, workers/jobs, workers/inbound) clean. Exit 0. Real toolchain, no
   mocks.
2. `flock /tmp/montra-heavy.lock npm run lint` — `prettier --check .`: "All matched files use Prettier code style!";
   `eslint .`: no output (clean). Exit 0.
3. `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2` (full repo suite, local D1/workerd, no external
   provider) — **Test Files 1 failed | 226 passed (227)**, **Tests 1 failed | 3302 passed (3303)**, 234.14 s. The
   one failure, `test/integration/account-keys.test.ts > password-proving account actions are throttled (red team
   L3) > per user: the 21st attempt from rotating addresses answers 429`, is unrelated to this diff (not in
   `git diff --stat`, a rate-limit timing test). Re-run in isolation: `flock /tmp/montra-heavy.lock npx vitest run
   --maxWorkers=2 test/integration/account-keys.test.ts` → **42 passed (42)**, confirming a load-induced flake (this
   host was running concurrent, unrelated vitest/Playwright jobs from other project worktrees throughout this QA
   session), not a regression. Every Mandiri-specific test file (`src/lib/shared/statements/mandiri.test.ts`,
   `src/lib/server/statements/read.test.ts`, `src/lib/shared/statements/detect.test.ts`, `scripts/compat-statements
   .test.ts`, `src/lib/server/statements/validation.test.ts`, `test/integration/impor-statements.test.ts`) passed in
   the full run.
4. `flock /tmp/montra-heavy.lock npm run build` — `vite build` + prerender + service worker build: "✓ built in
   1.30s" (client+server), "✓ built in 23ms" (service worker), adapter-cloudflare "18 prerendered site files
   bundled into the Worker". Exit 0.
5. `LD_LIBRARY_PATH=<chromium-libs> flock
   /tmp/montra-heavy.lock npx playwright test e2e/impor.spec.ts --workers=1` — **23 passed (47.0s)**, phone and
   desktop viewports, real Chromium (mocked AI/no external provider; local D1/workerd dev server). Includes the new
   test "statement upload: a Mandiri consolidated statement asks which account, then imports that one" on both
   viewports.
6. `flock /tmp/montra-heavy.lock npm run compat:statements -- --samples=<repo>
   ref/samples` — real, owner-provided redacted samples (fixture/real-provider boundary: real sample files, no
   external network/service call). Printed matrix (counts only, reproduced verbatim, nothing beyond this was
   printed or opened):
   ```
   #  folder   format    institution  pages  rows parsed  rows rejected (reasons)       balance check
   1  bca      pdf_text  bca          1      9            0                             pass (Rp0 gap)
   2  bni      pdf_text  bni          12     170          0                             pass (Rp0 gap)
   3  csv-1    csv       bca          —      8            0                             pass (Rp0 gap)
   4  mandiri  pdf_text  mandiri      3      29           0                             pass (Rp0 gap)
   5  ocbc     pdf_text  unknown      4      —            — (institution not detected)  —
   No receipt samples in .../receipts.
   ```
   The real Mandiri sample is read cleanly (29 rows, 0 rejected, balance pass, Rp0 gap) — **the cycle-3 L3 fix
   (institution_conflict) does not block a genuine file.** No migration was added by this diff (`git diff --stat`
   touches no `migrations/`), so `db:migrate:local` was not run.

## Checked criteria (FN-16a PRD + FN-16e specifics)

- **Picker, one account** — a single-section Mandiri file imports directly with no picker shown (inherited FN-16a
  path): covered by `mandiri.test.ts` and the real `mandiri` sample above (no picker needed, 29 rows straight
  through).
- **Picker, several accounts** — `test/integration/impor-statements.test.ts` ("reads, reconciles and imports
  through the shared path", ~line 1150): no pick → `section_required`; pick index 1 → imports only that section's 2
  rows into the chosen wallet; pick index 0 after → imports its own 4 rows into a different wallet; dedupe keys are
  file-unique (`0..5`) across both sections. PASS. UI: `e2e/impor.spec.ts:373` picks "Giro Fiktif ••6667" from a
  2-radio `role=group` picker, previews ("Rekening: Giro Fiktif ••6667", "Saldo cocok") and imports; the account
  label the UI shows an unmasked product name plus only the last 4 digits (`accountLast4`), never the full number.
  PASS.
- **Disabled/refused sections are disabled, not relied on client-side** — `src/lib/server/statements/read.ts`
  `pickSection` re-validates the picked index server-side against the re-parsed bytes (`section_unknown`,
  `section_unsupported`, or `inconsistent` for a section that itself fails its own balance check), independent of
  the UI's `disabled` radio attribute. Confirmed by `impor-statements.test.ts` ("an unknown, unsupported or
  inconsistent account is refused before any write"). PASS.
- **Duplicate account number across sections, or a section cut by remark text, refuses the whole file** —
  `mandiri.ts` `parsePdf`: `structure = false` on a duplicate account or a label-ended section that fails its own
  check, giving `StatementParse.inconsistent = true` at the whole-document level before any section is even
  offered. `mandiri.test.ts` lines 184-227 and the M1 regression suite ("remark text equal to an account-block
  label never opens an importable section", `impor-statements.test.ts`) exercise this with both "same account" and
  "new account" forgeries, both refusing the whole file with zero rows/batches written. PASS.
- **Two banks' letterheads in one file (`institution_conflict`)** — cycle-3 fix in `detect.ts`
  (`letterheadClaims`)/`read.ts`. Tested in `read.test.ts` ("two letterhead claims refuse the file, automatic or
  picked by hand"), `detect.test.ts` ("another bank's letterhead lines planted in remark text make two claims (and
  a detection tie)"), and end-to-end in `impor-statements.test.ts` ("another bank's letterhead lines in remark text
  refuse the file, never a pick") for both BNI-markers-in-Mandiri and Mandiri-markers-in-BNI, for `null`/`'bni'`/
  `'mandiri'` picks, through both `previewStatement` and `importStatement`, plus the full form-action path
  (`act('previewStatement')`) asserting the exact Indonesian message, `console.error` not called, and zero rows/
  batches. PASS.
- **Hand-picked bank differs from the one letterhead present → `institution_mismatch`** — `read.ts`: `claims.length
  === 1 && claims[0] !== parser` → mismatch. `read.test.ts` ("a hand pick of another parser is refused when the
  file carries one bank's letterhead") and `impor-statements.test.ts` (BNI file hand-picked as BCA now answers
  `institution_mismatch`, was `inconsistent` before the fix — the old BCA-misreads-BNI-text behaviour is gone).
  PASS.
- **Dedupe on re-import** — `impor-statements.test.ts` ~line 1196: the same section re-imported answers
  `{ imported: 0, already: 2 }`, `batchId: null`, never an error; dedupe key `statement:<sha256>:<row index>`
  (regex-checked). PASS.
- **Undo** — same test: `undoImportBatch` on each batch (one per section import) tombstones all its rows; `
  liveRows` empty after. One `db.batch`, identical to CSV/BCA/BNI undo (no fork per source). PASS.
- **Refusal messages in Indonesian and English** — every new message constant in `src/lib/server/imports/
  messages.ts` (`STATEMENT_INSTITUTION_CONFLICT`, `STATEMENT_SECTION_INVALID/REQUIRED/UNKNOWN/UNSUPPORTED`) has a
  matching entry in `src/lib/shared/i18n-en.ts`; `src/lib/shared/i18n.test.ts` runs in the full `npm run test` and
  passed (it fails the suite if an entry is missing). New UI strings ("Rekening dalam berkas ini", "{label}
  ••{last4}", "tidak bisa diimpor", "Rekening: {account}") likewise have English entries. PASS.
- **No account numbers beyond last 4 in UI/logs** — `read.ts` `choiceOf` masks the section label
  (`maskAccountNumbers(cleanText(...))`) and exposes only `accountLast4`; `statement-import.ts` `maskRow` masks
  title/notes/walletName before storage; the compat harness output above contains no account number, row text or
  filename beyond the folder name, confirmed by grepping the printed matrix against the real sample's institution/
  account strings and by `compat-statements.test.ts` ("a multi-account statement gets one line per account, counts
  only" — asserts the output never contains the fictional account number, "Tabungan", "FIKTIF" or the period
  string). PASS.
- **360 px no horizontal scroll, no-JS path** — `e2e/impor.spec.ts:373` calls `expectNoHorizontalScroll(page)` after
  the Mandiri picker flow (phone viewport project). The existing no-JS statement-refusal test
  (`e2e/impor.spec.ts:401`) exercises the shared `fail(400, …)` action path that `section_required`/
  `institution_conflict` also use; the radio picker itself is a plain HTML `<fieldset>`/`<input type=radio
  disabled>` that posts without JavaScript by construction, though no dedicated no-JS test drives the Mandiri
  picker specifically — noted as a minor coverage gap, not a functional risk (same `fail()` mechanism already
  proven to render without JS for every other statement refusal). PASS with note.
- **BCA/BNI/CSV still work** — all pre-existing BCA/BNI/CSV statement and CSV-import tests passed in the full
  vitest run and the full Playwright run (`e2e/impor.spec.ts` tests 2, 8-10 for BCA PDF, BCA CSV, BNI password
  flow). The compat harness confirms real BCA and BNI samples still parse cleanly (rows 9/170, 0 rejected, balance
  pass). PASS.
- **Cross-space authorization** — unchanged code path: `+page.server.ts` resolves `spaceId` through
  `currentSpaceScope(event.locals.user)` for both `previewStatement`/`importStatement` actions (not from a client
  field); `statement-import.ts`'s `fallbackWalletOf` checks the wallet against the resolved space before the file
  is even read. Pre-existing tests in `impor-statements.test.ts` ("another space's wallet is not found before the
  file is read; a removed member writes nothing", "cross-space: another space's wallet gets the uniform not-found")
  passed in the full run; this diff does not touch `currentSpaceScope`/`requireSpaceAccess`/wallet lookup, only adds
  the Mandiri parser and the section/letterhead refusal types threaded through the same calls. PASS (inherited,
  re-verified passing).
- **WIB dates / money integers** — `mandiri.ts` reads the full `DD Mon YYYY` (4-digit year) off every row directly
  (no year inference needed, unlike BCA's day/month-only format which uses the shared `dateInPeriod` helper in
  `rows.ts`), and rejects any row whose date falls outside the statement's own printed period
  (`mandiri.test.ts:165`, "refuses a date outside the printed period or an unknown month"). All amounts go through
  `parseMoneyAmount` (FN-14a) only, in integer minor units; the running-balance self-check in `consistent()`
  requires every intermediate balance and the final credit/debit/closing totals to match exactly
  (`Number.isSafeInteger` guard). No currency mixing: a non-IDR currency anywhere in a section refuses it
  (`unsupported_currency`). PASS.
- **Engineering checklist** — no new SQL/loaders/secrets/`{@html}`; `{#each statementSections as choice
  (choice.index)}` keys by stable index, never filename/description; touch targets ≥44 px (`.check { min-height:
  44px }`, confirmed in the diff); i18n entries present (above); no upload persistence (no R2/D1/log write of raw
  bytes or extracted text — `grep` of the diff shows only `transactions`/`import_batches` writes, same as cycle-2
  security review's "Uploads/PII" finding, unchanged). PASS.

## Findings

None blocking. One non-blocking note recorded above (no dedicated no-JS Playwright test for the Mandiri
multi-account picker specifically — the underlying mechanism is already proven no-JS-safe for every other statement
refusal on this page, so this is a coverage note, not a functional gap).

## Files touched by QA

None in `src`/`workers`/`migrations` (verification only). This report:
`docs/features/fn-16e-mandiri-parser/QA_REPORT.md`.
