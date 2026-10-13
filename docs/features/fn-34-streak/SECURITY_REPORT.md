# FN-34 Streak / Tutup hari — Security report (phase review)

Reviewed: `git show 5a4cf41` (on main at 2246744), against `docs/ENGINEERING_CHECKLIST.md`. Read-only worktree.

## Verdict: PASS

No medium or high findings.

## What was checked

- **closeDay action** (`src/routes/(app)/+page.server.ts:52-59`): reads no form field; user id is `locals.user.id`
  (via `currentSpaceScope`, which redirects a signed-out visitor to `/masuk`); the date is `wibDateString(Date.now())`
  on the server. No client date or id can reach another account or day.
- **CSRF**: no `csrf`/`checkOrigin` override in `vite.config.ts` or hooks, so SvelteKit's default origin check
  covers the form POST.
- **Idempotency / concurrency / replay** (`src/lib/server/streak/repo.ts:22-44`): one guarded `INSERT … SELECT …
  WHERE EXISTS(user) AND NOT EXISTS(closure)` plus `ON CONFLICT DO NOTHING`, backed by the unique index
  `(user_id, closed_on)`; all values bound parameters (Drizzle `sql` template). Integration test with 20 concurrent
  closes leaves exactly one row; a replayed POST is a no-op.
- **Streak read** (`repo.ts:47-63`): filtered by `user_id` only, bounded to 400 days and 400 rows; no cross-account
  path. Account-wide by owner decision A, so space membership is not involved in the read.
- **Migration 0021**: FK to `users` with `ON DELETE CASCADE`; unique index; explicit delete also added to
  `deleteAccount` (`src/lib/server/auth/delete-account.ts:100-101`) behind the same `proof` guard.
- **Export**: `day_closures` added to `ACCOUNT_TABLES` with `export: 'json'`; account tables are filtered by
  `user_id = <locals.user.id>` (`src/lib/server/export/tables.ts:274-275`).
- **Errors**: streak load failure logs `errorLabel(e)` only (no SQL text/values); action failure is a bare 404 or
  SvelteKit's generic 500 (`handleError` logs `errorLabel` only).
- **Page data**: only `{ current, closedToday }` serialised; no ids, no secrets.

## Findings

1. **Low — closing the day depends on current-space access** (`src/routes/(app)/+page.server.ts:53`). The account-
   scoped write goes through `currentSpaceScope`, so a user whose `locals.space` became stale (removed from a shared
   space) gets a 404 on that request instead of closing their own day. Not exploitable (fails closed); availability
   and consistency only. Repro: remove member B from a shared space while B's session still names it, POST
   `/?/closeDay` as B → 404 (the next request resolves the personal space).
2. **Low — no CHECK constraint on `day_closures.closed_on` format** (`migrations/0021_streak.sql:5`). Only the server
   writes it (`wibDateString`), so not reachable from a client today; a future writer passing a non-`YYYY-MM-DD`
   string would silently break the streak count. Tracked only.

## Commands

- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 test/integration/streak.test.ts
  src/lib/server/streak src/lib/server/reports/money-flow.test.ts src/lib/shared/money-flow.test.ts
  src/lib/ui/charts/geometry.test.ts src/lib/server/export` → 6 files, 49 tests passed.
- `npm run gates` / `npm test` not run (RAM limit).
