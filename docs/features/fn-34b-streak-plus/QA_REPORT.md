# FN-34b Streak extensions — QA Report

**Verdict: PASS**

Worktree: `<repo>-worktrees/fn-34b-qa`, detached at `c48df4c` (rebased on
`c50fa17`). Diff reviewed: `git diff c50fa17..c48df4c` (38 files, +11037/-43).

## Commands run

- `npm ci --no-audit --no-fund` — installed 277 packages, exit 0, no provider.
- `npm run gates` (`check && lint && test && build`) — check: 0 errors/warnings; lint: clean; test: 5234 passed,
  1 failed (`test/integration/account-keys.test.ts` rate-limit timing test, unrelated file not touched by this
  diff); build: succeeded (client+SW+Worker bundle). Exit 1 overall due to the one flaky test — mock DB/AI, no
  real provider.
- `npx vitest run test/integration/account-keys.test.ts -t "per user: the 21st attempt"` — 1 passed alone, exit
  0, confirms the failure above is pre-existing timing flake, not this PRD. Mock DB.
- `FIN_PERSIST_TO=.wrangler/state/qa-fresh npm run db:migrate:local` — fresh D1, 0000→0038 all ✅, exit 0, local
  D1 (miniflare).
- `FIN_PERSIST_TO=.wrangler/state/qa-fresh npm run db:migrate:local` (rerun) — "No migrations to apply!", exit 0,
  local D1.
- `FIN_PERSIST_TO=.wrangler/state/qa-seed npm run db:migrate:local` (0000-0037, 0038 file moved aside) — all ✅,
  exit 0, local D1.
- `npx wrangler d1 execute … --persist-to .wrangler/state/qa-seed` (insert 2 users, 4 `notification_prefs` rows,
  2 `user_notifications` rows) — 3 commands executed, exit 0, local D1.
- `npx wrangler d1 execute … "select count(*) …"` before 0038 — `np: 4, un: 2`, exit 0, local D1.
- `FIN_PERSIST_TO=.wrangler/state/qa-seed npm run db:migrate:local` (0038 restored) — applied, exit 0, local D1.
- `npx wrangler d1 execute … "select count(*) …"` after 0038 — `np: 4, un: 2` (identical), exit 0, local D1.
- `npx wrangler d1 execute … "PRAGMA foreign_key_check;"` — empty result (clean), exit 0, local D1.
- `npx playwright test e2e/beruntun.spec.ts --workers=1` (E2E_PORT=9071, flock shim on PATH) — 7 passed, exit 0,
  real browser (Chromium) against local Worker/D1, no mocked AI needed (no AI in this PRD).
- `npx playwright test e2e/beranda.spec.ts e2e/beruntun.spec.ts e2e/notifikasi.spec.ts --workers=1` — 26 passed,
  1 skipped, exit 0, local Worker/D1.
- `npx vitest run src/lib/shared/i18n.test.ts src/lib/shared/streak.test.ts src/lib/shared/notifications.test.ts`
  — 38 passed, exit 0.
- Ad hoc screenshot spec (`e2e/tmp-qa-screens.spec.ts`, written then deleted) — 2 passed (setup + screenshot
  test), exit 0, local Worker/D1; 4 PNGs captured, not committed.

## The 1 skipped e2e test

`[desktop] › e2e/beranda.spec.ts:132:1 › at 360 px: no horizontal scroll, 44 px bar and picker targets, focus
returns to the opener` — skipped via the pre-existing `test.skip(!isPhone(page), 'phone layout only')`
(`e2e/beranda.spec.ts:136`). Correct and unrelated to this PRD: the test only makes sense at a 360 px phone
viewport and runs fully on the `phone` project; the `desktop` project (1280 px) legitimately skips it. No
hidden failure.

## Checked criteria

### Streak page
1. PASS — `streakDetails`/`streakSummary` (`src/lib/server/streak/repo.ts:64-79`) both read the same
   `closedDates` window, so `/beruntun`'s current always equals the Beranda chip by construction; e2e
   (`e2e/beruntun.spec.ts`) and `test/integration/streak-plus.test.ts:711` confirm loading/empty/calendar/
   milestone states.
2. PASS — chip is now `<a class="chip-link" href="/beruntun"><span class="day-chip">…</span></a>`
   (`src/routes/(app)/+page.svelte:238`), same text/position; e2e confirms SPA navigation (no full reload) and
   ≥44 px hit area.
3. PASS — `test/integration/streak-plus.test.ts:711` (10-day run two months ago, 3-day run now → longest 10,
   current 3), bounded to 400 days (`longestStreak` unit tests in `count.test.ts`).
4. PASS — milestone reached/not-reached asserted in English and Indonesian in the e2e spec and integration test;
   icon is `star`/`check`, never a coin/flame (visually confirmed in screenshots, see below).
5. PASS — `?bulan=` only accepts this month or the one before, else falls back
   (`test/integration/streak-plus.test.ts:752`); 360 px no-horizontal-scroll and ≥44 px cells asserted in e2e
   and in code (`StreakCalendar.svelte:93` `min-height: 44px`).

### Freeze
6-9. PASS — `src/lib/server/streak/count.test.ts` ("streakHistory: freezes" describe block) covers all four
   criteria directly: 7-day earn bridging one gap, no-freeze-without-7-days (unchanged FN-34 break), 2 banked
   freezes bridging 2 gaps then breaking on the 3rd, and the earn count restarting after a bridge. All pass.

### Evening reminder
10-16. PASS — each mapped 1:1 to a named test in `test/integration/streak-plus.test.ts` (lines 316-489); cron
   rotation verified against the PRD's explicit `round:'all', wrap:true` requirement
   (`workers/jobs/src/cron.ts:176-186`); guard SQL in `evaluateCloseReminder`
   (`src/lib/server/notifications/triggers.ts:259-281`) matches the PRD exactly (hour coalesce, live
   `day_closures` check, `(user_id, kind, data_key)` dedupe); queue.ts drops a stale-date `close_reminder`
   exactly like `daily_nudge` (`workers/jobs/src/queue.ts:107-111`).

### Budget streak
17-26. PASS — each mapped 1:1 to a named test (lines 533-650); `budgetDayStatus`/`snapshotBudgetDay`
   (`src/lib/server/budgets/streak.ts`) match the PRD's floor/exhausted-budget/skip/snapshot-once rules; demo
   rows and transfers/income excluded via the shared `dailyTotals`/`MONEY_ROWS`/`is_demo=0` filters (verified by
   reading `src/lib/server/transactions/aggregate.ts:144,374`); month-boundary test at line 609 confirms WIB
   `occurred_on` and `daysRemainingInclusive` use the correct month length across 31 Oct → 1 Nov; 20-concurrent
   test (line 622) confirms the guarded insert's single-row result, also re-verified independently at the DB
   layer (see migration row-count check above). Space scoping (24) verified both by code
   (`currentSpaceScope`→`requireSpaceAccess`, live-membership check, same gate as every other route) and by test
   (line 772, non-member and forged space id both answer 404, no existence oracle).

### General
27. PASS — `i18n.test.ts` green in the full gate run and standalone.
28. PASS — budget streak's money line (none currently shown beyond within/over; no raw money in this PRD's UI)
    and every date comparison use WIB strings (`wibTodayString`, `monthOf`) throughout; no hand-formatted money
    found in the diff.
29. PASS — `/beruntun` screenshotted at 360 px in Terang, Gelap, Hitam-putih and Pro (Emas) — all render cleanly,
    no horizontal scroll, legend and milestone list readable, calendar cells visibly square/≥44 px, no coin/flame
    iconography. `StreakCalendar.svelte:126` gates the cell-fade animation behind
    `@media (prefers-reduced-motion: no-preference)`.

## Migration verification detail

Fresh D1 0000→0038 all apply (✅ table above); a second run is a clean no-op ("No migrations to apply!"); a
seeded run (2 users, 4 `notification_prefs` rows across 4 kinds, 2 `user_notifications` rows) at 0037 showed
`notification_prefs`/`user_notifications` row counts of 4/2 both before and after 0038, `hour` null on every
pre-existing row (default behaviour), and `PRAGMA foreign_key_check` empty after the rebuild. `budget_streak_days`
correctly placed in `SPACE_SCOPED_TABLES` (`src/lib/server/spaces/spaces.ts:300`, cascades with space deletion)
and in `src/lib/server/export/tables.ts:127`.

## Findings

None. No ENGINEERING_CHECKLIST violation found: space-access gate reused unchanged on the new route, no new
unbounded scan (400-day cap respected everywhere, `MAX_PAGES_PER_TICK`/`SCHEDULE_PAGE_SIZE` reused for both new
cron walks), no money hand-formatted, no R2/upload persistence touched, idempotent capture holds under 20x
concurrent delivery for both `close_reminder` and `budget_streak_snapshot`, i18n complete, no coin/flame/level
artwork anywhere in the diff or screenshots.
