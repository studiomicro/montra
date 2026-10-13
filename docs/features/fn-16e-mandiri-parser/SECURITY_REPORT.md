# FN-16e Mandiri parser — Security report (cycle 2)

Reviewed: `git diff main...HEAD` (main now has FN-16d BNI), focusing on `git diff 56a4b32..HEAD`, in the read-only
worktree `fn-16e-rt` (detached at d5aab58). I did not open the owner's real sample or password (`.superpowers/`).
Probe scripts were kept in the session scratchpad. Nothing in the repo was modified except this file.

## Verdict: PASS

M1 is fixed. L1 is fixed by main's `samplePassword`. L2 is covered by the duplicate-account refusal. One new
low finding (L3) is recorded for tracking.

## Cycle-1 findings, re-checked

### M1 (was medium): fixed
`src/lib/shared/statements/mandiri.ts:168-175` (a label inside a started row breaks the file; the label sets
`endedByLabel`), `:185` (a row-amount line outside a table breaks the file), `:372` (a section ended by a label must
check out), `:373-376` (an account printed twice breaks the file).

I re-ran the cycle-1 PoC and these variants against the new parser, using synthetic pages and calling
`MANDIRI.parse` directly:

| Variant | Result |
|---|---|
| Full PoC (remark before label), same account / new account | file `inconsistent` |
| Forgery starting the row (empty buffer at the label), positive real amount | file `inconsistent` (cut section fails to check out) |
| Same, real row `+0,00` | file `inconsistent` (real amount line is left outside any table) |
| Single `Nama/Name`, `Periode/Period`, `Nomor Rekening/Account Number`, at row start or mid-row | file `inconsistent` |
| Label, then `Keterangan`/`Remarks` with no block (the table reopens on the same section) | the real section imports unchanged; only the row's description loses the label text. No amount or structure change |
| Label, then `: USD`/`: IDR`, then reopen (currency-only pending) | the same section continues; the leftover pending currency could only make a later section refuse (fail closed) |
| Absorb attack: the forged table swallows the real row's amount/time/date as its own row (attacker knows the running balance) | a zero real row is unreadable (`statementRow` rejects 0), so the forged section is refused. A non-zero real row cuts the real section, so the file is refused |

Third-party remark text inside a table now has only two structural effects. A `DATE`-shaped line ends a row
early, which leaves an unreadable row and the section is refused. A block label ends the table, and every path
after that either refuses the file or leaves the bank's own rows and amounts as printed. The regression tests are
in `mandiri.test.ts` and `test/integration/impor-statements.test.ts` (the import is refused for both section
indices, and no rows or batches are written).

### L1 (was low): fixed
`scripts/compat-statements.ts:70-90`: `lstatSync().isFile()` rejects symlinks, `realpathSync` must equal
`<realpath(folder)>/.pdf-password`, the file is opened with `O_NOFOLLOW`, and `fstat` checks the size and file
type on the open fd.

### L2 (was low): covered
Two sections with the same account number now refuse the file (`mandiri.ts:373-376`). A forged section therefore
always shows a different last 4 from the real one. As the table above shows, it is also never offered next to an
intact real section.

## New findings

### L3 (low): remark text can force a detection tie; the user's manual pick is then trusted as the parser
`src/lib/shared/statements/detect.ts` `detectInstitution` (a tie returns unknown), `src/lib/server/statements/read.ts:196-200`
(a manual pick only checks the format). This was mostly there before this diff; adding a third PDF parser widens it.

BCA, BNI and Mandiri all top out at 0.9. The Mandiri score depends only on whole lines anywhere in the text layer
(`Keterangan`+`Remarks`, `e-Statement`, a line starting with `PT Bank Mandiri (Persero) Tbk.`), and so does BNI's
(`Laporan Mutasi Rekening`, its bank line, its table header).

Repro (probe script): add the three BNI lines as remark lines of one row in a genuine Mandiri file. The result of
`detectInstitution(..., [BCA, BNI, MANDIRI])` is `null` (tie), so /impor answers `institution_unknown` and asks the
user to pick. The reverse also works: Mandiri marker lines inside another bank's remarks cause a tie. If the user
then picks the wrong bank, that parser reads only the structure planted in the remark text. For example, a full
Mandiri block, table and row planted in a BNI file, closed by a `Nama/Name` line, gives a self-consistent,
importable forged section.

Exploiting this needs multi-line remark text that is extracted line-for-line, plus a user who picks a bank other
than their own. Low.

Fix: when two parsers tie at letterhead confidence (0.9), refuse the file as `inconsistent` (a genuine statement
never carries two banks' letterheads) instead of offering a manual pick. Or, on a manual pick, require that the
picked parser's own `detect` is at least `MIN_DETECT_CONFIDENCE` and that no other parser claims the letterhead.

## Checked and holding (unchanged from cycle 1 unless noted)

- **Section picker:** checked server-side and re-read from the uploaded bytes on every request. File-level
  `inconsistent` is checked before any pick. Out-of-range and refused sections are rejected. `disabled` in the UI
  is not relied on.
- **Rows:** the balance has exactly 2 decimals, so the `<saldo><No>` split is unambiguous. Row numbers 1…n, the
  running balance, the opening/closing balances and the in/out totals must match in integer minor units. A
  remark shaped like an amount or time line makes its row unreadable.
- **Currencies/products:** a non-IDR currency anywhere in the section refuses it. Only Tabungan and Giro are
  importable.
- **Caps/timing:** at most 20 sections. The regexes have no catastrophic backtracking (cycle-1 timing; the regexes
  have not changed since).
- **Uploads/PII:** this diff adds no storage or logging of file content. The PDF password is per-request only. The
  compat report prints counts only.
- **Rebase hygiene:** no conflict markers are left in `src`, `test`, `scripts` or `e2e` (`git grep` exit 1). The
  `parsers.ts` registry is `[BCA, BNI, MANDIRI]`.
- **Engineering checklist:** no new SQL, loaders, secrets or `{@html}`. English i18n entries are present.

## Commands

- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 src/lib/shared/statements/ src/lib/server/statements/validation.test.ts scripts/compat-statements.test.ts`:
  8 files, 125 tests passed.
- `node --experimental-strip-types` probe (scratchpad `c2/poc.ts`): every PoC variant gives a file
  `inconsistent` or an unchanged real section. The BNI-marker tie gives detection `null`.
- `git grep -cE '^(<<<<<<<|>>>>>>>|=======$)' -- src test scripts e2e`: exit 1 (no matches).
