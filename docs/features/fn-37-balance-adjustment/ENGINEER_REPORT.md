# FN-37 Balance adjustment — engineer report (cycle 1)

Branch `fn-37-balance-adjustment` (from `main` 1303a7a). Migration **0022** (FN-34 holds 0021).

## Acceptance criteria

| # | Status | How / evidence |
|---|--------|----------------|
| 1 | Met | `adjust` action on `/riwayat/baru`: Rp1.200.000 → Rp1.500.000 writes one `adjustment`/`increase` row of 30.000.000 minor units (IDR has 2 decimals, so the PRD's "300000" is Rp300.000 = 30_000_000 minor); `walletBalanceMinor` = 150_000_000. Test `1:` in `test/integration/balance-adjustment.test.ts`. |
| 2 | Met | Same, Rp900.000 → one `decrease` of 30_000_000; balance 90_000_000. Test `2:`. |
| 3 | Met | `adjustmentFor` returns `ADJUSTMENT_SAME` ("Saldo sudah sama, tidak ada perubahan.") for a zero difference; no row written. Test `3:` + unit tests. |
| 4 | Met | Every sum uses `MONEY_ROWS` (`t.type in ('expense','income')`) and `foldTotals` sums only expense/income. Test "every aggregate … unchanged" snapshots periodTotals (all/expense/income/wallet), day totals, dailyTotals, categoryTotals, monthlyTotals, categoryMonthlyTotals, `berandaSummary` (spent, diff, avg/day, safe-to-spend, bars, lines), `anggaranSummary`, `laporanReport` (keluar, masuk, tahunan), Catat lagi and the CSV export before/after five adjustments: identical. Test `4:` checks Beranda `spentMinor` = Riwayat header (Pengeluaran and Semua) with an adjustment in the month. **Fail-before proof:** with `main`'s `aggregate.ts` restored, tests "every aggregate…", `4:` and `7:` fail (adjustments counted as `outMinor`, e.g. 4_842_500_000 instead of 5_000_000). |
| 5 | Met | `wallet-sum.ts` `OWN_WALLET_DELTA` counts an adjustment ± by direction; same test shows the balance moved to exactly the stated value while every figure above stayed. |
| 6 | Met | `RiwayatView['type']` accepts `adjustment`; chip "Penyesuaian saldo" with `adjustmentCount`; header "N transaksi" (no money, like Transfer). Row: title defaults to "Penyesuaian saldo", meta "Saldo disesuaikan · BCA", amount signed +/− via `signedAmount`, never income-coloured, no category. Test `6:`, `row-text.test.ts`, e2e. |
| 7 | Met | Listed on its day; day header excludes it. Test `7:`. |
| 8 | Met | Edit page renders `AdjustmentForm` in edit mode (summary + title/note/date/time only); the `update` action for an adjustment uses `parseAdjustmentEdit` + `adjustmentEditInput`, ignoring any posted amount/type/wallet/category. Stale form → 409. An expense can never be edited into an adjustment (`FORM_TRANSACTION_TYPES`). Tests `8:` and "an expense can never be edited into an adjustment"; e2e. |
| 9 | Met | Unchanged `deleteTransaction`; `TOMBSTONE_CONTENT` and the tombstone CHECK clear `adjustment_direction`. Test `9:`. |
| 10 | Met | `frequentManualTransactions` uses `MONEY_ROWS`; `recordAgain` refuses any non expense/income row (`missing`). Tests in the "unchanged" snapshot (three identical adjustments) and `10:`. |
| 11 | Met | Load/actions go through `currentSpaceScope` (→ `requireSpaceAccess`); the wallet is looked up inside the space (`getWallet`); the insert is `insertTransactions` (live-member + `refsHold` + cap); `?wallet=` from another space is ignored. Test `11:` (member works, stranger and removed member get `WALLET_NOT_FOUND`/404, direct call with a removed member's scope writes nothing). |
| 12 | Met | Cap enforced by the shared guarded insert; answer `TRANSACTION_LIMIT`. Test `12:` (100.000 rows). |
| 13 | Met | Form default date is `wibTodayString()`; stored `occurred_on` is the form's WIB date, `occurred_at` from `wibInstantUtcMs`. Test `13:` at 2026-10-31T16:30Z (23:30 WIB) and 17:30Z (00:30 WIB 1 Nov). |
| 14 | Met | 16 new phrases in `i18n-en.ts`; `test/i18n-coverage.test.ts` passes; English row text asserted in `row-text.test.ts`. |
| 15 | Met | e2e `riwayat.spec.ts` "balance adjustment (FN-37) at 360 px": no horizontal scroll on the form, list and chip view; wallet select, "Saldo minus" label, submit and chip ≥ 44 px on the coarse-pointer (phone) project. |
| 16 | Met | `createBalanceAdjustment` reads the balance on the server (`readWalletBalance`, same SQL as the guard) and inserts only while `walletBalanceSql(...) = <read balance>` holds inside the insert; on a miss it re-reads (max 3 attempts) and recomputes. Tests: 20 concurrent same-balance submits → exactly 1 row, rest "Saldo sudah sama" (or "Saldo dompet baru saja berubah"); adjustment racing 10 expenses → its amount always matches the balance at its own write. |

## Every money-summing / type-filtering site found (grep of `'transfer'`, `'expense'`, `'income'`, `from transactions` over `src` and `workers`)

| Site | Handling |
|------|----------|
| `transactions/aggregate.ts` `foldTotals` | Sums only `expense`/`income` (was: everything but transfer → adjustment would be expense). |
| `aggregate.ts` `periodTotals` | Counts `adjustmentCount`; `count` includes it; money via `foldTotals`. |
| `aggregate.ts` `listTransactionsByDay` day sub-query, `dailyTotals`, `categoryTotals`, `monthlyTotals`, `categoryMonthlyTotals`, `frequentManualTransactions`, `listTransactionsForExport` (7 sites) | `t.type <> 'transfer'` → `${MONEY_ROWS}` (`t.type in ('expense','income')`), a positive list so no future type is summed by default. |
| `aggregate.ts` `merchantTotals`, `largestTransactions` | Already require `type` expense/income: unchanged. |
| `aggregate.ts` `LIST_SELECT` / `TransactionListRow` | Carries `adjustmentDirection` for the row sign. |
| `transactions/wallet-sum.ts` `walletTransactionsSums` | The one place it counts: shared `OWN_WALLET_DELTA` case. New `walletBalanceSql` / `readWalletBalance` use the same delta. |
| `budgets/summary.ts` (Beranda, safe-to-spend), `budgets/anggaran.ts`, `budgets/math.ts`, `reports/laporan.ts`, `notifications/triggers.ts` budget alert + weekly summary | Call the aggregates with explicit `expense`/`income` (Laporan's `null` periodTotals uses `foldTotals`): covered by the fix, verified by the snapshot test. |
| `net-worth/summary.ts`, `routes/(app)/dompet` | Use `walletTransactionsSums`: adjustments move wallet balances and net worth, as intended. |
| `export/account-export.ts` `EXPORTABLE` (FN-31) | `t.type <> 'transfer'` → `t.type in ('expense','income')` (its rows go through FN-18's expense/income-only format). |
| `notifications/triggers.ts` `evaluateDailyNudge` | Excludes adjustments: an adjustment is not a recorded payment, so it does not silence "catat hari ini" (test). |
| `transactions/voice.ts` `recordAgain` | Refuses non expense/income (was: only transfer). |
| `transactions/repo.ts` `refsHold` | `adjustment` needs only the wallet (no category), like transfer. |
| `subscriptions/repo.ts` (type = 'expense'), `imports/csv-import.ts`, `drafts/repo.ts`, `shared/csv.ts` | Expense/income only already; captures never produce adjustments (out of scope): unchanged. |
| Streak (FN-34) | **Not on this branch.** At merge, FN-34's streak query must exclude `adjustment` (count only `expense`/`income`, or whatever FN-34 counts for a recorded day). |

## Migration

`migrations/0022_balance_adjustment.sql` + `meta/0022_snapshot.json` + journal entry (idx 21, tag `0022_balance_adjustment`).
Rebuilds `transactions` (type CHECK gains `adjustment`; new nullable `adjustment_direction` with CHECK: set iff
`type='adjustment'`, values `increase|decrease`; category only on expense/income; tombstone clears it). drizzle-kit's
generated SQL was wrong for D1 (it copied the not-yet-existing column, and `PRAGMA foreign_keys=OFF` is ignored by D1, so
dropping `transactions` failed while `drafts.saved_transaction_id` referenced a row — reproduced: "internal error").
Hand-fixed: links from `drafts`/`subscriptions` are parked in a scratch table, nulled, the table rebuilt, then restored
(no `updated_at`/`seq` change). Verified on a local D1 at 0020 holding a draft→transaction link: applied, link restored,
`PRAGMA foreign_key_check` empty, FK and new CHECKs enforced. `drizzle-kit generate` afterwards: "No schema changes".

**Re-chain after FN-34's 0021 lands on main:** rebase; in `_journal.json` put FN-34's `0021_*` entry at idx 21 and
ours at idx 22; then delete `meta/0022_snapshot.json` and our journal entry, run `npx drizzle-kit generate --name
balance_adjustment`, keep the new snapshot + journal entry, and **restore our hand-written
`0022_balance_adjustment.sql`** over the generated SQL (`git checkout`); `drizzle-kit generate` must then report no
changes. If FN-34 also rebuilt `transactions`, re-check the column list in our INSERT.

## Pre-handoff probes

- Cross-space: stranger posting another space's wallet → 400 `WALLET_NOT_FOUND`, edit/delete 404 same as missing id, `?wallet=` foreign id ignored; 0 rows written — PASS.
- Removed member: adjust → `WALLET_NOT_FOUND`, edit 404, direct `createBalanceAdjustment` with old scope → 409, nothing written — PASS.
- Concurrency: 20 concurrent identical submits → exactly 1 row, balance exactly stated; 1 adjustment racing 10 expenses → amount consistent with the balance at its write — PASS.
- Two tabs / stale form: adjustment edit with old `updated_at` → 409 "Berubah sejak terakhir dimuat" — PASS.
- Money vectors (field is whole units like "Saldo awal", never a free-text money parser): `Rp 1.250.000`, `1.250.000,50`, `Rp 28.000,00`, `IDR 1,250,000.00`, `25rb`, `25k`, `1,5 jt`, `goceng`, `-50.000`, `1.250.000 CR`, `12.34`, 14 digits → `BALANCE_INVALID`; negative via the "Saldo minus" box → decrease to −Rp50.000; overflow (diff > 10^13 minor) → `ADJUSTMENT_TOO_LARGE`; exactly 10^13 accepted; zero difference (incl. empty = 0 on an empty wallet) → `ADJUSTMENT_SAME` — PASS.
- Month boundaries: 23:30 WIB 31 Oct → `2026-10-31`, 00:30 WIB 1 Nov → `2026-11-01`, bucketed into Oct/Nov — PASS.
- CSV round trip: export with an adjustment present contains no adjustment; re-import into an empty space gives exactly the expense — PASS.
- 360 px: e2e (phone project + explicit 360 viewport): no horizontal scroll, targets ≥ 44 px on coarse pointer — PASS.
- No-JS forms: adjust/update are plain POST actions; refusals return field errors + echoed values via `fail()` (integration tests call the actions directly) — PASS.
- User copy: no paths or ids in new strings — PASS.
- Two devices: N/A (no sync layer on this branch).

## Gates (each step separately, under `flock /tmp/montra-heavy.lock`)

- `npm run check` — exit 0, `COMPLETED 1480 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`
- `npm run lint` — exit 0 (`All matched files use Prettier code style!`, eslint clean)
- `npx vitest run --maxWorkers=2` — exit 0, `Test Files 162 passed (162)`, `Tests 2307 passed (2307)`
- `npm run build` — exit 0 (`✔ done`)
- Fresh `npm run db:migrate:local` (`FIN_PERSIST_TO` scratch dir) — exit 0, 0000–0022 applied
- Playwright `--workers=1`, port 8837: `riwayat.spec.ts` + `kekayaan.spec.ts` → 30 passed, 3 skipped (pre-existing project skips); `parity-d.spec.ts` + `shell.spec.ts` + `beranda.spec.ts` → 41 passed, 2 skipped. No server left running.

## Deviations and not verified

- **Entry point:** the PRD asks for a 4th option in the compose form's type segmented control. At 360 px four labels
  ("Penyesuaian saldo" included) do not fit one non-wrapping segmented row, so the compose page shows a
  "Sesuaikan saldo dompet" link that opens the same page in adjustment mode (`/riwayat/baru?type=adjustment`, own
  `AdjustmentForm`, `?/adjust` action); Dompet's wallet edit sheet adds "Sesuaikan saldo ke angka sebenarnya"
  (`?wallet=<id>` preselects it), per the brief.
- **Default title (owner decision D):** stored title stays null and the row shows `tr('Penyesuaian saldo')`, so the label
  follows the reader's language instead of freezing Indonesian text into the row.
- **"Saldo baru" empty = 0**, as for "Saldo awal" (the shared `wholeAmountMinor`; AmountInput cannot show a typed 0).
- Adjustments are left out of the FN-18/FN-31 CSV exports (format has expense/income only, like transfers): a user's
  data export therefore omits them — flag for product.
- Not verified: real-device touch behaviour; remote D1 apply of 0022 (not run, by rule); streak exclusion (FN-34 not on
  this branch).

## Cycle 2

Coordinator items (entry point and smaller defaults accepted).

1. **Rebased onto `main` 72dd561 (FN-34).** Conflicts only in `_journal.json` and `i18n-en.ts` (both merged). Re-chained
   as described: 0022 snapshot regenerated after `0021_streak` (`prevId` = 0021's id, journal idx 22), hand-written
   `0022_balance_adjustment.sql` restored (drizzle's regenerated table definition was identical to ours);
   `drizzle-kit generate` → "No schema changes".
   - **FN-34 queries checked:** `streak/repo.ts` reads and writes `day_closures` only (no transaction query, no money);
     the streak counts closed days, so an adjustment neither closes nor breaks one. The Beranda "Hari ini" card uses
     `berandaSummary().todayGroup` (`listTransactionsByDay`), whose day totals already exclude adjustments (cycle 1's
     `MONEY_ROWS`). "N transaksi tercatat hari ini" counts listed rows, adjustments included, like Riwayat's "N
     transaksi". Fixed: a day with only transfers or adjustments now shows "Pengeluaran hari ini Rp 0" instead of no
     spend line (`src/routes/(app)/+page.svelte`). Test: `balance-adjustment.test.ts` › "Beranda "Hari ini" card with
     FN-34" (adjustment-only day → listed, no money; plus an expense → today's spend equals the expense only; streak
     0 → 1 only by closing the day).
2. **Account export (FN-31) now has every transaction row.** Before this, transfers were missing too (the CSV is
   FN-18's expense/income template). I picked the smaller change: `transactions` gets a JSON table decision (`omit:
   ['dedupe_key']`). Each space folder now holds `transactions.json` with every live row of every type: expense,
   income, transfer (with `transferToWalletId`) and adjustment (with `adjustmentDirection`). Free text is masked to
   the last 4 digits by the shared table exporter, and times are WIB. The FN-18 CSV files are unchanged.
   `account.json` `formatVersion` is now 3, with a note explaining the two files. The row cap counts transactions
   once, through the JSON file. Test: `privacy.test.ts` › "transactions.json holds every row the user owns": expense,
   transfer and adjustment are all present, the account number is masked, there is no `dedupeKey`, the CSV has
   neither the transfer nor the adjustment, and `transactions` is no longer listed under "not included".
3. **Migration re-verified on a populated local D1 at 0021:** user, space, category, wallet, two transactions, a draft
   linked to t1, a live subscription linked to t2, a category budget and a day closure. After applying 0022, the
   draft→t1 and subscription→t2 links were restored, `updated_at`/`seq` were unchanged, `category_budgets` and
   `day_closures` were byte-identical, `PRAGMA foreign_key_check` was empty, and no scratch tables were left.

Gates (each step separately, under `flock /tmp/montra-heavy.lock`):

- `npm run check` — exit 0, `COMPLETED 1484 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`
- `npm run lint` — exit 0
- `npx vitest run --maxWorkers=2` — exit 0, `Test Files 164 passed (164)`, `Tests 2332 passed (2332)`
- `npm run build` — exit 0
- Fresh `npm run db:migrate:local` (scratch persist dir) — exit 0, 0000–0022 applied
- Playwright `--workers=1`, port 8837: `beranda.spec.ts` + `riwayat.spec.ts` → 32 passed, 1 skipped; no server left running.
