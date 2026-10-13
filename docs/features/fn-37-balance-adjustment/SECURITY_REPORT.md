# FN-37 Balance adjustment — Security report

Reviewer: red-team-pentester, cycle 1. Scope: `git diff main...HEAD` at 37227ef (branch `fn-37-balance-adjustment`),
PRD, ENGINEER_REPORT (cycles 1–2), QA_REPORT (PASS), `docs/ENGINEERING_CHECKLIST.md`.

## Verdict: PASS

No medium or high findings. Three low findings are listed so they are tracked.

## What was checked

### 1. Migration 0022 (rebuilding `transactions` on D1)

- **Atomicity.** `wrangler d1 migrations apply` (wrangler 4.148.0, `node_modules/wrangler/wrangler-dist/cli.js`
  ~234190–234260) sends each migration file plus its `d1_migrations` insert as **one** `executeSql` command; the
  command's own help text says "If applying a migration results in an error, this migration will be rolled back,
  and the previous successful migration will remain applied." A failure anywhere (for example the copy
  `INSERT … SELECT` hitting the new CHECK) leaves the database as it was before 0022, with the links still on
  `drafts`/`subscriptions` and no `__fn37_links`. No half-cleared link state can remain on remote.
- **Links set aside and restored.** Only `drafts.saved_transaction_id` and `subscriptions.linked_transaction_id`
  reference `transactions` (grep of every migration, and `schema.ts:510,848`). Both are copied to `__fn37_links`,
  nulled, then restored after the rename by id; every transaction id is copied, so the restore satisfies the
  enforced FK. `updated_at`/`seq` are not touched, so nothing syncs as edited. The scratch table is dropped last.
- **Other dependants.** No trigger is defined on `transactions`, `drafts` or `subscriptions` (the triggers are on
  billing tables, `consent_records`, `categories`); no views. Columns (24 copied + `adjustment_direction`),
  the 5 indexes (incl. the partial unique `transactions_dedupe_uq`) and the 5 FKs match the 0021 snapshot.
- **CHECK change.** `(type <> 'transfer' or category_id is null)` became `(type in ('expense','income') or
  category_id is null)`: identical for existing rows. Direction is required exactly on a live adjustment and
  cleared on a tombstone.

### 2. Adjustment create / edit / delete

- **Space and wallet IDOR.** `adjust` (`riwayat/baru/+page.server.ts`) takes the space only from
  `currentSpaceScope(locals)` (membership re-checked); the wallet is read with `getWallet(db, spaceId, id)`;
  the insert repeats `isLiveMember` and the wallet ref check (`repo.ts` `refsHold`). Integration test 11 covers
  stranger and removed member (404, nothing written). `?wallet=` on the load only picks from this space's list.
- **Tampering.** The form sends only `walletId`, `balance` (whole-unit text, 13-digit cap, no floats) and
  `negative`. Direction and difference are computed on the server from a balance read at submit time
  (`readWalletBalance`, BigInt-exact); the client's displayed balance is never trusted. `|diff| > 10^13` is
  refused before the DB CHECK. 13 digits × 10^exponent stays exact.
- **Stale balance / race / replay.** The insert is guarded by `walletBalanceSql(...) = current` inside the same
  `INSERT … SELECT` (D1 serialises writes), with 3 bounded re-reads; a resubmitted POST re-reads, finds the
  balance already equal and writes nothing ("Saldo sudah sama"). Test 16 (20 concurrent submits → one row;
  concurrent spending) passes.
- **Type changes.** The generic compose/edit validator accepts only `FORM_TRANSACTION_TYPES` (no `adjustment`),
  so no row can become an adjustment; an adjustment's edit uses `adjustmentEditInput`, which keeps type, amount,
  direction, wallet and currency from the stored row whatever the form sends. Delete tombstones via the existing
  path (direction cleared). Optimistic `updatedAt` check still applies.
- **CSRF.** Plain SvelteKit form actions; no `csrf`/`checkOrigin` override in `vite.config.ts`/svelte config.

### 3. Money aggregates exclude `adjustment`

Grepped `type`, `'transfer'`, `<>`, `!=`, `not in`, `from/join transactions` across `src` and `workers`.
`aggregate.ts` now sums only `MONEY_ROWS = type in ('expense','income')` (period, daily, category, monthly,
category-monthly, day headers, Catat lagi, CSV export) and `foldTotals` skips non-money types. Budgets,
Anggaran, budget alerts, safe-to-spend and Laporan call these with `type: 'expense'`/`'income'` or count only.
`recordAgain` refuses non-money types; the daily nudge ignores adjustments; the account-export CSV uses
`type in ('expense','income')`; `subscriptions/repo.ts:392` matches `type = 'expense'` only. `wallet-sum.ts`
is the one place adjustments count (± by direction), and net worth reads it. The jobs worker has no own
transaction sums. FN-35's `moneyFlowTotals` on main (not yet in this branch) already selects
`type in ('income','expense')`, so the merge does not reintroduce a counting site (aggregate.ts will need a
textual merge only).

### 4. Account export `transactions.json`

Rows come from `tablePages` with `scopeWhere`: `space_id = ?` plus `isLiveMember` on every page and
`deleted_at is null`, per live space of the caller. `dedupe_key` omitted, `space_id`/`seq`/`deleted_at`
always omitted; `title`, `note`, `tag`, `reference`, `payment_method`, `recurrence` masked to the last 4
digits. No secrets or other users' columns (the table has no user column).

### 5. Secrets, i18n, HTML

No `{@html}` and no new `console.*` in the diff. Loaders add only wallet balances of the current space and
the adjustment's own fields. New phrases have English entries (QA i18n test). `/riwayat?saved=` is a
fixed allow-list.

## Findings

### L1 (low) — The generic compose/edit form still offers "Penyesuaian saldo", which the server refuses

`src/lib/ui/transactions/TransactionForm.svelte:84` builds the type control from `TRANSACTION_TYPES`, which now
contains `adjustment`. Choosing it on `/riwayat/baru` or an expense's edit page and saving returns the
`TYPE_INVALID` field error (the server validator only accepts `FORM_TRANSACTION_TYPES`). Not exploitable — the
server holds the line — but it is a dead primary option. Use `FORM_TRANSACTION_TYPES` there (or link to
`?type=adjustment`). Reproduction: open `/riwayat/baru`, pick "Penyesuaian saldo", enter an amount, save → type
error.

### L2 (low) — `transactions.json` in the account export includes `Data demo` rows

`src/lib/server/export/tables.ts:74` exports every live row; `scopeWhere` has no `is_demo` filter, while the
CSV beside it excludes demo rows ("fictional rows never leave as real data"). Rows carry `isDemo: true`, so they
are labelled, and drafts/other JSON tables already behave the same way; still, a demo-seeded account's export
mixes fictional money rows into the file a user may re-import elsewhere. Consider excluding `is_demo = 1` or
noting it in `account.json`. Reproduction: seed demo data locally, export the account, see `isDemo: true` rows
in `spaces/*/transactions.json`.

### L3 (low, operational) — 0022 relies on per-file rollback and is not re-runnable by hand

`migrations/0022_balance_adjustment.sql:8` creates `__fn37_links` without `IF NOT EXISTS` and nulls the links
before the rebuild. Through `wrangler d1 migrations apply` this is safe (one command, rolled back on error).
Run any other way (e.g. `wrangler d1 execute --file` split into chunks, or pasted statement by statement in the
dashboard), a failure after the `UPDATE … = NULL` lines would leave drafts/subscriptions unlinked until the
scratch table is replayed. Per the checklist ("RUNBOOK notes the D1 Time Travel bookmark"), take the bookmark
before the remote apply and apply only through `migrations apply`; `PRAGMA defer_foreign_keys = on` is the
D1-documented alternative for future rebuilds.

## ENGINEERING_CHECKLIST

Guarded single-statement writes in `db.batch` with a concurrent test (yes); bounded queries (balance read is
one wallet, aggregates in SQL); integer money, no `parseFloat` (yes); migration not editing an applied one
(yes; Time Travel bookmark per RUNBOOK before remote apply — see L3); CSV export prefixes unchanged.

## Commands run

- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 test/integration/balance-adjustment.test.ts src/lib/server/transactions/adjustment-validation.test.ts`
  → 2 files passed, 29 tests passed.
- `npm run gates` / `npm test` not run (RAM limit instruction).
