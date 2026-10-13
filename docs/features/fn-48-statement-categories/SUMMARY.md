# FN-48 Categories for imported rows — SUMMARY (Part A)

Status: **Parts A and B complete** (2026-10-11). Part C (own-transfer matching) is open.

- Goal: imported rows get a real category from the bank's own mutation text instead of "Lainnya" / "Pemasukan Lain".
- Built: deterministic bank-narrative layer (`src/lib/shared/merchants/bank-narratives.ts`) inside FN-20's resolver
  with the reason "Dari kode mutasi bank"; six new preset tiles (Biaya Bank, Pajak, Tarik Tunai, Kartu Kredit,
  Transfer keluar, Transfer masuk, Bunga); `category_source` on transactions and drafts; "Rapikan kategori"
  preview/apply/undo at `/impor/rapikan-kategori` for eligible rows, never hand-set ones.
- Migration: `0037_fn48_categories.sql` (rebuilds categories, recurring_transactions, category_budgets,
  merchant_rules; adds two `category_source` columns last).
- QA: PASS (40 criteria; fresh and seeded-data migrations keep every row, FK check clean). Red team: PASS with L1
  (a sender's note can steer a category only), L2 (0037's last two ALTERs are not repeatable), L3 (info).

## Part B — month continuity (2026-10-11)

- Built: each statement import stores its wallet, period (WIB) and printed Saldo Awal/Akhir; preview and import
  compare Saldo Awal with the previous statement of that wallet by date (or with the wallet's balance before the
  first statement), listing each break in a "Kesinambungan saldo" card on `/impor`; "Catat selisihnya" writes one
  FN-37 adjustment for exactly the gap, recomputed on the server. No guess when a printed balance is missing,
  periods overlap or the file is cut off.
- Migration: `0040_fn48_continuity.sql` (nullable columns and an index on `import_batches`).
- QA: PASS. Red team: PASS with L1 (0040 ALTERs not re-runnable) and L2 (printed balances stored unsealed — owner
  decision). Cycle fix: statements starting on the same day are now ordered deterministically.
