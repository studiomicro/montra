# FN-37 Balance adjustment ("Penyesuaian saldo") — PRD

Catalog entry: `docs/FEATURES.md` › FN-37 (Phase 1b, owner request 2026-10-08, `docs/design/APP_PARITY.md` § 3
"Transaksi" type chips: "Semua, Pengeluaran, Pemasukan, Transfer, Penyesuaian saldo"). Tracker: `docs/TASKS.md` ›
App layout parity › "New features seen in the reference app (PRDs first): FN-34 streak / close the day, FN-35
money-flow chart, recurring transactions, balance adjustment type." This PRD closes the "balance adjustment type"
slice of that line. Risk tier: **Medium** (touches the `transactions` table's CHECK constraints and several
money-summing functions that today implicitly assume only `expense`/`income`/`transfer` exist — a missed site is
a silent wrong total, not a crash, so this is riskier than its line count suggests).

Checked first, per the brief ("first check what FN-04/FN-05 already have… scope only the gap"): FN-04's wallet
edit form already lets a user type a new `openingBalanceMinor` directly
(`src/lib/server/wallets/repo.ts:236-255`, form at `src/lib/server/wallets/validation.ts:22,66-76`). That is a
silent, undated change to the wallet's base balance — no ledger row, no date, nothing in Riwayat, nothing a
budget or report would ever show happened. It is **not** what this feature builds, and it is not removed by this
feature either (editing a wallet's starting balance is a legitimate correction to how a wallet was first set up).
FN-37 is a new, dated, ledger-visible way to say "this wallet's balance is actually X now" without the user
computing the difference by hand.

## Goal

A user who reconciles against a bank app or a receipt they forgot to log for weeks does not want to hunt for
every missing transaction — they want to tell MONTRA the wallet's real balance today and have the gap
accounted for as one clear, dated entry, without that entry pretending to be spending or income it never was
(which would wreck a budget or a monthly total). FN-37 is that one entry.

## Scope

- **Migration (assign `0020`, or the next free number after FN-34/FN-36 at merge — renumber per `CLAUDE.md` ›
  Data access › "Migrations"):**
  - `transactions_type_check` (`migrations/0004_transactions_categories.sql:44`) gains `'adjustment'`.
  - New column `transactions.adjustment_direction` (`'increase'|'decrease'`, nullable), with
    `transactions_content_check` (`migrations/0004_transactions_categories.sql:46`) extended so a live row has
    `adjustment_direction` set **iff** `type = 'adjustment'`, `category_id` is null for `type = 'adjustment'`
    (same as `transfer`), and `transfer_to_wallet_id` is null for `type = 'adjustment'`. `amount_minor` keeps its
    existing rule (`between 1 and 10000000000000`) — the convention that it is always a positive magnitude
    (`src/lib/shared/transactions.ts:6-7`) is preserved; `adjustment_direction` is what carries the sign, the
    same way `type` already carries the sign for `expense`/`income`.
- **`src/lib/server/transactions/validation.ts`:** the `isTransfer`-style branch that currently skips
  `categoryId` only for `transfer` (`parseTransactionForm`, lines 102–124) must skip it for `adjustment` too; a
  new, separate entry point (not the generic compose form) that takes `{ walletId, statedBalanceDigits,
  occurredOn }`, re-reads the wallet's **current** balance server-side via `walletBalanceMinor` +
  `walletTransactionsSums` (`src/lib/server/wallets/balance.ts`, `src/lib/server/transactions/wallet-sum.ts`) at
  submit time (never trusts a balance the client displayed earlier — it may be stale), computes
  `diff = statedBalanceMinor − currentBalanceMinor`, and refuses with a clear message when `diff === 0` (no
  transaction is written — `amount_minor` cannot be stored as 0 under `transactions_content_check`, so this is a
  validation rule, not a database error).
- **`src/lib/server/transactions/repo.ts`:** `insertTransactions`'s per-row JSON payload
  (`src/lib/server/transactions/repo.ts:189-213`) gains `adjustmentDirection`, written through alongside the
  other columns; no change to the function's guarded-insert shape.
- **Every function in `src/lib/server/transactions/aggregate.ts` that currently distinguishes only `'transfer'`
  from everything else must be corrected to also exclude `'adjustment'` — this is the actual gap, found by
  reading the current code, not assumed:**
  - `foldTotals` (lines 146–162): `if (r.type === 'transfer') continue;` must also skip `'adjustment'` — today it
    would fall into the `else` branch and be counted as an **expense**, which is exactly the bug this feature
    must not ship.
  - `dailyTotals`, `categoryTotals`, `monthlyTotals`, `listTransactionsByDay`'s day-total sub-query, and
    `listTransactionsForExport` all filter with `t.type <> 'transfer'` (lines 332, 367, 412, 277, 579) — each
    becomes `t.type not in ('transfer', 'adjustment')`.
  - `frequentManualTransactions` (line 521) filters `t.type <> 'transfer'` for its "Catat lagi" grouping — same
    fix, so an adjustment is never offered as a one-tap repeat button.
  - `periodTotals`'s `count`/`expenseCount`/`incomeCount`/`transferCount` shape (lines 164–187) needs an
    `adjustmentCount` alongside, so the Riwayat header ("N transaksi · keluar Rp X") can still report a correct
    `N` that includes adjustments in the count without including their amount in `keluar`/`masuk`.
  - `budgets/summary.ts` and `reports/laporan.ts` already call these functions with an explicit
    `type: 'expense'`/`'income'` filter (never `null`) for every money figure they show
    (`src/lib/server/reports/laporan.ts:161-162`, `src/lib/server/budgets/summary.ts:48-51`) — **verified, not
    re-derived**: once the fixes above land, budgets and Laporan need no separate change, because `filterWhere`
    only adds the type clause when a specific type is asked for, and neither module ever asks for `null` on a
    money figure.
- **`src/lib/server/transactions/wallet-sum.ts`:** `walletTransactionsSums`'s SQL `case` (lines 19–22) gains a
  branch: `when 'adjustment' then (case when adjustment_direction = 'increase' then amount_minor else
  -amount_minor end)` — this is the one place an adjustment **must** be counted, because its entire purpose is to
  change the wallet balance `walletBalanceMinor` (`src/lib/server/wallets/balance.ts`) reports.
- **Riwayat (`/riwayat`):** a "Penyesuaian saldo" type filter chip, extending `RiwayatView['type']`
  (`src/lib/shared/riwayat-query.ts:16,54`) with `'adjustment'`; the row renders with a neutral label (not
  "+"/"−" styled as income/expense) showing the direction and amount, e.g. "Saldo disesuaikan +Rp150.000" /
  "−Rp40.000", and no category line (same treatment as a transfer row today).
- **Entry point:** a fourth type option alongside Pengeluaran/Pemasukan/Transfer in the existing compose form
  (`src/routes/(app)/riwayat/baru/+page.server.ts` + `.svelte`); selecting it swaps the amount field for a
  "Saldo baru" (new balance) field showing the wallet's current balance as a hint, and the wallet picker is
  required exactly as it is today. (A `/dompet` entry point, e.g. "Sesuaikan saldo" on a wallet row, follows once
  the Dompet page from parity wave C exists — not a dependency of this PRD, since the compose-form entry point
  stands on its own.)
- **Editing:** an adjustment's edit form only allows `occurredOn`/title/note changes — `amountMinor`,
  `adjustmentDirection` and `walletId` are immutable after creation (Owner decision below); to correct a wrong
  adjustment the user deletes it and creates a new one.
- **i18n:** "Penyesuaian saldo," "Saldo baru," "Saldo sudah sama, tidak ada perubahan" (the zero-diff refusal),
  the chip label and the row's direction phrasing, all through `tr()`/`trf()` with English entries.

## Out of scope

- Any capture path producing an adjustment automatically (Gmail, receipt, statement, spreadsheet, CSV, voice) —
  `capturedTransactionInput` (`src/lib/server/transactions/validation.ts:188-231`) is untouched; adjustments are
  manual-only this pass, because no capture source can know "the user's true current balance," only a stated
  figure the user types.
- Recurring adjustments (excluded from FN-36 for the same reason, stated there).
- Changing `amount_minor`/`adjustment_direction`/`walletId` on an existing adjustment (see Editing, above, and
  Owner decision A).
- Removing or changing the wallet-edit "Saldo awal" field (`src/lib/server/wallets/repo.ts:236-255`) — that gap
  is explicitly not this feature's problem, per the brief.
- A `/dompet`-page entry point (depends on parity wave C's Dompet page, not yet built) — the compose-form entry
  point is sufficient for this pass.
- Foreign-currency adjustments across a wallet's currency (an adjustment's `currency` is always the wallet's own,
  exactly like every other transaction — `resolveTransactionInput`'s existing rule).
- Any assistant (FN-22) or report narrative that explains an adjustment's cause — it is a plain ledger row with no
  AI involvement.

## Acceptance criteria

1. Given a wallet with a current balance of Rp1.200.000, when the user opens the adjustment form, enters a new
   balance of Rp1.500.000 and saves, then exactly one transaction is created with `type = 'adjustment'`,
   `adjustment_direction = 'increase'`, `amount_minor = 300000`, and the wallet's balance (`walletBalanceMinor`)
   is now exactly Rp1.500.000.
2. Given the same wallet, when the user instead enters Rp900.000, then one `'decrease'` adjustment of
   `amount_minor = 300000` is created and the wallet's balance is now Rp900.000.
3. Given the user enters the wallet's exact current balance (no change), when they submit, then no transaction
   is created and the form shows "Saldo sudah sama, tidak ada perubahan" — never a zero-amount row (which the
   `transactions_content_check` constraint would refuse at the database level if one were attempted).
4. Given an adjustment transaction exists, when Beranda's month total, Riwayat's "N transaksi · keluar Rp X"
   header for the "Semua" and "Pengeluaran" filters, Laporan's month figures, and a budget's spent-so-far figure
   are each computed for a period including that adjustment, then none of them include its amount — Beranda
   total still equals Riwayat total for the same filter (`docs/ACCEPTANCE.md` › "Beranda total = Riwayat total
   for the same filter"), and that equality holds with at least one adjustment present in the period (the
   regression test this feature must add, proven to fail on the unfixed `foldTotals`).
5. Given the same adjustment, when the wallet's balance is computed via `walletTransactionsSums`, then it is the
   one place that **does** include the adjustment's signed amount — criterion 1/2 and criterion 4 both hold at
   once, on the same row.
6. Given the user opens Riwayat and selects the "Penyesuaian saldo" chip, when the list renders, then it shows
   only adjustment rows, each with a neutral (non income/expense-coloured) amount and direction, no category.
7. Given an adjustment row in the "Semua" (unfiltered) Riwayat view, when the day's rows are listed, then it
   appears in the list (so a user can find and delete it) but the day's "money in"/"money out" header total for
   that day excludes it, consistent with criterion 4.
8. Given an existing adjustment, when the user opens its edit form, then only date/title/note are editable;
   amount, direction and wallet are not offered as editable fields.
9. Given an adjustment, when the user deletes it, then it tombstones exactly like any other transaction
   (`deleteTransaction`, `src/lib/server/transactions/repo.ts:346-376`) and the wallet's balance recomputes
   without it — no special-cased delete path.
10. Given a transfer or an adjustment row, when `frequentManualTransactions` ("Catat lagi") computes its
    suggestions, then neither ever appears as a one-tap repeat button.
11. Given any load or action touching an adjustment (create, edit, delete, list, filter), when it runs, then it
    is scoped through `requireSpaceAccess`/`isLiveMember` exactly like every other transaction route — no new
    access path is introduced (`docs/ENGINEERING_CHECKLIST.md` › "One access rule").
12. Given a `MAX_TRANSACTIONS_PER_SPACE`-full space, when an adjustment is attempted, then it is refused with the
    same `limit` reason any other over-cap save gets.
13. Given the WIB date boundary, when an adjustment is saved at 23:30 WIB on the last day of a month or 00:30 WIB
    on the first, then its `occurred_on` is the correct WIB date (same test every other dated feature in this
    pass runs).
14. Given the UI language is English, when the adjustment form, the chip, the row label, the zero-diff refusal
    and the edit-form restriction render, then every phrase has an English entry.
15. Given 360 px width, when the adjustment form (the "Saldo baru" field, the wallet picker) and the chip render,
    then every touch target is ≥ 44 px and there is no horizontal scroll.
16. Given a concurrent double-submit of the adjustment form (two tabs computing the same diff against a
    momentarily-stale displayed balance), when both reach the server, then each recomputes the current balance
    fresh at submit time, so the second submission's diff is computed against the balance **after** the first
    one's effect, not a stale client-side figure — no double-counted adjustment.

## Architecture notes

- Touches: new migration (`transactions_type_check`, `transactions_content_check`, new
  `adjustment_direction` column); `src/lib/server/db/schema.ts`; `src/lib/server/transactions/validation.ts`
  (new adjustment entry point, `isTransfer`-style branch extended); `src/lib/server/transactions/repo.ts`
  (`insertTransactions`'s JSON payload); `src/lib/server/transactions/aggregate.ts` (every site listed in
  Scope — this is the file with the most lines to touch and the highest cost of a missed one);
  `src/lib/server/transactions/wallet-sum.ts` (the one place that must count it);
  `src/lib/shared/transactions.ts` (`TRANSACTION_TYPES`/labels gain `'adjustment'`);
  `src/lib/shared/riwayat-query.ts` (`RiwayatView['type']`); `src/routes/(app)/riwayat/baru/` and
  `[id]/edit/` (form + restricted edit); i18n files.
- Reuses, unchanged: `walletBalanceMinor`/`walletTransactionsSums` (read, not rewritten, except the one `case`
  branch above); `insertTransactions`'s guarded-insert and `refsHold` machinery (an adjustment's wallet still
  must be live and in the space, exactly like any other row — `refsHold`'s category-less branch for `transfer`
  is extended to also match `adjustment`, `src/lib/server/transactions/repo.ts:123-136`); the existing
  amount-input/digits parsing (`src/lib/shared/amount-input.ts`) for the "Saldo baru" field, since it is the same
  kind of whole-unit currency input as "Saldo awal" already uses.
- Does not touch: `src/lib/server/wallets/repo.ts`'s `updateWallet` opening-balance path (named in the PRD header
  as an existing, separate gap, intentionally out of scope).

## Prerequisites

None. No new secret, provider or credential. Uses the existing D1 binding only.

## Owner decisions

- **A — Can an adjustment be amount-edited after creation?** Default: **no** — only date/title/note are
  editable; to correct the amount, delete and recreate. Trade-off: slightly more friction for a typo (two actions
  instead of one), but it avoids a confusing ledger state where an "adjustment" no longer reflects any real
  stated balance at any point in time (if the amount could be edited freely, "this sets the wallet to X" stops
  being true for any X once the surrounding transactions have since changed). Alternative (allow amount edits)
  is simpler for the user but weakens the row's meaning.
- **B — Can an adjustment take a wallet negative, or must it be refused?** Default: **allowed** — the ledger
  already lets expenses exceed a wallet's balance (credit cards, overdrafts are real); an adjustment is no
  different and must not add a special-cased refusal the rest of FN-05 does not have.
- **C — Direction representation.** Default: a new `adjustment_direction` column (`increase`/`decrease`) rather
  than allowing `amount_minor` to be signed for this one type. Trade-off: one more column and one more CHECK
  clause, versus breaking the project-wide convention that `amount_minor` is always a positive magnitude
  (`src/lib/shared/transactions.ts:6-7`) for just one type, which would make every future reader of
  `amount_minor` have to remember a type-specific exception. The column keeps the convention uniform at the cost
  of a slightly wider table.
- **D — Default title when the user leaves it blank.** Default: an auto-filled title through `tr()`, e.g.
  "Penyesuaian saldo," rather than "Tanpa judul" — adjustments are self-explanatory and a blank-looking row in
  Riwayat would be confusing without it.

## Tracker impact

Closes the "balance adjustment type" slice of `docs/TASKS.md` › App layout parity › "New features seen in the
reference app (PRDs first): FN-34 streak / close the day, FN-35 money-flow chart, recurring transactions, balance
adjustment type." Directly exercises and should move `docs/ACCEPTANCE.md` › Money and dates › "Beranda total =
Riwayat total for the same filter" from **Not run** to a real status once this feature's regression test
(criterion 4) runs, since that row's guarantee is exactly what a missed exclusion site would silently break.
