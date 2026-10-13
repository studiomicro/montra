# FN-16j Move import batch — security report

Reviewed 2026-10-11. Scope: `git diff de86268..HEAD` plus the QA additions to `e2e/impor.spec.ts`
(uncommitted). Files: `src/lib/server/imports/repo.ts` (`batchWalletSides`, `importBatchMoveStates`,
`moveImportBatch`), `src/routes/(app)/impor/+page.server.ts` (`move` action, loader), `+page.svelte`,
`messages.ts`, `i18n-en.ts`, `schema.ts`, `migrations/0042_import_batch_moved.sql`, both new integration tests.

## Verdict

**PASS.** No medium or high findings. Two low findings are listed below for tracking.

## What was checked

- **Authorization / IDOR.** The batch read and the guarded `UPDATE import_batches` both filter by `space_id` from
  `currentSpaceScope` (never from the form) and `isLiveMember`. The target wallet is looked up with `getWallet(db,
  spaceId, …)` and re-checked in the guarded UPDATE (`w.space_id = spaceId AND w.deleted_at IS NULL`, same
  currency as the source). Every transaction UPDATE filters `space_id` + `import_batch_id` + live, and runs only
  when the batch row changed in the same `db.batch` (`moved` = batch `seq` equals the freshly bumped space seq,
  which no earlier row can hold). Another space's batch answers `missing` (404, `BATCH_NOT_FOUND`), and another
  space's wallet answers `wallet_not_found` (404, `WALLET_NOT_FOUND`). Each answer is the same as for an
  unknown id: no existence oracle. Membership is checked before the wallet lookup. Tests AC-12 and AC-13 cover
  this.
- **Role.** Any live member may move a batch, which matches `undo`. Member management is not touched.
- **CSRF.** The `move` action is a normal form POST and is covered by the `isCrossSiteForm` check in
  `src/hooks.server.ts:66`.
- **Transfers.** Only the source-wallet side moves. A row that would become from = to is skipped and counted.
  `transfer_to_wallet_id` for a row cannot point outside the space; every UPDATE is space-scoped. A from = to
  row is changed by pass (b), and pass (c) excludes it afterwards (`wallet_id <> target`), so no row is changed
  twice.
- **Races.** The not-exists clause in the guard catches a row edited between the read and the write. The
  `updated_at = expected` guard catches undo, delete or a concurrent move. A wallet tombstoned or a currency
  changed in the meantime is caught by the target/currency subquery. A refusal writes no rows: only the space
  seq is bumped, which is harmless. Tests cover this: 20 concurrent moves give exactly one winner, and a row
  moved by hand mid-move gives `stale`.
- **Sync.** Every changed row gets `seq = currentSpaceSeq` and `updated_at = max(now, updated_at + 1)`, so pull
  sees the moves. Amounts, currencies and dates are untouched.
- **Audit.** The row holds only space id, actor, action, null target and a timestamp. It has no transaction ids,
  amounts, wallet names or PII. It is written in the same batch under the same `moved` guard.
- **Migration 0042.** It is identical to the 0016 rebuild except that the CHECK list is widened. All six columns
  are copied. The three FKs (spaces cascade, users set null x2) and `audit_events_space_idx` are re-created. It is
  re-runnable (`DROP TABLE IF EXISTS __new_audit_events`). No table references `audit_events`.
  `migration-0042.test.ts` proves that data is preserved and the CHECK enforced.
- **Bounded queries and the D1 bind cap.** Batch ids are bound once as JSON via `json_each` (tested with 120 ids).
  The loader passes at most `IMPORT_LIST_MAX` = 50 ids. Form ids are capped at `ID_MAX_LENGTH`. `updatedAt`
  is regex-checked. There is no raw string interpolation: all values in the `sql` templates are bound.
- **Output.** There is no `{@html}`. The wallet name is rendered as text through `trf`. The loader exposes only
  `id`, `name` and `currency` of the caller's own space's live wallets. No secrets are in page data.
- **Engineering checklist.** Guarded single statement in one `db.batch` with a concurrent test: yes. JSON-bound
  lists with 101+ test: yes. Same answer for hidden and missing: yes. Migration re-runnable: yes. Cross-space and
  removed-member probes: yes (AC-12/13). Every new string has an English entry: yes.

## Findings

1. **Low — status oracle after the guard misses, for a member removed mid-request.**
   `src/lib/server/imports/repo.ts:393`. When the guarded UPDATE changes nothing, the follow-up read omits
   `isLiveMember`. A user whose membership was removed between the first read (which passed) and the
   `db.batch` gets `already`/`stale` (409) instead of `missing` (404). That user saw the batch a moment earlier,
   so nothing new leaks and nothing is written. Fix suggestion: add `isLiveMember(spaceId, userId)` to that
   re-read so it answers `missing`.
   - **Resolution (2026-10-13): FIX.** `fix(import): move refuses an archived source wallet and answers missing to a removed member (FN-16j L1, L2)`. The re-read after a missed guard now includes `isLiveMember`, so a member removed mid-request gets `missing` (404). Test: `imports-move.test.ts` "FN-16j red team L1: a member removed while the move runs gets missing, never a status".
2. **Low — source wallet read with `includeArchived: true`.** `src/lib/server/imports/repo.ts:299` and the guard
   subquery `f.id = source AND f.space_id = spaceId` do not require the source wallet to be live. Rows sitting in
   a tombstoned wallet can be moved to a live wallet of the same space. This stays inside the caller's own space
   and makes those rows visible again. It is not a cross-space issue. A deleted source wallet whose row is gone
   answers `currency_mismatch`, which is a misleading message. Track it as a product question, not as an
   exploit.
   - **Resolution (2026-10-13): FIX.** `fix(import): move refuses an archived source wallet and answers missing to a removed member (FN-16j L1, L2)`. The source wallet must be live: an archived one is refused up front with its own reason (`source_archived`, 409, "Dompet impor ini sudah diarsipkan. Pulihkan dompet itu dulu untuk memindahkan impor ini."), and the guard's currency subquery also requires `f.deleted_at is null`, so a wallet archived during the move gives `stale` and nothing moves. The misleading `currency_mismatch` for a missing source is gone. Test: `imports-move.test.ts` "FN-16j red team L2: a batch whose wallet is archived stays there, before or during the move".

## Commands run (local only, no remote D1, no commit)

- `npx vitest run test/integration/imports-move.test.ts test/integration/migration-0042.test.ts`:
  2 files, 18 tests passed.
