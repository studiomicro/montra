# FN-48 Part C Own-transfer matching — SUMMARY

Status: **complete** (2026-10-13), after 3 fix cycles.

Goal (PRD): an own transfer between two wallets (e.g. BCA to OCBC) imported from two statements is two unrelated
rows that Beranda and Laporan count as both spending and income. "Cocokkan transfer" finds same-amount pairs of
Transfer keluar / Transfer masuk rows across two wallets within ±1 day, the user confirms each pair, the pair merges
into one transfer row, and a merge can be undone with both rows restored exactly.

- Files: `src/lib/server/transfers/match.ts` (propose, apply, undo, list, `settleTransferLinksOfBatch`),
  `src/lib/server/transfers/messages.ts`, `src/lib/server/imports/repo.ts` (import undo settles links,
  `ok_transfer_kept`; FN-16j move refused with `transfer_linked`), `src/lib/server/db/schema.ts`,
  `src/lib/server/export/tables.ts`, `src/lib/server/spaces/spaces.ts`, `src/routes/(app)/impor/` (card, notes),
  `src/routes/(app)/impor/cocokkan-transfer/`, `src/lib/shared/i18n-en.ts`, `docs/FEATURES.md`.
- Migration: `0043_transfer_links.sql`.
- Tests: `test/integration/cocokkan-transfer.test.ts`, `cocokkan-transfer.qa.test.ts`, `migration-0043.test.ts`,
  `src/lib/server/transfers/match.test.ts`, `e2e/cocokkan-transfer.spec.ts`, `e2e/cocokkan-transfer-move.qa.spec.ts`.
- QA: PASS (cycles 1, 2, 3). Red team: FAIL cycle 1 (M1, M2), FAIL cycle 2 (M3), PASS cycle 3 with low L3; QA low
  (undo list shows the 50 newest links). Both logged in `docs/TASKS.md`.
- Not verified: staging (not deployed); the owner's sample rows.
