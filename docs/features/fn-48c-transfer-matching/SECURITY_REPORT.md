# Security report — FN-48 Part C "Cocokkan transfer" (cycle 1)

Reviewed: `git diff 115ff51..34fec61` on `feat/fn-48c-transfer-matching` (rebased on `a45585f`), plus QA's uncommitted
`test/integration/cocokkan-transfer.qa.test.ts` and `QA_REPORT.md` (QA PASS). Focus: `src/lib/server/transfers/match.ts`,
`src/routes/(app)/impor/cocokkan-transfer/+page.server.ts`, `migrations/0043_transfer_links.sql`, schema, export and
space-deletion tables. Reviewer: red-team-pentester, 2026-10-12.

## Verdict: FAIL

Two medium findings, both at the seam between a live transfer link and "Urungkan impor" (`undoImportBatch`). No
authorization, injection, secrets or masking issue found. Everything else attacked holds (see "Checked and held").

## Findings

### M1 (medium) — Undoing the merge revives a row of an import batch the user has since undone

`src/lib/server/transfers/match.ts:313-322` (undo guards) and `:366-394` (credit restore).

Scenario: debit row from batch A (wallet BCA), credit row from batch B (wallet OCBC). User confirms the pair
(credit tombstoned with `deleted_at = link.created_at`). User then opens `/impor` and presses "Urungkan" on batch B:
`undoImportBatch` marks the batch `undone_at` and tombstones its *live* rows — the credit is already a tombstone, so
it is left exactly as the merge wrote it. User then presses "Urungkan" on the transfer link. The undo guards only
check that the credit still holds what the merge wrote (`c.deleted_at = l.created_at`, `updated_at` match) and that the
credit's wallet is live; they do not check the row's `import_batch_id` batch is still live. The credit row comes
back with `deleted_at = null` while `import_batches.undone_at` is set.

Effect: an income of Rp 5.000.000 counts again in Beranda/Laporan and in wallet B's balance although the batch it
came from shows as undone; the /impor batch card says "diurungkan" while one of its rows is live. Money is not
invented (the row is the user's own), but the record contradicts the user's explicit undo and the batch state, and
a re-import of statement B then hits the live row's dedupe key, so the user cannot repair it through import.

Reproduced on a local D1 (probe `cocokkan-transfer.redteam.test.ts`, kept in the reviewer scratchpad, not committed):
`undoImportBatch` → `ok`, `undoTransferMatch` → `ok`, credit `deleted_at` → `null`, batch `undone_at` → set.

Fix options (engineer's choice): refuse the undo (`stale`) when either snapshot row's `import_batch_id` points at a
batch with `undone_at is not null`; or have `undoImportBatch` mark links of its rows undone-by-import so they leave
the "Urungkan" list.

### M2 (medium) — Undoing the debit row's import batch silently loses the other batch's credit row for good

`src/lib/server/imports/repo.ts:138-155` (`undoImportBatch` tombstones live rows only) with
`src/lib/server/transfers/match.ts:313-322` (undo refuses once the debit is a tombstone).

Scenario: same pair as M1. User presses "Urungkan" on batch A (the debit's batch). The merged transfer row is
tombstoned as part of batch A — expected. But the credit row, which belongs to batch B and which the user never
undid, stays a tombstone: it was deleted by the merge, and the only path back (`undoTransferMatch`) now answers
`stale` (409 "changed") forever because the debit is deleted. Its dedupe key stays on the tombstone, so re-importing
statement B never recreates it (that is Part C's intended dedupe behaviour, which here works against the user). The
link remains live in the review's "Urungkan" list with `title: null` and a button that always fails.

Effect: wallet OCBC permanently lacks a Rp 5.000.000 credit that is on the user's statement; the FN-48B continuity
check for wallet B will flag a gap the user cannot close by import. A financial record is lost through two normal,
unwarned actions; the PRD's "restore, not recreate" decision is honoured but its consequence is not surfaced.

Reproduced on local D1: `undoImportBatch(batch A)` → `ok`; `undoTransferMatch` → `stale`; credit `deleted_at` still set.

Fix options: on `undoImportBatch`, for every live link whose debit row is in the batch, restore the credit row from
the snapshot (same guarded shape) and mark the link undone; or refuse "Urungkan impor" with a message while the
batch has rows in a live link; or let `undoTransferMatch` restore the credit alone when the debit is a tombstone.

### No low findings worth tracking beyond the two above

## Checked and held

- Authorization: load and both actions go through `currentSpaceScope` → `requireSpaceAccess`; every write repeats
  `isLiveMember` inside the guarded statement. A removed member gets 404 (QA/feature tests). Cross-space: debit of my
  space with a credit of another space → `missing`, nothing written (probe run). Other space's link id → `missing`.
  Wallet and category lookups are pinned to `spaceId` in `eligible()`; snapshot `walletId` is re-checked against
  `wallets.space_id` on undo, so even a tampered snapshot cannot point a row at another space's wallet.
- Replay and races: one `db.batch` per merge/undo; `updated_at` guards both rows; `seq`-stamped "written in this very
  batch" guard before touching rows; partial unique indexes on live debit/credit ids; `already`/`stale`/`missing`
  answers with one wording for unknown and foreign ids. 20 concurrent confirms/undos covered by feature tests.
- Money invariants: no `amount_minor` is written on merge; expense+income become one transfer; credit tombstone uses
  `TOMBSTONE_CONTENT` and keeps `dedupe_key`, `import_batch_id`, `created_at`; Patungan bills and photo-bearing
  credits excluded; same `currency` enforced in `PAIRED`.
- Bounds: `limit 200` preview, `limit 50` links, count in SQL; `EXPLAIN QUERY PLAN` of the pair join uses
  `transactions_space_day_idx` on both sides with the ±1 day range (no full self-join).
- Input: ids capped at `ID_MAX_LENGTH`, versions matched against `/^\d{1,15}$/`, body via `readFormBody` (8 KiB cap);
  all SQL parameterised (only `sql.raw` on fixed alias/column literals). No `{@html}`; `{#each}` keyed by ids.
- Privacy: titles masked with `maskAccountNumbers` in preview and link list; notes not shown; no secrets in page data.
- Export and deletion: `transfer_links` in `SPACE_TABLE_DECISIONS` (json) and `SPACE_SCOPED_TABLES` (deleted before
  `transactions`), FK `on delete cascade` to `spaces`.
- Migration 0043: `IF NOT EXISTS` on table and indexes; re-runnable.
- Engineering checklist: guarded statements, bounded scans, one access rule, i18n entries present, form guard used.

## Commands run

- `npx vitest run test/integration/cocokkan-transfer.redteam.test.ts` — 4 probes: 3 passed, 1 failed (M1 assertion;
  M2 probe passed by asserting the observed loss). Probe file moved to the reviewer scratchpad, not left in the tree.
- `EXPLAIN QUERY PLAN` of the pair count join on local D1 — indexed on both sides.

---

# Cycle 2 (re-check of `git diff 34fec61..b995b39`)

**Verdict: FAIL** — M1 and M2 are closed. One new medium finding (M3) remains: a narrower form of M2 that the new
settle path leaves open.

## M1: closed

Undoing the credit row's import batch (batch B) now settles the link in the same `db.batch`. The debit row comes back as its
expense: `type` is `expense`, `transfer_to_wallet_id` is null and the category is restored. The credit row stays a
tombstone. A later `undoTransferMatch` answers `already` and writes nothing (full dump of the space's transactions,
links and batches is identical before and after). `undoTransferMatch` also has its own `rowImportLive` guard. The
cycle-1 probe can no longer reach a live link after the import undo: `listTransferLinks` is empty.

## M2: closed

Undoing the debit row's import batch (batch A) now restores the credit row of batch B from its snapshot: it is live,
`income`, Rp 5.000.000 and on wallet OCBC. The transfer row is tombstoned and the link is settled, so it leaves the
"Urungkan" list.

## Findings

### M3 (medium): the credit row is lost for good when its wallet is archived during "Urungkan impor"

`src/lib/server/transfers/match.ts:474-531` (`settleTransferLinksOfBatch`). The link-settle statement marks every
live link of the batch undone without any condition. The credit restore at `:516` requires `creditWalletLive`. When
that guard fails, the link is settled but the credit is not restored.

Scenario: merge BCA debit (batch A) with OCBC credit (batch B). Archive wallet OCBC. "Urungkan impor" batch A answers
`ok`. Then `restoreWallet(OCBC)` answers `ok`. After that, `undoTransferMatch` answers `already`. The credit row
stays a tombstone, and its dedupe key blocks a re-import. Result: OCBC permanently lacks the Rp 5.000.000 credit
from a statement the user never undid. This is the M2 loss reached through one extra reversible action (archiving).
The one-pair undo handles the same situation correctly: it answers `stale` and leaves the link live, so the user can
restore the wallet and retry.

Reproduced on local D1 (cycle-2 probe): link `undone_at` set, `undoTransferMatch` → `already`, credit `deleted_at`
still set after the wallet was restored.

Fix options (engineer's choice):

- Settle a link only when its other row was restored in this batch, or when that row is not restorable because its
  own import is undone or it is in this batch.
- Otherwise refuse the import undo with a message.
- Or drop `creditWalletLive` from the settle path: an archived wallet is restorable, and its rows stay attached.

### L1 (low): the restore UPDATEs scan every transaction of the space on each import undo

`src/lib/server/transfers/match.ts:509-530`. Both restore statements are `update transactions where space_id = ? and
exists(...)`. `EXPLAIN QUERY PLAN` shows `SEARCH transactions USING INDEX transactions_transfer_to_idx (space_id=?)`,
which reads every row of the space. Each row then runs a correlated `transfer_links` lookup. This happens on every
"Urungkan impor", even when the batch has no links. The settle statement on `transfer_links` also walks all of the
space's links through `transfer_links_space_idx`, and that index has no `undone_at` filter.

Measured locally: 30 links plus about 2.460 rows took 40 ms. Correctness holds. The cost is D1 rows read, and it
grows with the space's history (engineering checklist: bounded queries).

Fix: drive the restores from the links, for example `t.id in (select l.credit_transaction_id from transfer_links l
where <settledNow>)`.

### L2 (low): an edited transfer stays pointed at an undone import's wallet, with no notice

Scenario: edit the merged debit after the merge (for example its note). Then "Urungkan impor" the credit's batch.
The link is settled, and the debit stays `transfer` to OCBC because `debitHolds` fails. OCBC keeps +Rp 5.000.000
from a statement the user undid, and no undo path remains. The docblock intends this ("a row edited since stays as
the user left it"). It is tracked because the user gets no message. The user can still edit or delete the row.

## Checked and held (cycle 2)

- **Both batches undone, either order:** both rows end as tombstones and nothing is revived. When both rows are in
  one batch, both stay tombstones.
- **Seq guards:** the settle statements run only when `batchUndoneNow` holds, which needs the batch row stamped with
  this batch's seq. The restores run only for links stamped `settledNow` with that same seq. Each statement is pinned
  to `space_id`, and `inBatch` checks `t.space_id`.
- **Race, `undoImportBatch` against `undoTransferMatch`:** 10 rounds in both orders. Each round ends with the credit
  live once with Rp 5.000.000, the debit tombstoned and the link undone. The answers were `ok`/`ok` (match first) and
  `ok`/`already`.
- **Race, `undoImportBatch` against `applyTransferMatch`:** 10 rounds in both orders. No live link ever touches a
  row of an undone batch, and the credit is never lost.
- **Refusals write nothing:** a stale `undoImportBatch`, a non-member and another space's user (`missing`) leave the
  transactions, `transfer_links` and `import_batches` dumps identical. Only the pre-existing `bumpSpaceSeq` runs, as
  everywhere else.
- **FN-16j move:** a batch with live rows plus a linked tombstone answers `transfer_linked` (409) and writes nothing.
  The same guard is repeated inside the guarded batch UPDATE (`not batchHasLiveTransferLink`), so a match confirmed
  between the read and the write still blocks the move.
- **Engineering checklist:** i18n entry present (`i18n-en.ts`), no `{@html}`, all SQL is parameterised (`sql.raw`
  only on the fixed `'d' | 'c'` alias and column literals), and the access rule is unchanged.

## Commands run (cycle 2)

- `npm install` in the red-team worktree: exit 0.
- Cycle-1 probe against b995b39: 2 of 4 now fail as intended. Both fail with
  `Cannot read properties of undefined (reading 'id')`: the link is settled, so `listTransferLinks` no longer returns
  it. The other 2 pass.
- Cycle-2 probe (`c2.test.ts`, 12 probes, kept in the reviewer scratchpad and removed from the tree): 12 passed. It
  records M3 and L2 as observed output.
- `npx vitest run` on the feature, QA and import/move integration suites: 9 files, 155 tests passed.
- Local D1 only. No remote command, commit or push.

## Cycle 3 (re-check of `git diff 0478c20..3bcbe23`)

**Verdict: PASS.** M3 is closed. L1 and L2 are fixed. One new low finding (L3) is tracked. No medium or high finding
remains.

### Cycle-2 findings

- **M3 closed.** `src/lib/server/transfers/match.ts:499-510`: the credit restore no longer requires
  `creditWalletLive`. The link is settled at `:546-561` in the same `db.batch`, after the restores. Probe: archive
  OCBC, then "Urungkan impor" batch A answers `ok`. The credit is live again in OCBC with Rp 5.000.000. After
  `restoreWallet`, the OCBC balance is Rp 5.000.000. Mirror case: archive BCA, undo the credit's batch, and the debit
  becomes `expense` again. Wallets are never hard-deleted. `archiveWallet` only sets `deleted_at`, and the FK on
  `transactions.wallet_id` stays satisfied. A missing wallet can therefore neither orphan a restored row nor abort
  the batch.
- **L1 fixed.** `EXPLAIN QUERY PLAN` for all four statements starts from `transactions_import_batch_idx (space_id=?
  AND import_batch_id=?)` and the live-link unique indexes (`transfer_links_debit_live_uq` /
  `transfer_links_credit_live_uq`). The outer rows are reached by primary key. No statement scans the space-wide
  indexes any more. The snapshot scalar subqueries are each a unique-index probe per restored row.
- **L2 fixed.** `src/lib/server/imports/repo.ts:129,167` returns `ok_transfer_kept` from the probe (index 4 of the
  batch). The probe runs after the debit restore, so a restorable debit never triggers the notice. Probe: an
  edited debit that is still a transfer to OCBC answers `ok_transfer_kept`. A debit edited back to `expense`, an
  unedited debit, and both rows in one batch each answer `ok`. A stale call answers `stale`. The /impor note is
  i18n'd (`i18n-en.ts`) and contains no `{@html}`.

### Regression probes (cycle 3, all held)

- **Other space:** a second space's full dump is identical after the undo. Another user's scope on this space's
  batch id answers `missing` and writes nothing. Every statement pins `space_id`: `+space_id` on the outer table,
  `space_id` in `batchRows`, and `c.space_id`/`d.space_id` in the holds helpers.
- **Other batch, same space:** a second merge (batches C/D) keeps its link row and both transaction rows
  byte-identical when batch A is undone.
- **Replay and double restore:** a second undo answers `already` with both the old and the new `updated_at`, and
  the dump is identical. A concurrent double undo of batch B answers `ok` + `already`. Every statement is gated on
  `batchUndoneNow` (seq) and on `undone_at is null`.
- **Re-merged credit:** the credit is merged, undone with the one-pair undo, then re-merged with a new debit. The
  import undo restores the credit from the live link's snapshot only (unique partial index). The old, already
  undone link row is untouched.
- **User-deleted debit, credit batch undone:** the debit stays deleted at the user's time. The credit stays a
  tombstone. The link is settled.
- **Ordering in the batch:** bump, batch row, credit restore, debit restore, edited probe, settle, then the
  tombstone of the batch's rows. The restores see the live links before the settle. A credit restored into a
  different batch is not hit by the tombstone UPDATE, which is filtered by `import_batch_id`. When both rows are in
  one batch, `rowImportLive` blocks the restore.
- **M1/M2:** the feature suite (including the new M3 test) and the QA suite pass.

### L3 (low, carried over from cycle 2, not a regression): import undo revives a credit after the user deleted the merged transfer

`src/lib/server/transfers/match.ts:499-510`. The credit restore checks only the credit (`creditHolds`) and its
import. It does not check the state of the debit row.

Scenario: merge the BCA debit (batch A) with the OCBC credit (batch B). Delete the merged transfer row in Riwayat.
Then "Urungkan impor" batch A. The OCBC income of Rp 5.000.000 reappears (probe: credit `deleted_at` = null).

For the same state, the one-pair `undoTransferMatch` answers `stale`, because `debitHolds` fails. The money is
real: it comes from statement B, which is still imported. The row is visible and deletable. It is still a
user-deleted row brought back without a notice.

Suggested fix: require the debit to be live (or untouched since the merge) for the credit restore. Otherwise
settle the link without restoring.

**Resolution (2026-10-13): FIX.** `fix(import): transfer-match lows: deleted merge stays deleted on import undo, older links page, no straddle gap (FN-48C L3, QA lows)`. The credit restore in `settleTransferLinksOfBatch` now also requires the merged transfer (the debit row) to be live; otherwise the link is settled without restoring. Test: `cocokkan-transfer.test.ts` "L3: undoing the debit’s import after the user deleted the merged transfer keeps the credit deleted and settles the link".

### Commands run (cycle 3)

- Cycle-3 probe (9 probes, copied into `test/integration` only for the run, then deleted): 9 passed.
- `npx vitest run test/integration/cocokkan-transfer.test.ts`: 25 passed.
- `npx vitest run test/integration/cocokkan-transfer.qa.test.ts`: 8 passed.
- `npx vitest run test/integration/imports-move.test.ts`: 16 passed.
- Local D1 only. No full suite, commit, push or remote command.
