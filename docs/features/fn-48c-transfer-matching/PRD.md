# FN-48 Part C — Own-transfer matching across two wallets

Catalogue id: **FN-48** (Part C of the three-part PRD at `docs/features/fn-48-statement-categories/PRD.md`).
Parts A (migration 0037) and B (migration 0040) have shipped. This PRD is the focused, standalone pass for Part
C, carrying over the parent PRD's scope item 10, acceptance criteria 49–57 and Part C architecture notes as its
baseline — nothing here weakens them, only renumbers and fills in the details the owner left open on 2026-10-11.

## Goal

An imported bank statement today records a transfer the user makes between their own wallets (e.g. BCA to OCBC)
as two unrelated rows — an expense in the source wallet and an income in the destination wallet — so Beranda and
Laporan double-count it as both money out and money in, even though it never left the user's own money. The
owner's real staging data shows this exactly: BCA "SWITCHING DB TRF … 009 BANK CENTRA" debits paired with OCBC
credits of the same rupiah amount on the same or next day (plus a separate Rp 6.500 "BIAYA TXN" fee row, which
must stay an ordinary expense, not be swept into a transfer). This feature finds such pairs deterministically,
lets the user confirm each one explicitly, merges the pair into one FN-05 transfer row, and lets the user undo a
merge with both rows restored exactly — never inventing an amount, never auto-applying a match.

## Scope

1. **A deterministic scan module**, `src/lib/server/transfers/match.ts`, `proposeTransferMatches(db, spaceId)`:
   live, non-demo, `type in ('expense','income')` rows whose `category_id` points at a category with
   `tile_key = 'transfer'` of the matching kind (expense "Transfer keluar", income "Transfer masuk" —
   `src/lib/shared/transactions.ts:98-123`), grouped by exact `amount_minor` + `currency`, paired across two
   *different* `wallet_id`s of the same space within a ±1-day window (`occurred_on`, WIB date). Bounded: at most
   **200** proposed pairs per run (newest `occurred_on` first), ids and candidate sets bound once as JSON via
   `json_each` (never `inArray` past 100 parameters, per `docs/ENGINEERING_CHECKLIST.md`).
2. **A review-and-confirm route**: `src/routes/(app)/impor/cocokkan-transfer/+page.server.ts` +
   `+page.svelte`, same shape as `rapikan-kategori` (`src/routes/(app)/impor/rapikan-kategori/+page.server.ts`):
   `load` calls `proposeTransferMatches` through `currentSpaceScope`; lists every candidate pair (masked titles,
   dates, amount, both wallets' names); an ambiguous group (more than one same-amount, same-window candidate on
   either side) lists every candidate in the group, never auto-picks one — the user picks a specific partner row
   or skips the whole group.
3. **A "Cocokkan transfer" card on `/impor`**, next to the existing "Rapikan kategori" card
   (`src/routes/(app)/impor/+page.svelte:1021-1038`), shown only when `data.transferMatchCount > 0` (a true empty
   state, no hidden button), linking to `/impor/cocokkan-transfer`.
4. **`actions.merge`** (one pair at a time, explicit confirm): `applyTransferMatch(db, scope, debitId, creditId,
   now)` — one `db.batch`: update the debit row's `type = 'transfer'`, `transfer_to_wallet_id = <credit row's
   wallet>`, `category_id = null`, `category_source = null`; tombstone the credit row with the shared
   `TOMBSTONE_CONTENT` (`src/lib/server/transactions/repo.ts:452-472` — dedupe key kept, per AC 10 below); write
   one `transfer_links` row snapshotting both rows' full previous content (JSON) for undo. Guarded like every
   other space write (`isLiveMember` repeated inside the write, `bumpSpaceSeq`/`currentSpaceSeq`,
   `src/lib/server/sync/seq.ts`).
5. **`actions.undo`** (one pair at a time): `undoTransferMatch(db, scope, linkId, now)` — restores the debit
   row's exact previous `type`, `category_id`, `category_source`, `transfer_to_wallet_id` and restores the credit
   row from its snapshot (every content column, including `category_id`, `amount_minor`, `currency`, `wallet_id`,
   `title`, `occurred_on`, `occurred_at`) — a guarded `UPDATE … WHERE …`, restore not recreate, same id, same
   `created_at`. Marks the link `undone_at`; the link row itself is never deleted (append-only history, no
   tombstone column needed, mirroring the parent PRD's architecture note).
6. **New table `transfer_links`** (migration 0043 — see Architecture notes): space-scoped, one row per confirmed
   merge, holding both transaction ids and a JSON snapshot of each row's full previous content, `created_at`,
   `updated_at`, `undone_at`, `seq`.
7. **i18n**: every new Indonesian string (card copy, review list, confirm/skip/undo buttons, loading/empty/error/
   saving/success states) through `msg()`/`tr()`/`trf()` (`src/lib/shared/i18n.ts`) with an English entry in
   `i18n-en.ts`; the existing i18n completeness test fails otherwise.
8. **360 px layout**: the review list, pair cards and confirm/skip/undo controls fit the phone-first grid with no
   horizontal scroll and ≥44 px touch targets, following `docs/design/DESIGN_SYSTEM.md`.

## Out of scope

(Carried over from the parent PRD's Part C out-of-scope list, unchanged.)

- Cross-currency transfer matching — amount and currency must match exactly, never amount alone.
- A matching window wider than ±1 day, or a chain across more than two wallets (one debit, one credit only).
- Using the SKN/BI-FAST bank-code table (009/014/028/…) or the account holder's name as a *required* matching
  signal — amount, currency and the date window are the only required signals (owner decisions 11, 12 of the
  parent PRD).
- Auto-applying any match without an explicit per-pair confirm, and auto-picking among ambiguous candidates.
- Teaching the merchant/narrative resolver (FN-20) anything from a confirmed or skipped pair — this feature never
  writes a merchant rule or cache row; a future pass could reconsider this (Owner decision 3 below).
- A matcher that proposes a pair when only one side is categorised "Transfer" and the other is not — both sides
  must already carry the `transfer` tile category of the matching kind (Owner decision 1 below).
- Reversing a merge automatically when either row is later edited or deleted outside this feature's own undo —
  a normal edit/delete on a merged transfer row behaves exactly like FN-05's existing edit/delete, unrelated to
  `transfer_links`.

## Acceptance criteria

Carried over verbatim from the parent PRD's Part C ACs (49–57), renumbered 1–9, plus the new ones this pass's
detail requires (10–21). None of 1–9 is weakened.

1. Given a debit row like "SWITCHING DB TRF BUDI SANTOSO 009 BANK CENTRA…" of Rp 5.000.000 on 2026-07-10 in
   wallet A (category "Transfer keluar") and a credit row of Rp 5.000.000 on 2026-07-10 or 2026-07-11 in wallet B
   (category "Transfer masuk") of the same space, when the transfer-matching review runs, then the pair is
   proposed as one transfer from A to B.
2. Given the user confirms a proposed pair, when the merge applies, then wallet A's row becomes
   `type = 'transfer'` with `transfer_to_wallet_id = B` and no category, wallet B's row is tombstoned, and every
   `amount_minor` involved is unchanged from what each statement originally printed.
3. Given a merged pair, when either wallet's history or Beranda/Laporan's totals are viewed, then the transfer
   shows once, linked, not as a separate expense and a separate income (no more double-counting of that pair in
   the space's income and expense totals).
4. Given a merged pair, when the user presses undo, then wallet A's row reverts to its original `type` and
   category and wallet B's row is restored with its exact original content (amount, title, wallet, date,
   category) — restored, not recreated as a new row with a new id.
5. Given two same-amount, same-window "Transfer" rows in two other wallets that are not actually a matching pair
   (coincidence), when the review lists them among several ambiguous candidates, then the user can skip that
   proposal; nothing merges without an explicit confirm, and no candidate is auto-picked.
6. Given wallet B's statement is re-imported after its credit row was merged (and tombstoned) into a transfer,
   when the re-import runs, then the dedupe key still marks that row "already imported" and it is not recreated
   (checklist: idempotent capture).
7. Given wallets A and B belonging to two different spaces (not shared), when the matching review runs for a user
   who is a member of only one, then only that space's own wallets are ever compared; no cross-space match is
   proposed or possible.
8. Given a debit row already merged into a transfer, when the review runs again, then it is never offered again
   as an unmatched "Transfer" row (it is no longer a plain expense).
9. Given a currency mismatch between two candidate rows (e.g. one wallet is USD), when the review runs, then they
   are never proposed as a pair — amount and currency must both match, never amount alone.
10. **(FN-48B continuity interaction.)** Given a credit row that is tombstoned by a merge and that row still
    belongs to its original import batch (`import_batch_id` unchanged by the merge), when that wallet's FN-48B
    continuity check next runs, then it still reconciles: the import batch's own recorded
    `opening_balance_minor`/`closing_balance_minor` (read from `import_batches`, never from live transaction
    rows) are unaffected by the merge, and wallet B's computed balance is unchanged — the tombstoned income row
    no longer contributes, but the merged transfer row (source wallet A, `transfer_to_wallet_id = B`) now credits
    wallet B for the same amount (`src/lib/server/transactions/wallet-sum.ts:36,56`), so the net effect on wallet
    B's balance before and after the merge is exactly zero.
11. Given the separate Rp 6.500 "BIAYA TXN" fee row from the owner's real case (categorised "Biaya Bank" by
    Part A, never "Transfer"), when the review runs, then it is never listed as a transfer candidate on either
    side — only rows whose category tile is `transfer` are scanned.
12. Given a debit row's narrative describes a transfer but its category is not `transfer` (e.g. still "Lainnya",
    not yet cleaned up by "Rapikan kategori"), when the review runs, then it is never proposed — a category of
    `transfer` on both sides is required (Owner decision 1).
13. Given a space with more candidate pairs than the 200-per-run cap, when the review runs, then it lists the
    first 200 (newest `occurred_on` first) and the card's count still shows the true total, so the user knows to
    re-run it to see more.
14. Given every load and action this feature adds (`/impor/cocokkan-transfer`'s load, merge and undo), then each
    re-checks space membership through `currentSpaceScope`/`requireSpaceAccess` and repeats `isLiveMember` inside
    its own write statements — never trusting a cached role from an earlier request; a removed member gets the
    same 404 a non-member gets; a request naming another space's link id from this session gets the same 404
    every other cross-space check gets (no existence oracle).
15. Given a merge or undo request is resubmitted (double click, browser retry, replayed form), when it is
    processed a second time, then nothing changes further and the response says "already merged"/"already
    undone" — never a second `type` change, never a second tombstone, never a duplicate `transfer_links` row
    (same guarded-statement pattern as `undoImportBatch`, `src/lib/server/imports/repo.ts:111-157`).
16. Given a concurrent merge attempt and a concurrent manual edit on the same debit or credit row, then exactly
    one of them wins per CLAUDE.md's "Concurrent writes" rule (a guarded `UPDATE … WHERE updated_at = expected`
    inside one `db.batch`, never a read-then-write split across two round trips); the loser is reported, not
    silently overwritten.
17. Given the review list is loading, then a loading state shows; given the server call fails, then an error
    state shows with a retry, never a stack trace or a silent empty list; given a merge or undo is confirmed, it
    is shown as saved only after the server confirms the write (success only after a confirmed write); given
    zero candidate pairs, the card does not appear on `/impor` (a true empty state).
18. Given every new Indonesian phrase this feature adds, then each has an English entry in `i18n-en.ts`; the
    existing i18n completeness test fails otherwise.
19. Given this feature's own scan and write statements, then every amount comparison is on `amount_minor`
    (integer) and `currency` exactly — never a float, never a cross-currency sum; `occurred_on` (WIB date) is the
    only date compared for the ±1-day window, never a UTC date.
20. Given this feature's own Vitest suite, then every regression test is shown failing on the unfixed code first
    (checklist "Fail-before proof"), and `npm run gates` is clean before hand-off.
21. Given 360 px width, then the review list, pair cards, and confirm/skip/undo controls show with no horizontal
    scroll and every touch target is at least 44 px.

## Architecture notes

- **`src/lib/server/transfers/match.ts`** (new): `proposeTransferMatches(db, spaceId)` reading live, non-demo
  `expense`/`income` rows joined to `categories` on `category_id` where `categories.tile_key = 'transfer'`
  (mirrors the `eligible()` SQL shape in `src/lib/server/categories/cleanup.ts:35-40`, swapping `tile_key = 'lain'`
  for `tile_key = 'transfer'` and adding the cross-wallet, ±1-day, same-amount-and-currency grouping); capped at
  200 proposed pairs, newest first. `applyTransferMatch(db, scope, debitId, creditId, now)` and
  `undoTransferMatch(db, scope, linkId, now)` reuse `TOMBSTONE_CONTENT`
  (`src/lib/server/transactions/repo.ts:452-472`), `isLiveMember`/`SpaceScope`
  (`src/lib/server/spaces/access.ts`), `bumpSpaceSeq`/`currentSpaceSeq` (`src/lib/server/sync/seq.ts`), following
  the guarded-statement shape of `undoImportBatch` (`src/lib/server/imports/repo.ts:111-157`) and
  `updateTransaction`/`deleteTransaction` (`src/lib/server/transactions/repo.ts:517-605`).
- **New table `transfer_links`** (`src/lib/server/db/schema.ts`, next to `categoryCleanupBatches`/
  `categoryCleanupItems` at line ~773-823): `id`, `spaceId` (FK `spaces.id` cascade), `debitTransactionId`,
  `creditTransactionId`, `debitSnapshot` (JSON text — the debit row's previous `type`, `categoryId`,
  `categorySource`, `transferToWalletId`), `creditSnapshot` (JSON text — the credit row's full previous content:
  `amountMinor`, `currency`, `walletId`, `title`, `note`, `occurredOn`, `occurredAt`, `categoryId`,
  `categorySource`, and the rest of `TOMBSTONE_CONTENT`'s fields), `createdAt`, `updatedAt`, `undoneAt`, `seq`.
  Append-only, no `deletedAt`: an undone link stays, marked `undoneAt`, exactly like the parent PRD's note. A
  unique index on `(debitTransactionId)` where `undoneAt is null` stops a live debit row being merged into two
  links at once.
- **Route**: `src/routes/(app)/impor/cocokkan-transfer/+page.server.ts` + `+page.svelte`, same shape as
  `src/routes/(app)/impor/rapikan-kategori/+page.server.ts`: `load` via `currentSpaceScope`, `actions.merge`,
  `actions.undo`.
- **`/impor` card**: `src/routes/(app)/impor/+page.svelte`, new `{#if data.transferMatchCount > 0}` block next to
  the existing `o-cleanup` section (`:1021-1038`), `transferMatchCount` computed in
  `src/routes/(app)/impor/+page.server.ts`'s `load` via a bounded `count(*)` (never by loading the full proposal
  list, mirroring `countCleanupCandidates`, `src/lib/server/categories/cleanup.ts:70-75`).
- **New messages module** `src/lib/server/transfers/messages.ts` (mirrors
  `src/lib/server/categories/messages.ts`): load-failed, already-merged, already-undone, not-found, none-selected
  strings.
- No change to `src/lib/shared/transactions.ts`, `aggregate.ts` or `wallet-sum.ts` — a merged row is a normal
  FN-05 transfer; every existing aggregate (`EFFECTIVE_AMOUNT`, `walletTransactionsSums`) already handles
  `type = 'transfer'` correctly (it is excluded from income/expense sums and moves both wallets' balances via the
  one row), confirmed by reading `src/lib/server/transactions/wallet-sum.ts:36,56`.
- **Migration 0043** (next free number — 0037 Part A, 0038 FN-34b, 0039 FN-26b, 0040 Part B, 0041 Patungan, 0042
  FN-16j already applied): `CREATE TABLE transfer_links (...)` plus its indexes. A plain `CREATE TABLE`, no
  `ALTER` of an existing table and no `CHECK`-constrained rebuild, so it is trivially re-runnable (unlike 0037's
  `categories` rebuild, flagged as a red-team low for not being idempotent against a half-applied state — this
  migration avoids that class of risk entirely).

## Prerequisites

None. Entirely deterministic (no AI Gateway key, no Anthropic key, no new provider, no new `.dev.vars.example`
entry) — same as Parts A and B.

## Tracker impact

Closes the open `docs/TASKS.md` line:
> `- [ ] **Claude** — FN-48 Part C own-transfer matching (±1 day, confirm, undo). …`

`docs/ACCEPTANCE.md` currently has no FN-48 Part C row; add: "A transfer between two of the user's own wallets is
proposed and merged into one FN-05 transfer row, never double-counted, with one-step undo (FN-48 Part C) |
Automated" once this PRD's Vitest vectors pass, per the parent PRD's Tracker impact note.

## Risk tier

**Medium-Large**, per the parent PRD's own Part C risk note: the first feature in this codebase that converts
two already-written rows into one FN-05 transfer after the fact, with a snapshot-and-undo table; money-adjacent
(changes `type` and removes a row, even though no amount changes) and worth its own focused red-team pass on the
matching/merge/undo logic before it ships. One migration (0043), new table only, no rebuild of an existing table.

## Owner decisions (defaults proposed; pick to change)

1. **One-sided categorisation.** Default: never propose a pair unless *both* rows already carry a `transfer`
   tile category of the matching kind — deterministic, no guessing from narrative text alone (AC 12). Alternative:
   also offer a pair where only one side is categorised "Transfer" and the other is an ordinary un-reviewed
   expense/income with a transfer-like narrative — raises false-positive risk and needs its own narrative check,
   deferred.
2. **Candidate cap per run.** Default: 200 proposed pairs per run (`src/lib/server/categories/cleanup.ts`'s
   `CLEANUP_PREVIEW_MAX` is 500 for a single-row list; a pair involves a cross-wallet join, so a smaller cap is
   proposed). Re-run after confirming or skipping to see more.
3. **Learning from a confirmed or skipped pair.** Default: none — this feature never writes a merchant rule,
   cache row, or any other state besides `transfer_links` and the two transaction rows. A future pass could teach
   FN-20 to prefer the `transfer` category for a narrative pattern seen in a confirmed pair; out of scope here.
4. **Where the entry point lives.** Default: a "Cocokkan transfer" card on `/impor`, next to "Rapikan kategori",
   linking to `/impor/cocokkan-transfer` (keeps every deterministic import clean-up tool in one place, consistent
   with Part A's placement decision). Alternative considered and rejected: `/dompet/transfer` — splits the
   clean-up tools across two different tabs for no reason.

Prior owner decisions already made 2026-10-11 and carried over unchanged: ±1 day window; exact `amount_minor` +
`currency` match; never auto-applied, confirm per pair; one-step undo per pair restoring both rows exactly
(restore, not recreate); ambiguous candidates all listed, user picks or skips; the credit row is tombstoned on
merge but its dedupe key stays.

## Owner decisions — answered 2026-10-12

1. One-sided categorisation: **both rows must carry a `transfer` tile category** (Transfer keluar / Transfer masuk).
   Never propose a pair from narrative text alone.
2. Candidate cap: **200 pairs per run**, newest first.
3. Learning: **none**; the feature writes only `transfer_links` and the two transaction rows.
4. Entry point: **"Cocokkan transfer" card on `/impor`** linking to `/impor/cocokkan-transfer`.
