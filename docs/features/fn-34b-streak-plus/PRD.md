# FN-34b Streak extensions — PRD

Catalog entry: `docs/FEATURES.md` › FN-34 (add an FN-34b line, Phase 1b, owner request 2026-10-11 — all four
options the owner was offered). Builds directly on the already-shipped FN-34 ("Tutup hari", closed
2026-10-08, `docs/features/fn-34-streak/PRD.md`, migration `0021_streak.sql` + format triggers
`0024_day_closures_format.sql`). Risk tier: **Medium** (two new migrations across three tables, a new
`workers/jobs` cron rotation and queue job type, a new page, reuses FN-07/08's budget math read-only — no
change to any existing money total, but real scheduling logic in a shared Worker).

Owner decisions already fixed (do not re-litigate): FN-34's owner decision A — closures are **per account**,
not per space (`src/lib/server/streak/repo.ts:9-11`); owner decision C — no Fitur toggle for the streak; no
coins, points or in-app currency (`docs/FEATURES.md:132-133`, FN-34 "Out of scope" line 57). This PRD fixes its
own open decisions under **Owner decisions** below with a proposed default; the owner auto-accepts defaults
unless told otherwise.

## Goal

FN-34 made closing the day visible but gave it nowhere to live beyond a one-line chip, no memory of how long a
run actually was, no nudge for the user who simply forgets in the evening, and no reward for the behaviour the
whole ledger exists to encourage — spending inside the budget, not just opening the app. The four extensions
turn the plain streak count into a small habit loop that still never looks like a reward currency: a page to
see the run and its history, an evening reminder so an honest gap is rare instead of inevitable, a small amount
of forgiveness so one missed evening does not erase weeks of use, and a second, independent streak that tracks
the thing that actually protects the user's money — staying within what FN-07's "Sisa … per hari" said was
safe to spend that day.

## Scope

### 1. Streak page (`/beruntun`)

- **New route `src/routes/(app)/beruntun/+page.server.ts` + `+page.svelte`.** Load calls
  `streakSummary(locals.db, locals.user.id, today)` (existing, unchanged) for the closure streak, a new
  `longestClosureStreak` read (below), the current space's budget streak (new, below) and the user's reminder
  preference (new, below) — four independent reads, each wrapped the way Beranda already wraps `berandaSummary`/
  `berandaLists`/`streakSummary` in `Promise.all(...).catch(() => null)`
  (`src/routes/(app)/+page.server.ts:23-36`) so one failure never blanks the whole page.
- **Current + longest + calendar + milestones**, closure streak:
  - Current: `data.streak.current` (already computed).
  - Longest: a new `longestStreak(closedOn: readonly string[], today: string): number` in
    `src/lib/server/streak/count.ts` beside `countStreak` — walks the same bounded window
    (`STREAK_LOOKBACK_DAYS = 400`, `src/lib/server/streak/repo.ts:15`) once, forward from its oldest date,
    tracking the longest run of consecutive dates found (not just the run ending today); pure and unit-tested
    the same way `count.test.ts` tests `countStreak`. "Longest" is explicitly scoped to the last 400 WIB days,
    never an unbounded all-time scan, per `CLAUDE.md`'s "every scan has a row cap."
  - Calendar: a new `src/lib/ui/kit/StreakCalendar.svelte`, one month at a time (same shape as
    `src/lib/ui/charts/HeatCalendar.svelte` for layout, weekday header, 44 px cells, `prefers-reduced-motion`
    fade-in and focus ring — a new component because the per-day state is not a heat level: `closed` (check),
    `frozen` (owner decision B below; a distinct dot/outline, never a snowflake-as-currency look), `missed`
    (muted), `future`/`today` as `HeatCalendar` already renders them). Tapping a closed or frozen day is
    informational only (no link to a day's transactions — a closure carries no transaction list of its own).
  - Milestones: fixed thresholds `STREAK_MILESTONES = [7, 30, 100]` (new, `src/lib/shared/streak.ts` or beside
    `count.ts`), each shown as "reached" once `current >= milestone` (or, for the all-time view, once the
    longest streak ever reached it) with a plain `tr()`/`trf()` label ("7 hari berturut-turut", "30 hari
    berturut-turut", "100 hari berturut-turut") and the existing `star` or `check` icon
    (`src/lib/ui/icons.ts:22-23` — no new coin/badge artwork); never a numeric "level" name, never a flame.
- **Reminder settings** (owner decision D below) live on this page or link to `/pengaturan/notifikasi` — the
  engineer's call; either way the control is one `Toggle` + one hour picker, using the existing
  `GroupList`/`GroupRow`/`Toggle` kit.
- **Budget streak** (owner decision E/F below): current + longest for the signed-in user's **current space**
  (space-scoped, unlike the closure streak), with its own small calendar or inline figure — reuses
  `StreakCalendar` with states `within`/`over`/`no_budget` instead of `closed`/`frozen`/`missed`.
- **Mobile top-bar chip becomes a link**: `src/routes/(app)/+page.svelte:237` (`<span class="day-chip">`)
  becomes `<a class="day-chip" href="/beruntun">`, same text, same place, now reachable with one tap — the
  only change to existing FN-34 UI.
- **i18n**: page title "Beruntun", "Hari ini" vs "Hari ini belum ditutup" copy already exists; new strings for
  "Rekor terbaik", "Beruntun anggaran", the three milestone lines, the calendar's legend (`closed`/`frozen`/
  `missed`/`within`/`over`/`no_budget` labels) and the reminder control — every one gets an
  `src/lib/shared/i18n-en.ts` entry (`i18n.test.ts` fails otherwise).

### 2. Evening "belum ditutup" reminder

- **New notification kind `close_reminder`**, added to `NOTIFICATION_KINDS`/`USER_NOTIFICATION_KINDS`
  (`src/lib/shared/notifications.ts:14-34`) beside the existing `daily_nudge` — a different moment from
  `daily_nudge` ("~07:00 WIB, no transaction logged yet", `src/lib/server/notifications/triggers.ts:220-222`):
  this one fires in the evening when **today is not closed**, independent of how many transactions exist.
  `NOTIFICATION_KIND_LABELS` gains a `close_reminder` entry (`src/lib/shared/notifications.ts:45-70`).
  `notificationText`/`notificationUrl`/`parseParams` (same file, ~lines 190-240) gain the matching `case`,
  opening `/beruntun` (or `/` — the engineer's call, consistent with `daily_nudge`'s `/riwayat/baru`).
- **Migration (table rebuild, Drizzle precedent `migrations/0013_subscriptions.sql:39-53` when `bill_reminder`
  was added to the same two CHECK constraints):** `notification_prefs` and `user_notifications`'
  `kind` CHECK widens to include `'close_reminder'`; `notification_prefs` gains one new nullable column
  `hour integer` (generic — "the WIB hour this kind should act at, when the kind supports it"; every other
  kind ignores it). No column is added to `day_closures` or `budgets` for this part.
- **Default:** `CLOSE_REMINDER_DEFAULT_HOUR = 20` (20:00 WIB) when `notification_prefs.hour` is null; the
  settings control only offers whole WIB hours **06–23** (`src/lib/server/push/...` no — simply the same range
  `JOBS_CRON`/`workers/jobs/src/cron.ts:6` already ticks on: `'0 23,0-16 * * *'`, hourly 06:00–23:00 WIB) — a
  half-hour or a quiet-hour value is refused server-side, not clamped silently.
- **`workers/jobs/src/cron.ts`: a new endless rotation, modelled on `budget_check`
  (`runCronTick`, lines 134-143), *not* on `daily_nudge`'s single-global-hour gate (lines 167-176).** This
  matters: `daily_nudge`'s round is keyed `plan.today` with `wrap:false`
  (`walk()`, `cron.ts:85-112`) because every user becomes eligible at the *same* hour (`NUDGE_HOUR`), so the
  first tick that finds nothing left to walk can safely mark the day's round "done" for good. A per-user
  reminder hour breaks that: the 06:00 WIB tick would find zero of the (mostly 20:00-preferring) users
  eligible, return an empty page, and `walk()` would mark the round `done` — silently cancelling the reminder
  for everyone that day on every later tick. So `close_reminder` must use `round: 'all', wrap: true` (like
  `budget_check`), cycling continuously over every active user who has not disabled the kind
  (`spacesWithBudget`-style new query `usersWithCloseReminder(afterId, limit)`, mirroring
  `usersWanting`'s shape, `src/lib/server/notifications/schedule.ts:36-48`, filtered only by `enabled`, never
  by hour or by whether today is closed — those two checks happen inside the guarded insert below, exactly
  how `daily_nudge`'s own "no transaction yet" check happens inside `evaluateDailyNudge`'s guard, not in the
  cron query, `triggers.ts:219-246`). This reuses the same bounded `SCHEDULE_PAGE_SIZE`/`MAX_PAGES_PER_TICK`
  ceiling already accepted for `budget_check`'s rotation (`cron.ts:9-24`) — no new unbounded scan.
- **New trigger `evaluateCloseReminder(db, userId, date, now)`** in `src/lib/server/notifications/triggers.ts`:
  one `createIfAbsent` call (`src/lib/server/notifications/repo.ts`'s guarded insert, same shape as
  `evaluateDailyNudge`) whose SQL guard is `wibHour(now) >= coalesce((select hour from notification_prefs
  where user_id = ? and kind = 'close_reminder'), 20) and not exists (select 1 from day_closures where
  user_id = ? and closed_on = ?)` — so the reminder fires at most once per `(userId, kind, date)` (the unique
  index `user_notifications_key_uq`, already on `(user_id, kind, data_key)`, absorbs a repeated queue delivery
  per `CLAUDE.md`'s "Queue delivery may repeat: idempotency keys"), quiet the moment `day_closures` already
  has today's row (checked live inside the guard, not from a stale cron snapshot), and never twice even if the
  user lowers their hour after already receiving today's push.
- **`src/lib/shared/jobs.ts`**: a new discriminated-union member `{ type: 'close_reminder', userId, date }`
  (pattern identical to `daily_nudge`, `jobs.ts:18-19`); **`workers/jobs/src/queue.ts`**: a new `case
  'close_reminder':` calling `pushNew(deps, await deps.closeReminder(job.userId, job.date), m.attempts)`,
  dropped (acked, not processed) when `job.date !== deps.today()` exactly like `daily_nudge`
  (`queue.ts:97-101`) so a long-delayed retry never fires for the wrong WIB day.
- **Settings:** `/pengaturan/notifikasi` (or `/beruntun`, owner/engineer's call for placement) gets one `Toggle`
  for "Pengingat tutup hari" plus an hour `<select>` (06–23), posting a `setCloseReminderPref` action that
  extends `setNotificationPref` (`src/lib/server/notifications/repo.ts`) to also write `hour`. The existing
  VAPID gate is unchanged: without `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`
  (`.dev.vars.example:8-10`, `src/lib/server/push/vapid.ts:28-43`) the control still shows and saves (the
  preference and the in-app notification row work without push, exactly as FN-24 already does, PRD
  `docs/features/fn-24-reminders/PRD.md:74-78,121-124`), the per-device toggle keeps showing "Belum
  dikonfigurasi" (`src/routes/(app)/pengaturan/notifikasi/+page.svelte:217-227`), and no push is attempted.

### 3. Streak freeze

- **Computed, not stored** (owner decision B): no new table, no new column on `day_closures` — a freeze is a
  pure function of the same bounded window of `closed_on` dates `streakSummary` already reads
  (`src/lib/server/streak/repo.ts:47-64`), so it can never drift from the rows that actually exist and never
  needs its own migration or sync handling.
- `countStreak` (`src/lib/server/streak/count.ts`) gains a freeze-aware mode (or a sibling function, the
  engineer's call) that simulates forward through the lookback window, date by date, tracking a small `bank`
  (0–2) that increases by 1 every 7th **actual** close encountered while the run is unbroken (capped at 2,
  extra earns are simply not banked) and decreases by 1 each time a missing day is bridged instead of ending
  the run; the function returns the final `current` (and feeds `longestStreak`'s same simulation) plus, for the
  calendar, which specific dates were bridged ("frozen") rather than actually closed. A gap the bank cannot
  cover still ends the run exactly as today (FN-34 acceptance criterion 5, unchanged).
- The freeze never writes a `day_closures` row for the bridged date (FN-34's "Out of scope: backdating a close
  for a day that already ended" stays true — a frozen day is not recorded as closed, it is only not counted as
  a break) and is never spent on **today** (today is either closed or not; a freeze only ever bridges a past
  gap day while walking the window).

### 4. Budget streak

- **New migration, new table `budget_streak_days`** (space-scoped): `id`, `space_id` (FK `budgets`'/`spaces`'
  space, cascade with the space, added to `SPACE_SCOPED_TABLES`,
  `src/lib/server/spaces/spaces.ts:237`), `date` (WIB `YYYY-MM-DD`, same format-guard trigger pattern as
  `day_closures` — `migrations/0024_day_closures_format.sql`), `status` (`'within'` | `'over'`, CHECK-bounded),
  `created_at`. Unique index `(space_id, date)`; written once, never updated — a day's verdict is a snapshot,
  never revised even if a transaction dated that day is edited or deleted afterwards (owner decision F).
- **Why a snapshot and not a live recompute:** FN-07's `budgets` table holds **one persistent, mutable value
  per space with no month-scoped history by explicit owner decision**
  (`docs/features/fn-07-budgets-beranda/PRD.md:394-399`, "Owner decision G" — "a user who raises their budget
  mid-month immediately sees a larger 'Sisa' … with no record that the earlier, smaller figure ever applied").
  Recomputing a past day's safe-to-spend target live, from *today's* `budgets` row, would silently apply
  whatever the budget is **now** to a day that may have had a different budget then — exactly the kind of
  invented figure `CLAUDE.md` forbids. A snapshot fixes the target (and the verdict) using the budget that was
  live when the snapshot was taken, the morning after the date it is for, and never rewrites it.
- **What "within" means for WIB date `D`** (owner decision F): computed once, on the first open cron tick of
  `D+1` (so `D` is unambiguously over), for every space with a live budget at that moment
  (`spacesWithBudget`, `src/lib/server/notifications/schedule.ts:13-19`, already paginated):
  1. Read the space's live budget (`getActiveBudget`, `src/lib/server/budgets/repo.ts:24-35`). **No live
     budget → write nothing for that space/date** (owner decision F: a day with no budget is skipped — neither
     `within` nor `over` — not a table row at all, so the read side treats a missing row as "no budget that
     day", indistinguishable from "not yet evaluated" only for `today`/future dates, which the UI never shows
     anyway).
  2. Compute the same figures Beranda already computes for the budget's currency, using the FN-05 aggregates
     (`periodTotals`/`dailyTotals`, `src/lib/server/transactions/aggregate.ts` — already `is_demo = 0` and
     expense-only, so demo rows and transfers/income never enter this calculation, with no extra filtering
     needed): the month-to-date expense total through `D − 1`, and `daysRemainingInclusive(D)`
     (`src/lib/server/budgets/math.ts:30-32`). The allowance for `D` is
     `floor((budgetMinor − spentThroughYesterday) / daysRemainingInclusive(D))`, floored exactly like
     `safeToSpend` (`math.ts:46-58`, owner decision F there) — never a figure a user could read as more
     generous than the real remainder.
  3. If `spentThroughYesterday` already exceeds `budgetMinor` (the month's budget is already spent before `D`
     even starts), `D` is `over` regardless of `D`'s own spending — once a month's budget is gone, every
     remaining day of it reads as over, matching what Beranda's own "Sisa" already shows that month.
  4. Otherwise, `D` is `within` when `D`'s own expense total (same currency, same exclusions) is **≤** the
     computed allowance, `over` when it is greater.
- **Scope: per space, not per account** (contrast with FN-34's closure streak, owner decision A there) — a
  budget is itself a `budgets.space_id` row (`migrations/0008_budgets.sql:1-12`), so its streak follows the
  space the way every other budget figure does; a user with two spaces sees two independent budget streaks,
  one per space, on `/beruntun` for whichever space is current.
- **`src/lib/shared/jobs.ts`**: `{ type: 'budget_streak_snapshot', spaceId, date }`; **`cron.ts`**: a new
  **finite, once-per-day** round (`round: plan.today, wrap: false`, the `daily_nudge` shape **is** correct
  here, unlike the reminder above, because every space becomes eligible at the same moment — the first open
  tick of the day, 06:00 WIB — there is no per-space variable hour); **`queue.ts`**: a new case writing the
  guarded insert (`insert … where not exists`, same idiom as `closeDay`,
  `src/lib/server/streak/repo.ts:22-44`) so a redelivered message never produces two rows or a 500.
- **`src/lib/server/budgets/streak.ts`** (new): `budgetStreakSummary(db, spaceId, today)` → `{ current:
  number, longest: number }`, reading at most the same `STREAK_LOOKBACK_DAYS` window of `budget_streak_days`
  ordered by date, walking back from `today − 1` (today itself is never evaluated yet — see below) the same
  way `countStreak` does, treating a missing row as a skip (continue past it without breaking or extending)
  rather than a gap.
- **Today is never part of the budget streak's `current`**: unlike the closure streak (which is a direct user
  action, available the moment the WIB date starts), the budget streak can only be known the next morning —
  `/beruntun` shows `current` through yesterday and, optionally, today's running `safeToSpend` state
  (`kind: 'over'`/`'left'`/`'spent'`, already computed by `berandaFigures`, `src/lib/server/budgets/math.ts:
  34-58`) as a separate "so far today" line, never folded into the streak count itself until snapshotted.

## Out of scope

- Any coin, point, flame, badge image or other monetary-looking reward for either streak, the freeze or a
  milestone — the owner's FN-34 rule stands unchanged for every extension in this PRD.
- Re-opening, backdating or un-closing a day (FN-34's existing rule; the freeze bridges a gap without ever
  writing a `day_closures` row for it, so this still holds).
- Editing or deleting a `budget_streak_days` snapshot once written, including after the underlying
  transactions for that date change — a later edit changes Riwayat/Laporan/Beranda's live figures as it always
  has, but never rewrites a past streak verdict (stated plainly as a known limitation, not a bug).
- A Fitur toggle for any of the four pieces (matches FN-34's existing owner decision C).
- Catch-up across a WIB day boundary for a missed `close_reminder` tick: if every open tick of a WIB day is
  somehow skipped (Worker outage) before a user's chosen hour is reached, that day's reminder is not sent
  retroactively once the next day begins — the dedupe key is the date, and a new date starts fresh.
- A streak leaderboard, comparison across space members, or sharing either streak's figure — both stay
  personal/space-scoped exactly as FN-34 already decided for the closure streak.
- Google Calendar or e-mail delivery of the evening reminder — Web Push and the in-app notification list only,
  matching FN-24's existing channel scope.
- Per-minute reminder precision — only the whole WIB hours the cron already ticks on (06–23) are offered.
- Budget streaks for a space's **category budgets** (migration `0020_category_budgets.sql`) if that table is
  live by the time this ships — this PRD covers only the one space-level budget `getActiveBudget` reads.

## Acceptance criteria

### Streak page

1. Given a signed-in user on `/beruntun`, when the page loads, then it shows the closure streak's current
   count (identical to the top-bar chip's number the same WIB day), a calendar of the last full WIB month with
   closed/frozen/missed days visually distinct, and the three milestone lines each marked reached or not
   reached, with loading (skeleton), error (retry) and empty (zero closures ever: "Belum ada hari
   berturut-turut" or similar) states.
2. Given the mobile top-bar chip (`src/routes/(app)/+page.svelte:237`), when it is tapped, then it navigates to
   `/beruntun` without a full page reload where supported, and the chip's visible text and position are
   unchanged from FN-34.
3. Given a user with closures spanning more than one unbroken run within the last 400 WIB days (e.g., a 10-day
   run two months ago, a 3-day run now), when `/beruntun` loads, then "Rekor terbaik"/longest shows 10 and
   "current" shows 3 — longest is not the same figure as current, and both are bounded to the 400-day window
   (a closure older than that window is never counted toward longest).
4. Given a user whose longest run has reached exactly 7 (but not yet 30), when `/beruntun` loads, then the
   7-day milestone shows reached and the 30- and 100-day milestones show not reached, in both Indonesian and
   English, with no icon that could be mistaken for a coin or a flame.
5. Given a WIB date outside the current and previous month, the calendar shows nothing for it (never scrolls
   or loads beyond a bounded range); given 360 px width, every calendar cell and the milestone rows render
   without horizontal scroll and every tap target is ≥ 44 px tall.

### Freeze

6. Given a user closed 7 consecutive WIB days then missed exactly one day then closed the next day, when
   `streakSummary`/the freeze-aware count runs, then `current` continues unbroken through the missed day (one
   banked freeze spent), the calendar marks the missed day "frozen" (not "closed", not "missed"), and the
   freeze is never written as a `day_closures` row (a direct query for that date finds no row).
7. Given a user who has never closed 7 days in a row (bank always 0), when a single day is missed, then the
   streak breaks exactly as FN-34 specified before this PRD (acceptance criterion 5 of
   `docs/features/fn-34-streak/PRD.md`, unchanged) — the freeze never applies without having been earned.
8. Given a user with 2 banked freezes who then misses 2 consecutive WIB days, when the count runs, then both
   days are bridged (bank now 0) and the streak continues; given a third consecutive missed day with no
   freeze left, then the streak breaks on that third day, not before.
9. Given a user spends a freeze bridging a gap, when they later close a fresh run of 7 more days measured from
   the day after the bridge, then they earn exactly one more freeze (freezes earn from actual closes only —
   a bridged/frozen day never counts toward the 7-day earn count).

### Evening reminder

10. Given a user with `close_reminder` enabled at the default 20:00 WIB who has not closed today, when the
    cron tick that covers 20:00 WIB runs, then exactly one `close_reminder` notification (and, if VAPID keys
    are configured and the user holds a live push subscription, exactly one push) is created for that user;
    given the user closed before that tick, when the tick runs, then none is created.
11. Given VAPID keys are not configured (`vapidKeys(getEnv())` returns null, `.dev.vars.example:8-10`), when
    the reminder fires, then the in-app notification row is still created and `/pengaturan/notifikasi`
    continues to show "Belum dikonfigurasi" for the per-device switch exactly as today — this feature adds no
    new secret requirement.
12. Given a user sets a custom reminder hour of 21:00 WIB, when the 20:00 and 21:00 WIB ticks run in order,
    then no reminder fires at 20:00 and exactly one fires at 21:00; given they lower it to 18:00 WIB *after*
    already receiving today's 21:00 reminder, when the 22:00 WIB tick runs, then no second reminder fires that
    same WIB date (dedupe is by date, not by hour).
13. Given 20 concurrent deliveries of the same `close_reminder` queue message (simulated redelivery) for one
    user and date, when all are processed, then exactly one `user_notifications` row and at most one push per
    live subscription result (the existing `(user_id, kind, data_key)` unique index holds), per
    `docs/ENGINEERING_CHECKLIST.md` › "Idempotent capture"/"Concurrent writes."
14. Given two users in two different spaces (or the same shared space) with different reminder hours, when
    both become eligible on their own ticks, then each receives their own reminder scoped to
    `locals.user.id`/`userId` only — there is no id in the settings form a caller could substitute for another
    account's preference or reminder (no existence oracle).
15. Given a user submits an hour outside 06–23 WIB or a non-integer value, when the preference is saved, then
    the server refuses it (no silent clamp) and the stored value (or default) is unchanged.
16. Given the WIB boundary around midnight, a `close_reminder` job carrying yesterday's date that reaches the
    queue after today has started is dropped (acked, not processed) exactly like `daily_nudge`
    (`workers/jobs/src/queue.ts:97-101`) — it never fires for the wrong WIB day.

### Budget streak

17. Given a space with a live budget whose month-to-date spend through yesterday, plus yesterday's own
    spend, stayed at or under the computed daily allowance for every WIB day so far this run, when
    `budgetStreakSummary` runs for today, then `current` counts every such day (today excluded, since today's
    verdict does not exist until tomorrow morning).
18. Given a space with a live budget whose spend on some WIB date `D` exceeded that date's computed allowance
    (or the month's budget was already exhausted before `D`), when the snapshot for `D` is written the
    following morning, then `D` is `over`, and the budget streak counted through `D` is 0 from `D` onward
    (unless `D` is itself outside the lookback window the user is viewing).
19. Given a space with no live budget on WIB date `D` (never set, or removed before `D` and not reset), when
    the snapshot job runs for `D`, then no `budget_streak_days` row is written for `(spaceId, D)`, and
    `budgetStreakSummary` treats `D` as a skip — a run of `within` days before and after a no-budget stretch
    is never broken by the stretch itself, only by an actual `over` day.
20. Given a space's budget is **raised** mid-month on WIB date `D` (before `D`'s own snapshot is taken the
    next morning), when `D`'s snapshot is computed, then it uses the budget amount live at snapshot time (the
    morning after `D`), never the smaller amount that was live for part of `D` — stated and tested as the
    documented limitation (owner decision F), not a defect: a later budget change can still affect how a day
    not yet snapshotted reads, but never rewrites a date whose snapshot already exists.
21. Given a space's income or transfer rows on WIB date `D` (no expense spend at all that day), when `D` is
    snapshotted, then `D` is `within` (zero expense spend is never greater than a non-negative allowance) —
    income and transfers never count toward or against the budget streak, matching FN-05's existing
    `MONEY_ROWS`/expense-only aggregate filters.
22. Given fictional seed (`Data demo`) transactions dated `D` in an otherwise-real space, when `D` is
    snapshotted, then those rows are excluded from `D`'s spend total exactly as they are excluded from every
    other FN-05 aggregate (`t.is_demo = 0`, `src/lib/server/transactions/aggregate.ts`) — a demo-only day with
    a live budget reads as `within` on zero real spend, never invents a figure from the demo rows.
23. Given a user who is a member of two spaces, each with its own live budget and its own run of `within`
    days, when `/beruntun` loads for each space in turn (switching the current space), then the budget streak
    shown changes to that space's own figures — never the other space's, never summed across spaces.
24. Given a request to read or write any budget-streak data, when the request is handled, then it is scoped
    through the existing `currentSpaceScope`/`requireSpaceAccess` gate exactly like every other budget/Beranda
    read — a user who is not a live member of the space gets the same 404 any other space-scoped route returns
    (no existence oracle).
25. Given the WIB boundary around midnight, when the snapshot job for WIB date `D` runs on the first open tick
    of `D + 1`, then it reads exactly `D`'s transactions (WIB `occurred_on`, never the UTC date) — tested at a
    month boundary (the last WIB day of a month snapshotted correctly, its `daysRemainingInclusive` using that
    month's own length) per `docs/ENGINEERING_CHECKLIST.md` › "WIB dates."
26. Given 20 concurrent deliveries of the same `budget_streak_snapshot` message for one space and date, when
    all are processed, then exactly one `budget_streak_days` row exists for that `(space_id, date)` — the
    guarded insert absorbs the race, no duplicate, no 500.

### General

27. Every new Indonesian phrase introduced by this PRD has an English entry in `src/lib/shared/i18n-en.ts`
    (`i18n.test.ts` stays green).
28. Every money figure this PRD's UI shows (the budget streak's "so far today" line, if built) goes through
    `formatMoney`/`formatMoneyCompact`, never hand-formatted; every date shown or compared is the WIB calendar
    date, never the UTC date.
29. `/beruntun` and the new settings control render correctly in all four themes (Terang/Gelap/Hitam-putih/Pro,
    FN-40/FN-46) with AA contrast, and respect `prefers-reduced-motion` for the calendar's cell-in animation.

## Architecture notes

- **Touches:** `migrations/0038_streak_plus.sql` (new — table rebuild of `notification_prefs` and
  `user_notifications` for the `close_reminder` kind + `hour` column, new `budget_streak_days` table; number
  confirmed at merge — the owner's brief notes a parallel FN-48 branch already claims `0037`, so this PRD
  starts at **0038** and the engineer renumbers if yet another migration lands first);
  `src/lib/server/db/schema.ts` (`budgetStreakDays`, widened `userNotifications`/`notificationPrefs` kind
  enums and the new `hour` column); `src/lib/server/streak/count.ts` (`longestStreak`, freeze-aware count);
  `src/lib/server/streak/repo.ts` (no change to `closeDay`/`streakSummary`'s signatures — FN-34's existing
  calls stay exactly as they are); `src/lib/server/budgets/streak.ts` (new, `budgetStreakSummary`);
  `src/lib/shared/notifications.ts` (`close_reminder` kind, label, text, url, params, `CLOSE_REMINDER_HOURS`
  range constant); `src/lib/server/notifications/triggers.ts` (`evaluateCloseReminder`);
  `src/lib/server/notifications/schedule.ts` (`usersWithCloseReminder`); `src/lib/server/notifications/repo.ts`
  (extend `setNotificationPref` or add `setCloseReminderPref` to also write `hour`);
  `src/lib/shared/jobs.ts` (`close_reminder`, `budget_streak_snapshot` union members);
  `workers/jobs/src/cron.ts` (new `CURSOR_KEYS` entries, the endless rotation for `close_reminder`, the
  finite daily round for `budget_streak_snapshot`); `workers/jobs/src/queue.ts` (two new `case`s, `JobDeps`
  gains `closeReminder`/`budgetStreakSnapshot`); `src/routes/(app)/beruntun/+page.server.ts` + `.svelte`
  (new); `src/routes/(app)/+page.svelte:237` (chip becomes a link); `src/routes/(app)/pengaturan/notifikasi/
  +page.server.ts` + `.svelte` (reminder hour control); `src/lib/ui/kit/StreakCalendar.svelte` (new);
  `src/lib/shared/i18n.ts` + `i18n-en.ts`.
- **Reuses, unchanged:** `streakSummary`/`countStreak`/`closeDay` (FN-34, called exactly as Beranda already
  calls them); `getActiveBudget`, `safeToSpend`, `daysRemainingInclusive`, `berandaFigures`
  (`src/lib/server/budgets/{repo,math}.ts`); `periodTotals`/`dailyTotals` (`src/lib/server/transactions/
  aggregate.ts`, already demo/expense-filtered); `createIfAbsent`, `listActiveSubscriptions`,
  `sendPushNotification`, `vapidKeys` (FN-13/FN-24 push stack); `spacesWithBudget`, the `walk()` cursor helper
  and `SCHEDULE_PAGE_SIZE`/`MAX_PAGES_PER_TICK` (`workers/jobs/src/cron.ts`); `currentSpaceScope`/
  `requireSpaceAccess` for every space-scoped read/write this PRD adds (the budget streak, never the closure
  streak or the reminder preference, which stay account-scoped per FN-34's owner decision A).
- **No change** to `transactions`, `wallets`, `budgets`' own row, `day_closures`' schema, or any existing FN-05/
  FN-07/FN-08 aggregate return shape — every new figure is read-only derived data in new tables/functions
  beside the existing ones.
- **Jobs Worker cadence, verified from the actual schedule, not assumed:** `JOBS_CRON =
  '0 23,0-16 * * *'` (`workers/jobs/src/cron.ts:6`, `workers/jobs/wrangler.jsonc:7`) ticks hourly, exactly on
  the WIB hours 06:00–23:00 inclusive (UTC 23 and 00–16, `+7` h), with **no tick 00:00–05:00 WIB**. The evening
  reminder's selectable hours (06–23) and its "no catch-up across midnight" rule both follow directly from
  this existing, unchanged cadence — this PRD adds no new Cron Trigger and no new binding.

## Prerequisites

- **VAPID keys** (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `.dev.vars.example:8-10`) — already
  an open owner item from FN-13/FN-24 (`docs/TASKS.md`), still not configured in staging. Until set,
  `vapidKeys(getEnv())` returns null and every `close_reminder` push attempt is skipped while the in-app
  notification row, the preference control and the rest of this PRD (streak page, freeze, budget streak) work
  fully without it — the settings control and `/pengaturan/notifikasi`'s per-device switch show "Belum
  dikonfigurasi" exactly as today (`src/lib/server/push/vapid.ts:40-43`). No other credential is needed — no
  AI, no new provider, no new Cloudflare binding.

## Owner decisions

- **A — Streak page route and chip link.** Default: `/beruntun` (an existing, non-brand Indonesian word for
  "in succession/successive"), reached by tapping the existing top-bar chip
  (`src/routes/(app)/+page.svelte:237`). *Trade-off:* a new top-level-feeling route that is not one of the
  five tabs; alternative (`/pengaturan/beruntun` or a Beranda sheet) would bury a page the owner explicitly
  asked to be "reachable from the top-bar streak chip," so a dedicated route reads as the more literal match.
- **B — Freeze rule.** Default: **earn one freeze every 7 actually-closed WIB days within the current run,
  banked up to 2**, each spent automatically to bridge exactly one missed day (consecutive missed days can
  consume consecutive banked freezes), computed fresh from `day_closures` every time (no table, no migration).
  *Trade-off:* a user who closes sporadically (never reaching a 7-day run) never earns a freeze and FN-34's
  original all-or-nothing gap rule applies unchanged to them — this rewards sustained use, not occasional use,
  which seems closer to the owner's "a missed day does not break the streak within a limit" brief than a flat
  grant to everyone from day one. Alternative (one freeze per ISO calendar week, regardless of use) was
  considered and rejected: it is harder to reason about at a timezone-of-one's week boundary, and it would
  grant a freeze to a user who has never actually used the streak.
- **C — Milestones: thresholds, copy and scope.** Default: fixed at **7, 30, 100** days (as asked), a plain
  `tr()`/`trf()` line per threshold with the existing `star`/`check` icon
  (`src/lib/ui/icons.ts:22-23`), shown for the closure streak's current *and* longest-ever figures on
  `/beruntun` only — not pushed as a separate notification kind this pass, and not applied to the budget
  streak (which has its own figures but no milestone badges, to avoid six badges on one small page).
  *Trade-off:* a user who reaches 100 days gets no special push/celebration beyond the Beranda close-day
  mascot moment FN-44 already shows (`dayClosedCelebrates(form)`,
  `src/routes/(app)/+page.svelte:478-479`) — a dedicated milestone celebration is a natural, small follow-up,
  not built here to keep this PRD's scope to what was asked.
- **D — Evening reminder: default time, default on/off, granularity.** Default: **20:00 WIB**, **default ON**
  (matching every other FN-24 kind's "default-on unless turned off," `docs/features/fn-24-reminders/
  PRD.md` owner decision 5), whole-hour picker restricted to **06:00–23:00 WIB** (the cron's own tick range —
  offering a value the schedule could never honour would be a small invented promise). *Trade-off:* default-on
  means a user who already finds the 07:00 "catat hari ini" nudge (`daily_nudge`) enough gets a *second* daily
  push unless they turn this one off; the alternative (default OFF, opt-in) was considered and rejected
  because the reminder is the mechanism that makes the freeze/streak genuinely low-friction to keep — a
  streak feature that silently never reminds anyone seems less likely to be what "add a reminder" asked for,
  and turning one kind off is a single toggle away in a page every notification already lives on.
- **E — Budget streak scope: per space, not per account.** Default: **per space**, following `budgets.space_id`
  itself (contrast with FN-34's closure streak, which is deliberately per-account). *Trade-off:* a user with
  two spaces (e.g. personal + a shared household space) sees two separate budget-streak numbers instead of
  one combined figure — the alternative (sum or best-of across spaces) would mix two different budgets'
  "within"/"over" verdicts into one number that no longer means "this space's spending stayed inside its own
  safe-to-spend," which seems like the more confusing result.
- **F — Budget streak "within," no-budget days, and mid-month changes.** Default: as specified in Scope §4 —
  snapshotted the morning after, floored like `safeToSpend`, a no-budget day is a skip (never a break), a
  mid-month raise or cut only affects days not yet snapshotted. *Trade-off:* this is the most owner-visible
  trade-off in the whole PRD — a user who changes their budget will occasionally see a day's verdict that used
  an amount they no longer remember setting (e.g., they raised the budget at 23:50 WIB; the day already in
  progress gets evaluated at the raised amount once snapshotted the next morning, even though they spent most
  of the day under the smaller figure). The alternative — storing a timestamped history of every budget value
  so each day can be evaluated against exactly what was live at the time — is explicitly out of scope for
  FN-07 itself (`docs/features/fn-07-budgets-beranda/PRD.md:394-399`, Owner decision G there) and would be a
  larger, separate migration to FN-07, not this PRD.
- **G — "Longest" is bounded, not all-time.** Default: both streaks' "longest" figure is computed only from
  `STREAK_LOOKBACK_DAYS` (400) of history, same as "current" already is. *Trade-off:* a user whose very first,
  longest-ever run happened more than ~13 months ago would see a smaller "Rekor terbaik" than the true
  all-time figure — judged acceptable because an unbounded scan over a user's or space's entire lifetime
  violates `CLAUDE.md`'s "every scan has a row cap," and 400 days already comfortably covers over a year of
  continuous use.

## Tracker impact

- **New `docs/TASKS.md` line** (FN-34 itself already closed, `docs/TASKS.md:174`): add under the same App
  layout parity section a new entry, e.g. "FN-34b streak extensions: streak page, evening reminder, streak
  freeze, budget streak (owner request 2026-10-11) — PRD `docs/features/fn-34b-streak-plus/PRD.md`," so the
  follow-up work is tracked separately from the already-shipped FN-34 line rather than reopening it.
- **`docs/ACCEPTANCE.md`**: no existing row names FN-34 or FN-34b. On completion, add to "Money and dates" a
  row "Streak closures, freezes and budget-streak snapshots bucket by the WIB date, never the UTC date (23:30/
  00:30 WIB and month-boundary tests)," and extend "Space isolation on every load, action and sync push/pull"
  (line 29) to cover the new `/beruntun` route and the budget-streak reads/writes (account-scoped pieces — the
  closure streak, the freeze and the reminder preference — are covered the same way FN-34's own tracker-impact
  note already reframed "space isolation" as "account isolation" for that class of check).

## Owner decisions — answered 2026-10-11

Asked explicitly and accepted as proposed: (B) one freeze earned per 7 closed days, at most 2 banked, used
automatically on a gap; (D) reminder on by default at 20:00 WIB, whole hours 06–23; (F) a good budget day is spending
within that day's safe-to-spend, snapshotted the next morning, no-budget days skipped; (E) budget streak per space.
A, C and G take the proposed defaults. Orchestrator risk tier: Large (migration with table rebuilds, jobs cron).
