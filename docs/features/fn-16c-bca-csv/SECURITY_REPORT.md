# FN-16c BCA mutation CSV — Security report (cycle 1)

Reviewed: `git diff main...HEAD` at 41c9436 (read-only worktree `fn-16c-rt`). Scope: `src/lib/shared/statements/bca-csv.ts`,
`bca.ts` wiring, fixtures, unit/integration/e2e tests. Path traced: `/impor` action → `statement-import.ts prepare()` →
`read.ts readStatement()` → `parseCsv` (FN-18) → `BCA.detect/parse` → `maskRow` → FN-18 import core. The owner's real
sample (`.superpowers/`) was not opened; the fixture is synthetic (invented names, numbers, amounts).

## Verdict: PASS

No medium or high findings. Three low findings, tracked below.

## What was attacked (all held)

Probed by running the parser against crafted files (scratch script, `parseCsv` + `parseBcaCsv`):

| Attack | Result |
|---|---|
| Amount-shaped text + `CR`/`DB` + commas in a description (`A,999.00,CR,5000.00,x`) | Read from the right end: text only widens the description; amount/mark/balance stay the bank's columns. |
| Quote opened in one remark and closed in a later one (merges records, hides rows) | Hidden rows break the `Kredit`/`Debet` totals and the chain → `inconsistent`, nothing imported. |
| Raw line break in a remark forging a full row | The split-off head becomes a stray record or adds a non-zero amount → totals mismatch → refused. |
| Two rows whose errors cancel (150 CR + 50 CR vs real 100 CR) | Per-row running balance check fails → refused. |
| `=` as the first description cell (fake label record) | Unknown label → stray → refused. |
| Separator switching (`;` rows under a comma header) | Delimiter comes from line 1 (the bank's `No. Rekening` line); rows do not split → refused. |
| CRLF line ends, BOM, lower-case `cr`, fullwidth digits | CRLF/BOM accepted; mark upper-cased; fullwidth digits → `unparseable_amount` → refused. |
| Second `Mata Uang` (USD) / no currency / non-IDR | Footer-area label → stray; header non-IDR → every row `unsupported_currency`; none → refused. |
| `PEND` rows, impossible calendar dates, rows after the footer, repeated footer labels | Refused whole. |
| Huge input | 15 MB request cap, ≤5000 records, ≤50 columns; the amount regex is length-bounded first; all passes linear. A file cut at 5000 records loses its footer → refused. |
| Overflow | Amounts capped by `MAX_AMOUNT_MINOR`; balances beyond 2^53 → null; running/total sums checked with `isSafeInteger`. |
| Writes before refusal | `readStatement` returns `inconsistent` before any D1 call; preview writes nothing; import is one `db.batch`. |
| Masking / PII | Account number and name never enter a row; descriptions pass `maskRow` (card number → `••••3456`, asserted in the integration test); the log test asserts no fixture text or number reaches logs. |
| CSV re-export formula injection | Description is stored as `title`; export `csvCell` → `guardFormula` prefixes `=`, `+`, `-`, `@`, tab/CR/LF, fullwidth forms, also behind leading `'` (unchanged FN-18 code). |
| Detection confusion | The column row is required (0.6, 0.9 with header labels); FN-18 template / Money Manager headers do not match it; another bank sharing the header is still refused unless it chains. |

## Findings

### L1 — A third-party remark can make a statement unimportable (availability) — low
`src/lib/shared/csv.ts:120-127` (quote opens only at cell start) with `src/lib/shared/statements/bca-csv.ts:107-123`.
Assuming BCA writes remarks unquoted (as the parser's doc comment does), a sender who puts `x,"` (no closing quote),
more than 44 commas, or `=` as the first word in a transfer's remark makes the victim's whole month refused
(`unterminated_quote`, `too_many_columns` or `inconsistent`). Nothing is forged and the refusal is shown, but the user
cannot import that CSV (the PDF path is still available). Repro: description cell `x,"A` → `csv-refused unterminated_quote`.
Suggest: once a real export with such a remark is seen, decide whether BCA quotes; if it does not, read rows by line
for this institution so a literal `"` stays text.

**Resolution (2026-10-13): FIX.** `fix(import): BCA PDF refuses a forged table header; BCA CSV reads a lone quote, many commas or a bare = remark (FN-16b, FN-16c L1)`. (1) A record whose first cell is a date is always a row, so a remark that is just `=` no longer reads as a label. (2) A statement CSV whose quotes do not pair up is read again with `"` as plain text (`parseCsv` `literalQuotes`), and the bank parser's self-checks still decide; a file that parsed before reads exactly as before. (3) Statement CSV records may be up to 200 columns wide, so a remark's commas only widen its description. Tests: `read.test.ts` "a lone quote, many commas or `=` in a remark still reads the month, with the remark as text" and "read as text, a remark still never decides an amount: a mismatch refuses the file whole", `bca-csv.test.ts` "red team L1: a remark that is just `=` stays a row of its own, never a label", `csv.test.ts` "literalQuotes reads a `\"` as text …".

### L2 — Remaining integrity window is limited to the sender's own row's date/description — low
`bca-csv.ts:119-147`. If the bank ever emits a raw line break and an unescaped quote in a remark, a sender who also
knows the victim's running balance could rewrite the date and description of their own transfer row (amounts and
directions cannot change: every forged non-zero row breaks the footer totals, every hidden row breaks the chain).
No money effect; recorded so the assumption "remarks have no line breaks" is checked against a real export.

### L3 — Re-downloaded or cross-format statements are only flagged, not blocked, as duplicates — low (pre-existing design)
`src/lib/server/statements/statement-import.ts:73-91`. The dedupe key is `statement:<sha256 of the bytes>:<index>`.
The same month downloaded twice (any byte difference), or imported once as PDF and once as CSV, gets new keys; the
rows are shown as "Mungkin duplikat" but imported if the user proceeds. Same behaviour as FN-16a/b; no attacker gain.

**Resolution (2026-10-13): ACCEPTED.** This report calls it pre-existing design with no attacker gain. Blocking instead of flagging would also drop real repeated transactions (two identical same-day payments in the PDF and the CSV of one month cannot be told apart by content), so the user keeps the decision: rows are shown as "Mungkin duplikat" and the import can skip them. No change.

### Note (no finding)
`bca-csv.ts:151-156`: the non-IDR result omits `inconsistent: true`; it still imports nothing (`prepare()` answers
`no_rows`), but the user sees "no rows" rather than "unsupported currency" consistently with the PDF path.

## Engineering checklist
Money through the shared parser, integer minor units, no floats: yes. Untrusted text cleaned, capped and masked before
storage: yes (`maskRow`). Shared parser in `src/lib/shared`: yes. No upload persistence (no R2/D1/log write of bytes or
text in the diff): yes. CSV export guard: unchanged and applies. Bounded queries: no new queries.

## Commands
- `flock … npx vitest run --maxWorkers=2 src/lib/shared/statements test/integration/impor-statements.test.ts` →
  Test Files 5 passed (5), Tests 89 passed (89).
- Attack probe script (scratchpad, Node 24 `--experimental-strip-types`) → results as in the table above.
