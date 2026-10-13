# FN-16j Move an import to another wallet — SUMMARY

Status: **complete** (2026-10-11).

Goal (PRD): let the user move an import batch that landed in the wrong wallet, since undo plus re-import is blocked
by dedupe keys.

- Files: `src/lib/server/imports/repo.ts` (`moveImportBatch`, `importBatchMoveStates`), `src/lib/server/imports/messages.ts`,
  `src/lib/server/db/schema.ts` (audit action), `src/routes/(app)/impor/+page.server.ts` (`move` action, load),
  `src/routes/(app)/impor/+page.svelte` (control), `src/lib/shared/i18n-en.ts`, `docs/FEATURES.md`.
- Migration: `0042_import_batch_moved.sql` (rebuilds `audit_events`, widens the action CHECK).
- Tests: `test/integration/imports-move.test.ts`, `test/integration/migration-0042.test.ts`, `e2e/impor.spec.ts`.
- QA: PASS (`QA_REPORT.md`). Red team: PASS with lows L1, L2 (`SECURITY_REPORT.md`), logged in `docs/TASKS.md`.
- Not verified: staging (not deployed yet).
