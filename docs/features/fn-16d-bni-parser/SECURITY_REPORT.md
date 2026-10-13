# FN-16d BNI parser — Security report

Reviewed: `git diff main...HEAD` at 9410e81 (read-only worktree `fn-16d-rt`), 2026-10-09. The owner's real sample
and its password (`.superpowers/`) were not opened.

## Verdict: PASS

No medium or high findings. Two low findings are tracked below.

## Findings

### L1 (low): `.pdf-password` lookup follows symlinks out of the samples folder
`scripts/compat-statements.ts:60-62`: `existsSync`, `statSync` and `readFileSync` all follow symlinks. If
`.superpowers/ref/samples/statements/x/.pdf-password` is a symlink to a regular file elsewhere (for example
`~/.ssh/id_ed25519`, which is under the 514-byte cap), that file is read and passed to PDF.js as a password. The
content is never printed (the output only says "wrong password"), and the folder is git-ignored and
owner-controlled, so there is no real exploit. But this breaks the brief's rule "never follow symlinks outside
the samples folder". Sample PDFs themselves are safe: `Dirent.isFile()` at :40 skips symlinks.
Repro: `ln -s ~/somefile samples/statements/a/.pdf-password` gives a read outside the folder.
Fix: use `lstatSync(path)` and refuse when `isSymbolicLink()`, or check that `realpathSync(path)` starts with
`realpathSync(samplesDir) + sep`.

### L2 (low, availability only): third-party text can make a user's own statement fail to import
`src/lib/shared/statements/bni.ts:204-210` and `:189-203`, and `detect` at :326-331. A transfer remark that wraps
onto its own line as `5 Jun 2026`, or that copies an amount tail, makes a row split or become ambiguous. A remark
matching BCA's table header and period lines makes BCA tie BNI at 0.9, so detection says "unknown". In both cases
the file is refused as a whole (or the user must pick the bank), and a wrong row is never imported. The
statement's owner then can't import that file. This is accepted fail-closed behaviour. Legitimate layouts are
also refused (a row split across pages, more than 200 pages, an overdraft balance), which is a usability issue,
not a security one.

**Resolution (2026-10-13): ACCEPTED.** The report records this as accepted fail-closed behaviour: a wrong row is never imported, the refusal is visible and nothing is written. Loosening the BNI row and detection rules to admit such text would reopen the forgery checks this parser depends on. No change.

## Attacks tried (probe script on the parser, plus review)
- Sign or amount forged through remark text: the anchored `AMOUNT_TAIL` takes only the end of the line. A second
  amount-shaped line makes the row ambiguous. A flipped sign breaks the running balance. All are refused
  (`inconsistent: true`).
- Fake `Saldo Awal/Akhir` lines are taken only between rows. A third opening, or a fake closing on any non-last
  page, gives 3 values, so `agreed()` returns null. A fake closing on the last page only drops rows that would then
  have to add up to 0 in and 0 out, which can't happen because zero amounts are rejected. Probe confirmed: the
  import is unchanged.
- Remark text building a whole fake row: the real row ends up `missing_amount` and the fake row is ambiguous.
  Refused.
- Duplicate or missing pages, and fake counters: each page needs exactly one `i dari N` with N equal to the number
  of read pages (more than 200 pages fails). Counters, the period and the currency are read above the table only,
  where no third-party text appears. Duplicate pages are refused.
- Cancelling errors: every row's printed balance is compared with the running total, and the in/out totals are
  compared separately. A swap that cancels out still breaks a balance on some row.
- Year and period: the New Year crossing is correct (2026-12-20 and 2027-01-02). A row outside the period becomes
  `unparseable_date`, and the file is refused. Mixed `Periode` values mean no period, and the file is refused.
- Currency: an IDR `Mata Uang` line is required, and any other currency rejects every row.
- Amounts go through the shared `parseMoneyAmount` (`1,234,567` gives 123456700 minor; values over the cap give
  null, so the row is rejected). `Number.isSafeInteger` guards the running sum.
- Parse time: 0.9 MB hostile lines run in 5–43 ms. The regexes are anchored with bounded quantifiers. Text is
  already capped by `pdf-text.ts` (1 M chars, 200 pages).
- Password: the app's `pdfPassword` path is unchanged. The integration test asserts the password is absent from
  results and logs. The compat script is in `scripts/` only and is not imported by `src/`. The password is never
  printed (tested), and dotfiles are not listed as samples.
- Masking and dedupe: the description is still cleaned and masked server-side (integration test asserts this). The
  dedupe key is `file hash + index`, which doesn't depend on the institution, so there is no new collision.
- `docs/ENGINEERING_CHECKLIST.md`: money goes through the shared parser, the parser lives in `src/lib/shared`,
  third-party text is treated as untrusted, and nothing in the diff persists an upload.

## Commands
- `flock … npx vitest run --maxWorkers=2 src/lib/shared/statements scripts/compat-statements.test.ts
  test/integration/impor-statements.test.ts` gave 6 files, 105 tests passed.
- Ad-hoc probe (`node probe.ts` in the session scratchpad) on synthetic pages, with results as listed above.
