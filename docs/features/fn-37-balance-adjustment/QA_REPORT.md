# FN-37 Balance adjustment — QA report

**Verdict: PASS**

Branch `fn-37-balance-adjustment`, head `c53b650` (cycle 2), rebased on `main` 72dd561 (includes FN-34).
Worktree: `<repo>`.

## Commands run

- `flock … npm run check` — exit 0, `COMPLETED 1484 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`.
- `flock … npm run lint` — exit 0, Prettier clean, ESLint clean.
- `flock … npx vitest run --maxWorkers=2` — exit 0, `Test Files 164 passed (164)`, `Tests 2332 passed (2332)` (local D1, no mocked AI/provider; this feature has none).
- `flock … npm run build` — exit 0, SvelteKit + Cloudflare adapter build succeeded, service worker built.
- Fresh `FIN_PERSIST_TO=<scratch> npm run db:migrate:local` — exit 0, migrations 0000–0022 applied in order (local D1, fixture-free).
- Populated-DB migration check (manual, local D1 via `node:sqlite` against the same wrangler D1 sqlite file): seeded at 0021 with a user/space/two wallets/category, an expense, income and transfer transaction, a tombstoned draft linked to the expense, a live subscription linked to the income, a category budget and a day closure; applied `0022_balance_adjustment.sql`; row counts, draft/subscription links, `updated_at`/`seq`, `category_budgets` and `day_closures` all unchanged; `PRAGMA foreign_key_check` empty before and after; `sqlite_master` diff showed only the `transactions` table definition changed (new column, extended CHECK), all 5 indexes present and byte-identical before/after; no leftover `__fn37_*`/`__new_*` tables — exit 0.
- `flock … npx vitest run test/integration/privacy.test.ts --maxWorkers=2` (after adding an income-row assertion, see Findings) — exit 0, `Tests 25 passed (25)`.
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=8853 flock … npx playwright test --workers=1 e2e/riwayat.spec.ts e2e/beranda.spec.ts e2e/kekayaan.spec.ts e2e/laporan.spec.ts` — exit 0, `51 passed`, `4 skipped` (pre-existing phone-only tests skipped on the desktop project, consistent with the engineer report); real Chromium browser against the local three-Worker `wrangler dev`, no mocked provider involved; no server left running afterwards (checked with `pgrep`).
- No `npm run gates` or `npm test` run (forbidden by the RAM limit); each gate step run separately as above.

## Checked criteria (PRD `docs/features/fn-37-balance-adjustment/PRD.md`)

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Rp1.200.000 → Rp1.500.000 writes one `increase` row of the diff; wallet balance becomes exactly the stated figure | PASS | `test/integration/balance-adjustment.test.ts` "1:" (engineer); logic re-read in `adjustment.ts`/`wallet-sum.ts` — `OWN_WALLET_DELTA` is the one place that counts the signed amount. |
| 2 | Same wallet → Rp900.000 writes one `decrease` row | PASS | test "2:"; same code path, direction flips on sign of `diff`. |
| 3 | Same balance entered → no row, "Saldo sudah sama, tidak ada perubahan" | PASS | `adjustmentFor` returns `ADJUSTMENT_SAME` on `diff === 0n`, no insert attempted; test "3:" and e2e (same-balance submit shows the exact phrase, row count unchanged). |
| 4 | Beranda/Riwayat/Laporan/budget figures exclude the adjustment; Beranda total = Riwayat total with an adjustment present | PASS | `aggregate.ts`'s `MONEY_ROWS`/`foldTotals` sum only `expense`/`income`; `periodTotals` adds `adjustmentCount` without touching money; test "4:" asserts `beranda.spentMinor === header.outMinor === semua.outMinor` with an adjustment in the period, and the broader "every aggregate … unchanged" test diffs Beranda/Anggaran/Laporan/CSV before and after five adjustments (byte-identical). Engineer's fail-before proof (unfixed `aggregate.ts` miscounts an adjustment as `outMinor`) read and accepted as reported. |
| 5 | `walletTransactionsSums` is the one place that counts the adjustment, criteria 1/2/4 hold at once | PASS | `wallet-sum.ts` `OWN_WALLET_DELTA` case for `adjustment`; same test as #1/#2 shows the wallet balance moved while every money figure stayed. |
| 6 | "Penyesuaian saldo" chip lists only adjustments, neutral amount/direction, no category | PASS | `RiwayatView['type']` extended; test "6:" and `row-text.test.ts`; e2e asserts the row text "Saldo disesuaikan · BCA" and a signed, non-income-coloured amount. |
| 7 | Adjustment listed on its day in "Semua"; day's money header excludes it | PASS | test "7:" — day lists expense+expense+adjustment, day total excludes the adjustment. |
| 8 | Adjustment edit form only allows date/title/note; amount/direction/wallet immutable | PASS | server `update` action branches on `current.type === 'adjustment'` and calls `adjustmentEditInput`, which copies amount/direction/wallet/currency from the stored row regardless of form input; test "8:" posts a different amount/wallet/type and confirms none of it took effect; a second test confirms an expense can never be edited into an adjustment (generic form's type enum excludes it). |
| 9 | Deleting an adjustment tombstones it like any row; balance recomputes without it | PASS | unchanged `deleteTransaction`; tombstone CHECK clears `adjustment_direction`; test "9:". |
| 10 | "Catat lagi" never offers a transfer or an adjustment | PASS | `frequentManualTransactions` filters `MONEY_ROWS`; test "10:" and the three-identical-adjustments case inside the "unchanged" snapshot test. |
| 11 | Every adjustment load/action is scoped through the shared space-access helper; no new access path | PASS | `createBalanceAdjustment`'s `getWallet(db, spaceId, …)`, the edit route's `getTransaction(db, scope.spaceId, id)`, and the compose load's `listWallets(locals.db, spaceId)` (so a foreign `?wallet=` id is ignored) all read code directly; test "11:" — member succeeds, stranger and a removed member get `WALLET_NOT_FOUND`/404 on create/edit/delete, and a direct `createBalanceAdjustment` call with a removed member's scope returns 409 and writes nothing. |
| 12 | A full space refuses an adjustment with the same `limit` reason | PASS | shared guarded insert's `underCap` condition; test "12:" (100,000-row space). |
| 13 | WIB boundary: 23:30 WIB last day of month / 00:30 WIB first day keep the correct `occurred_on` | PASS | test "13:" at `2026-10-31T16:30Z` and `17:30Z`; `occurred_on` lands on `2026-10-31` and `2026-11-01` respectively, each month's `periodTotals.adjustmentCount` is 1. |
| 14 | English entries for every new phrase | PASS | `i18n-en.ts` has all 16+ new phrases ("Penyesuaian saldo", "Saldo baru", "Saldo sudah sama, tidak ada perubahan.", "Sesuaikan saldo dompet", "Sesuaikan saldo ke angka sebenarnya", etc.); `test/i18n-coverage.test.ts` passed in the full vitest run. |
| 15 | 360 px: no horizontal scroll, ≥44 px touch targets on the form/chip | PASS | e2e "balance adjustment (FN-37) at 360 px" asserts `expectNoHorizontalScroll` three times (form, list, chip view) and ≥44 px bounding boxes on the wallet select, "Saldo minus" checkbox row, submit button and chip (coarse-pointer/phone project); re-ran this spec myself (passed). |
| 16 | Concurrent double-submit recomputes the balance fresh each time; no double-counted adjustment | PASS | `createBalanceAdjustment`'s guarded insert checks `walletBalanceSql(...) = cast(<balance read at this attempt> as integer)` inside the same INSERT, retrying up to 3 times on a miss; tests "16:" — 20 concurrent identical submits write exactly 1 row (rest refused with "Saldo sudah sama"/"Saldo dompet baru saja berubah"), and an adjustment racing 10 concurrent expenses always matches the balance at its own write. |

## Migration 0022 (specific focus item)

- Fresh DB (0000→0022): all 23 migrations applied cleanly.
- Populated DB at 0021 (user, space, 2 wallets, category, expense/income/transfer transactions, a tombstoned draft linked to the expense, a live subscription linked to the income, a category budget, a day closure) → applied 0022:
  - Row counts unchanged (`transactions: 3`, `drafts: 1`, `subscriptions: 1`, `category_budgets: 1`, `day_closures: 1`).
  - `drafts.saved_transaction_id` and `subscriptions.linked_transaction_id` both correctly restored to the original transaction ids.
  - `updated_at`/`seq` on every row (transactions, drafts, subscriptions) unchanged — nothing looks edited to a sync consumer.
  - `category_budgets` and `day_closures` byte-identical before/after (untouched tables, confirming the rebuild did not cascade anywhere it shouldn't).
  - `PRAGMA foreign_key_check` empty both before and after.
  - `sqlite_master` diff: only the `transactions` table's own SQL differs (new `adjustment_direction` column, extended `transactions_type_check`/`transactions_content_check`); all 5 indexes (`transactions_import_batch_idx`, `transactions_space_day_idx`, `transactions_wallet_idx`, `transactions_transfer_to_idx`, `transactions_dedupe_uq`) present with identical definitions before and after.
  - No leftover scratch tables (`__fn37_links`, `__new_transactions`) — both gone after migration.
  - `drizzle-kit generate` reporting "No schema changes" (per engineer report) is consistent with the hand-written SQL matching the schema.

## Findings

1. **Gap closed by QA, not a defect**: `test/integration/privacy.test.ts`'s FN-37 export test ("transactions.json holds every row the user owns") seeded only `expense`, `transfer` and `adjustment` rows, missing an explicit `income` row — the task's criterion ("account export contains expense, income, transfer and adjustment rows") was not fully exercised by an automated test. I added an `income` row to the seed and two assertions (the row appears in `transactions.json` with the correct amount, and the FN-18 CSV beside it also contains the income merchant). Re-ran `test/integration/privacy.test.ts`: 25/25 passed, confirming income rows export correctly (no production code change needed — `export/tables.ts`'s `transactions: { export: 'json', omit: ['dedupe_key'] }` decision has no type filter, so expense/income/transfer/adjustment all already flowed through unchanged). Diff: `test/integration/privacy.test.ts` (+6/-1 lines).

No other findings. The engineer's every-money-summing-site audit (`aggregate.ts`, `wallet-sum.ts`, `notifications/triggers.ts`, `transactions/voice.ts`, `export/account-export.ts`, `export/tables.ts`) was read line-by-line against the diff and matches the PRD's required exclusion sites exactly; no missed site found. Owner-accepted deviations (separate adjustment form via a compose-page link and Dompet's "Sesuaikan saldo ke angka sebenarnya", empty "Saldo baru" = 0, reader-language default title) are implemented as described and covered by tests/e2e. `docs/ENGINEERING_CHECKLIST.md` reviewed against the diff: guarded single-statement INSERT for the concurrency-sensitive write (no violation), one access rule used throughout (no new access path), masking confirmed in the export, i18n entries present, Svelte `{#each}` lists keyed by id, touch targets and no-horizontal-scroll verified by e2e — no violations found.

## Files touched by QA

- `<repo>` (added an income-row assertion to close the export-coverage gap above; no other file modified).
- `<repo>` (this report).
