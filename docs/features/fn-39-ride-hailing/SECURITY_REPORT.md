# FN-39 Ride-hailing and food delivery: Security Report

Reviewer: red-team-pentester. Scope: `git diff main...HEAD` at c093905 (review worktree `.claude/worktrees/fn-39-rt`), Large tier
(migration + new external-input parsing). Checked against `docs/ENGINEERING_CHECKLIST.md`.

## Verdict: PASS

No medium or high findings. The low and informational items below are recorded for tracking.

## Findings

### L1 (low): migration 0027 on remote D1 is only as atomic as D1's multi-statement `/query`
`migrations/0027_ride_food_categories.sql:15-21, 157-160`. Wrangler (`buildMigrationQuery` and `executeSql`) sends the whole file plus
the `d1_migrations` insert as one command. Locally that runs as one `db.batch` and is atomic. Remotely it goes to the
D1 `/query` endpoint. If that run stopped between clearing `transactions.category_id`/`recurring_series_id`/`drafts.category_id`
(lines 19-20) and restoring them (lines 157-159), the category and series links would exist only in `__fn39_links`.
That state fails safe: a re-run stops at `CREATE TABLE __fn39_links` (no `IF NOT EXISTS`), so the scratch copy
is never overwritten. Recovery would still be manual. The comment's "repeats cleanly" (line 12) is only true after
a complete run. Mitigation already exists: RUNBOOK §deploy prints the Time Travel bookmark before `--remote`. Keep that
bookmark and the pre/post row counts of `transactions`, `drafts`, `recurring_transactions`, `category_budgets` and
`categories` for this migration in particular.

### I1 (info): GET loaders write presets for existing spaces
`src/lib/server/categories/repo.ts:60-72, 94-121`. `ensurePresetCategories` now inserts two rows into existing spaces
on their next category load. That includes `GET /api/v1/categories` with an API token. This is the same write-on-read pattern
as the first seed. The write is scoped to the gate-admitted `spaceId`, guarded in one statement (NOT EXISTS per tile,
preset count < 17, live space), and runs in one `db.batch` with a seq bump. No cross-space write, and no recreation of a
preset that was renamed, hidden, re-tiled or tombstoned: the count includes `deleted_at` rows. Tests cover 20
concurrent top-ups. No action needed.

### I2 (info): CSV/statement ride/food guess resolves by the preset's current name
`src/lib/server/imports/csv-import.ts:330-340, 388-391`. If a visible custom category with the same name and kind
sorts earlier, the row goes to that category. It is the same space and the user can see and edit it, so there is no isolation impact.

## Areas checked with no issue

- **Migration integrity.** The 0026 and 0027 drizzle snapshots match for `categories`, `category_budgets`,
  `recurring_transactions`, `transactions` and `drafts` (columns, indexes, FKs and checks), apart from the widened
  `categories_tile_key_check`. All indexes are recreated, including the partial `recurring_transactions_due_idx` and
  `categories_space_id_uq`, which the composite FK needs. `category_budgets` gets back its composite FK
  `(space_id, category_id) → categories(space_id, id)`, so a budget still cannot point at another space's category.
  The `category_budgets_follow_category` trigger is recreated unchanged. No other triggers exist on the touched tables.
  The only FKs into the rebuilt tables are transactions, drafts, recurring_transactions and category_budgets, and all
  are handled. `transactions.recurring_series_id` (ON DELETE SET NULL) is set aside and restored. `__fn39_links`
  and the `__new_*` tables are dropped. `updated_at` and `seq` do not change, so nothing syncs as edited.
- **Cap.** `MAX_CATEGORIES_PER_SPACE` (100) still gates user creation (`repo.ts:209, 339`) and import room
  (`csv-import.ts:398`; a negative room skips new names). `CATEGORY_LIST_MAX` (102) only raises list limits so a
  space that was at the cap does not lose rows from its lists. The top-up adds at most two rows, ever.
- **Keyword guesser** (`src/lib/shared/category-keywords.ts`). It uses `Object.hasOwn` on plain objects, so `__proto__`,
  `constructor` and `valueOf` return undefined (probed). Input is cut to `TITLE_MAX_LENGTH` before the split, and the
  split regex `[^\p{L}\p{N}]+` is linear: a 10 MB title returns in 5 ms. Homoglyphs (Cyrillic О) and dotted İ do not match,
  so they fail closed. A lone surrogate is harmless. The output is only a `TileKey`. Voice maps it client-side
  against the space's own `data.categories` and the save is re-validated server-side. CSV/statement maps it against
  `listCategories(db, spaceId)`. Income rows are never guessed: voice checks `type === 'expense'` and imports return the
  income fallback.
- **Wallet quick pick `?tambah=1&dompet=<id>`** (`dompet/+page.server.ts:89-91`). The value is matched against the
  `WALLET_QUICK_PICKS` allowlist, and only the constant id reaches page data. The client re-resolves it through the same allowlist.
  Nothing is reflected, links are same-origin constants with no redirect, and there is no `{@html}`. The form still posts
  through the normal validated `create` action.
- **Langganan `?tambah=<id>`.** An unknown id gives `catalogueEntry` → null, which opens the typed-name form. The server
  refuses an unknown or prototype `catalogueId` (`subscriptions/validation.ts:106-107`). The catalogue holds no price,
  so the amount is always typed.
- No new secrets, logging, SQL interpolation (all `sql` template values are bound), R2 or upload paths.

## Commands

- `flock … npx vitest run --maxWorkers=2 test/integration/migration-0027.test.ts test/integration/transactions.test.ts
  src/lib/shared/category-keywords.test.ts src/lib/server/imports/csv-import.test.ts src/lib/shared/wallets.test.ts
  test/integration/dompet-routes.test.ts` → 6 files, 90 tests passed.
- `npx tsx` probe of `importCategoryFromTitle`/`categoryHintFromWords` (prototype keys, 10 MB input, homoglyphs) → all
  undefined or correct, 5 ms.
