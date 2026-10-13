# FN-48 Part B (month continuity) — Security report

- Scope: `git diff c50fa17..2d6bd03` (worktree `fn-48b-qa`, detached at 2d6bd03 plus QA's uncommitted tests).
- Files reviewed: `src/lib/server/statements/continuity.ts`, `statement-import.ts`, `transactions/wallet-sum.ts`,
  `imports/repo.ts`, `imports/csv-import.ts`, `routes/(app)/impor/+page.server.ts` and `+page.svelte`,
  `migrations/0041_fn48_continuity.sql`, `db/schema.ts`. Context checked: `transactions/repo.ts` (guarded insert),
  `statements/read.ts`, `shared/statements/sections.ts` and the four production parsers, `spaces/spaces.ts` (purge
  order), `server/csrf.ts`.
- Date: 2026-10-11.

## Verdict: PASS

No medium or high findings. Two low items are tracked below.

## Attacks tried

### `?/closeGap` ("Catat selisihnya")

- **Arbitrary amount.** The posted `gap` is used for one thing only: an equality test against the gap the server
  recomputes from stored rows (`continuity.ts:367`). The written amount comes from `adjustmentFor(result.openingMinor,
  result.expectedMinor)` (`:368`). The guarded insert (`:382-390`) checks the same thing again in SQL: batch still
  live, same predecessor batch, and `opening − expected = gap`. Temporary PoC through the real action:
  `9007199254740993`, `-100000`, `1e5`, `100000.0`, `0x186a0`, `" 100000"` and `99999999999999999999` all
  returned 409 with no row written. The true gap `100000` wrote exactly one row of 100000.
- **Other wallet or space.** The form has no wallet field. Extra fields `walletId=zzz` and `amountMinor=999` were
  ignored: the row went to the batch's stored wallet with the recomputed amount. `storedBatch` filters on
  `space_id` from the session scope. `walletWindowSql` needs `w.space_id = spaceId`, so a foreign wallet gives a
  null total and no claim. `insertTransactions` adds `isLiveMember` and `refsHold`, which check that the wallet is
  live in the space and has the same currency. Covered tests: "another space's batch is missing" and "another
  account's post finds nothing".
- **Replay and race.** A second post returns `already`; PoC confirms this. The predicate and the insert are one
  statement, so 20 concurrent posts wrote one row (QA test). Deleting the adjustment reopens the gap, which is the
  intended FN-05 undo.
- **Removed member.** `currentSpaceScope` refuses through `requireSpaceAccess`, and the insert also requires
  `isLiveMember` (covered test). An Anggota may close a gap, the same right as recording any FN-37 adjustment.
- **CSRF.** The action is covered by the hooks-level cross-site form check (`hooks.server.ts` and
  `lib/server/csrf.ts`; Kit's own check is opened only for the Bearer API). The body goes through `readFormBody`.
  The `id` field is length-capped. The action is rate-limited by `overTransactionCreateLimit`.
- **Too large.** A statement with Saldo Awal Rp 90.000.000.000.000 was stored as INTEGER 9000000000000000 and
  shown as a gap. Closing it returned 400 (`ADJUSTMENT_TOO_LARGE`, magnitude > MAX_AMOUNT_MINOR) with nothing
  written. `safeMinor` turns any total beyond ±2^53 into "no claim". `int()` binds only safe integers taken from
  the database, and all sums run as SQLite integers or JS BigInt.

### Forged printed balances in statement text

Continuity adds no new parsing path. `statementSpan` reads `parse.openingBalanceMinor` and
`parse.closingBalanceMinor` only after `readStatement` passes three checks:

- whole-file `inconsistent` refusal (`read.ts:178`);
- `pickSection`, which refuses an inconsistent or unsupported section;
- the per-parser reconciliation, where BCA, BNI, Mandiri and OCBC use `only()` on the printed openings and
  closings, and check the running balance and totals.

A sender note that injects a second "SALDO AWAL" makes `only()` return null, so the whole file is refused. A note
that changes the opening must also stay consistent with every row and the closing balance. These are the same
barriers as FN-16b/16f/16h M1/L1. The closing balance is also dropped when rows were cut (`truncated`). Even with a
forged opening, the adjustment is the user's own explicit click on a figure shown with both numbers. It lands in the
user's own wallet and is deletable, so the sender gains nothing.

### Preview `defaultWalletId`

The value comes from the form, checked with zod and a length cap. `checkStatement` joins `wallets` on the session
space and IDR currency. `walletWindowSql` also needs the session space. A foreign wallet id therefore gives
`none`, and no other space's balance can be read through it.

### Bounded queries

The batch read is capped at `CONTINUITY_BATCH_MAX + 1`, ordered and space-filtered. All windows go into one
statement as a single JSON parameter (`json_each`), at most 1000 items of about 150 B, far below D1's 100-parameter
and 2 MB limits. Windows run between consecutive statements, so the summed work is roughly one pass over the
wallet's rows. The list is capped at 20. All SQL uses Drizzle `sql` with bound values; nothing user-supplied is
interpolated.

### Migration 0041 and data lifecycle

- All five new columns are nullable ADD COLUMNs, and the index uses `IF NOT EXISTS`.
- `purgeSpaces` deletes `importBatches` before `wallets`, so the new FK `wallet_id REFERENCES wallets(id)` cannot
  block account or space deletion.
- No `{@html}`. The page receives only figures, dates, wallet name and batch id, all for its own space.

## Findings

| # | Severity | Where | Issue |
|---|----------|-------|-------|
| L1 | low | `migrations/0041_fn48_continuity.sql:8-12` | Plain `ALTER TABLE … ADD` cannot be re-run: a second apply fails with "duplicate column name". It changes nothing, but it breaks the checklist's "re-runnable" rule. This is the same pattern as 0037 L2 and is documented in the file. Track it with 0037 L2 (for example a runbook note, or a guard in the migration runner). |
| L2 | low (info) | `continuity.ts:212-251`, `imports/repo.ts:550` | The new figures (printed Saldo Awal and Akhir, first and last row dates) are stored unsealed in D1. They are derived from an uploaded statement. This matches the existing server-first design, where imported rows are already stored as transactions, and the PRD asks for these columns. It is recorded so FN-21's "results sealed" scope stays an explicit owner decision. The file itself and any PDF password are still never stored, and no logging was added. |

Info, not findings:

- The `GAP` regex allows 16 digits. Values from 2^53 up lose precision in `Number()`, but they can never equal a
  `safeMinor` gap. The PoC confirmed 409 for them.
- `import_batches.deleted_at` is never written; the continuity queries also exclude deleted wallets through the join.
- `storedBatch` does not itself check that the wallet is IDR. `refsHold` in the insert refuses a currency mismatch.

## Commands run

- `npx vitest run test/integration/continuity.test.ts test/integration/migration-0041.test.ts src/lib/server/statements/continuity.test.ts`
  gave 3 files and 29 tests passed.
- Temporary PoC `test/integration/zz-redteam-poc.test.ts` (forged, malformed and replayed gap posts, extra
  wallet and amount fields, Rp 90 T opening) gave 1 passed, with the results above. It was deleted afterwards and
  `git status` shows only QA's two modified test files.
