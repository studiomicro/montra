# FN-24 Notifications and reminders

Slug: `fn-24-reminders`. Phase 3 (Intelligence). Risk tier: **Medium** (new Worker cron logic, new queue job
types, per-user scheduling across time zones-of-one (WIB), reuses but extends FN-13's push path).

## Goal

MONTRA fills itself, but a user who never opens the app never sees what it caught. FN-24 closes that loop:
budget-threshold alerts, a daily "catat hari ini" nudge, goal-milestone pushes and a weekly summary turn the
ledger into something that reaches the user on the lock screen, and an in-app notification list gives the same
information to anyone without push enabled (desktop, denied permission, unsupported browser). This is the
feature that makes budgets (FN-07) and goals (FN-10) feel alive between visits, and is the plumbing FN-26
(subscription bill reminders) and FN-19 (Gmail capture pushes) will both schedule through.

## Scope

- **Migration `0012_notifications.sql`** (renumber at merge if 0010/0011 land first from another branch):
  - `notifications` table: one row per in-app notification. Columns: `id`, `space_id` (nullable — the daily
    nudge and weekly summary are per-user, not per-space, so this is the first notification-ish table that is
    **not** uniformly space-scoped; budget/goal notifications set it, nudge/summary do not), `user_id` (who
    sees it — always set; a shared-space budget alert is created once per live member), `kind` (enum:
    `budget_80`, `budget_100`, `daily_nudge`, `goal_milestone`, `weekly_summary`), `title`, `body`, `url` (the
    in-app link it opens, e.g. `/kekayaan`, `/laporan`), `data_key` (idempotency: see below), `read_at`
    (nullable), `created_at`, `deleted_at` (tombstone — dismissed notifications are removed from the list, not
    hard-deleted, matching the tombstone convention; content-free CHECK like `drafts`/`transactions`).
  - `notification_prefs` table: per-user, per-kind opt-in/out (mirrors `feature_flags`' shape — no `space_id`,
    no `seq`, one row per `(user_id, kind)`, default-on with no row, `budgets/validation.ts`-style bounded
    enum). Settings page writes here; the jobs Worker reads it before sending or creating anything.
  - `notification_dedupe` table (or a unique index on `notifications(user_id, kind, data_key)` where
    `data_key` is not null): a budget-80% alert for October's budget must never re-fire every hour once it has
    fired once this month; a goal's "100%" milestone must never re-fire once hit. `data_key` encodes the
    natural key (e.g. `budget:{space_id}:{YYYY-MM}:80`, `goal:{goal_id}:milestone`, `nudge:{user_id}:{YYYY-MM-DD}`).
  - Both new tables are added to `SPACE_SCOPED_TABLES` (`src/lib/server/spaces/spaces.ts:237`) **only for the
    space-scoped rows** — since `notifications.space_id` is nullable, the purge statement must filter
    `space_id is not null` in addition to matching the id list, or (simpler, chosen default) split into two
    tables: `space_notifications` (budget/goal, always has `space_id`, goes in `SPACE_SCOPED_TABLES`) and
    `user_notifications` (nudge/summary, no `space_id`, purged in `deleteAccount` like `featureFlags`
    (`src/lib/server/auth/delete-account.ts:65`) instead). This PRD adopts the two-table split as the clean
    design the engineer should build; name them `budget_goal_notifications` and `user_notifications` in the
    migration if clearer.
- **`src/lib/shared/notifications.ts`**: the `NotificationKind` enum, per-kind default title/body `trf()`
  templates, and `notificationDataKey()` helpers (pure functions, unit-testable, used by both the app Worker
  and `workers/jobs` per CLAUDE.md's "shared code" rule).
- **`src/lib/server/notifications/repo.ts`**: `listNotifications(db, userId, {limit})`, `markRead`, `dismiss`
  (tombstone), `createIfAbsent(db, {userId, spaceId, kind, dataKey, title, body, url}, now)` — the one guarded
  insert (`insert … where not exists`) every trigger below calls, so a replayed queue message or a repeated
  cron tick never duplicates a notification (CLAUDE.md "idempotent capture" / ENGINEERING_CHECKLIST "Idempotent
  capture").
- **`src/lib/shared/jobs.ts`**: extend `jobMessage` with new discriminated-union members: `{ type:
  'budget_check', spaceId }`, `{ type: 'daily_nudge', userId }`, `{ type: 'goal_milestone', goalId }`,
  `{ type: 'weekly_summary', userId }`, `{ type: 'send_push', notificationId }`. Each carries only ids, never
  amounts or titles (CLAUDE.md "no tool can write"/least data in a queue message that may be logged on
  failure).
- **`workers/jobs/src/cron.ts` + `src/index.ts`**: the existing `scheduled()` handler (currently a
  console.log heartbeat, `workers/jobs/src/index.ts:13`) gains real work on the existing hourly 06–23 WIB
  trigger (`JOBS_CRON`, already defined): for each WIB hour tick, enqueue one `budget_check` message per space
  with a live budget (bounded batch, cursor-paginated, never "load every space"), and on the one tick nearest
  07:00 WIB enqueue `daily_nudge` for users who have not logged a transaction yet today and have the nudge
  enabled, and on Monday's first tick enqueue `weekly_summary`. Goal milestones are checked synchronously
  inside the existing goal-contribution write path (`src/lib/server/goals/contributions.ts`) — no cron needed,
  since the event (crossing 50/100%) only happens at the moment of a write — and that write enqueues a
  `send_push` job rather than calling push inline, so a slow push send never blocks the user's save.
- **`workers/jobs/src/queue.ts`**: `handleBatch`'s switch (`workers/jobs/src/queue.ts:27`) gains the five new
  cases, each: read what it needs from D1, check `notification_prefs`, call `createIfAbsent`, and on success
  enqueue (or directly call, since it is the same Worker) `send_push` for every live subscription
  (`listActiveSubscriptions`, reusing FN-13's `src/lib/server/push/repo.ts:122`) and `sendPushNotification`
  (`src/lib/server/push/send.ts:32`). Bounded retries and DLQ are already configured
  (`workers/jobs/wrangler.jsonc:18-27`); add the idempotency key check (above) so a retried message after a
  partial failure never double-creates or double-sends.
- **`src/routes/(app)/kotak-masuk/+page.server.ts` and `+page.svelte` — new section, or a new
  `/kotak-masuk/notifikasi` tab** (owner decision below): the in-app notification list, newest first, with
  unread styling, mark-read on open, a dismiss action, and empty/loading/error states matching the existing
  kit (`ErrorState`, `Skeleton`, `EmptyState`, `GroupList`/`GroupRow` as used throughout `/kekayaan`).
- **`/pengaturan/notifikasi`** (existing route, `src/routes/(app)/pengaturan/notifikasi/+page.server.ts`):
  add a `GroupList` of `Toggle` rows, one per `NotificationKind`, below the existing per-device push switch;
  each posts a new `setPref` action that upserts `notification_prefs`. The existing "Belum dikonfigurasi" VAPID
  gating (`vapidKeys(getEnv())`, line 36) is unchanged — these per-kind toggles still show and save even when
  push is unconfigured (they also gate the in-app list), but no push is ever sent until VAPID keys exist.
- **i18n**: every new string (`notifications.ts` templates, settings page labels, kotak-masuk list) added to
  `src/lib/shared/i18n.ts` (ID) and `src/lib/shared/i18n-en.ts` (EN); the existing EN-coverage test
  (`src/lib/shared/i18n.test.ts`) must stay green.

## Out of scope

- Google Calendar export of reminders (FN-29, Phase 5).
- Gmail-captured-payment push (FN-19's own "Beri tahu di perangkat ini" toggle; FN-19 is on hold — Anthropic
  key — per `docs/TASKS.md`). FN-24 builds the generic push/notification plumbing FN-19 will call later; it
  does not build Gmail capture itself.
- Subscription/bill reminders' catalogue and billing-date logic (FN-26, builds on this feature's
  `createIfAbsent`/`send_push` plumbing but is its own PRD).
- SMS, e-mail or Google Calendar as delivery channels — push and the in-app list only.
- Quiet hours / per-user send-time customisation beyond the fixed 06–23 WIB cron window already in place.
- Any AI-written notification copy — all strings are fixed `trf()` templates.

## Acceptance criteria

1. Given a space with a live budget and no notification sent this WIB month, when the space's month-to-date
   expense total (the same aggregate Beranda/Riwayat use) first reaches ≥80% of the budget, then exactly one
   `budget_80` notification is created for every live member who has not disabled it, and it is never created
   again that month even if the cron tick runs again before month end.
2. Given the same space reaches 100% (or passes it) of its budget, then a `budget_100` notification is created
   once per WIB month, independent of whether `budget_80` fired.
3. Given a user with the daily nudge enabled who has recorded no live transaction with today's WIB
   `occurred_on` by the time the ~07:00 WIB cron tick runs, then one `daily_nudge` notification is created for
   that user; given the user has already recorded one, then none is created.
4. Given a user crosses a goal's 50% or 100% saved threshold on a contribution write (FN-10's
   `goalSavedMinor`/`goalProgressPercent`), then a `goal_milestone` notification is created once per goal per
   threshold, never again for the same threshold even after further contributions or a later decrease and
   re-cross.
5. Given it is the first cron tick on a WIB Monday, when a user has the weekly summary enabled, then one
   `weekly_summary` notification is created summarising last week's total (reusing FN-09's period-total
   aggregate so the figure equals what Laporan would show for that week), and not again later that day.
6. Given a user has disabled a notification kind in `/pengaturan/notifikasi`, when that kind's trigger
   condition is met, then no row of that kind is created for that user (checked before, not after, creation).
7. Given a created notification and the user holds at least one live Web Push subscription (FN-13) and VAPID
   keys are configured, then a push is attempted to every live subscription; a 404/410 response tombstones
   that subscription (reusing `removeSubscription`) without creating a duplicate notification; a non-2xx,
   non-404/410 response is a bounded retry through the queue, never a crash, and after `max_retries` the
   message reaches the configured DLQ (`montra-jobs-dlq`) and the notification row itself still exists (it
   is not lost — the user still sees it in `/kotak-masuk`, only the push attempt failed).
8. Given VAPID keys are not set (`vapidKeys(getEnv())` returns null, as today), then no push send is attempted
   for any trigger, the in-app notification row is still created normally, and `/pengaturan/notifikasi`
   continues to show "Belum dikonfigurasi" for the device switch exactly as FN-13 left it — FN-24 adds no new
   configuration requirement for push to keep working as today.
9. Given a replayed queue message (same `type` and ids, simulating an at-least-once redelivery), when the
   handler runs twice, then at most one notification row and at most one push attempt per subscription result
   from the two deliveries (idempotency key, per ENGINEERING_CHECKLIST "Idempotent capture").
10. Given the in-app notification list (`/kotak-masuk` or its own route) is opened, when it loads, then it
    shows loading (skeleton), empty ("Belum ada notifikasi" style text), error (with retry) and populated
    states, newest first, and every row is scoped to `locals.user.id` (user-level rows) or passes
    `requireSpaceAccess` for the row's `space_id` (space-level rows) — a user who is not a live member of a
    space that later removed them sees no further rows from it (sync pull / list query re-checks membership,
    never a cached list).
11. Given a user dismisses a notification, when the action completes, then it is a content-free tombstone
    (`deleted_at` set, `title`/`body`/`url` cleared) and no longer appears in the list on reload; given the
    write fails (network/server error), then the list shows the item unchanged with a retryable error, never
    an optimistic removal that silently reverts.
12. Given 20 concurrent cron ticks or queue deliveries target the same space/user/goal/key at once (the
    ENGINEERING_CHECKLIST concurrency probe), then the unique `(user_id, kind, data_key)` index holds exactly
    one notification, proven by a concurrent test.
13. Given a user who is a member of two spaces with independent budgets, when both cross 80% on the same cron
    tick, then two separate notifications are created (one per space), each linking to that space's `/kekayaan`
    or `/laporan`, never merged or cross-attributed.
14. Given the account-deletion path (`deleteAccount`, `src/lib/server/auth/delete-account.ts`) runs, then
    every `user_notifications` row and `notification_prefs` row for that user is deleted in the same batch,
    and every `budget_goal_notifications` row of a space this user was the last live member of is purged via
    `SPACE_SCOPED_TABLES`/`purgeSpaces`, exactly like `featureFlags`/`pushSubscriptions` today.
15. Given a space a user is not a member of, when a crawler hits any notification route or action naming that
    space's id, then it receives the same 404 `requireSpaceAccess` already returns for every other feature —
    no existence oracle, status/body/timing identical to an unknown id.
16. Every new Indonesian string has an English entry (`i18n.test.ts` passes); every money figure in a
    notification body uses `formatMoney`/`formatMoneyCompact`, never hand-formatted; every date in a body is
    the WIB calendar date.

## Architecture notes

- **New migration** `migrations/0012_notifications.sql` (renumber at merge — `0010`/`0011` may already exist
  from a concurrent branch per `docs/TASKS.md`'s note). Drizzle schema additions to
  `src/lib/server/db/schema.ts`: `budgetGoalNotifications`, `userNotifications`, `notificationPrefs`. Add the
  first two to `SPACE_SCOPED_TABLES` (`src/lib/server/spaces/spaces.ts:237`), children before `budgets`
  (they reference a budget/goal's space, nothing references them).
- **Reused exactly as-is:** `requireSpaceAccess`/`isLiveMember` (`src/lib/server/spaces/access.ts`); FN-13's
  full push stack — `listActiveSubscriptions`, `removeSubscription`, `sendPushNotification`, `vapidKeys`,
  `PushSendError` (`src/lib/server/push/*`); FN-07's budget math (`src/lib/server/budgets/math.ts`,
  `safeToSpend`, `berandaFigures`) and `getActiveBudget` (`src/lib/server/budgets/repo.ts`) to detect the
  80%/100% crossing without recomputing it differently; FN-10's `goalProgressPercent`/`goalSavedMinor`
  (`src/lib/server/goals/progress.ts`); FN-09's period aggregate for the weekly summary
  (`src/lib/server/reports/laporan.ts`); `bumpSpaceSeq`/`currentSpaceSeq` (`src/lib/server/sync/seq.ts`) for
  the space-scoped notification table only (user-level notifications are not synced data, like
  `push_subscriptions`, so no `seq`).
- **New:** `src/lib/shared/notifications.ts` (kinds, templates, dedupe-key builders — pure, tested the way
  `src/lib/shared/push.ts`/`money-format.ts` are); `src/lib/server/notifications/repo.ts` (repo, modelled on
  `src/lib/server/goals/repo.ts`'s guarded-insert/`whyNot` pattern for the idempotent create); new queue job
  types in `src/lib/shared/jobs.ts`; real logic in `workers/jobs/src/cron.ts` and `workers/jobs/src/queue.ts`
  replacing the current heartbeat/`ping`-only handlers.
- **Touches:** `workers/jobs/wrangler.jsonc` (no binding changes needed — DB, queue consumer and DLQ already
  configured); `src/routes/(app)/pengaturan/notifikasi/+page.server.ts` and `.svelte` (new prefs section);
  `src/routes/(app)/kotak-masuk/+page.server.ts` and `.svelte`, or a new sibling route, for the list.
- **Worker boundary:** the cron/queue logic lives in `workers/jobs`, same as the existing statement workflow
  skeleton; it shares `src/lib/server/*` and `src/lib/shared/*` code with the app Worker via the `#lib/*`
  alias, exactly as `recordPing` already does (`workers/jobs/src/index.ts:1`).
- **No AI** anywhere in this feature (per the request); every notification body is a fixed template filled
  with stored figures.

## Prerequisites

- **VAPID keys** (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) — already an open owner item from
  FN-13 (`docs/TASKS.md`: "Production/staging VAPID keypair for Web Push… **You**"). FN-24 adds no new
  credential; until they are set, `vapidKeys(getEnv())` returns null exactly as today and every push attempt
  is skipped while in-app notifications still work (criterion 8).
- No other credential needed — no AI, no new provider.

## Owner decisions

All auto-accepted per owner instruction 2026-10-08 (no open questions):

1. **In-app list location:** a new tab/section inside `/kotak-masuk` rather than a new top-level route —
   auto-accepted: reuses an existing nav slot instead of a sixth tab; the engineer may choose a sub-route
   (`/kotak-masuk/notifikasi`) or a toggle within the existing page if that fits the design system better.
2. **Weekly summary day/time:** Monday, first WIB cron tick of the day (~06:00 WIB) — auto-accepted as a
   simple, predictable default; no per-user customisation this pass.
3. **Daily nudge time:** ~07:00 WIB, the first tick after the 06:00 WIB cron window opens — auto-accepted;
   matches the Gmail-check start hour so the user gets one consistent "morning" touchpoint.
4. **Nudge condition:** "no live transaction with today's WIB date yet" (not "no capture via any source") —
   auto-accepted as the simplest, least-surprising rule; a manual entry made at 23:00 yesterday still counts
   for *today's* nudge only if dated today.
5. **Default opt-in:** every kind defaults ON (no row = enabled), matching FN-12's `feature_flags` default —
   auto-accepted for consistency; a user who wants quiet toggles each kind off once.
6. **Dismiss vs. delete:** dismiss tombstones (content-free), never a hard delete — auto-accepted, matches the
   project-wide tombstone convention even though these rows are not synced to other devices via the FN-02
   change log in this pass (that is deferred with FN-02 itself).
7. **Retention:** notification rows are not swept after a fixed period in this pass (no retention job) —
   auto-accepted as the simplest default; flagged for a later retention pass alongside FN-31's stated "no
   retention limits yet" risk.
8. **Budget threshold set:** fixed at 80% and 100% (FEATURES.md's "Ours" line), not configurable per space —
   auto-accepted; matches the stated scope exactly, no new settings surface for thresholds.

## Tracker impact

- Closes the Phase 3 breakdown item to be added under `docs/TASKS.md` › "Phases 3 – 5 and later" (currently
  just "FN-22 – FN-33 in `docs/FEATURES.md`; break them into items here when Phase 2 is under way" — FN-24 is
  the first Phase 3 item broken out once this PRD lands) — specifically the FN-24 line: "Notifications and
  reminders: budget 80%/100%, daily nudge, goal milestones, weekly summary; reuses FN-13 push."
- Moves `docs/ACCEPTANCE.md` rows once checked: no existing row names FN-24 directly; this PRD adds new rows
  under "Required journey" (none — FN-24 is not in the named journey list) and should instead be tracked under
  a new "Notifications" sub-section the engineer's QA report creates, or folded into "Security and privacy" ›
  "Space isolation on every load, action and sync push/pull" (criterion 15 above extends that row to the new
  routes).
