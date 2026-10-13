# FN-24 Notifications and reminders — engineer report (cycle 1)

Branch `fn-24-reminders` (from `main` 9c77de9). Risk tier Medium. No push, deploy, remote D1 or login.

## What works

- **Cron → queue → notification.** `workers/jobs` `scheduled()` runs `runCronTick` (`workers/jobs/src/cron.ts`) on
  the existing hourly 06–23 WIB trigger: one `budget_check` per live space with a live budget every tick, a
  `daily_nudge` per user (pref not off) on the 07:00 WIB tick, a `weekly_summary` per user on Monday's 06:00 WIB
  tick. Keyset pages of 100 (`src/lib/server/notifications/schedule.ts`), at most 100 pages per kind per tick.
  Nothing in quiet hours (00:00–05:59 WIB; manual/misfired ticks). Logs counts only.
- **Queue consumer** (`workers/jobs/src/queue.ts`): exhaustive switch over `ping`, `budget_check`, `daily_nudge`,
  `weekly_summary`, `send_push`; each trigger creates rows through the one guarded insert and enqueues one
  `send_push` per new row (a redelivered message, `attempts > 1`, re-enqueues rows it found, safe because pushes
  are claimed per device). A stale `daily_nudge` (processed on another WIB day) is dropped. Failures retry; DLQ
  as configured. Bodies never logged. FN-26 extension point is a commented case in the switch.
- **Triggers** (`src/lib/server/notifications/triggers.ts`): budget 80 %/100 % from FN-05 `periodTotals` over the
  WIB month in the budget's currency (the figure Beranda shows) and FN-07 `getActiveBudget`; goal milestones from
  FN-10 `getGoal` (`goalProgressPercent`) on the contribution write path (synchronous create, push enqueued);
  daily nudge guarded in-statement by "no live non-demo transaction dated today in any live space of the user";
  weekly summary from `periodTotals` over last Monday–Sunday (WIB) of the personal space, favourite-wallet
  currency (as Laporan).
- **Idempotency:** `createIfAbsent` (`src/lib/server/notifications/repo.ts`) is one `INSERT … SELECT … WHERE` +
  `ON CONFLICT DO NOTHING` on the unique `(user_id, kind, data_key)` index (no `deleted_at` condition, so a
  dismissed key never returns); recipient active, pref not off and (space kinds) `isLiveMember` checked in the
  statement. Push delivery claims each `(notification, subscription)` pair in `notification_deliveries` first.
- **Push:** FN-13 `listActiveSubscriptions` + `sendPushNotification` unchanged in behaviour; 404/410 tombstones
  the subscription; other failures release the claim and throw `PushRetryError` (queue retry → DLQ); the row
  stays. No VAPID keys → `unconfigured`, in-app only. Quiet hours → no push. Push text is Indonesian.
- **UI:** `/kotak-masuk/notifikasi` (list newest first, unread dot + "Belum dibaca", open = mark read + switch to
  the row's space + redirect, dismiss = content-free tombstone; skeleton/empty/error/retry; no optimistic
  change), entry row with unread count on `/kotak-masuk`; `/pengaturan/notifikasi` gains five per-kind switches
  (shown and saved without VAPID; device switch unchanged).
- **Data:** `migrations/0012_notifications.sql` (chained to 0009's snapshot; renumber at merge):
  `space_notifications` (in `SPACE_SCOPED_TABLES`, `seq` bumped on writes), `user_notifications`,
  `notification_prefs`, `notification_deliveries`. `deleteAccount` deletes all four for the user.

## Decisions taken (beyond the PRD's auto-accepted defaults)

1. Rows store `kind` + `params` (the stored figures, JSON) instead of rendered `title`/`body`/`url`: the list renders
   in the reader's locale, the link is derived from the kind (`notificationUrl`), never stored. Tombstone clears
   `params` and `read_at`.
2. Push copy is Indonesian (the jobs Worker has no per-user language; locale is a cookie only).
3. A jump past a threshold creates only the highest one (≥100 % → `budget_100` only; ≥100 % saved → goal 100 only).
4. Daily nudge counts transactions in every live space of the user (shared included), demo rows excluded.
5. Weekly summary covers the personal space only.
6. Goal milestones are created synchronously in the action; no `goal_milestone` queue type (nothing would enqueue it).
   Messages carry the WIB date (`daily_nudge.date`, `weekly_summary.weekStart`) besides ids.
7. Quiet hours: 00:00–05:59 WIB never pushes (a milestone created at night stays in-app only).
8. Jobs Worker gets a `JOBS_QUEUE` producer binding on its own queue and an `Env` augmentation for VAPID secrets;
   RUNBOOK notes that the VAPID secrets must also be set on `financer-jobs`.
9. Type-only fixes in `push/encrypt.ts`/`push/send.ts` so they compile under the Workers runtime types (byte copy
   via `new Uint8Array(...)`, a cast for `deriveBits`' `public`); RFC 8291 vector test still passes.

## Tests

- `src/lib/shared/notifications.test.ts` (18): exact BigInt thresholds, keys, WIB hours/quiet hours, Monday
  06:00 WIB = Sunday 23:00 UTC, month boundary 23:30/00:30 WIB, params parsing, ID/EN text via `formatMoney`, URLs.
- `workers/jobs/src/cron.test.ts` (+5), `workers/jobs/src/queue.test.ts` (+7): paging, schedule, stale nudge,
  enqueue-only-new, redelivery, retry, no body in logs.
- `test/integration/notifications.test.ts` (24, local D1): cron→queue→notification replay (no duplicate row or
  push), 20-way concurrency, 80/100 once per WIB month, WIB boundary, demo excluded, prefs before creation,
  two spaces → two rows, removed member/stranger 404 (same body), push 410/500/no VAPID/quiet hours, nudge rules,
  weekly = `periodTotals`, goal 50/100 once incl. drop and re-cross, settings, account deletion.
- Fail-before (mutation) runs: removing the delivery claim fails 2 tests; disabling the pref guard and the
  membership re-check fails 3 tests.
- `e2e/notifikasi.spec.ts` (new journey at 360 px): milestone → list → open → dismiss; preferences persist.

## Checks run

- `npm run gates`: svelte-check `0 ERRORS 0 WARNINGS` (+ tsc service worker, jobs, inbound clean); prettier and
  eslint clean; Vitest `91 files, 1309 tests passed`; build OK.
- Full e2e (`E2E_PORT=8847`): 162 passed, 24 failed, 15 skipped on the full parallel run (timeouts and workerd
  "broken pipe" under load across untouched specs). Each failing file rerun alone once: pwa 19, riwayat 15,
  ruang 13 (+2 skipped), suara 15, tabungan 15 (+2), accounts 23 (+6), kekayaan 14 (+3), kotak-masuk 7,
  laporan 9 passed; new `notifikasi.spec.ts` 5 passed (setup + 2 tests × phone/desktop).
- Real cron path: `wrangler dev` with the jobs config first, local persist dir, port 8826, `--test-scheduled`;
  `/cdn-cgi/handler/scheduled?…&time=1791417600000` (07:00 WIB 8 Oct) logged `budgets: 1, nudges: 1`, two queue
  batches ran, D1 held one `budget_80` (`budget:<space>:2026-10:80`, spent 850000 of 1000000) and one
  `daily_nudge`; two more ticks (07:00 replay, 08:00) left the count at 2. Server stopped.

## Pre-handoff probes

- Concurrency: 20 concurrent `createIfAbsent` on one key → 1 row, 1 `created` (integration test). PASS.
- Two tabs / stale forms: dismiss/open of an already-dismissed row → 404, never a second change; prefs are a
  last-write-wins upsert (as feature flags). PASS.
- Cross-space: stranger and removed member get the identical 404 `Not found` for open/dismiss; list re-checks
  live membership; two spaces crossing → two rows, each with its own space. Sync pull: notifications are not
  synced in this pass (N/A). PASS.
- Month boundaries: 23:30 WIB on 30 Sep counts September, 00:30 WIB on 1 Oct is October (integration + unit). PASS.
- 360 px: `notifikasi.spec.ts` at 360 px, `expectNoHorizontalScroll` on list and settings. PASS.
- No-JS forms: open/dismiss are plain POST forms with redirect/`fail`; settings rows keep the Simpan button
  without JS (fitur pattern). Not browser-tested without JS in this cycle.
- User copy: notification text is fixed templates with names and `formatMoney` figures; no ids or paths. PASS.
- Money vectors / two devices: N/A (no money parsing, no sync change).

## Gaps

- No real push service exercised (VAPID keys are an open owner item); push tested with a stubbed fetch only.
- VAPID secrets must also be set on `financer-jobs` when the owner configures push (RUNBOOK).
- No retention sweep for notification rows (owner decision 7); push copy Indonesian only.

## Cycle 2 (red-team Lows L1–L4)

- **L1** (`triggers.ts deliverPush`): `finishDelivery` now runs outside the send `try`; if recording fails (one
  retry), the claim is kept, never released, and the device counts as delivered, so the message is acked and no
  retry sends it again. Residual: a crash between the push service's 2xx and the record, followed by a retry of
  the same message more than 5 minutes later, can still resend (idempotency preferred; no way to tell this from
  "died before sending").
- **L2** (`repo.ts claimDelivery` → `'claimed' | 'done' | 'busy'`): a device claimed by another attempt is no
  longer skipped as sent; `PushRetryError` (now a `RetryLaterError`, `src/lib/shared/jobs.ts`) asks the queue to
  `retry({ delaySeconds: 360 })`, past the 5-minute stale window, so the retry takes the dead claim over. Bounded
  by `max_retries` then the DLQ.
- **L3** (`workers/jobs/src/cron.ts`): each walk stores its position in `app_meta` (`cron:budget_check`,
  `cron:daily_nudge`, `cron:weekly_summary`; one row each, overwritten). Budgets rotate endlessly (continue
  from the last id, wrap at the end); the nudge runs from 07:00 WIB and the weekly summary on Monday from 06:00 WIB
  until that day's/week's pass is done, so every id is reached within ceil(n / 10,000) ticks. `tickPlan` now
  allows those windows; the stored "done" keeps each pass to once.
- **L4** (`schedule.ts sweepNotifications`, run every tick): bounded batch (500 rows per statement) deleting user
  notifications, budget alerts and delivery records older than 90 days; goal milestones that old become
  content-free tombstones (key kept, so a milestone is still never repeated); rows of recipients who are no
  longer live members become content-free tombstones. New `created_at`/`updated_at` indexes in 0012 (regenerated,
  still chained to 0009; not applied anywhere outside this branch).
- RUNBOOK: manual tick via `/cdn-cgi/local/scheduled?…&time=<ms>` (`/__scheduled` ignores `time`), cursors and sweep.
- Tests (written first; fail-before runs against cycle-1 code: L1/L2 2 failed, L3 4 failed, L4 3 failed): 3 cron
  cursor tests + malformed-cursor test, 2 delivery tests, 3 sweep tests, 1 D1 cursor test, 1 queue delayed-retry
  test; `tickPlan` unit test updated for the new windows.
