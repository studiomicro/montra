# FN-11 Drafts inbox (Kotak masuk) — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted).

- **Built:** migration `0006_drafts.sql` (drafts with dedupe partial unique index, content-free discard, DB amount cap);
  `/kotak-masuk` list and `/kotak-masuk/periksa` review with bulk Atur kategori / Atur dompet and "Simpan N transaksi"
  in one guarded `db.batch` (all or nothing); drafts become transactions only via FN-05's shared
  `insertTransactions`/`createTransaction(…, origin)` and validator (`source`, `dedupeKey`, `isDemo` from the stored
  draft, never a form); stale 409 via per-row `updated_at`; one-shot httpOnly cookie summary; caps 100 listed / 50 per
  save / 1.000 pending per space; dev-only seed behind `devRoutesEnabled` (404 in production) — no real capture source
  writes drafts yet (Phase 2); e2e `kotak-masuk.spec.ts`.
- **QA:** PASS 28/28 (FN-05 insert path verified unchanged). **Red team:** PASS; Lows (demo flag on save, draft cap)
  fixed in cycle 2.
