# FN-34b Streak extensions — SUMMARY

Status: **complete** (2026-10-11). Goal: more reasons to close each day, without coins or points.

- Built: `/beruntun` (current and longest streak within 400 days, calendar, 7/30/100 milestones; the Beranda chip
  links there); computed freezes (one per 7 closes, at most 2, used on a gap, never written as a closure); evening
  "close the day" reminder (on by default at 20:00 WIB, whole hours 06–23, one per user per WIB day); a per-space
  budget streak judged against that day's safe-to-spend and snapshotted the next morning.
- Migration: `0038_streak_plus.sql` (new `budget_streak_days`; rebuilds `notification_prefs` and
  `user_notifications`).
- QA: PASS (29 criteria). Red team: PASS with L1 (the reminder rotation queues every user each open hour; slow above
  ~10 000 users) and L2 (a push can still go out if the day was closed after the reminder row was made; fixed text).
- Not verified: a real push (no VAPID keys on staging).
