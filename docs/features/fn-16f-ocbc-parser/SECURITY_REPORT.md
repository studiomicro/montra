# FN-16f OCBC parser — Security report (cycle 1)

Reviewed: `git diff main...HEAD` in the read-only worktree `fn-16f-rt` (detached at e5372b5): `src/lib/shared/statements/ocbc.ts`,
its tests, the fixture, the `parsers.ts` registration, `detect.test.ts`, the integration and e2e additions. I did not
open the owner's real samples (`.superpowers/`). Probes ran from the session scratchpad against the real parser, using
a copy of the fictional fixture. No source was modified.

## Verdict: PASS

No medium or high findings. Two low findings are recorded for tracking. L1 is the engineer's documented gap: I proved
it with a PoC and rated its severity below.

## Findings

### L1 (low): a crafted remark can add a cancelling fake +Y / −Y pair that reconciles, but only if the sender knows the balance to the cent
`src/lib/shared/statements/ocbc.ts:207-210`: a `ROW_START` line inside a table always starts a new row.
`:284-288`: only the row's own lines are checked for a second amount line. `:313-322`: the only cross-check is the
running balance (OCBC prints no row numbers and no totals).

PoC (scratchpad `poc.ts`, `OCBC_SINGLE` with opening 2,000,000.00): the attacker sends Rp 10.00 on 02-Jul with a
remark that the text layer wraps into these lines:

```
- PENGIRIM JAHAT/
0.00 900,000,000.00 902,000,000.00
02-Jul-2026 02-Jul-2026 Koreksi
900,000,000.00 0.00 2,000,000.00
02-Jul-2026 02-Jul-2026 Transfer Masuk Fiktif/
```

Result: the file is not `inconsistent`, the section's refusal is `null`, and three rows are read: income
Rp 900.000.000, expense Rp 900.000.000, then the real income Rp 10. The balance check passes. Off by one cent in
the guessed balance, the section is refused (`inconsistent`).

Why this is low and not medium (unlike BCA M1, which needed no secret):
- The attacker needs the victim's exact running balance, to the cent, just before their own transfer posts. That
  includes every earlier posting that day. Someone who only sends a transfer never sees this.
- The remark must be about 5 lines (about 120 or more characters) and must wrap exactly at the attacker's
  boundaries in the bank's PDF.
- The net effect is zero. Balance, opening/closing and net worth are unchanged. Income and expense totals, and
  possibly budgets, are inflated by Y in the victim's own space only. The rows sit in one import batch and can be
  removed with it.
- Aggravating: the preview shows counts only (`statement-import.ts:132-134`), so the user sees "+2 rows", not the
  amounts, before importing.

Narrowest robust fix (follow-up, not a cycle blocker): use positioned text from `pdf-text.ts` (x of each text item).
A row is started only by a date token in the Trans Date column, and an amount line counts only when its numbers sit
in the Debet/Kredit/Saldo columns. Remark text is always in the Description column, so it can never become
structure. Content heuristics do not close it: refusing an adjacent equal opposite pair is beaten by +Y / −a / −b,
and it would refuse genuine reversals. An interim option, if wanted: refuse a section in which any row's amount
exceeds the account's largest |opening|, |closing| or printed balance by a large factor. This is weak and I do not
recommend it as the fix. Keep the "Known limit" comment (`ocbc.ts:44-47`) and track the follow-up in TASKS.

**Resolution (2026-10-13): FIX.** `fix(import): OCBC rows start only in the date column, from PDF and OCR line positions (FN-16f L1, FN-16h L1)`. `pdf-text.ts` now returns each page's width and the left edge of every text line (`layout`; OCR passes its word boxes the same way). A `DD-Mon-YYYY DD-Mon-YYYY` line starts a row only within 2% of the page width of the leftmost row start in the file; a forged start in the description column stays in its own row, whose second amount line refuses the section. Without positions the text decides as before. Tests: `ocbc.test.ts` "red team L1: a remark wrapped into a cancelling +Y/−Y pair is refused once positions are known", `read.test.ts` "a remark wrapped into a cancelling pair is refused from the real PDF; the honest file still reads", `pdf-text.test.ts` "gives each page’s width and where each text line starts (FN-16f/16h red team L1)". Calibrated on fictional fixtures only: the owner's real sample is password-protected and its password is not available here.

### L2 (low, availability only): third-party remark text can make the user's own statement refuse to import
Same class as FN-16d L2. Any one of these lines in a remark makes the section or the file refuse to import, and
writes nothing:
- a bare `DD-Mon-YYYY DD-Mon-YYYY` line;
- `Saldo Akhir …`;
- a footer line followed by a forged header;
- a footer line followed by a `Tanggal …` period line.

Repro: `ocbcWithLastRemarks(['31-Jul-2026 31-Jul-2026'])` gives section `inconsistent`.

Fix: none needed beyond the L1 follow-up. Positioned text would remove it as well.

**Resolution (2026-10-13): partly FIX, rest ACCEPTED.** With positions (see L1), a bare `DD-Mon-YYYY DD-Mon-YYYY` remark line no longer refuses the statement (test `ocbc.test.ts` "red team L2: a bare date pair in a remark no longer refuses the statement once positions are known"). `Saldo Akhir`, footer and header text in a remark still refuse: that is the fail-closed structure check this report accepts, and the real column of those lines is not known without the owner's sample, so gating them by position could refuse real statements.

## Attacks tried and holding (probe `poc2.ts`)

| Attack | Result |
|---|---|
| Fake pair with a wrong balance guess | section `inconsistent` |
| Footer in remark + same-account header reopen + row start | section `inconsistent` (the real row is cut) |
| Footer + forged header for the listed Giro with its own `Saldo Awal`, absorbing the rest | file `inconsistent` (account seen twice) |
| Footer + forged period line | file `inconsistent` (two periods) |
| `Saldo Akhir` in remark | file `inconsistent` (real amount line outside a table) |
| Header lines (`Mata Uang`, `No Rekening`, `Saldo /`+`Balance`, `REKENING …`) inside a table | file `inconsistent` |
| Fake pair dated outside the period | section `inconsistent` |
| Second amount-shaped remark line / description tail ending in an amount | row unreadable, section refused |
| OCBC letterhead planted in another bank's remarks (and the reverse) | two claims, so `institution_conflict` (`read.ts:200-201`); the FN-16e L3 fix holds |
| USD sub-account, unlisted account, deposit | refused (`unsupported_currency` / `not_transaction_account`) |
| ReDoS: 5k–80k character remark lines (digits, comma groups, amount repeats) | at most 11 ms per parse + detect; text is capped at 1M characters by `pdf-text.ts` |
| Overflow | `parseMoneyAmount` cap plus `Number.isSafeInteger` on the running balance |

- Uploads/PII: the diff adds no storage or logging of file content. Only `accountLast4` leaves the parser. No new
  SQL, loaders, routes, secrets or `{@html}`.
- Section pick, membership and space scoping are unchanged (`read.ts` and the `/impor` actions are not in the diff).
- Engineering checklist: no items affected beyond the above. The e2e test only uses fictional fixtures.

## Commands

- `flock /tmp/montra-heavy.lock node …/vitest.mjs run --maxWorkers=2 src/lib/shared/statements/`: 7 files, 145
  tests passed.
- `node scratchpad/poc.ts`: the fake-pair PoC is accepted with the exact balance (`refusal=null`) and refused when
  the guess is off by one cent.
- `node scratchpad/poc2.ts`: every structural variant gives file or section `inconsistent`.
- `node scratchpad/redos.ts`: at most 11 ms on 80k-character lines.
