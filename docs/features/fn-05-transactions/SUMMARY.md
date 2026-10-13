# FN-05 Transactions and history + FN-06 Categories — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (owner accepted defaults).

- **Built:** migration `0004_transactions_categories.sql` (categories with 15 lazily-seeded presets per space,
  transactions with positive `amount_minor` + type, `source`, `dedupe_key`, `is_demo`; live-row CHECK requires full
  content and amount 1..10^13, deleted rows content-free); `src/lib/server/{transactions,categories}/` incl.
  `aggregate.ts` (exact per-currency sums via TEXT + BigInt, "too large" state) and wallet sums feeding Kekayaan;
  routes `/riwayat` (WIB day groups, chips, period, search via `instr`, "Muat lebih banyak"), `/riwayat/baru`,
  `/riwayat/[id]/edit`, `/pengaturan/kategori`; Tambah sheet "Ketik manual"; same-currency transfers excluded from
  income/expense; wallet currency locked once used; 100.000 live rows per space; demo seed rows (`Data demo`)
  excluded from totals; e2e `riwayat.spec.ts`; Segmented native radios (arrow keys).
- **QA:** PASS 43/43. **Red team:** FAIL (M1 sum overflow DoS, M2 tombstones kept money data) → fixed, re-check PASS;
  DB-level amount cap added. Open Low: no per-user rate limit (tracked).
