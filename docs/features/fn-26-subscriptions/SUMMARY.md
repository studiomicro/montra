# FN-26 Subscriptions (Langganan) — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted).

- **Built:** migration `0013_subscriptions.sql` (subscriptions with `is_demo`; rebuilds `notification_prefs` and
  `space_notifications` to add the `bill_reminder` kind — verified byte-identical data and indexes); `/langganan` with
  our own 38-service catalogue (names only, initials tiles), custom subscriptions, monthly/weekly/yearly cycles with
  month-end and leap-year clamping in WIB, monthly "≈" total per currency (floored once), mark paid → FN-05
  transaction (idempotent per charge date), content-free deletion; bill reminders through FN-24 (per subscription and
  charge date, preference switch "Tagihan langganan", quiet hours, max 5 single pushes per member per WIB day then one
  grouped notification, deleted subscriptions blanked in reminders); FN-12 Langganan toggle with a nav entry; demo seed;
  e2e `langganan.spec.ts`.
- **QA:** PASS 12/12. **Red team:** PASS; Lows (push flood cap, blanking on delete, RUNBOOK) fixed in cycle 3.
