# FN-09 Reports (Laporan) — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted).

- **Built:** `/laporan` with three fixed periods (this month, last month, year to date) via a no-JS GET form; in/out/net
  per currency; per-category (CategoryBar) and top-10 merchants (normalised exact text, SQL top-N); month trend for the
  year; all sums on FN-05's exact TEXT+BigInt path with the "too large" state (fixed a `?? 0` overflow bug);
  Laporan = Riwayat = Beranda totals for the same filter; transfers and demo rows excluded; new aggregate helpers
  `monthlyTotals`, `merchantTotals`, `yearToDateRange`; failed loads log no D1 error text; e2e `laporan.spec.ts`.
- **QA:** PASS 26/26. **Red team:** PASS; L2 (error logging) fixed; L1 (non-ASCII merchant case) left for FN-20.
