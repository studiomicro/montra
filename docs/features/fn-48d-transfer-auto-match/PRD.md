# FN-48d — Auto-match clear transfer pairs after a statement import

Catalogue id: **FN-48d** (extends FN-48 Part C "Cocokkan transfer",
`docs/features/fn-48c-transfer-matching/PRD.md`, migration 0043). Owner decision 2026-10-15, reversing Part C's
"never auto-applied" rule for **unambiguous `OWN_PAIR` candidates only**, right after a statement import commits.
`CARD_PAIR` (FN-55a card-payment pairs) stays manual, unchanged.

## Goal

FN-48 Part C already finds own-transfer pairs deterministically but makes the user open `/impor/cocokkan-transfer`
and confirm every one by hand, even when a pair is not actually ambiguous — same amount and currency, two
different wallets, dates one day apart, both rows already sitting in the "Transfer keluar"/"Transfer masuk" tile,
and no other same-amount row competing for either side. The owner's own staging space shows this is the common
case: after every import so far, 0 pairs were left pending because the owner confirmed each one by hand anyway.
Auto-merging exactly the pairs that have only one possible reading removes that chore without weakening Part C's
"never guess" rule anywhere a real choice exists: a pair with any ambiguity, or a card-payment pair, still waits
for the user, with the same one-step undo either way.

## Scope

1. **A new auto-match pass**, `autoMatchTransferPairs(db, scope, batchId, now)` in
   `src/lib/server/transfers/match.ts`: run only right after a statement import's own `db.batch` has committed
   (`src/lib/server/statements/statement-import.ts:295-343`, when `result.batchId !== null`), as a second,
   separate round trip — never inside the import's own atomic batch, so a failed auto-match never fails the
   import itself.
2. **Candidate restriction, bounded.** Only `OWN_PAIR` candidates (the existing `eligible()`/`PAIRED` SQL,
   `src/lib/server/transfers/match.ts:36-50`) whose `amount_minor` + `currency` matches at least one live,
   non-demo, transfer-tile row the just-committed batch wrote (`transactions.import_batch_id = batchId`); this
   bounds the scan to the batch's own distinct amounts (indexed, never a full-space scan) while still computing
   full connected components for those amounts, so ambiguity is judged correctly even when the other, competing
   candidate predates this import.
3. **Unambiguous, batch-touching pairs only.** Of the groups `groupTransferPairs` returns for that restricted
   candidate set (`src/lib/server/transfers/match.ts:145-177`), auto-apply a pair only when: its group has exactly
   one pair (`ambiguous === false`), and at least one of its two rows belongs to the just-committed batch (a
   pre-existing unambiguous pair that this import did not touch is left for the user, as today — it was already
   proposable before this import and nothing about this pass should newly sweep it in).
4. **Reuse the existing merge path**, `applyTransferMatch`, extended with a `source: 'manual' | 'auto'` parameter
   (default `'manual'`, so every existing caller — the `cocokkan-transfer` route's `actions.merge` — is unchanged):
   the same guarded `db.batch`, the same stale/already/missing answers, the same `isLiveMember` and cross-space
   checks, the same `transfer_links` row and one-step undo. Auto-match calls it with `source: 'auto'` once per
   unambiguous pair, newest `occurred_on` first, up to `AUTO_MATCH_MAX` pairs per commit (proposed 20 — see Owner
   decisions) so one import's write budget stays bounded; any pair past the cap is simply left pending for the
   user on `/impor/cocokkan-transfer`, exactly as an ambiguous one is today.
5. **Never re-apply an undone auto-match.** Before auto-applying a pair, skip it when any existing `transfer_links`
   row (live or undone, `source = 'auto'`) already names either of its two transaction ids as
   `debit_transaction_id` or `credit_transaction_id` — this is what "an undone auto-match is not auto-applied
   again" means in practice: the per-pair "Urungkan" on `/impor/cocokkan-transfer` restores both rows to live
   candidates again, but the link row itself (append-only, never deleted) remembers the user's choice forever for
   those exact row ids.
6. **Migration 0048**: `transfer_links` gains `source text NOT NULL DEFAULT 'manual'` with a column `CHECK` (`source
   in ('manual', 'auto')`), added with a plain `ALTER TABLE … ADD` (no table rebuild — this check only references
   the new column and every existing row satisfies the default, the same shape as 0046's `net_worth_snapshots.classes`
   add). Backfills nothing (every row written before this migration is a manual merge by construction).
7. **Import result tells the user.** `ImportStatementResult` (and the OCR/spreadsheet/CSV result types stay
   untouched — see Out of scope) gains `autoMatchedCount: number`; the statement-import success panel on
   `src/routes/(app)/impor/+page.svelte` (near the existing `statementImported` success text,
   `src/routes/(app)/impor/+page.svelte:364-377`) shows, only when `autoMatchedCount > 0`, a line such as "N
   pasangan transfer dicocokkan otomatis — periksa di Cocokkan transfer" linking to
   `/impor/cocokkan-transfer`.
8. **Visible and undoable on both pages.** `TransferLinkSummary` (`src/lib/server/transfers/match.ts:606-616`)
   gains `source`; `listTransferLinks`'s SQL selects the column. `/impor/cocokkan-transfer`'s existing undo list
   (`src/routes/(app)/impor/cocokkan-transfer/+page.svelte`) shows a small "Otomatis" badge on a `source = 'auto'`
   link, with the same "Urungkan" control already there — no new undo code path, just the badge and the `source`
   field flowing through.
9. **i18n**: every new Indonesian phrase (the import success line, the "Otomatis" badge, any new server message)
   through `tr()`/`trf()` (`src/lib/shared/i18n.ts`) with an English entry in `i18n-en.ts`; the existing i18n
   completeness test fails otherwise.
10. **Vitest coverage**: unambiguous batch-touching pairs auto-merge; an ambiguous group (new row shares an amount
    with two existing candidates) auto-merges nothing and still lists every candidate on
    `/impor/cocokkan-transfer`; a `CARD_PAIR` candidate is never auto-merged; a repeated import of the same file
    auto-merges nothing a second time (dedupe); an undone auto-match is never re-applied by a later import; the
    `AUTO_MATCH_MAX` cap leaves the remainder pending with the card's count still showing the true total; two
    spaces/cross-space isolation; a concurrent edit on one of the two rows during the auto-match pass yields the
    same 409-shaped "skip, don't overwrite" behaviour `applyTransferMatch` already gives a manual merge.

## Out of scope

- **CSV import (`actions.import`), spreadsheet import (FN-17) and on-device OCR import (FN-16g) do not trigger
  auto-match in this pass** — only the statement-import commit path does (owner decision, default below). A CSV
  or spreadsheet import that happens to create an unambiguous transfer pair still surfaces it, unapplied, on
  `/impor/cocokkan-transfer` exactly as today.
- **FN-16j "Pindahkan ke dompet lain" does not trigger auto-match in this pass** — moving an existing batch to
  another wallet can in principle create a new unambiguous pair, but this is a rare, already-reviewed path and is
  deferred rather than bundled into a Large-tier pass (Owner decision below).
- Widening `CARD_PAIR` (FN-55a) auto-match — explicitly out of scope per the feature request; card payment pairs
  stay manual, unchanged, forever within this pass.
- Any new matching signal beyond FN-48 Part C's existing amount/currency/wallet/±1-day rule — this pass changes
  *when and whether a pair applies itself*, never *what counts as a pair*.
- Teaching FN-20's merchant resolver anything from an auto-merged pair (unchanged from Part C's Owner decision 3).
- A new, separate "declined pairs" table — the no-re-apply rule reuses the existing `transfer_links` history with
  the new `source` column (see Architecture notes); no new table.
- A new `audit_events` action for this feature — `transfer_links` itself (who/when/before/after, `source`) already
  is this feature's audit trail, exactly as a manual merge today writes no `audit_events` row either; adding one
  only for the auto path would be an inconsistent, half-measure trail.
- Any change to `applyTransferMatch`'s or `undoTransferMatch`'s guard logic, `settleTransferLinksOfBatch`, or
  `undoImportBatch` — an auto-matched link is undone exactly like a manual one, by both the per-pair "Urungkan" and
  by undoing either side's import batch; this pass adds a `source` column and a pre-check before merging, nothing
  to the restore/undo path itself.

## Acceptance criteria

1. Given a statement import commits two rows — a "Transfer keluar" debit in wallet A and the only same-amount,
   same-currency "Transfer masuk" credit in wallet B within ±1 day, with no other row of either wallet sharing
   that amount in the window — when the import's response is returned, then the pair is already merged into one
   FN-05 transfer (wallet A's row is `type = 'transfer'` with `transfer_to_wallet_id = B`, wallet B's row is
   tombstoned) and the import's result reports `autoMatchedCount: 1`, with no further action from the user.
2. Given the same import also creates a row that shares its amount and window with two other rows (an ambiguous
   group of more than one pair), when the import commits, then none of that group is auto-merged; every candidate
   of the group still lists on `/impor/cocokkan-transfer` for the user to pick or skip, exactly as before this
   feature.
3. Given a `CARD_PAIR` candidate (a bank debit paying a card's bill, FN-55a) that would otherwise be unambiguous,
   when any statement import commits, then it is never auto-merged — it stays listed on
   `/impor/cocokkan-transfer` for an explicit manual confirm, with no exception.
4. Given an auto-merged pair, when the user opens `/impor/cocokkan-transfer`, then that link shows with a visible
   "Otomatis" marker and the same "Urungkan" control a manual merge's link has; pressing it restores both rows
   exactly (same ids, same `created_at`) via the unchanged `undoTransferMatch` path.
5. Given the user undoes an auto-merged pair, when any later statement import commits (even one that reintroduces
   the same amount/window relationship, e.g. the same statement re-imported, or a different statement in the other
   wallet), then that exact pair of row ids is never auto-merged again — it may still be confirmed by hand on
   `/impor/cocokkan-transfer` like any other candidate, but the auto pass skips it permanently.
6. Given a statement is re-imported after its rows were already auto-merged, when the import's dedupe check runs,
   then the already-merged rows' dedupe keys still mark them "already imported" (checklist: idempotent capture);
   the second import's `autoMatchedCount` is 0 for that pair, and no second `transfer_links` row is written for
   the same two ids.
7. Given a space has more unambiguous, batch-touching candidate pairs than `AUTO_MATCH_MAX` in one commit, when the
   import runs, then only the first `AUTO_MATCH_MAX` (newest `occurred_on` first) are auto-merged, the rest stay
   pending on `/impor/cocokkan-transfer`, and the card's existing count on `/impor` still reflects the true
   remaining total (reusing `countTransferMatches`, unchanged).
8. Given two wallets belonging to two different spaces, when a statement import commits in one space, then the
   auto-match pass only ever reads and writes that one space's own rows — `autoMatchTransferPairs` takes the same
   `SpaceScope` every other write in this module takes and repeats `isLiveMember` inside its own guarded statement,
   never trusting a cached role; a removed member's in-flight import gets the same refusal the manual merge gives
   a removed member.
9. Given a concurrent manual edit lands on one of the two rows between the auto-match pass's read and its guarded
   write, then `applyTransferMatch` reports `stale` for that pair exactly as it does for a manual merge today; the
   auto-match pass counts it as not merged (it does not retry, overwrite, or surface an error to the user — the
   pair simply stays available on `/impor/cocokkan-transfer`).
10. Given this feature's new SQL, then every amount comparison stays on `amount_minor` (integer) and `currency`
    exactly, and every date comparison stays on `occurred_on` (WIB date) within ±1 day — never a float, never a UTC
    date, consistent with FN-48 Part C's existing rule.
11. Given CSV import, spreadsheet import, on-device OCR import or an FN-16j "Pindahkan ke dompet lain" move, when
    any of these commits, then no auto-match pass runs (Out of scope); any transfer pair they create still
    surfaces, unapplied, on `/impor/cocokkan-transfer`.
12. Given every new Indonesian phrase this feature adds (the import success line, the "Otomatis" badge text, any
    new message), then each has an English entry in `i18n-en.ts`; the existing i18n completeness test fails
    otherwise.
13. Given the statement-import success panel after a commit with `autoMatchedCount > 0`, then the new line is
    shown only after the server has confirmed the write (success only after a confirmed write, never optimistic);
    given `autoMatchedCount === 0`, no such line appears (a true empty state, not a zero-count line).
14. Given this feature's own Vitest suite (see Scope item 10), then every regression test is shown failing on the
    unfixed code first (checklist "Fail-before proof"), and `npm run gates` is clean before hand-off.
15. Given 101 or more candidate row ids are ever involved in one auto-match pass's restriction query, then the
    query binds them via `json_each` rather than a growing `IN (...)` parameter list (checklist: "100 bound
    parameters per statement").
16. Given migration 0048 is applied to a database that already has `transfer_links` rows from FN-48 Part C, then
    every existing row reads as `source = 'manual'` (the column's default), and re-running the migration against a
    database where it already applied changes nothing (idempotent per `docs/RUNBOOK.md`'s remote-apply rule).

## Architecture notes

- **`src/lib/server/transfers/match.ts`**: new `autoMatchTransferPairs(db, scope, batchId, now)`, built from the
  existing `pairsOf(spaceId)`/`OWN_PAIR`/`groupTransferPairs` (`:84-177`) with an added restriction —
  `d.import_batch_id = batchId or c.import_batch_id = batchId` for the *membership* test (is this group
  batch-touching?) layered on top of a wider amount/currency-matched candidate query (bounded by the batch's own
  distinct `(amount_minor, currency)` pairs, read once from the batch's own rows, never the whole space) so
  ambiguity is still judged against every live competing row, not just the batch's own. For each resulting
  unambiguous, batch-touching pair, in order, up to `AUTO_MATCH_MAX`: skip if a `transfer_links` row (any
  `undone_at`) with `source = 'auto'` already names either row id; else call `applyTransferMatch(db, scope,
  pair, now, 'auto')` and count `ok` results. Returns `{ autoMatchedCount: number }`.
- **`applyTransferMatch`** (`:260-348`) gains a fifth parameter `source: 'manual' | 'auto' = 'manual'`, threaded
  into the raw `json_object`/`select` insert's literal value list for `transfer_links.source`; every other
  statement, guard and return shape is unchanged. The `cocokkan-transfer` route's `actions.merge`
  (`src/routes/(app)/impor/cocokkan-transfer/+page.server.ts:84-106`) calls it with no fifth argument (defaults to
  `'manual'`), so it needs no edit.
- **Call site**: `src/lib/server/statements/statement-import.ts:295-343`, after `importRows` returns `result.ok
  === true` and `result.batchId !== null` (and after the FN-55b card-statement race check at `:324-327`, which is
  unrelated): `const autoMatchedCount = result.batchId ? (await autoMatchTransferPairs(db, scope, result.batchId,
  now)).autoMatchedCount : 0;`, added to the returned `ImportStatementResult`. A failure inside
  `autoMatchTransferPairs` (e.g. a thrown D1 error) must not fail the whole import — wrap it the same way
  `guardedDb` wraps the route's other calls, log and fall back to `autoMatchedCount: 0` (the pairs stay pending,
  nothing is lost).
- **`src/lib/server/db/schema.ts`**: `transferLinks` (`:1033-1060`) gains `source: text('source', { enum:
  ['manual', 'auto'] }).notNull().default('manual')`, with a table-level `check('transfer_links_source_check', …)`
  matching the migration's column `CHECK`.
- **Migration 0048** (`migrations/0048_transfer_auto_match.sql`, next free number after 0047 FN-55a/credit cards):
  `ALTER TABLE transfer_links ADD source text NOT NULL DEFAULT 'manual' CONSTRAINT transfer_links_source_check
  CHECK(source in ('manual','auto'));` — a plain `ALTER TABLE … ADD`, no rebuild, the same shape as 0046's
  `net_worth_snapshots.classes` add (cited in that migration's own comment as the precedent for an additive
  column with a same-column `CHECK`). Remote apply only through `wrangler d1 migrations apply` after a D1 Time
  Travel bookmark (`docs/RUNBOOK.md`).
- **`ImportStatementResult`** (`src/lib/server/statements/statement-import.ts:286-289`) gains `autoMatchedCount:
  number` on the `ok: true` branch.
- **`src/routes/(app)/impor/+page.server.ts`**: the `statement` action (`:440-491`) passes `autoMatchedCount`
  through to the returned form data unchanged otherwise.
- **`src/routes/(app)/impor/+page.svelte`**: new conditional line near `:364-377`'s `statementImported` success
  text, `tr()`/`trf()`'d, shown only when `statementForm.counts`/result carries `autoMatchedCount > 0`.
- **`TransferLinkSummary`/`listTransferLinks`** (`:606-660`): add `source: 'manual' | 'auto'` to the interface and
  the `select` list (`l.source as source`); `src/routes/(app)/impor/cocokkan-transfer/+page.svelte`'s existing
  links list renders a small badge when `link.source === 'auto'`.
- **No change** to `src/lib/shared/transactions.ts`, `aggregate.ts`, `wallet-sum.ts`, `undoTransferMatch`,
  `settleTransferLinksOfBatch` or `undoImportBatch` — an auto-matched transfer is, after the merge, byte-for-byte
  the same kind of row a manual merge produces; every downstream aggregate, undo and import-undo path already
  handles it correctly (FN-48 Part C's own architecture note, unchanged).

## Prerequisites

None. Entirely deterministic — no AI Gateway key, no Anthropic key, no new provider, no new `.dev.vars.example`
entry, same as FN-48 Parts A–C.

## Tracker impact

No open `docs/TASKS.md` line names FN-48d yet (it is a new owner decision dated 2026-10-15, after the tracker's
last update); add a new **Claude** line under Phase 2 when this PRD is accepted:
> `- [ ] **Claude** — FN-48d auto-match clear transfer pairs after a statement import (unambiguous OWN_PAIR only, migration 0048).`

`docs/ACCEPTANCE.md` has no FN-48 Part C row yet either (Part C's own PRD left this as a follow-up); once this PRD's
Vitest vectors pass, add or extend that same row: "A transfer between two of the user's own wallets is proposed
and merged into one FN-05 transfer row, never double-counted, with one-step undo — unambiguous pairs auto-merged
right after a statement import, everything else still confirmed by hand (FN-48 Part C + FN-48d) | Automated".

## Risk tier

**Large**, per the task's own framing. This is the first feature in the codebase that lets the server change a
stored transaction's `type` and tombstone another row *without* an explicit user action in the same request —
even though it reuses Part C's already-reviewed merge path unchanged, the decision of *which* pairs qualify as
"unambiguous enough to not ask" is new, money-adjacent logic that a false positive would silently misrepresent
(an incorrectly auto-merged pair hides what looks, to the user, like two real transactions as one transfer). Worth
its own full red-team pass on the restriction query, the ambiguity computation, the no-re-apply guard and the cap,
before it ships, same as Part C got.

## Owner decisions (all six defaults accepted by the owner 2026-10-15)

1. **Trigger scope.** Default: **statement-import commit only** — CSV import, spreadsheet import, on-device OCR
   import and FN-16j's "Pindahkan ke dompet lain" do not run the auto-match pass in this pass (Out of scope items
   1–2). Alternative: also run after CSV/OCR/spreadsheet commits (symmetrical, but widens the red-team surface
   proportionally in a Large-tier feature without a concrete owner-observed need for those paths yet) or after
   FN-16j moves (rare path, already reviewed once; a new wallet assignment can create a new pair, but re-running
   the already-existing manual review there costs the user one extra tap, not a missing feature).
2. **Candidate scope.** Default: only pairs where **at least one row belongs to the just-committed batch** —
   a pre-existing unambiguous pair this import did not touch is left exactly as it was (pending, on
   `/impor/cocokkan-transfer`) rather than opportunistically swept up by an unrelated import. Alternative: auto-merge
   any unambiguous pair found anywhere in the space whenever any statement import runs — simpler to implement, but
   means an import of wallet A's statement could silently merge a pair the user has never seen touched by this
   import at all, surprising them more.
3. **Cap per commit (`AUTO_MATCH_MAX`).** Default: **20** pairs per commit. Each auto-merge is its own small
   `db.batch` (5 statements) on top of the import's own already-large batch; 20 keeps the worst case (a bulk
   statement full of transfer pairs) well inside D1's per-request budget. Any excess stays pending for manual
   review, never lost. Alternative: no cap (simplicity) — risks a very large statement timing out the import
   request itself; a smaller cap (e.g. 5) — safer but likely re-surfaces most of the owner's real "0 pending"
   case as "a few still pending," defeating the point.
4. **"Undone" memory.** Default: reuse `transfer_links` with the new `source` column — any existing row (live or
   undone) with `source = 'auto'` naming either row id blocks future auto-merge of that pair forever (Scope item
   5, migration 0048). Alternative: a new dedicated `transfer_auto_declines` table — functionally equivalent,
   adds a second table and a second migration concept for no behavioural gain over the column approach.
5. **Audit trail.** Default: **none beyond `transfer_links` itself** (`source`, timestamps, before/after
   snapshots) — consistent with a manual merge, which also writes no `audit_events` row today. Alternative: add a
   content-free `audit_events` action (`transfer_auto_matched`, FN-16j's enum-widening precedent) — rejected as an
   inconsistent half-measure when the manual path next to it has none, and nothing reads `audit_events` yet.
6. **Surfacing the count.** Default: a one-line addition to the statement-import success panel
   ("N pasangan transfer dicocokkan otomatis") plus an "Otomatis" badge on the matching link in
   `/impor/cocokkan-transfer`'s existing undo list (Scope items 7–8). Alternative: silent (no line, badge only) —
   rejected; the owner should see *that* something changed automatically to their money's shape, right where they
   just finished an import, not only find it later by opening a different page.

Prior FN-48 Part C owner decisions (2026-10-11/12) stay unchanged and are not reopened here: ±1-day window; exact
`amount_minor` + `currency` match; both sides must already carry a `transfer`-tile category; ambiguous candidates
all listed, user picks or skips; the credit row is tombstoned on merge but its dedupe key stays; 200
candidate-pairs-per-run cap on the review page itself (unaffected — that cap is for `proposeTransferMatches`'s
human-facing list, separate from this PRD's `AUTO_MATCH_MAX` for the auto pass); nothing is learned from a
confirmed or skipped pair (now also: nothing is learned from an auto-merged one either, beyond the no-re-apply
memory this PRD adds).
