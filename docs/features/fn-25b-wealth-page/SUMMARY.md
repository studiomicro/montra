# FN-25b Kekayaan page parity — SUMMARY (pass 1)

Status: **pass 1 complete** (2026-10-11). Pass 2 (FN-25c: Piutang kind, credit-card statement and due days) open;
portfolio screenshot import deferred.

- Built: net-worth trend chart from stored daily snapshots (1 bln / 3 bln / 1 thn / Semua, simple SVG), allocation
  bar with chips (assets only; debts as a separate minus line; integer percentages summing to 100), "Belum dihitung"
  suggestions (Emas, Dana pensiun) with quick add, grouped Dompet / Investasi / Kripto sections with totals,
  credit-card cards with 30-day spend, every new amount behind the eye toggle, desktop two columns from 1024 px.
  No migration.
- QA: PASS. Red team: PASS with two lows (amounts flash before the eye toggle applies on reload; the trend line and
  percentages stay visible while amounts are hidden — product decision).
