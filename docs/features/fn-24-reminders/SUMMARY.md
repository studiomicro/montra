# FN-24 Notifications and reminders — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted). Phase 3; no AI.

- **Built:** migration `0012_notifications.sql` (space_notifications, user_notifications, notification_prefs,
  notification_deliveries); the jobs Worker cron (hourly 06–23 WIB) walks spaces/users with a persisted cursor and
  enqueues bounded evaluation jobs; the queue consumer creates idempotent notifications (budget 80/100 % once per month,
  daily "catat hari ini" nudge, goal milestones, Monday weekly summary) and sends Web Push via FN-13 to opted-in devices
  of live sessions (no push 00:00–05:59 WIB; claim/retry logic so a replay never pushes twice and a busy claim retries
  past the stale window); rows store type + figures so the list renders in the reader's language; list at
  `/kotak-masuk/notifikasi` with unread count and mark-as-read; per-type switches at `/pengaturan/notifikasi`; 90-day
  retention sweep; account deletion purges all four tables; e2e `notifikasi.spec.ts`.
- **QA:** PASS (live cron verified via `/cdn-cgi/local/scheduled?…&time=`). **Red team:** PASS; Lows (double/lost push,
  10k cursor, retention) fixed and re-reviewed.
- **Not verified:** real push delivery (VAPID keys pending — they must also be set on `montra-jobs`).
