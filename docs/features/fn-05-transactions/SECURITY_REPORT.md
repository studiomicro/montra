# FN-05 Transactions — Security report

- Reviewed: `git diff 98df284..e744c98` (cycle 2 head `e744c98`), against `docs/ENGINEERING_CHECKLIST.md`.
- Method: code review of every changed loader/action/repo; a throwaway local-D1 probe test (deleted after
  running); `npm run db:reset:local`, `npm run build`, `wrangler dev --local --port 8805` with curl probes
  (server stopped afterwards). Nothing remote, no login, no deploy.

## Verdict: FAIL

Two medium findings. No high findings.

## Findings

### M1 — Medium: one member can permanently break Kekayaan and Riwayat for the whole space through total overflow

- `src/lib/server/transactions/validation.ts:32` (`AMOUNT_MAX_DIGITS = 13`, ×10^exponent per row) with
  `src/lib/server/transactions/aggregate.ts:110-113` (`safe()` throws), `aggregate.ts:139-140` and
  `src/lib/server/transactions/wallet-sum.ts:31` (throw on an unsafe sum), and
  `src/lib/server/wallets/balance.ts` (`walletBalanceMinor` throws).
- Exploit: a signed-in user, or any Anggota of a shared space, adds a USD wallet and posts 10 expenses of
  `9.999.999.999.999` (each 999,999,999,999,900 minor units, each passes `Number.isSafeInteger`). The sum
  passes 2^53, so `periodTotals`, `listTransactionsByDay` (day headers) and `walletTransactionsSums` throw.
  With IDR it takes about 900 rows; no per-space row cap or rate limit stops that.
- Reproduced over HTTP on 8805: 11 POSTs to `/riwayat/baru?/create`, each answered with a 303 to
  `/riwayat?saved=created`. After that `/riwayat` shows "Transaksi tidak bisa dimuat" and `/kekayaan` shows
  "Dompet tidak bisa dimuat" with `wallets: []`. The local-D1 probe test confirmed that all three aggregates reject.
- Impact: every member of the space loses Kekayaan (the wallet list, so no edit or archive either) and that
  Riwayat period. The usual recovery path is gone. The bad rows can only be reached through Riwayat, and
  Riwayat no longer loads for any filter that includes them: type and category filters still run
  `periodTotals`, and the rows have no title, so search cannot single them out. The Pemilik cannot clean up
  the space from the UI. A user can also do this to themselves by mistake by typing extra zeros.
- Fix: put a product upper bound on one amount so that MAX_ROWS × bound stays under 2^53. For example, cap
  one amount at 10^12 minor units and cap transactions per space, or check the per-wallet running total in
  the insert guard. Totals should degrade instead of throwing: the list should still render when a sum
  overflows, showing an "angka terlalu besar" state, so the rows can still be deleted. Add a regression test
  with N max-size rows.

### M2 — Medium: deleted transactions are not content-free tombstones

- `src/lib/server/transactions/repo.ts:218-226` (`deleteTransaction`): only `title`/`note` are cleared.
  `amount_minor`, `currency`, `wallet_id`, `category_id`, `occurred_on` and `occurred_at` stay in D1 for as
  long as the space exists. The NOT NULL/CHECK constraints in `migrations/0004_transactions_categories.sql`
  (`amount_minor > 0`) make it impossible to clear them.
- Failure scenario: a user deletes a transaction they do not want kept, for example a sensitive purchase.
  The server still holds the amount, date, time, wallet and category without limit. Any later code path or
  sync pull that forgets to filter `deleted_at` will expose it, and a D1 export or backup carries it. This
  breaks `CLAUDE.md` ("content-free tombstones"), ENGINEERING_CHECKLIST line 55 ("Deletes are `deleted_at`
  rows without content") and PRD criterion 22 ("tombstone, content-free").
- Fix: on delete, keep only `id, space_id, deleted_at, updated_at, seq`. Either move the row to a
  `transaction_tombstones` table and hard-delete the original, or relax the constraints so the columns can be
  nulled or zeroed when `deleted_at is not null`. Add a test that a tombstone holds no amount, date, wallet or
  category.

### L1 — Low: an archived wallet can still receive a new transaction during a race

- `src/lib/server/transactions/repo.ts:105-110` (`refsHold`): the in-statement guard checks space and
  currency, but not `w.deleted_at is null`. If wallet A is archived between `loadDraftRefs` (which refuses
  archived wallets) and the insert, the new row lands on the archived wallet. This only affects integrity:
  the wallet stays in the same space, so there is no cross-space effect.
- Fix: add `and (w.deleted_at is null or w.id in (<the ids the current row already uses>))` to the guard.

### L2 — Low: no per-space cap or rate limit on transaction creation

- `src/routes/(app)/riwayat/baru/+page.server.ts:45-55`: categories have a 100-row cap and wallets have a
  cap, but transactions have neither. A script can fill D1 for a space without limit, which also makes M1
  possible with IDR.
- Fix: add a per-user or per-space write throttle, as for sign-in, plus a generous per-space row ceiling.

## Checked and holding

- **IDOR / cross-space:** every route uses `currentSpaceScope`, which re-runs `requireSpaceAccess` on each
  load and action. A probe found that another space's wallet, transfer counter-wallet and category are all
  refused, both at the form and when a forged `TransactionInput` is passed straight to `createTransaction`.
  `getTransaction`, `updateTransaction` and `deleteTransaction` on another space's id return `null`,
  `missing` and `missing`, the same answer as an unknown id. Writes repeat `isLiveMember`, so a removed
  member loses access at once.
- **Hidden categories and archived wallets** are only allowed when the edited row already uses them. Category
  kind must match the type.
- **Transfers:** same wallet is refused (in the form and by a DB CHECK). A cross-currency transfer is refused.
  Transfers are never part of income or expense totals, and wallet sums join on the wallet's currency.
- **Money:** `^[\d. ]*$`, then `^[1-9]\d*$`, then `digitsToMinor`, then a safe-integer check, then the DB
  `CHECK > 0`. `-5`, `1e5`, `0` and sen are refused. No `parseFloat`.
- **`is_demo`, `source`, `dedupe_key`** are hard-coded (`0`, `'manual'`, `null`). Over HTTP, posting
  `isDemo=1&source=gmail` stored `is_demo=0, source=manual, dedupe_key=null`. Edits never touch them. The
  demo seed is local-only, behind `assertLocalOnly`.
- **Search:** `instr(lower(...), ?)` with a bound parameter, `cleanText` and `SEARCH_MAX_LENGTH`, always inside
  a bounded period of at most 366 days.
- **Cursor:** the format is strictly checked and it is only applied after the `space_id` and period
  predicates. A forged cursor cannot cross spaces or widen the scan, and the limit is clamped to 50.
- **Categories:** seeding and the 100-row cap are each one guarded `INSERT … SELECT` (atomic in SQLite).
  Concurrent seeds and creates cannot go over.
- **Stale edits and deletes** use optimistic `updated_at`. A malformed value becomes -1 and is refused.
- **CSRF and body:** a cross-origin POST to `/riwayat/baru?/create` got 403. `readFormBody` caps the body at
  8 KB and checks the content type.
- **Untrusted text:** title, note and category name go through `cleanText` (Cc/Cf/Zl/Zp stripped, capped).
  There is no `{@html}` anywhere in the diff.
- **Account deletion:** `SPACE_SCOPED_TABLES` lists `transactions` and `categories` ahead of `wallets`, in an
  order that satisfies the foreign keys.
- **Wallet currency lock:** the currency cannot change once the wallet has transactions. The action checks
  this and the update statement repeats the check against races.

## Commands

- `npx vitest run test/integration/transactions.test.ts test/integration/riwayat-routes.test.ts src/lib/server/transactions`
  → 3 files, 57 tests passed.
- Throwaway probe `test/integration/zz-pentest-probe.test.ts` (deleted): 2 passed (overflow rejects; cross-space
  refused).
- `npm run db:reset:local`, `npm run build` → ok; `wrangler dev --local --port 8805` probes as above; server
  stopped.

## Cycle 3 re-check (`git diff 727eb69..ded0d6e`)

### Overall verdict: PASS

No medium or high findings remain. Two low items are tracked below.

| Finding | Status | Evidence |
| --- | --- | --- |
| M1 total overflow breaks the space's pages | FIXED | Results 1–5 below |
| M2 tombstone keeps the money data | FIXED | Results 6–7 below |
| L1 a wallet archived (or category hidden) during a save can still be used | FIXED | Result 8 below |
| L2 no transaction cap or rate limit | PARTLY FIXED | Result 9 below |

1. **M1 — USD repro.** Over HTTP on 8805, after `db:reset:local` and `build`, 10 × `9.999.999.999.999`
   in a USD wallet were all refused with 400 "Jumlah terlalu besar untuk satu transaksi"
   (`MAX_AMOUNT_MINOR = 10^13`, `validation.ts:39,167`). `100.000.000.001` IDR was refused the same way.
2. **M1 — many rows under the cap.** 1,000 IDR expenses of 10^13 plus 1,000 transfers of 10^13 out of a
   second IDR wallet, 16 at a time: all 2,000 were accepted (expected), giving day and period sums of 10^16,
   which is past 2^53. `/riwayat`, `/riwayat?type=expense` and `/kekayaan` all answered 200. The list loaded
   with 50 rows and a next cursor. The header, the day group and the overdrawn wallet row showed "Total
   terlalu besar untuk ditampilkan" (`balanceMinor:null`). The balanced wallet still showed 0, and nothing
   was rounded.
3. **M1 — exact sums.** Sums are returned with `CAST(SUM … AS TEXT)` and added with `BigInt`
   (`aggregate.ts:114-119,166,265`, `wallet-sum.ts:18,32`). The largest possible sum is
   100,000 × 10^13 = 10^18 per wallet, type and currency. A transfer counts once on each of two wallets, so
   10^18 is also the ceiling per wallet. That is below SQLite's int64 limit (9.22×10^18), so SQL never
   throws an integer overflow.
4. **M1 — concurrency at the cap.** I seeded the space to 99,988 live rows with a local SQL fill, then sent 40
   parallel creates. Exactly 12 got 303 and 28 got 409 ("100.000 transaksi"). The count and the insert are
   one guarded statement (`repo.ts:144-160`). At 100k rows, `/riwayat?month=2026-09` (97,989 rows) answered in
   0.18 s.
5. **M1 — later aggregates.** The diff has no `dailyTotals` or `categoryTotals`. The only `sum(` calls are the
   three above, and all three use the exact path. FN-07/08/09 must reuse `foldTotals` or `safeMinor`.
6. **M2 — delete clears everything.** `deleteTransaction` nulls amount, currency, wallet, transfer target,
   category, `occurred_on`, `occurred_at`, title and note in the same statement (`repo.ts:241-256`). In local D1
   the tombstone of a deleted transfer kept only id, space_id, type, source, dedupe_key, is_demo, created_at,
   updated_at, deleted_at and seq.
7. **M2 — the DB enforces it.** `transactions_content_check` refuses a content-bearing tombstone:
   `update transactions set deleted_at = 5 where id = 'fill-1'` fails with `CHECK constraint failed:
   transactions_content_check`. It also refuses a live row without content. The read paths keep filtering on
   `deleted_at is null`, and `getTransaction` adds a null guard.
8. **L1.** `refsHold` (`repo.ts:113-130`) now requires `w.deleted_at is null` and `c.is_hidden = 0`
   inside the write. On an edit, the wallets and category the row already uses stay allowed, through a
   correlated reference to the row's old values.
9. **L2.** The 100,000 live-row cap per space is in place. There is still no per-user write throttle. A
   member can fill the space to the cap, which blocks new entries for every member until rows are deleted.

### New low findings (this diff only)

- **L3 — Low: the 10^13 single-amount cap is only in route validation, not in the database.**
  `validation.ts:167` enforces it, but there is no `CHECK (amount_minor <= 10000000000000)`. A future capture
  path (Gmail, statement, sync push) that writes through the repo without `resolveTransactionInput` could
  bring back an SQL int64 overflow, which throws and breaks the page as in M1. Fix: add the bound to
  `transactions_content_check`, or assert it in `createTransaction` and `updateTransaction`.
- **L4 — Low: migration 0004 was changed after it was written.** I could not check whether it was applied
  anywhere remote. `docs/TASKS.md` says the last staging deploy was from `0e01a08`, before FN-05, so it
  should be safe. Any local or remote D1 that already applied the old 0004 keeps the old schema (no content
  CHECK, NOT NULL columns), and then delete fails. Fix: confirm before `/ship` that 0004 has never been
  applied remotely, and reset local databases (`db:reset:local`).

### Commands (cycle 3)

- `npx vitest run test/integration/transactions.test.ts test/integration/riwayat-routes.test.ts src/lib/server/transactions`
  → 3 files, 64 tests passed.
- `npm run db:reset:local`, `npm run build` → ok. `wrangler dev --local --port 8805` → the HTTP and D1 probes
  above. The server was stopped afterwards.
