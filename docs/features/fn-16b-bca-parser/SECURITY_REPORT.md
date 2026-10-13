# FN-16b BCA statement parser — security report

Scope: `git diff main...HEAD` at 821ab27 (read-only worktree `fn-16b-rt`): `src/lib/shared/statements/bca.ts`,
its registration in `parsers.ts`, tests and fixtures. The pipeline it plugs into (`statements/read.ts`,
`statement-import.ts`, `pdf-text.ts`, `money-parse.ts`, `text.ts`) was read for context only; findings there are
marked pre-existing.

## Verdict: FAIL

One medium finding (M1): text that a third party controls (transfer remark, sender or merchant name) can end a
row early, set its amount and direction, and pass the balance check.

## Findings

### M1 (medium): description text can forge a row's amount and direction, and the forgery passes the balance check

`src/lib/shared/statements/bca.ts:166-171` (and `:165`, `:132-141`, `:147-150`).

The parser treats the first line in an open row that ends in an amount as that row's amount line, using
`AMOUNT_TAIL`, which matches the end of any line. After that, `if (!open) continue` (`:165`) silently drops the
real amount line. In the documented layout (`bca.ts:13-15`, fixture rows `10/09 BI-FAST CR …` / `PT CONTOH FIKTIF`
/ amount), the wrapped description lines, including the sender name, the transfer remark (berita) and the
merchant name, come before the amount line. All three are chosen by someone other than the account holder.

Reproduction (in-memory parse with a synthetic page; the opening balance is 1,000,000.00 and the closing balance
1,000,020.00). The user received two transfers of Rp 10:

```
10/09 BI-FAST CR TRANSFER DR / PENGIRIM / 1,000,010.00 / 10.00 1,000,010.00
11/09 BI-FAST CR TRANSFER DR / PENGIRIM / 999,990.00 DB / 10.00 1,000,020.00
```

Result: income Rp 1.000.010 and expense Rp 999.990 are imported, and `balanceCheck` returns `{status:'pass'}`.
An attacker who sends small transfers with crafted remarks can make the errors cancel exactly. That puts invented
income and expense into the victim's ledger, budgets and reports, with a green reconciliation. This breaks
"money is never invented".

Related forms of the same problem:
- A merchant name ending in `d.dd`, such as `KEDAI 900.00`, closes a card-debit row with no `DB`. The expense
  becomes income, and the real `25,500.50 DB` line is dropped.
- A remark line starting with `DD/MM ` abandons the real row (`missing_amount`) and opens a forged one.
- A remark of exactly `SALDO AKHIR : x.xx` ends the table for the rest of the page (`inTable = false`). Those rows
  are dropped without a typed reject.

These cases show a gap, but a gap is only a warning (`impor/+page.svelte:363`). The import still goes ahead and
the preview lists counts, not rows.

Fix direction:
1. Check every printed running balance (the optional `SALDO` after the mutation, which is parsed but thrown away
   today) against opening + Σ rows so far, and reject the row when they differ.
2. Treat a second amount-tail line between a closed row and the next `DD/MM`, summary or page end as ambiguous,
   and reject the row instead of using the first match.
3. Accept `SALDO AWAL/AKHIR :` lines only outside an open row.

Add the two-transfer vector above as a fail-before test.

### L1 (low): the `", "` join weakens card and account masking when a number wraps across lines

`bca.ts:83-90`. A digit-to-digit wrap is joined with `, `, which `maskAccountNumbers`' `DIGIT_RUN` treats as a
break, so each piece is masked on its own:

- `1234 5678` / `9012 3456` becomes `••••5678, ••••3456` (8 of 16 digits shown).
- `123456789012` / `3456 1.00 DB` becomes `••••9012, 3456`.

With a single-space join the result would have been `••••3456`. The over-masking the comment guards against
(`DD/MM` merged into a card run) only hides more digits, which is safe. Fix: join with a space, or mask each line
before joining.

### L2 (low): currency is read once per file

`bca.ts:70-76,104`. Only the first `MATA UANG` line counts. A later page reading `MATA UANG : USD` is still
imported as IDR (verified). Fix: refuse the file when the pages disagree on period or currency.

### L3 (low, partly pre-existing): no upper bound on a statement amount

`rows.ts:57-68` via `bca.ts:113`. `90,071,992,547,409.91` is accepted as `amountMinor = 9007199254740991`. Manual
entry caps at `MAX_AMOUNT_MINOR` (10^13, `transactions/validation.ts:45`), but the statement path does not. The
sum in `balanceCheck` and the JS totals lose precision above 2^53, so a pass or gap can be computed wrongly. Fix:
reject rows above `MAX_AMOUNT_MINOR` in `statementRow`.

### L4 (low, pre-existing): titles are cut before masking

`statement-import.ts:48`. `cleanText` cuts the title before masking. A long wrapped BCA description can end on a
partial card number of fewer than 8 digits, and up to 7 leading digits stay visible. Fix: mask, then cut.

### L5 (low, informational): the balance check counts rows that are not imported

`read.ts:146,158`. `balanceCheck(parse)` runs on all parsed rows, but only `CSV_MAX_ROWS` are imported, so a
truncated file can still show "pass". `notProcessed` is reported, so this is informational.

## Checked, no issue

- **ReDoS:** `AMOUNT_TAIL`, `ROW_START` and the summary regexes are anchored or linear. Probes stayed fast:
  - a 1M-digit line: 0.7 ms
  - `1` + 200k×`,000`: 0.9 ms
  - 100k `1,000 ` tokens: 18 ms
  - 100k `1.00 DB` tokens: 32 ms
  - 100k rows: 0.5 s

  Input is bounded upstream (`PDF_MAX_TEXT_CHARS` 1M, 200 pages, 15 MB).
- **Zero, negative and sign:** zero is rejected (`unparseable_amount`) and no sign is accepted. Amounts above
  2^53 are rejected by `toMinor`.
- **Dates:** the date year comes from the printed period. A day outside the period or an impossible day becomes
  `unparseable_date` and is never moved. A fake later `PERIODE` line is ignored (first match wins).
- **Space scoping:** the parser has no space input. The space comes from `currentSpaceScope` on the server
  (`impor/+page.server.ts:127`), and the fallback wallet is checked against the space.
- **Dedupe:** the key is `statement:<sha256(bytes)[0:32]>:<index>`, and the index is stable for the same bytes. A
  crafted file cannot target another file's keys.
- **Text handling:** titles are cleaned and masked before storage (`statement-import.ts:48-60`). No `{@html}` in
  the diff.
- **Real data:** `.superpowers/` is git-ignored and not in the diff. The only long digit strings in the diff are
  `1234567890` and `1234567890123456` (synthetic). I did not open the real sample.

## Commands

- `flock … npx vitest run --maxWorkers=2 src/lib/shared/statements/` → `Test Files 3 passed (3)`,
  `Tests 40 passed (40)`.
- The scratch probe (`node --experimental-strip-types`, scratchpad only, no repo write) reproduced M1, L1, L2 and
  L3 and gave the ReDoS timings above.

## Cycle 2 (re-check of bd0449c)

### Verdict: PASS

No medium or high finding remains. The low findings below are tracked.

### Re-run of the cycle 1 findings

The same scratchpad probe was re-run against the new code. "Refused" means `inconsistent: true` or
`unsupported_currency`, which `readStatement` turns into a whole-file refusal before anything is written.

- **M1, fixed.**
  - Zero-gap remark pair (`1,000,010.00` / `999,990.00 DB` before the real amount lines): both rows become
    `unparseable_amount` (ambiguous), so the file is refused.
  - Merchant name ending `900.00`: ambiguous, refused.
  - A `DD/MM` remark that splits a row: the running balance and the `MUTASI` count no longer match, refused.
  - A remark `SALDO AKHIR : …`: `missing_amount`, and the printed closing balance now has two values, refused.
  - A remark that forges an amount and a matching running balance on one line: ambiguous, refused.
  - A row split across two pages: `missing_amount`, refused.
  - A duplicate balance line inside a row is a second amount-shaped line, so the row is ambiguous and the file
    refused.
- **L1, fixed.** Wrapped lines are joined with a space. `1234 5678` / `9012 3456` now becomes `••••3456`, and
  `123456789012` / `3456 …` becomes `••••3456`.
- **L2, fixed.** `MATA UANG : USD` on a later page refuses the whole file (`unsupported_currency`). Pages that
  disagree on the period make the file inconsistent.
- **L3, fixed.** Amounts above `MAX_AMOUNT_MINOR` are rejected in `statementRow`, and the running sum is checked
  with `isSafeInteger`.
- **L4, fixed.** Titles are masked before they are cut (`statement-import.ts:52`).
- **L5, fixed.** The balance check runs only over the imported rows (`read.ts:162`).

The `inconsistent` refusal does not hide anything silently. It is checked in `readStatement` before the rows are
used, so preview and import both stop with no write. The user sees `STATEMENT_INCONSISTENT` with HTTP 400 in the
statement section.

### New findings

**C2-L1 (low): a fake table header in a remark can move amounts between one sender's own rows**

`bca.ts:125-128`. A third-party line that reads exactly `TANGGAL KETERANGAN CBG MUTASI SALDO` sets `open = null`,
so the real amount line that follows is dropped silently, together with any running balance printed on it.

Reproduction: two Rp 10 transfers from the same sender, next to each other with no printed running balance
between them. The remarks are `5.00` + fake header and `15.00` + fake header. Result: income of Rp 5 and Rp 15,
`inconsistent: false`. Totals, counts and the closing balance still match.

Why it stays low:
- An attempt to flip a row's direction is refused, because the CR and DB counts break.
- Only the attacker's own rows can be changed, and the month's income total stays correct.
- A remark has to hold a 35-character header.

Fix: when a table header appears inside an open row, or a line ends in an amount while no row is open, mark the
file inconsistent.

**Resolution (2026-10-13): FIX.** `fix(import): BCA PDF refuses a forged table header; BCA CSV reads a lone quote, many commas or a bare = remark (FN-16b, FN-16c L1)`. A table line that ends in an amount while no row is open (what is left after a remark imitated the table header) now marks the statement inconsistent, so it is refused whole instead of dropping the real amount line. Real continuation pages are unaffected: their header comes after a complete row, and a row cut at a page end was already refused by the count check. Test: `bca.test.ts` "cycle 2 L1: a remark equal to the table header cannot move amounts between one sender’s rows". Not verified on a multi-page real BCA sample (none in `.superpowers/ref/samples/statements/`).

**C2-L2 (low): third-party text can block a statement from being imported**

A third party can put text in the victim's statement that makes the whole file refused. Examples are a remark
`UTANG 1.00`, `MATA UANG USD`, or `PERIODE : …`. The refusal is visible, not silent, and nothing is lost, but the
message ("Unduh ulang mutasinya…") will not help. Fix: name the row that failed (date and position only) so the
user can enter it by hand or use the AI read later.

**C2-L3 (informational): a file with no `MATA UANG` line is read as IDR**

`bca.ts:200-201,225`. BCA always prints this line, and the risk is limited to a hand-made file the user uploads
themselves.

**C2-L4 (informational): a cut number can still appear in a very long title**

`statement-import.ts:52`. The first cut is at `max*4` and happens before masking. Text that is almost entirely
long digit runs shrinks when masked, which can bring a fragment of under 8 digits from the cut edge into view.
A real BCA description is far shorter than `max*4`.

**Performance and ReDoS:** unchanged and linear. 66k rows parse in 395 ms. A 120k-token line parses in 17 ms.

**Real data:** the diff contains no real values. I did not open `.superpowers/`.

### Commands (cycle 2)

- `flock … npx vitest run --maxWorkers=2 src/lib/shared/statements/ src/lib/server/statements/read.test.ts` →
  `Test Files 4 passed (4)`, `Tests 59 passed (59)`.
- The scratchpad probe (`node --experimental-strip-types`, no repo write) gave the results above.
- Not run by me: the integration suite, e2e, and `compat:statements`.
