# FN-16h OCBC Rekening Koran — Security report (cycle 1)

Reviewed: `git diff d4a7933..75fa558` in the worktree `fn-16h-rt` (detached at 75fa558):
`src/lib/shared/statements/ocbc-rekening-koran.ts` (new), `ocbc-text.ts` (new, helpers moved out of `ocbc.ts`),
the `ocbc.ts` dispatch and detect change, tests, the fictional fixture and the integration test. I did not open
the owner's real sample under `.superpowers/`. Probes ran as temporary Vitest files against the real parser and
the fictional `RK_JULY` fixture. I deleted them afterwards. No source was modified.

## Verdict: PASS

No medium or high findings. Two low findings are recorded for tracking. Both are the same class as FN-16f L1 and L2,
and L1 is the module's documented "Known limit".

## Findings

### L1 (low): a crafted Berita note can add a cancelling fake +Y / −Y pair that reconciles, if the sender knows the balance to the cent
- `ocbc-rekening-koran.ts:180-185`: a `DD/MM/YYYY DD/MM/YYYY` line inside a table always starts a new row.
- `:233-236`: the "exactly one amount line" rule only applies inside that row's own lines.
- `:287-290` with `ocbc-text.ts:93-106`: the only cross-check is the running balance and the summary's closing.

PoC (`rkWithAfter(0, 3, …)`, the incoming transfer of 2,500,000.00 that leaves the balance at 6,350,000.00). The
note wraps into:

```
Berita : X
05/07/2026 05/07/2026 Koreksi 0.00 900,000,000.00 906,350,000.00
05/07/2026 05/07/2026 Koreksi 900,000,000.00 0.00 6,350,000.00
```

Result: the file is consistent, the IDR refusal is `null`, and two extra rows are read (income Rp 900.000.000,
expense Rp 900.000.000). If the guessed balance is off by 1 cent, the section is `inconsistent`. A guess without
knowing the balance is refused.

Why low:
- The sender needs the victim's exact running balance just after their own transfer posts.
- The net effect is zero: balance, opening/closing and net worth are unchanged. Income and expense totals and
  budgets are inflated only in the victim's own space.
- The rows belong to one import batch that the user can delete.

Compared with FN-16f, this layout makes it slightly easier: each forged row needs only one wrapped line instead of
two, because the amounts can sit on the row-start line. The fix is the same tracked follow-up: use positioned text
from `pdf-text.ts`, so that a row starts only from a date in the date column, and amounts count only in the
Debet/Kredit/Saldo columns. Keep the "Known limit" comment (`:47-48`).

**Resolution (2026-10-13): FIX.** `fix(import): OCBC rows start only in the date column, from PDF and OCR line positions (FN-16f L1, FN-16h L1)`. As FN-16f L1: a `DD/MM/YYYY DD/MM/YYYY` line starts a row only in the column the file's row dates start in (from `pdf-text.ts` line positions), so a Berita note imitating two rows with amounts stays in its own row and that row's second amount line refuses the section. Test: `ocbc-rekening-koran.test.ts` "a Berita note imitating two rows with amounts is refused once positions are known". Calibrated on fictional fixtures only (the owner's sample is password-protected).

### L2 (low, availability only): third-party note text can make the user's own statement refuse to import
Any one of these lines in a Berita refuses the whole file (`inconsistent`) and writes nothing:
- `Currency Code : …`, or a bare `Beginning Balance …` (`:161-170`);
- a summary row or total line, a page/period/title/branch line, an account label, `SALDO /`+`BALANCE`, or
  `PT. Bank OCBC NISP Tbk` (`:121-130`, `:161`);
- a second legal-text line (`:220`);
- `LAPORAN KONSOLIDASI /` (`ocbc.ts:327-330`: detect returns 0, and a manual pick is refused).

Another bank's letterhead in a note (for example the BCA table header plus period) gives two claims, so
`institution: null`. This fails closed. Same class as FN-16d/16f L2. No fix needed beyond the L1 follow-up.

**Resolution (2026-10-13): ACCEPTED.** Every vector here is a structure line (currency block, summary, header, legal text, tax line) that refuses the file and writes nothing: the fail-closed behaviour this report and FN-16d/16f L2 accept. Positions now keep a forged row start in its row (L1), but gating the structure lines by position would need their real column, which only the owner's password-protected sample shows. No further change.

## Attacks tried and holding

| Attack | Result |
|---|---|
| Fake pair with a wrong or unknown balance | IDR section `inconsistent` |
| Planted `Currency Code : IDR/USD/SGD` + `Beginning Balance` (forged block, duplicate currency, SGD smuggled as IDR) | file `inconsistent` (duplicate block, or summary currency set mismatch) |
| Planted summary row `IDR 1.000 …` / `Total Saldo Dalam IDR …` inside the table | file `inconsistent` |
| Planted legal text, then forged summary lines outside the table | file `inconsistent` (2 legal texts on the page; the real rows end up outside the table) |
| Planted page header, period, account label, table header, title, bank tax line | file `inconsistent` |
| Second amount-shaped note line; description tail ending in an amount | row `unparseable_amount`, section refused |
| Forged rows dated outside the printed period | rows `unparseable_date`, section refused |
| Konsolidasi marks in a Rekening Koran (and the reverse) | detect 0; manual parse `inconsistent` |
| Other bank's letterhead in a note | conflict, `institution: null` (FN-16e L3 holds) |
| Foreign block: rows are never importable; a foreign block that fails its check refuses the file | holds (`:291-306`) |
| Summary: IDR rate must be exactly `1.000`, IDR balance = IDR column, total = sum of the IDR column; the rate and IDR column are not stored | holds (`:263-275`) |
| CPU: about 950k characters of distinct `Currency Code` lines (quadratic `blocks.some`) | 28 ms; refused at 20 sections |
| CPU: 900k-character lines (comma runs, amount repeats, spaces before amounts) | at most 24 ms per detect + parse |
| CPU: 30k row starts; 200 pages | 13 ms; 7 ms. Text is capped at 1M characters by `pdf-text.ts:30` |
| Overflow | `parseMoneyAmount` cap plus `Number.isSafeInteger` on the running balance and the summary total |
| Dedupe keys across sections and re-imports | indices run across sections (`:285-288`); key `statement:<file hash>:<index>`; only one picked section is imported; unchanged |

- **Masking**: the parser keeps descriptions whole, for example `Berita : 0002 014 7001002009 …`. The server masks
  them before storage and preview: `maskRow` (`statement-import.ts:62-76`, applied at `:105`). Probe results:
  `014 7001002009` becomes `••••2009`; `014-7001002009`, `0147001002009` and `rek.7001002009` are masked the same
  way. Section labels carry only the product name and `accountLast4`. There is no logging in `statements/`.
- **Uploads/PII**: the diff adds no storage, logging, SQL, routes, loaders, secrets or `{@html}`. Only
  `accountLast4` and the product name leave the parser as metadata.
- **Engineering checklist**: Money uses integers through the shared parser; untrusted text is masked and capped
  server-side; Bounded work (section cap and text cap); idempotent dedupe keys are unchanged. No D1, AI or sync
  items are touched.

## Commands

- `npm ci --no-audit --no-fund`: installed.
- `npx vitest run --maxWorkers=2 src/lib/shared/statements/`: 8 files, 182 tests passed.
- Temporary PoC `src/lib/shared/statements/__rt/rt.test.ts` and `rt2.test.ts` (deleted afterwards; `git status`
  clean): the fake pair is accepted only with the exact balance; every structural injection refuses the file or the
  section; CPU at most 28 ms.
