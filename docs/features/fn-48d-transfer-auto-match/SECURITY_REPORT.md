# FN-48d transfer auto-match: security report

Reviewer: red-team-pentester. Scope: `git diff main..HEAD` at c64cb5e (branch `feat/fn-48d-transfer-auto-match`),
checked against `docs/ENGINEERING_CHECKLIST.md`. Local D1 only.

## Verdict: PASS

No medium or high findings. Two low findings are listed below so they are tracked.

## What was attacked and how it held

| Vector | Result | Evidence |
| --- | --- | --- |
| Wrong pair or ambiguous pair, from crafted statement lines | Holds. The read groups pairs by connected component and keeps only one-pair groups. The write guard (`stillUnambiguous`, `match.ts`) re-checks inside the same INSERT…SELECT that the debit has no other credit and the credit has no other debit, own pairs or card pairs. A component with 2 or more edges always has an edge touching `d` or `c`, so the row-level check covers group-level ambiguity. | Probe: 2 same-day debits in one statement plus 1 existing credit gave 0 merges. AC-2 and AC-9 tests pass. |
| Cross-wallet (same wallet), cross-space, demo rows, deleted wallet, non-transfer tile | Holds. The guard uses `eligible`/`PAIRED` (space, `is_demo = 0`, transfer tile, live wallet, `c.wallet_id <> d.wallet_id`), the same as the manual confirm. | Probes: a demo partner, a same-wallet partner, a deleted-wallet partner, an ordinary-income partner and another space's partner each gave 0 merges, and the other space got no link. |
| Card pair (FN-55a) | Holds. The read keeps `kind = 'own'` only, and the guard adds `not CARD_PAIR`. | AC-3 test: an `auto` merge of a card pair is `stale`, and a manual merge of the same pair succeeds. |
| Kept photo on the credit row, Patungan bill on the debit row | Holds. Both are excluded by `eligible`, which is unchanged. | Probe: a credit with `photo_key` gave 0 merges. The Patungan case was checked by reading the code (an FK prevents a synthetic probe). |
| Re-merge after undo | Holds. A live or undone `auto` link naming either row blocks the pass at read time (`autoBefore`) and in the write guard. | AC-5 test. Probe: auto merge, then import undo (FN-48c settles the link and restores the debit as an expense), then re-import of the same file. Result: `batchId` null (dedupe keys kept), 0 merges, still exactly 1 link. |
| Races (concurrent passes, edits, import undo) | Holds. Every merge is one guarded statement in one `db.batch`, with `updated_at` versions, `isLiveMember` and the live-link check. An import undo tombstones the batch's rows, so a later guard cannot match them. A merge that lands first is settled by `settleTransferLinksOfBatch`. | Tests pass: 20 concurrent passes, edit between read and merge, competitor appearing between read and merge, removed member. |
| D1 100 bound-parameter limit | Holds. The largest statement is the auto INSERT…SELECT with 76 params. The amount list is a subquery, never bound. | Probe: a D1 proxy recorded the max `bind()` length over the whole suite as 76. |
| Bounded work | Holds within caps. The read is capped at 1001 rows. The last, possibly incomplete amount is dropped. At most 20 merges run, each its own small batch. | AC-7 and AC-15 (120 amounts) tests, plus the `EXPLAIN QUERY PLAN` test. |
| Migration 0048 | Safe. `ADD COLUMN … NOT NULL DEFAULT 'manual'` with a same-column CHECK backfills old rows truthfully. The CHECK refuses other values and null. The partial index is `IF NOT EXISTS`. A re-run stops harmlessly at the ALTER. | `migration-0048.test.ts`, 4 tests pass. |
| Information leakage, logs, text injection | Holds. The success line carries only an integer count through `trf`. The badge is a fixed `tr('Otomatis')`. Svelte escapes both, and there is no `{@html}`. A pass failure logs a fixed line plus `errorLabel` (error name and code only, no row data). No upload bytes are written anywhere. | Code read. "Failing pass" test passes. |
| Authorization | Holds. The pass runs with the importer's `SpaceScope`. The guard repeats `isLiveMember` and space pins on every row, wallet and category. Any live member may merge, which is the same rule as the manual confirm. | AC-8 tests. |

## Findings

1. **Low: an under-reported count after a partial failure.** In `src/lib/server/statements/statement-import.ts:303-311` (`autoMatchAfterImport`), an exception during merge k of the loop in `autoMatchTransferPairs` (`match.ts`) makes the whole call return 0, but merges 1..k-1 are already committed. The success line then hides auto merges that did happen. The Otomatis badge on `/impor/cocokkan-transfer` still lists them and they stay undoable, so no data is lost. Reproduction: make `applyTransferMatch` throw on its second call during an import with 2 clear pairs. The response shows `autoMatchedCount` 0 while 1 `auto` link exists. Suggestion: count inside the loop and catch per pair, or return the partial count.
2. **Low: same-amount rows are compared quadratically (an existing pattern, now run automatically after each import).** The read in `match.ts` (`autoMatchTransferPairs`) and `pairsAround` join every live row of the same space, amount and currency before filtering by the ±1-day window. They then sort the whole result before `limit 1001`. A space with many transfer-tile rows of one amount, for example thousands of identical top-ups, makes the post-import pass do N² predicate work. It is bounded by the D1 query limit, and a failure is caught and counted 0, so the import itself never fails. This is a feature-level slowdown only, it is limited to the user's own space, and `countTransferMatches` already does the same on `/impor`. The checklist's "every scan has … a period" is met only through the date predicate, not through the index. Suggestion, later: add `occurred_on` to the lookup, either as an index column or a range on `c.occurred_on`.

## Checklist (`docs/ENGINEERING_CHECKLIST.md`)

Parameters stay at or below 76 out of 100, with no growing `IN (…)`. Concurrent writes go through guarded INSERT…SELECT in `db.batch` and are proven by a concurrent test. One access rule (`isLiveMember` in the write). Logs hold no row data. Migration is additive and re-runnable. i18n is complete (`Otomatis`, the 2 new phrases). No upload persistence in the diff. Bounded work: see low finding 2.

## Commands run (local D1 only)

- `npx vitest run test/integration/transfer-auto-match.test.ts test/integration/cocokkan-transfer.test.ts test/integration/migration-0048.test.ts src/lib/server/transfers/match.test.ts`: 4 files, 58 tests passed.
- Temporary probe (a copy of the auto-match suite with a D1 bind-counting proxy, plus 8 red-team cases): 24 tests passed, 16 suite tests and 8 probes. Max bound params was 76. The probe file was removed from the worktree afterwards, so the worktree is unchanged apart from this report.

## Resolution (orchestrator, 2026-10-15)

- **L1 resolved:** `autoMatchTransferPairs` now catches a throwing merge, logs `errorLabel` only and stops the pass,
  returning the merges already written. Regression test "a merge that throws stops the pass but still counts the
  merges already written (red team L1)" in `test/integration/transfer-auto-match.test.ts` fails without the fix
  (1 failed / 16 passed) and passes with it (17 passed).
- **L2 open:** recorded as a `**Claude**` To do item in `docs/TASKS.md` (same-amount N² read before the ±1-day
  filter; bounded by the scan cap and caught, the import still succeeds).
