# FN-16j — Move an import batch to another wallet ("Pindahkan ke dompet lain")

Owner request 2026-10-11, prompted by a real mistake: two BCA statement batches (Jan and Feb 2026, 89 rows) were
imported into the wrong wallet (GoPay). Undo + re-import is blocked because an undone row keeps its dedupe key
(`src/lib/server/imports/csv-import.ts:150-175`: `alreadyImported` scans tombstones too, so the same file can never
be re-imported into the right wallet). Risk tier: **Large** (bulk money-moving write across up to `MAX_TRANSACTIONS_PER_SPACE`
rows, two-sided transfer handling, a schema change to `audit_events`, cross-space and stale-version adversarial
paths).

## Goal

A statement or CSV batch imported into the wrong wallet is common (BCA's own template defaults, a mis-clicked wallet
picker) and today has no fix short of deleting every row by hand and re-entering them, which breaks FN-05's "never
recreate from the same source" rule and loses any edits made since. "Pindahkan ke dompet lain" lets the person who
made the mistake correct it from the same `/impor` screen where they already go to undo an import: pick the right
wallet, confirm, and every live transaction of that batch (including ones they have since edited) moves there in
one write, with the FN-48B continuity record following so the next statement's balance check still lines up.

## Scope

- **Server:** `src/lib/server/imports/repo.ts` gains `moveImportBatch(db, scope, batchId, targetWalletId,
  expectedUpdatedAt, now)`, next to `undoImportBatch`, returning a discriminated result (see Acceptance). It:
  - Reads the batch's live transactions and the **source wallet**: the one wallet id present in every live row's
    wallet side(s) — `wallet_id` for `expense`/`income`/`adjustment`, `{wallet_id, transfer_to_wallet_id}` for
    `transfer`. Exactly one such id across every live row ⇒ `sourceWalletId`; zero or more than one ⇒ refuse
    (`mixed_wallets`, see Owner decisions #2).
  - In one `db.batch` (mirrors `undoImportBatch`'s shape):
    1. `bumpSpaceSeq`.
    2. Guarded `UPDATE import_batches` — `id = batchId AND space_id AND undone_at IS NULL AND deleted_at IS NULL
       AND updated_at = expectedUpdatedAt AND isLiveMember AND` a re-check that every live row of the batch still
       has `sourceWalletId` on one of its sides (closes the race where a row was edited between the read above and
       this write) `AND` target wallet exists, is live, same space, same `currency` as `sourceWalletId`'s wallet.
       Sets `wallet_id = case when wallet_id is null then null else :target end` (only a statement batch's
       continuity wallet moves; csv/spreadsheet batches have no `wallet_id` to move), `updated_at` and `seq`
       bumped like `undoImportBatch`.
    3. Three guarded `UPDATE transactions … RETURNING id` passes, each `WHERE space_id AND import_batch_id = batchId
       AND deleted_at IS NULL`: (a) `type <> 'transfer' AND wallet_id = source` → `wallet_id = target`; (b)
       `type = 'transfer' AND wallet_id = source AND transfer_to_wallet_id <> target` → `wallet_id = target`
       (refuses — see Owner decisions #3 — only this row, by the `<> target` filter, when the move would make
       `from`/`to` equal); (c) `type = 'transfer' AND transfer_to_wallet_id = source AND wallet_id <> target` →
       `transfer_to_wallet_id = target`. Each stamps `updated_at = max(now, updated_at + 1)` and `seq =
       currentSpaceSeq(spaceId)` like `deleteTransaction` (`src/lib/server/transactions/repo.ts:596-609`).
    4. `batchAssert` that step 2's `UPDATE import_batches` affected exactly one row (else the whole write rolls
       back as one D1 batch transaction — nothing moves on a stale page, a non-member, a gone batch or a currency
       mismatch).
  - Writes one `audit_events` row (`action = 'import_batch_moved'`) in the same `db.batch`, holding no transaction
    ids or amounts (space id, actor, target user id null — matches the existing content-free rows).
  - Returns the moved count (sum of the three `RETURNING` lengths) and a `skippedTransferCount` (rows matching (b)
    whose `transfer_to_wallet_id` already equals `target`, i.e. the refused-equal-wallet transfers) so the page can
    show "82 dipindah, 1 dilewati (transfer ke dompet yang sama)".
- **New messages** in `src/lib/server/imports/messages.ts`: wallet-not-found, same-wallet, currency-mismatch,
  mixed-wallets, nothing-to-move (batch has zero live rows), stale (`TRANSACTION_CHANGED`, reused), batch-undone
  (reuses `BATCH_ALREADY_UNDONE`-shaped wording: "already" when the batch was undone first).
- **Migration `migrations/0042_import_batch_moved.sql`:** rebuilds `audit_events` exactly as `0016_connected_apps.sql`
  did, widening `audit_events_action_check` to add `'import_batch_moved'` to `AUDIT_ACTIONS`
  (`src/lib/server/db/schema.ts:319-331`). No other table changes — `wallet_id`/`transfer_to_wallet_id` already
  exist on `transactions`, `wallet_id` already exists on `import_batches` (migration 0040).
- **Route:** `src/routes/(app)/impor/+page.server.ts` gains action `move`, reading `id`, `updatedAt`, `walletId`
  (same `ID_MAX_LENGTH`/`UPDATED_AT` guards as `undo`), calling `moveImportBatch`, mapping its result to `fail()`
  the same way `undo` does. `load`'s existing `wallets` list (already IDR-space-filtered live wallets,
  `+page.server.ts:216-218`) is reused for the picker — extended to carry `currency` too, since a non-IDR wallet
  must be offered only when it matches the batch's own currency (FN-47 multi-currency wallets).
- **UI:** `src/routes/(app)/impor/+page.svelte`, next to the existing `Urungkan` `<details>`
  (`+page.svelte:1068-1084`): a second `<details>`/`<summary>` "Pindahkan ke dompet lain" per **live** batch, with
  a `<select>` of same-currency live wallets (excluding the batch's current wallet when known) and a confirm
  button, following the same `use:enhance={track}` + `busy` pattern. When the batch's rows are mixed-wallet (server
  flagged it at load time by including a `moveBlocked: 'mixed_wallets' | null` per batch summary from
  `listImportBatches`), the row shows disabled text instead of the control: "Transaksi di impor ini ada di lebih
  dari satu dompet — tidak bisa dipindahkan sekaligus." States: loading (existing skeleton), empty (no live
  batches — existing `EmptyState`), saving (`busy === 'move'` → "Memindahkan…"), success (toast/line "82 transaksi
  dipindahkan ke <wallet>." reusing the page's existing `done`-union result pattern), error (`fail()` message
  rendered like the `undo` action's).
- **i18n:** every new string above added to `src/lib/shared/i18n.ts` (id) and `i18n-en.ts` (en) through `tr()`/
  `trf()`/`msg()`, including the plural-free Indonesian counts and the English equivalents ("Move to another
  wallet", "N transactions moved to <wallet>.", "N moved, M skipped (transfer to the same wallet).", "Transactions
  in this import are in more than one wallet — it cannot be moved as one.", etc.).
- **Tests:** `test/integration/imports-move.test.ts` (new) on local D1, covering every acceptance criterion below.

## Out of scope

- Fixing `alreadyImported`'s tombstone-inclusive dedupe range so an undone import can be re-imported — a separate,
  smaller PRD if the owner still wants it after this ships (moving is the owner's chosen fix for the BCA case).
- Moving an individual row to a different wallet (that is FN-05's existing per-transaction edit form); this feature
  only moves a whole batch.
- Splitting a mixed-wallet batch's rows to several targets in one action (Owner decision #2: refused outright).
- Re-running the FN-48B continuity check or FN-48 "Rapikan kategori" automatically after a move; the existing
  `/impor` continuity card and cleanup card already recompute from live data on next load, nothing extra needed.
- Any change to `undoImportBatch`, `importRows` or the CSV/statement/spreadsheet import paths themselves.
- Moving a batch between spaces, or to an archived/deleted wallet.

## Acceptance criteria

1. Given a live statement batch whose rows all currently sit in wallet A, when the owner opens its "Pindahkan ke
   dompet lain" control and picks live same-currency wallet B in the same space and confirms, then every one of
   the batch's live transactions has `wallet_id = B` after reload, the batch's `import_batches.wallet_id` is also
   B, and the moved count shown equals the batch's live transaction count.
2. Given the same batch now sitting in wallet B, when the owner repeats the move back to wallet A, then it succeeds
   identically (moving back is just another move) and every row is back in A.
3. Given a batch whose live rows include one the owner edited (title, amount, category) since import, when the
   batch is moved, then that row moves too and its edited content is unchanged.
4. Given a batch with a tombstoned (deleted) row, when the batch is moved, then the deleted row stays
   `deleted_at`-set and is not touched (not revived, no wallet change recorded on it).
5. Given a batch whose live transactions are **not** all on one common wallet side (e.g. a CSV batch with rows in
   two wallets, or one row already hand-moved by the user to a third wallet), when the owner opens `/impor`, then
   the move control for that batch is shown disabled with the reason text, and the `move` action refuses
   (`mixed_wallets`) if posted directly, writing nothing.
6. Given a batch containing a `transfer`-type row (created by editing an imported row's type after import) whose
   source-wallet side is wallet A, when the batch moves to wallet B and B differs from the transfer's other side,
   then only the A-side of that row becomes B; when B equals the transfer's other side, then that one row is left
   unmoved and counted in the "skipped" total, while every other row in the batch still moves.
7. Given a target wallet in a different currency than the batch's source wallet, when the move is submitted, then
   it is refused with a stated reason and nothing in the batch changes.
8. Given a target wallet id that is archived, deleted, or belongs to another space, when the move is submitted,
   then it is refused the same way as a not-found wallet (no existence oracle between "other space" and
   "archived"), and nothing changes.
9. Given the owner picks the batch's own current wallet as the target, when submitted, then it is refused with a
   "pilih dompet lain" reason and nothing changes.
10. Given a batch already undone (`undoneAt` set), when the move is posted (form hidden client-side, posted
    directly), then it is refused the same way `undo` on an already-undone batch answers (`already`), writing
    nothing.
11. Given the batch's `updatedAt` sent by the page no longer matches the stored row (e.g. it was moved in another
    tab first), when the move is submitted, then it is refused "changed meanwhile" (`TRANSACTION_CHANGED`) and
    nothing changes — proven with a concurrency test posting two moves for the same batch at once: exactly one
    succeeds.
12. Given a batch id or wallet id belonging to another user's space, when that user (member of neither space)
    posts the move action, then it is refused exactly as a missing batch/wallet (404/fail shape identical, no
    timing or body difference revealing the row exists) — proven with a two-user, two-space test.
13. Given a user removed from the space between page load and submitting the move, when the move is posted, then
    it is refused (not a live member) and nothing changes.
14. Given a successful move, when the audit log is inspected, then exactly one `audit_events` row with
    `action = 'import_batch_moved'` exists for that write, holding no transaction id, amount or row content.
15. Given the move succeeds, when `/impor`'s FN-48B continuity card is viewed afterward, then it reflects the
    batch's new wallet (the moved statement's opening/closing balances are now checked against the target
    wallet's other statements, not the old one) — proven by an integration test moving a statement batch between
    two wallets that each have their own prior statement and checking `continuityBreaks`/`checkStatement` output
    before and after.
16. Given the page is reloaded after a successful move, then every moved transaction, the batch's wallet badge and
    the Riwayat/Beranda totals for both the old and new wallet reflect the move (persisted, not just a client-side
    optimistic update).
17. Given the move is in flight, the UI shows a disabled/"Memindahkan…" state on the control, and on both success
    and every failure path a visible state (success line, or the error text) replaces it — no action silently does
    nothing (CLAUDE.md "every primary action works or shows why it is unavailable").
18. Given the Indonesian strings above, every one has an English counterpart reachable through `tr()`/`trf()`
    (`src/lib/shared/i18n.ts` + `i18n-en.ts`); the existing "a test fails when a phrase lacks an English entry"
    check passes for this feature's additions.
19. Given a 360 px viewport, the new control (summary, select, confirm button) fits without horizontal scroll and
    every touch target is ≥ 44 px.
20. Given JavaScript disabled, the move form still posts and its `fail()`/success result renders from the server
    response alone (no-JS form contract, like `undo`'s).
21. Given a batch whose currency-matching live wallet list is empty (no other same-currency live wallet in the
    space), the control shows that reason instead of an empty, unusable `<select>`.
22. Given `npm run gates` (check, lint, test, build), it is clean with this feature's tests included.
23. Given a money/date vector check, moving a batch never changes any `amount_minor`, `currency`,
    `original_amount_minor`, `occurred_on` or `occurred_at` of any row — only `wallet_id`/`transfer_to_wallet_id`,
    `updated_at` and `seq` change on touched rows, and `wallet_id`, `updated_at`, `seq` on the batch.

## Architecture notes

- `src/lib/server/imports/repo.ts` — new `moveImportBatch`, beside `undoImportBatch` (`:109-170`) and
  `createImportBatch` (`:63-73`); reuses `bumpSpaceSeq`/`currentSpaceSeq` (`src/lib/server/sync/seq.ts`),
  `isLiveMember` (`src/lib/server/spaces/access.ts:127-131`), `batchAssert`/`isBatchAssertFailure`
  (`src/lib/server/db/assert.ts`, already imported by `csv-import.ts:35`), and the `TOMBSTONE_CONTENT`-adjacent
  `nextUpdatedAt` pattern already in `transactions/repo.ts:617` / `deleteTransaction` (`:580-618`).
- `src/lib/server/wallets/repo.ts` — `getWallet` (`:96-114`) for the target-wallet existence/liveness/currency
  read before building the guarded SQL (the guard itself re-checks currency inline so a concurrent archive/delete
  of the target between the read and the write is caught, same spirit as `favouriteSwap`'s `exists` check,
  `:125-148`).
- `src/lib/server/statements/continuity.ts` — unchanged code, but its `storedStatements`
  (`:227-251`) reads `import_batches.wallet_id`, so moving that column is what makes continuity "follow"; no
  function here needs editing, only the batch row's `wallet_id`.
- `src/lib/server/db/schema.ts:319-331` (`AUDIT_ACTIONS`) and `:337-356` (`auditEvents`) — add
  `'import_batch_moved'`; `migrations/0042_import_batch_moved.sql` rebuilds the table exactly like
  `migrations/0016_connected_apps.sql:33-49`.
- `src/lib/server/imports/messages.ts` — new `msg()` constants beside `BATCH_NOT_FOUND`/`BATCH_ALREADY_UNDONE`
  (`:24-25`).
- `src/routes/(app)/impor/+page.server.ts` — new `move` action beside `undo` (`:558-575`), reusing `ID_MAX_LENGTH`,
  `UPDATED_AT`, `textField`/`readFormBody`, and the `load` function's `wallets` projection (`:194-235`), extended
  with `currency` and (per batch) a computed `moveBlocked` flag from the same `listImportBatches` read plus one
  bounded per-batch wallet-side query (capped at `MAX_TRANSACTIONS_PER_SPACE`-bounded by `import_batch_id`, already
  indexed via `transactions`' existing batch id usage in `undoImportBatch`'s guard).
- `src/routes/(app)/impor/+page.svelte` — new control beside the `Urungkan` `<details>` (`:1068-1084`), same
  `use:enhance={track}`/`busy` plumbing already on the page.
- `src/lib/shared/i18n.ts` / `src/lib/shared/i18n-en.ts` — new entries for every string this PRD names.
- Worker: the app Worker only (no `workers/jobs`/`workers/inbound` change).
- No change to `csv-import.ts`'s `importRows`/`alreadyImported` (explicitly out of scope above).

## Prerequisites

None. No new secret, provider or credential — this is a pure D1 read/write feature on data already in the
database, behind the existing session + space-access guard. `.dev.vars.example` unchanged.

## Owner decisions

1. **Refuse the whole move vs. skip just the conflicting row when a transfer's two sides would become equal**
   (request text: "refuse a move that would make a transfer's from and to the same wallet"). **Proposed default:
   skip only that one transfer row** (counted and shown as "M dilewati"), move everything else — matches "every
   live transaction… moves" for the common case (no transfers at all, since imports never create transfer rows
   today) and avoids one edited row blocking 88 others for the owner's sample case. Alternative: abort the
   entire move (0 rows change) the moment any row would conflict.
2. **A batch whose live rows do not all share one current wallet side** (a CSV/spreadsheet batch spanning several
   wallets by its own `wallet_source` column, or a batch where the owner hand-moved one row elsewhere before using
   this feature). **Proposed default: refuse the move entirely** (disabled control with a reason, no partial
   move) — never silently move "most" rows and leave others, and never silently drag a hand-moved row back to the
   batch's old wallet. Alternative: move only the rows still at the batch's majority/original wallet, leaving
   hand-moved rows alone (more useful for mixed batches, more code and a subtler "why didn't everything move"
   support question).
3. **Rows whose wallet the user already changed by hand since import, when the rest of the batch is uniform.**
   Under proposed default #2 these are indistinguishable from "mixed wallets" and block the whole batch's move.
   If the owner instead wants "move everything still at the original wallet, leave hand-moved rows be" as the
   actual behaviour (not just for literal multi-wallet CSVs), say so — it changes the `sourceWalletId`
   determination from "the one wallet every live row agrees on" to "the wallet most rows are still in", and turns
   acceptance criterion 5 from a full refusal into a partial move.
4. **The skipped-transfer count's wording and whether it blocks "success".** Proposed default: a move that moves
   at least one row is still a success toast, with the skipped count mentioned in the same line (not a separate
   error), since the batch overall still did useful work.

## Tracker impact

- `docs/TASKS.md` has no existing open or blocked line for this — it is a new owner request (2026-10-11), not a
  continuation of the FN-16a–FN-16i lines (`docs/TASKS.md:151,181,277-334`), none of which mention moving a batch's
  wallet. This PRD creates the tracked item; add to `docs/TASKS.md`: **"FN-16j move import batch to another
  wallet (owner request 2026-10-11): `docs/features/fn-16j-move-import/PRD.md`."**
- `docs/ACCEPTANCE.md` has no FN-16j row yet. Add one under the import-related rows (near the "Statement PDF
  (password) → balance check → duplicates excluded → import → undo" row, `docs/ACCEPTANCE.md:17`): **"Move an
  import batch to another wallet, including a statement batch's continuity record | Not run |"** — moved to
  Automated once `test/integration/imports-move.test.ts` passes on local D1.

## Owner decisions — answered 2026-10-11

1. Transfer row that would make from = to: **skip that row**, move the rest, and say how many were skipped.
2. Batch whose live rows do not share one wallet: **refuse the whole move**; the control is disabled with a reason.
3. Follows from 2: hand-moved rows never move back automatically; such a batch is always refused.
4. Partial success (rows skipped under decision 1) shows as success with the moved and skipped counts.
