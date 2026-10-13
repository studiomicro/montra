# FN-49 Patungan — SUMMARY (pass 1)

Status: **pass 1 complete** (2026-10-11). Later passes: percentage and per-item modes with the Struk entry, the
share link and WhatsApp text, partial payments, the Kekayaan Piutang follow-up after FN-25c, auto-settle from
imported repayments.

- Built: splits with participants by name, equal (remainder to the payer) and exact modes; a split can link to the
  transaction that paid the whole bill, and every aggregate then counts only the payer's share
  (`EFFECTIVE_AMOUNT` in `aggregate.ts`); without a bill row the payer's own share is recorded as an expense; Lunas /
  undo per person; payer-only writes, with the Pemilik able to unlink or delete once the payer is no longer a member
  (owner decision 9); demo splits read-only on the server; a linked bill's amount cannot be edited anywhere.
- Migration: `0041_patungan.sql` (ALTER on `transactions`, CHECKs, partial unique index, same-space triggers;
  rebuild of `feature_flags` only).
- QA: PASS (cycle 2). Red team: PASS (cycle 2; L1 and L2 fixed). Info: a deleted payer's name stays on shared
  splits (owner decision).
