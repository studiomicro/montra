# FN-48d transfer auto-match — summary

**Status: complete** (2026-10-15). QA PASS (`QA_REPORT.md`), red team PASS with two lows (`SECURITY_REPORT.md`;
L1 fixed with a regression test, L2 open in `docs/TASKS.md`).

**Goal (PRD):** right after a statement import commits, merge by themselves only the unambiguous own-transfer pairs
the import touched (both rows in the transfer tile of their kind, exact amount and currency, two wallets of the
space, WIB dates within ±1 day, no other candidate sharing either row), through FN-48c's merge, link and one-step
undo. Card payments stay manual; an undone auto-merge is never applied again. Owner accepted all six defaults:
statement import only, batch-touching pairs only, at most 20 per import, undo memory in `transfer_links.source`, no
audit event, a success line plus an "Otomatis" badge.

**Files:** `src/lib/server/transfers/match.ts` (`autoMatchTransferPairs`, `chooseAutoMatches`, `source` on
`applyTransferMatch` with a write-time ambiguity/card/undo guard), `src/lib/server/statements/statement-import.ts`,
`src/routes/(app)/impor/+page.server.ts`, `+page.svelte`, `cocokkan-transfer/+page.svelte`,
`src/lib/server/db/schema.ts`, `src/lib/shared/i18n-en.ts`.

**Migration:** `0048_transfer_auto_match.sql` — `transfer_links.source` (`manual` | `auto`, CHECK) and the partial
index `transactions_space_amount_idx`.

**Tests:** `test/integration/transfer-auto-match.test.ts` (17), `test/integration/migration-0048.test.ts` (4),
`chooseAutoMatches` unit tests in `match.test.ts` (6); `cocokkan-transfer.test.ts` and `migration-0029.test.ts`
updated.

**Not verified:** on staging (migration 0048 not applied remotely); no browser check of the success line and badge.
