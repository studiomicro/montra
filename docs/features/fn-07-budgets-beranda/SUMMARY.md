# FN-07 Budgets and safe-to-spend + FN-08 Beranda — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (owner accepted defaults A–G).

- **Built:** migration `0008_budgets.sql` (one budget per space, revived in place on re-set); Beranda hero
  "Pengeluaran <bulan>" in the favourite wallet's currency (other currencies listed separately), ComparisonPill
  month-to-date vs the same days last month (±Rp 50.000 "hampir sama"), daily average, "Hari ke-N", safe-to-spend =
  remaining ÷ remaining WIB days floored, budget sheet with Hapus anggaran and a no-JS form, today's list = Riwayat's
  day group, chart picker (14-day bars with ≥44 px hit columns, per category, vs last month); `dailyTotals`/
  `categoryTotals` on FN-05's exact-sum path with the "too large" state; budget amount via `wholeAmountMinor` + 10^13
  cap; budget currency validated against the space's wallets; e2e `beranda.spec.ts`.
- **QA:** cycle 2 FAIL (criterion 28: 22 px bar targets) → fixed; cycle 3 re-check PASS. **Red team:** PASS; Lows
  (churn, shared parser + cap, currency from hidden field, removed-member 404) fixed in cycle 3.
