# SECURITY_REPORT — ui-parity-c

Reviewer: red-team-pentester, 2026-10-08. Scope: `git diff main...HEAD` (main 11e66ee, HEAD a555d58).

## Verdict: PASS

No medium or high findings. Two low findings tracked below.

## Checked

- **Migration 0020 / `category_budgets`**: `space_id` NOT NULL with cascade, `updated_at`, `deleted_at`, `seq`;
  unique (space_id, category_id); CHECK ties tombstone to amount 0 (content-free tombstone). Added to
  `SPACE_SCOPED_TABLES` before `categories`, so `purgeSpaces` (space delete and account delete) removes it first;
  `SPACE_TABLE_DECISIONS` is type-keyed on that list and exports it as JSON (FN-31). Integration test
  `purgeSpaces deletes the space's category budgets and nothing of another space` passes.
- **Budget actions (`src/lib/server/budgets/actions.ts`, `category-repo.ts`)**: space comes only from
  `currentSpaceScope(locals)` (requireSpaceAccess); no budget id read from the client; every write statement
  repeats `isLiveMember` and `liveExpenseCategory(spaceId, categoryId)` inside the guarded UPDATE/INSERT…SELECT,
  so another space's category id, an income category, a tombstoned category or a member removed between gate and
  write change nothing (`missing` 404 / `gone` 404). Category id capped at ID_MAX_LENGTH. Role: budgets are
  shared-space data editable by Pemilik and Anggota alike, matching the existing FN-07 total-budget rule; no
  member-management path touched.
- **Amounts**: `parseBudgetForm` uses `wholeAmountMinor` (no parseFloat), zod int/positive/max MAX_AMOUNT_MINOR;
  currency allow-listed then checked against the space's wallets (`isBudgetCurrency`). Negative, zero,
  fractional, overflow all 400.
- **Stale forms / concurrency**: updates guarded on `updated_at`; create path INSERT…SELECT WHERE NOT EXISTS +
  ON CONFLICT DO NOTHING; 20-concurrent-create test leaves one live row.
- **CSRF**: plain SvelteKit form actions, no `csrf.checkOrigin` override found; FiturSheet posts same-origin to
  `/pengaturan/fitur?/setFlag`.
- **/dompet loader**: wallets, sums and goals all read with `scope.spaceId` from requireSpaceAccess;
  `balanceTotals` / `goalsSetAside` sum per currency with BigInt, never across currencies; `?ubah=` only
  selects among already-scoped wallets. Wallet actions moved from /kekayaan unchanged (space-scoped repo).
- **/kekayaan**: same gate via requireSpaceAccess.
- **Fitur sheet**: `feature_flags` are per user (no space_id); setFlag writes only `locals.user.id`, module
  allow-listed. No shared-space escalation.
- **Impor pickers**: `defaultWalletId` still resolved server-side via `getWallet(db, spaceId, id)`
  (`csv-import.ts:260`); client choice is only a request.
- **Usage statistics**: vocabulary adds fixed screen names `dompet`, `anggaran` only; no ids or amounts.
- **Loaders**: no secrets, tokens or env values serialised; new logs use `errorLabel(e)` only.
- **Injection / XSS**: Drizzle `sql` template parameters throughout; no `{@html}` in changed Svelte files; keyed
  `{#each}` by db id or index.
- **Engineering checklist**: bounded reads (LIMIT MAX_CATEGORIES_PER_SPACE), db.batch, one currency per sum,
  stale-form compare, cross-space and removed-member tests present.

## Findings

1. **Low — live category budget survives its category's tombstone.**
   `src/lib/server/budgets/category-repo.ts` (reads join live categories; category delete does not tombstone the
   budget). Scenario: user sets a budget on "Kopi", then deletes the category; the `category_budgets` row stays
   with `deleted_at` null and its amount, is hidden from every read, but still appears in the FN-31 JSON export
   and is not reported as a tombstone to any future sync pull. No cross-space exposure; data-hygiene only.
   Suggest tombstoning the category's budget in the category-delete batch.
2. **Low — FK does not bind the category to the same space.**
   `migrations/0020_category_budgets.sql:11` references `categories(id)` only, not `(space_id, id)`. The
   same-space rule is enforced solely in application SQL (`liveExpenseCategory`), which is correct today; a
   future write path (e.g. sync push) that forgets it could store a budget pointing at another space's category.
   Reads join on `categories.space_id = category_budgets.space_id`, so no leak results. Suggest a composite FK or
   a test pinning it when sync push lands.

## Commands

- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 test/integration/anggaran.test.ts test/integration/dompet-routes.test.ts test/integration/privacy.test.ts` → 3 files, 55 tests passed.
- No wrangler dev started; no probe files written.
