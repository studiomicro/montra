# FN-26b Subscription check — SUMMARY

Status: **complete** (2026-10-11). Goal: Langganan finds likely subscriptions in recent payments.

- Built: a check card on `/langganan` that reads up to 300 expenses from the last 90 WIB days and lists up to 20
  candidates (known service names, or the same amount at one place on a weekly, monthly or yearly rhythm), each with
  its source rows; "Tambah" opens the existing subscription form pre-filled; "Bukan langganan" is remembered; nothing
  is added automatically. New `utilitas` entries (PLN, PDAM). Empty-state copy and a full-width add button.
- Migration: `0039_subscription_dismissals.sql` (one table, IF NOT EXISTS).
- QA: PASS (16 criteria). Red team: PASS with three lows (no per-space cap on dismissals; astral-plane titles cannot
  be dismissed; titles cleaned twice per load).
