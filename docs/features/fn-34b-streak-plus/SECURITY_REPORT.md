# FN-34b Streak plus — Security report

Reviewed: `git diff c50fa17..c48df4c` (detached worktree `fn-34b-qa`), PRD and QA report. Red-team review on 2026-10-11.

## Verdict: PASS

There are no medium or high findings. Two low findings are listed below so they are tracked.

## Attack surface checked

1. **Migration 0038** (`migrations/0038_streak_plus.sql`)
   - Both rebuilt tables copy every column of the old definitions in 0012 and 0013. `hour` is null for the old rows. No data is lost.
   - No table, trigger or view references `notification_prefs` or `user_notifications`. The DROP/RENAME therefore orphans no FK and drops no trigger.
   - All three indexes are recreated.
   - The CHECK constraints are only widened, so every old row passes them on copy.
   - The `budget_streak_days` triggers refuse any non-`YYYY-MM-DD` date on insert and on update.
   - Re-run safety and partial apply follow the 0013 precedent: one migration file, tracked by `d1_migrations`.
   - `test/integration/migration-0038.test.ts` passes.
2. **Jobs Worker**
   - **Repeated or concurrent delivery:** one row per user and date. `createIfAbsent` uses a unique `(user_id, kind, data_key)` key with `close:<date>`, and the hour and closure guards run inside the insert. Push is sent at most once per device through `claimDelivery`. A redelivery with `attempts > 1` re-enqueues `send_push`, and the claim then answers `done`.
   - **Stale and crafted messages:** a stale `close_reminder` (date ≠ today) is dropped. A `budget_streak_snapshot` whose date is not yesterday is dropped, so a future or old date can never be judged.
   - **Who can send messages:** only internal producers can enqueue. The Zod schema refuses any other shape.
   - **Another user's id in a message:** it can only create that user's own row with fixed text, sent to that user's own subscriptions (`pushTarget` → `target.userId`).
   - **Snapshot insert:** it re-checks that the space is live, and `not exists` plus the unique index make it idempotent.
   - **Load per message:** a snapshot reads one month of `dailyTotals` (bounded). Failures use the existing retry and DLQ path.
3. **Push content:** fixed title and body ("Hari ini belum ditutup" and the body text). It carries no amount, space name or date, so nothing leaks to a lock screen. The URL is `/beruntun`.
4. **`setReminderHour`**
   - It is user-scoped: it reads `locals.user.id` and takes no id from the form.
   - Hour parsing is `^\d{1,2}$` plus an allowlist of 06–23, and the table CHECK backs it up.
   - PoC: `023`, `+7`, ` 7`, `1e1`, `0x7`, Arabic-Indic digit, `07\n`, `NaN` and a 5 000-character value are all refused with 400. `07` is stored as 7.
   - CSRF: the global origin check in `hooks.server.ts` (`isCrossSiteForm`) covers this action.
5. **`/beruntun`**
   - Closure data and the reminder setting are read with the caller's own user id.
   - The budget streak goes through `currentSpaceScope` → `requireSpaceAccess` on every load.
   - PoC: a member removed from a shared space gets 404 at once, where the same request returned the streak just before.
   - A non-member and an unknown space id get 404 (existing test).
   - `?bulan=` only selects between two server-computed months.
   - Per-day within/over in a shared space shows less than members already see: the transactions and the budget itself.
   - `budget_streak_days` is purged with the space (`SPACE_SCOPED_TABLES`, FK cascade), and is in the export only for a space the caller can read.
6. **Freeze and closure gaming:** `closeDay` is called only with the server's `wibDateString(now)` (`src/routes/(app)/+page.server.ts:60`), so a client cannot backdate a closure. Freezes are computed on read and never written. The 400-day window is bounded.

## Findings

| # | Severity | Location | Issue |
|---|----------|----------|-------|
| L1 | low | `workers/jobs/src/cron.ts:182-193` | The endless `close_reminder` rotation enqueues one message for every active user who has not opted out, on every open tick (18 per day). That includes users already reminded or already closed for the day. Cost is about 18·N queue messages and about 2 D1 reads per message per day. One tick covers at most 100 pages × 100 users (10 000). Above that, a round spans more than one hour, so reminders arrive late. This is cost amplification only: there is no duplicate push and no cross-user effect. **Fix options:** filter `usersWanting` by `hour <= wibHour(now)` and by "not already notified today", or store a per-day done set. |
| L2 | low | `src/lib/server/notifications/triggers.ts:349` (`deliverPush`) | The closure guard runs when the row is created, not when the push is sent. A user who closes the day between creation and delivery (or during a quiet-hour or retry delay) can still get "Hari ini belum ditutup". This is a UX and integrity issue only: the text is fixed and leaks nothing. **Fix option:** re-check `day_closures` for `close_reminder` in `deliverPush`. |

**Resolution (2026-10-13):**
- L1 FIXED in `fix(streak): enqueue only due close reminders and skip the push once the day is closed` (bd6fcd5). The rotation lists only users due now (`usersDueCloseReminder`: reminder on, chosen hour reached,
  day not closed, not yet reminded for the date), so already-reminded, closed and not-yet-due users cost nothing.
  Tests: `test/integration/streak-plus.test.ts` › "red team L1: a user already reminded, or whose day is closed, is
  never enqueued again that day" (failed before) and the updated "default 20:00 WIB …" and "turned off …" tests.
- L2 FIXED in `fix(streak): enqueue only due close reminders and skip the push once the day is closed` (bd6fcd5). `deliverPush` re-checks `day_closures` for a `close_reminder` and sends nothing (`closed`). Test:
  "red team L2: a reminder whose day was closed before the push went out is not pushed" (failed before: delivered).

## Engineering checklist

- Queries are parameterised through Drizzle `sql` templates, and there is no string interpolation.
- Every space read goes through the access helper.
- Notifications are idempotent and replay-safe, and queue retries are bounded.
- Loaders return no secrets.
- `budget_streak_days` has no `updated_at`, `deleted_at` or `seq`. This is a documented deviation: the data is derived, write-once and never synced (PRD), so it is acceptable.

## Commands

- `npx vitest run test/integration/migration-0038.test.ts test/integration/streak-plus.test.ts workers/jobs/src/queue.test.ts workers/jobs/src/cron.test.ts src/lib/shared/notifications.test.ts`: 5 files, 90 tests passed.
- Temporary PoC `test/integration/zz-poc-sec.test.ts -t POC-SEC`: 3 passed (removed-member 404, forged hours refused). The file was deleted afterwards, and the worktree has no source changes.
