# FN-34 Daily streak and "Tutup hari" — engineer report (cycle 1)

Branch `fn-34-streak` (worktree `.claude/worktrees/fn-34-streak`), based on main 253a939.

## What works, per acceptance criterion

1. Open day: the "Hari ini" card shows today's totals (or "Belum ada transaksi hari ini.") and a full-width primary
   "Tutup hari ini" button (size lg, 52 px). The previous card action ("Lihat transaksi hari ini" / "Catat
   transaksi") stays as a text link above it, so no path is lost. — e2e `beranda.spec.ts` FN-34 test.
2. `?/closeDay` writes one `day_closures` row for `(locals.user.id, server WIB date)`; with JavaScript the card
   re-renders in place (enhance + load re-run) to "Hari ini ditutup · 1 hari berturut-turut" (`role="status"`),
   the button is gone. Success shows only after the server answered. — integration + e2e.
3. Reload / second device / other tab: load reads the stored row, closed state and count persist. — integration
   (two loads after close) + e2e reload.
4. Unbroken days count up by exactly one per day; yesterday's run still counts while today is open. — unit
   `count.test.ts` + integration.
5. Gap (closed 3 days ago only) → 0, nothing back-filled. — unit + integration.
6. WIB boundary: action at 23:30 WIB 31 Oct and 00:30 WIB 1 Nov (same UTC date) → `2026-10-31` and `2026-11-01`;
   the closed day is `wibDateString(Date.now())` on the server, never a form value. Fail-before shown: with the
   UTC date the test fails (UNIQUE collision).
7. Double submit: guarded `INSERT … SELECT … WHERE NOT EXISTS … ON CONFLICT DO NOTHING` + read-back in one
   `db.batch`; 20 concurrent actions and 20 concurrent repo calls → one row, no error. Fail-before shown: without
   the guard the same tests fail with `UNIQUE constraint failed`.
8. Account-wide: closing from a shared space's Beranda shows closed on the personal one; the other member of that
   space keeps their own streak (0).
9. Scoped to `locals.user.id` only: form fields `userId`/`user_id`/`closedOn` are ignored (test); signed-out →
   303 `/masuk`; a removed member naming the old space is resolved to their personal space by the existing gate
   (`currentSpaceScope` runs on the action and the load).
10. The streak loads beside the figures and lists (own `.catch`): a failing streak read (table renamed in the test)
    leaves summary and lists loaded, `streak: null` → no chip, card shows "Tutup hari belum bisa dimuat." plus the
    existing button. Logged with `errorLabel` (no query parameters). A failing summary keeps the existing
    whole-page ErrorState as before.
11. English entries for every new phrase (i18n coverage test passes).
12. 360 px: e2e phone project asserts button height ≥ 44 px, full card width, no horizontal scroll before and
    after closing; chip is the existing `.day-chip` style.
13. Zero closures → `{ current: 0, closedToday: false }`; chip reads "Belum ada hari berturut-turut".

Top-bar chip: the wave-A placeholder `Hari ke-{n}` in `src/routes/(app)/+page.svelte` is replaced by the streak
chip (only one chip ever shows); the unused English entry `Hari ke-{n}` was removed.

## Deviations from the PRD (flagged for QA)

- `berandaSummary` is unchanged: the PRD both asks to extend its return and forbids changing its call signature,
  and it has no user id. The streak is read in the Beranda load next to it (`data.streak`), which also gives
  criterion 10 its partial-failure behaviour.
- Action name `closeDay` (camelCase like `setBudget`/`deleteBudget`), not `close-day`.
- Migration is `0021_streak.sql` (caller instruction; wave C holds 0020).
- `day_closures` is added to the FN-31 export (`ACCOUNT_TABLE_DECISIONS`, json) and deleted explicitly in
  `deleteAccount` (also FK cascade) — required by the export registry test and the deletion contract.

## Files

- New: `migrations/0021_streak.sql`, `migrations/meta/0021_snapshot.json`, `src/lib/server/streak/count.ts`,
  `src/lib/server/streak/count.test.ts`, `src/lib/server/streak/repo.ts`, `test/integration/streak.test.ts`.
- Changed: `migrations/meta/_journal.json`, `src/lib/server/db/schema.ts` (`dayClosures`),
  `src/routes/(app)/+page.server.ts`, `src/routes/(app)/+page.svelte`, `src/lib/shared/i18n-en.ts`,
  `src/lib/server/export/tables.ts`, `src/lib/server/auth/delete-account.ts`, `e2e/beranda.spec.ts`.

## Migration and Drizzle chain

`0021_streak.sql`: `day_closures` (id, user_id FK users cascade, closed_on, created_at, updated_at) + unique
index `(user_id, closed_on)`. Journal entry `idx 20`, tag `0021_streak`; `0021_snapshot.json.prevId` = 0019's id.
`drizzle-kit generate` → "No schema changes"; `drizzle-kit check` → fine.
Re-chain at merge after wave C's 0020: take main's journal (with 0020 at idx 20), append this entry as `idx 21`
(tag `0021_streak`), set `0021_snapshot.json.prevId` to `0020_snapshot.json`'s `id`, and merge the 0020 tables
into 0021's snapshot by regenerating: delete `0021_snapshot.json` + the journal entry + `0021_streak.sql`, run
`npx drizzle-kit generate --name streak`, rename the output to `0021_streak.sql`/`0021_snapshot.json` (it will
already be 0021), restore the comment line. Wrangler applies by file name, so the SQL itself needs no change.

## Pre-handoff probes

- Month boundaries (WIB): 23:30 WIB 2026-10-31 and 00:30 WIB 2026-11-01 → two `closed_on` dates, streak 2 — PASS.
- Concurrency: 20 concurrent `closeDay` actions + 20 concurrent repo calls → exactly 1 row each day, all ok — PASS.
- Two devices: same day closed twice (different `now`) → 1 row, second reports closed — PASS.
- Cross-space / two users: shared-space close counts on personal space; co-member unaffected; non-member/removed
  member only ever write their own row; form ids ignored — PASS.
- Two tabs / stale forms: closing is monotonic and idempotent, no `updated_at` needed — PASS (concurrency test).
- 360 px: e2e phone project, tap target ≥ 44 px, no horizontal scroll — PASS.
- User copy: no ids or paths in new phrases — PASS (reviewed).
- No-JS forms: plain `method="POST" action="?/closeDay"`; not exercised with JavaScript disabled — NOT RUN.
- Money vectors: not applicable (no money).

## Gates (each step run separately under the heavy lock; `npm run gates` not run per RAM rule)

- `npm run check`: 1463 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
- `npm run lint`: All matched files use Prettier code style! ; eslint clean
- `npx vitest run --maxWorkers=2`: Test Files 157 passed (157), Tests 2259 passed (2259)
- `npm run build`: ✔ done
- `npm run db:migrate:local` (fresh persist dir): exit 0, 0000–0019 and 0021_streak ✅
- `npx playwright test e2e/beranda.spec.ts --workers=1` (E2E_PORT 8834, CI=1): 16 passed, 1 skipped

## Not verified

No-JS submit by hand; dark-theme visual check (uses existing tokens `--ink`, `--money-in`, `--panel` only);
desktop sidebar has no chip (unchanged, the top bar shows the chip on both layouts).
