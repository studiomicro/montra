# FN-49 Patungan — QA Report, pass 1

**Verdict: PASS**

Worktree `fn-49-qa`, detached at `3d46e1c` (base `c50fa17`). Scope verified: pass 1 only (schema, `EFFECTIVE_AMOUNT`
in `aggregate.ts`, equal/exact modes, link/unlink to the bill row, settle/unsettle, own-share expense). Percentage,
per-item, share link and partial payments are explicitly out of scope for this pass and were not in the diff.

## Commands run

- `npm ci --no-audit --no-fund` — installed 277 packages, exit 0, no provider, local only.
- `npm run gates` (check && lint && test && build) — exit 0; `check` 2212 files/0 errors/0 warnings; `lint`
  prettier+eslint clean; `test` 327 files / 5237 tests passed (local D1/miniflare, no real provider); `build`
  succeeded (client + service worker + Cloudflare adapter). All mocked/local, no real external provider.
- `npm run db:migrate:local` on a fresh `.wrangler` D1 — all 38 migrations through `0040_patungan.sql` applied,
  exit 0 (✅ on every row including 0040).
- `npx playwright test e2e/patungan.spec.ts --workers=1` (E2E_PORT=9091, no-op `flock` shim on PATH) — 7 passed
  (phone+desktop × light/dark + a no-JS journey), local dev server, no real provider.
- `npx playwright test e2e/shell.spec.ts --workers=1` (same setup, touched by this diff's nav change) — 43 passed,
  2 skipped (standard phone/desktop-only skips), local dev server.
- Read-only inspection of `migrations/0040_patungan.sql`, `aggregate.ts`, `patungan/repo.ts`, `patungan/form.ts`,
  `patungan.ts`, route server files, `test/integration/migration-0040.test.ts`,
  `test/integration/patungan-aggregates.test.ts`, `test/integration/patungan.test.ts` — no command, manual review.

No new test was written this pass: the engineer's own `test/integration/patungan-aggregates.test.ts` (one
assertion per aggregate surface named in the task brief) and `test/integration/migration-0040.test.ts` /
`patungan.test.ts` already cover every scenario I set out to probe (see below); I re-derived and spot-checked
each one against the source rather than duplicating passing coverage.

## Checked criteria (acceptance criteria 1–35, PRD)

1–5 (rounding, equal/exact/percentage/items vectors): PASS for pass-1 scope (`equal`, `exact`); `percentage`/
`items` engines exist in `src/lib/shared/patungan.ts`'s sibling money-parse code are **not** in this diff's
`patungan.ts` (only `equalShares`/`exactShares` present) — correct per "Suggested split into passes", not a gap.
`equalShares`/`exactShares` unit-tested with the exact Rp 100.000/3 and 100-cent/3 vectors (`patungan.test.ts`
shared-module tests, part of the 5237 passing).

6 (every aggregate surface counts only the payer's share): PASS. Verified in
`test/integration/patungan-aggregates.test.ts` with one assertion per surface named in the task brief:
`periodTotals`, `listTransactionsByDay` (day header + row), `dailyTotals`, `monthlyTotals`, `categoryTotals`,
`categoryMonthlyTotals`, `merchantTotals`, `largestTransactions`, `moneyFlowTotals`/`moneyFlowReport`,
`berandaSummary`+`safeToSpend`, `anggaranSummary` (budgets), `laporanReport` (month+year), Tanya tools, the
Agent's `facts.ts`. Confirmed in `aggregate.ts` that all nine PRD-named substitution sites use
`EFFECTIVE_AMOUNT = coalesce(t.patungan_effective_amount_minor, t.amount_minor)`, and that
`frequentManualTransactions`/`listTransactionsForExport` deliberately keep the raw amount (also asserted by test).
Wallet balance (`walletTransactionsSums`) correctly stays on the raw amount (the bank really paid the whole bill) —
verified by the same test file.

7 (public API): PASS — `GET /api/v1/transactions` and `GET /api/v1/laporan/ringkasan` tested in the same file;
`amountMinor: 400000` kept, `patungan: {splitId, effectiveAmountMinor: 100000}` added.

8 (Riwayat subtext): PASS — `rowShare()` in `row-text.ts` produces "patungan: bagianmu Rp 100.000" /
"Patungan" correctly; confirmed by e2e assertion `row.toContainText('patungan: bagianmu Rp 400.000'... )`-style
check in `e2e/patungan.spec.ts` (ran, passed).

9 (standalone own-share creation): PASS — `createSplit`'s `own` path writes one transaction via
`insertTransactions`/`capturedTransactionInput` pattern; `patungan.test.ts` and the no-JS e2e spec both exercise
and assert this (only one new transaction, amount = share).

10, 11 (link refusal — amount/currency mismatch, non-expense, already-linked): PASS — enforced both in
`linkSplit`'s SQL guard and DB-level by the migration's CHECK/unique index/trigger, tested in
`migration-0040.test.ts` ("enforces the link rules in the database") and `patungan.test.ts` ("refuses a bill that
is not a live, real, unlinked expense…").

12 (editing a linked transaction's amount/currency refused): PASS — `patungan.test.ts` "keeps its amount, currency
and type on every edit path; the rest stays editable (AC-12)"; also enforced in the offline sync queue
(`sync/push.ts` now returns `TRANSACTION_LINKED` for a queued amount/currency edit) and the public write
surface — confirmed in the diff and in "the offline queue and the public API refuse the amount change too (two
devices, FN-38)".

13 (edit while unlocked re-syncs effective amount): PASS — `patungan.test.ts` "editing the shares while unlocked
moves the counted share in the same write (AC-13)"; `batchAssert` defence-in-depth confirmed in `repo.ts`.

14–16 (unlink / delete-split / delete-transaction cascades): PASS — all three in `patungan.test.ts`; DB-level
tombstone-nulls-both-columns confirmed in `TOMBSTONE_CONTENT` (`transactions/repo.ts`) and in
`migration-0040.test.ts` (a delete that doesn't null the two columns is rejected by CHECK).

17 (settling never moves a total): PASS — `patungan.test.ts` "settling never moves a total; it is idempotent and
locks the shares (AC-17, AC-20, locking)"; also structurally true since `aggregate.ts` never reads
`paid_amount_minor`/`paid_at` (grepped, confirmed).

18 (duplicate-detection unaffected by linking): PASS — `patungan.test.ts` "a statement-import duplicate check
still matches the linked row (AC-18)"; `amount_minor`/`dedupe_key`/`source` untouched by every link/unlink/delete
path (read the SQL — only `patungan_split_id`/`patungan_effective_amount_minor`/`updated_at`/`seq` are ever set).

19 (Tanya/Agent cross-surface equality): PASS — same assertion in `patungan-aggregates.test.ts`.

20, 21 (settle/partial-payment semantics for pass 1 — full settle only): PASS for the full-settle path
(`setParticipantPaid`), idempotent, tested ("settling never moves a total… AC-17, AC-20"). Partial payment
("Catat sebagian") is pass-2 scope per the PRD's own split and is correctly absent from this diff.

22–26 (share link, signed-out page, revoke/expiry, throttle, noindex/redaction): **out of scope for pass 1**
(PRD's "Suggested split into passes" explicitly defers the share link to pass 2) — correctly absent; no
`/patungan/bagikan/[token]` route exists in this diff. Not a gap.

27, 28 (space isolation — non-member 404, cross-space scoping): PASS. Every `/patungan*` load/action goes through
`currentSpaceScope` → `requireSpaceAccess` (same 404-shaped refusal as every other space route — read
`src/lib/server/spaces/current.ts`). `patungan.test.ts` "who may do what" test: a non-member sees nothing, a
removed member loses access, another space's split is invisible; "the database keeps a link inside one space and
one live transaction per split" test confirms the cross-space trigger (`transactions_patungan_same_space_*`).

29 (space purge sweeps the three new tables): PASS — `patunganSplits`/`patunganParticipants`/`patunganShareLinks`
all present in `SPACE_SCOPED_TABLES` (`src/lib/server/spaces/spaces.ts`), and `patungan.test.ts` "purging a space
removes its splits, participants and share links" passed.

30 (Data demo split excluded from totals, badged): PASS — `scripts/demo-seed.ts`'s new `demoSplitStatements`
writes one `is_demo: true` split linked to the existing demo-3 transaction (already excluded from every real
total by the pre-existing `is_demo = 0` filter in every `aggregate.ts` query); `demo-seed.test.ts` updated and
passing.

31 (loading/empty/error/saving/success states): PASS — `/patungan`, `/patungan/baru`, `/patungan/[id]` all have
`loadError`/empty states and `saved=` one-shot notices confirmed after a server redirect (`saved-notice.ts`
pattern reused from transactions); exercised in both e2e specs.

32 (i18n, money formatting): PASS — every new string goes through `msg()`/`tr()`/`trf()`; the project-wide "every
Indonesian phrase has an English entry" test is part of the 5237 passing tests (gates would have failed
otherwise); every money figure in the UI reads through `formatMoney`.

33 (360 px, 44 px targets): PASS — `e2e/patungan.spec.ts`'s `expectTargets`/`expectNoHorizontalScroll` assertions
on the save and settle buttons, run on the `phone` (360 px) project; passed.

34 (no-JS forms): PASS — `e2e/patungan.spec.ts`'s dedicated no-JS test (create with a field error, then valid
create, settle) ran as a plain POST journey and passed; create/link/unlink/edit/delete/settle/unsettle are all
plain SvelteKit form actions (no client-only code path) — confirmed by reading every `+page.server.ts` action.

35 (feature flag off hides nav, changes no total): PASS — `feature-flags.ts`/`feature-flags.test.ts` updated
(`patungan` added, default on), `nav.ts`/`nav.test.ts` gate the Riwayat/sidebar entries on it; the flag never
touches `aggregate.ts` (grepped — no flag check in that file), so a hidden module changes no stored total by
construction.

## Specifically-requested verification beyond the engineer's own tests

- **Second user / removed member / cross-space 403/404**: confirmed via `currentSpaceScope` reuse (no new
  authorization code path) and `patungan.test.ts`'s "who may do what" test — a non-member's `unlinkSplit` call
  returns `'missing'` (404-shaped), another space's split is invisible, a removed member loses access.
- **Sync push/pull scoped the same way**: `sync/push.ts`'s `transaction.update` dispatch now refuses an
  amount/currency change on a linked row (`TRANSACTION_LINKED`), read through the same `updateTransaction` call
  used by the authenticated form and the public API — one guard, three callers. No separate "pull" path reads
  Patungan data outside the normal space-scoped sync tables.
- **Money sums exact integers, no mixed currency**: `equalShares`/`exactShares` use `BigInt` throughout and
  `assertSum` throws if a mode's own output doesn't add to the total exactly; a split has exactly one currency
  (`currency` column, enforced at the form and the link-match check) — confirmed by reading `patungan.ts`.
- **WIB month/day buckets**: this feature introduces no new date computation — `occurred_on` is taken verbatim
  from the linked transaction or the form's date field, and `aggregate.ts`'s existing WIB bucketing (`occurred_on`
  string compare/`substr`) is untouched by the `EFFECTIVE_AMOUNT` substitution (it only changes what is summed,
  never the `GROUP BY`/`WHERE` on `occurred_on`). No separate 23:30-WIB-boundary test was needed or added for this
  reason; the existing WIB-boundary tests on `aggregate.ts` (pre-existing, part of the 5237 passing) still cover
  the bucketing itself.
- **Captured data source/review state**: a bill is always a real transaction (never a draft); the payer's own
  share row is written through the same `manual` source as any manual expense (`insertTransactions`/
  `capturedTransactionInput`) — no AI involvement, no review-state change needed.
- **No fabricated figures**: `linkHolds`/`sharesHold` SQL guards plus `batchAssert` refuse any write where the
  shares don't sum to the total or the linked transaction's effective amount disagrees — a failed assertion
  throws, never silently corrects.
- **CSV/account export**: `src/lib/server/export/tables.ts`'s new `patungan_splits`/`patungan_participants`
  entries correctly omit `created_by_user_id`/`member_user_id`; `patungan_share_links` is `export: 'none'`
  (token hashes are bearer-secret material) — a good defensive decision ahead of the red-team pass.
- **Wallet balance stays raw**: confirmed in `patungan-aggregates.test.ts` ("the wallet balance, the CSV export
  and 'Catat lagi' keep the real amount") — the bank really paid the whole bill.
- **FN-34b (budget streak) interplay**: `b6fe074` (FN-34b, budget-streak days) is **not present** in this
  worktree (based at `c50fa17`, before FN-34b merged to `main`). There is no `budgets/streak.ts` in this tree to
  check. Flagging for the merge: once merged, confirm the per-day "spent within safe-to-spend" calculation that
  closes a budget-streak day reads through `aggregate.ts` (inheriting `EFFECTIVE_AMOUNT` for free) rather than a
  second raw `amount_minor` query — this file did not exist to inspect in this pass.

## Findings (deviations judged, per the task brief's explicit callouts)

None of the three flagged deviations below are functional defects; all are accepted as reasonable engineering
trade-offs for pass 1. No blocking findings.

1. **"bagianmu" subtext is not itself a link (PRD said "linking through to /patungan/[id]")**. In
   `src/lib/ui/kit/TransactionRow.svelte` the `share` subtext is a plain `<span>`; the row's own `href` goes to
   `/riwayat/{id}/edit`, not `/patungan/{splitId}`. The edit page does carry a "Lihat patungan" link through to
   the split (`src/routes/(app)/riwayat/[id]/edit/+page.svelte:138`), so the split is still reachable, just one
   extra tap away from Riwayat. Accepted — no information is hidden, the record is still one tap further than the
   PRD's literal wording.
2. **Generic "no bill row" state, not a distinct "transaction deleted" message**. `/patungan/[id]`'s unlinked
   state shows the same "Belum ada transaksi untuk patungan ini…" copy and the same two choices
   ("Tautkan transaksi lain" / "Buat transaksi untuk bagianmu") whether the split was never linked or its bill was
   deleted; the PRD asked for the specific sentence "Transaksi yang menautkan patungan ini sudah dihapus" in the
   latter case. Functionally identical (same recovery actions offered); only the explanatory copy is less
   specific. Accepted.
3. **"Batalkan lunas" (unsettle) is allowed even while the split is locked.** `setParticipantPaid`'s `unpaid`
   branch has no `lockedSql` guard, so the payer can un-settle one participant even if others remain paid (the
   split stays locked as long as any non-payer still has `paidAmountMinor > 0`). The PRD's text said unsettle
   should only be allowed "while the split is not yet locked". Since `paid_amount_minor`/`paid_at` are never read
   by `aggregate.ts` (confirmed — settling can never move a total) and the action is payer-only and idempotent,
   this cannot corrupt a total or let another participant tamper with anything; it only lets the payer correct a
   mistaken "Tandai lunas" tap. Accepted as a reasonable loosening, not a security or money-correctness issue.

## Engineering checklist spot-check

- Every new table has `space_id` (`patungan_participants`/`patungan_share_links` denormalised as the PRD
  specified); `patungan_splits`/`patungan_participants` have `updated_at`/`deleted_at`/`seq`; `patungan_share_links`
  (pass 2, unused yet) has `updated_at`/`deleted_at` but no `seq` — matches `space_invites`' own shape, the model
  the PRD named, so consistent with precedent, not a gap for pass 1.
- Every server query goes through `requireSpaceAccess`/`currentSpaceScope` — no new access path. A hidden button
  is not the guard anywhere: every repo write re-checks `created_by_user_id = userId` and `isLiveMember` inside
  its own SQL.
- D1: every batched write uses `db.batch`, no interactive transaction; `batchAssert` used as defence-in-depth
  after every guarded multi-statement write that touches both a split and a transaction.
- Money: integer minor units, `BigInt` sums, one currency per split, no floats anywhere in `patungan.ts`.
- Migration 0040 is a deliberate deviation from the PRD's literal "rebuild `transactions`" instruction — the
  engineer used `ALTER TABLE … ADD COLUMN` with a column-level CHECK plus two triggers instead of a full table
  rebuild, explicitly justified in the migration's own header comment (avoids rewriting the largest table) and
  verified byte-for-byte equivalent by `migration-0040.test.ts`. This is a sound deviation, not a gap — I verified
  the resulting guarantees (both-or-neither columns, range check, expense-only, same-space, one-live-link) all
  hold at the DB level exactly as the PRD specified, just built differently.

## Summary

`npm run gates` is clean (check/lint/test/build all exit 0, 5237 tests passed). Migration 0040 applies cleanly to
a fresh D1 and transforms a seeded 0037 DB correctly (own test suite, re-verified by reading it). Every acceptance
criterion in pass 1's scope is covered by a passing test or directly verified by reading the source; the
nine-site `EFFECTIVE_AMOUNT` substitution in `aggregate.ts` is complete and correctly excludes the two named
exceptions. The three PRD deviations flagged in the task brief are all judged acceptable. No blocking finding.

---

# Cycle 2

**Verdict: PASS**

Worktree `fn-49-qa2`, detached at `e3f458c` (rebased on `main` `a39d1e4`). History: `f81571f` cycle 1,
`094bd87` red-team L1/L2 + reports, `21f09dd` cycle 2 fix, `e3f458c` rebase onto 0040 (migration renumbered
0040 → `0041_patungan.sql` at merge, as the PRD's own renumber-at-merge note anticipated). Scope of this re-check:
`git diff f81571f..e3f458c -- src test e2e migrations` (the cycle-2 fix itself) plus `git diff a39d1e4..e3f458c`
for full-feature context; files that only changed because of the rebase onto main (e.g. unrelated FN-48B/FN-34b/
FN-26b code) were not re-reviewed.

## Commands run

- `npm ci --no-audit --no-fund` — 277 packages, exit 0, local only, no provider.
- `npm run gates` (check && lint && test && build) — exit 0 on the clean run; check 2251 files/0 errors/0
  warnings; lint (prettier+eslint) clean; test 342 files/5496 passed; build succeeded. Local/mocked only.
- `npm run gates` first attempt — exit 1, one failure: `test/integration/net-worth.test.ts` "105 more spaces…"
  timed out at 30000ms under full-suite parallel load. Re-run of that file alone: `npx vitest run
  test/integration/net-worth.test.ts -t "105 more spaces"` — 1 passed, 15 skipped, exit 0. File is untouched by
  this diff (`git diff f81571f e3f458c -- test/integration/net-worth.test.ts` is empty); judged a pre-existing
  timing flake, not a cycle-2 regression. The subsequent full `npm run gates` re-run was clean (see above).
- `npx vitest run test/integration/migration-0041.test.ts` — 4 passed, exit 0, local D1.
- `npx vitest run test/integration/patungan.test.ts test/integration/patungan-aggregates.test.ts
  src/lib/shared/patungan.test.ts src/lib/server/patungan/form.test.ts` — 56 passed, exit 0, local D1.
- `npm run db:migrate:local` on a fresh `.wrangler` D1 — all migrations 0001–0041 applied, every row ✅, exit 0.
- `npm run db:migrate:local` re-run on the same, now-migrated D1 — "No migrations to apply!", exit 0 (clean no-op).
- `npx wrangler d1 execute DB --local --command "PRAGMA foreign_key_check;"` on the fully migrated local D1 —
  empty result set (no violations), exit 0.
- `npx playwright test e2e/patungan.spec.ts --workers=1` (E2E_PORT=9101, no-op macOS `flock` shim on PATH) — 7
  passed (phone+desktop × light/dark + no-JS journey), local dev server, no real provider.
- `npx playwright test e2e/shell.spec.ts --workers=1 --project=phone` (same setup) — 21 passed, 2 skipped
  (standard desktop-only skips), local dev server.

## What changed this cycle (vs. cycle 1 / red-team findings)

- `src/lib/server/patungan/repo.ts`: L1 fix — every write path (`payerOf`, `whyNot`, `updateSplit`,
  `updateSplitDetails`, `linkSplit`, `createOwnShare`, `setParticipantPaid`) now also excludes `is_demo = 1`
  splits, answering `missing`/404 exactly like an unknown id. L2 fix — new `orphanOwnerOf`/`managerOf` SQL
  predicates and `isSpaceOwner` helper: the space's Pemilik may `unlinkSplit`/`deleteSplit` once the payer is no
  longer a live member, enforced inside the same guarded `UPDATE`/`DELETE` statements (not a second check).
- `src/routes/(app)/patungan/[id]/+page.server.ts` and `.../ubah/+page.server.ts`: demo-split actions
  (`ownShare`, `update`, `details`) now answer 404 instead of succeeding; `load` adds `canRescue = !isPayer &&
  !split.isDemo && !split.payerIsMember && locals.space?.role === 'owner'`.
- `src/routes/(app)/patungan/[id]/+page.svelte`: "Lepas tautan"/"Hapus" become visible under `canAct ||
  data.canRescue`; "Ubah", "Tandai lunas" and "Catat sebagian" stay gated on `canAct` alone (payer-only) — settling
  and editing are correctly never exposed to the rescuing Pemilik. A new hint explains the rescue state.
- `src/lib/shared/i18n-en.ts`: one new English entry added for the rescue hint string.
- `test/integration/patungan.test.ts` (+213 lines): new `describe` blocks "red team L1" (demo split: unlink,
  link, own-share, settle, update-shape action, `updateSplit`, the `/ubah` `update` action, `deleteSplit` — all
  refused `missing`/404; totals and the demo row's own title unchanged) and "red team L2" (payer still a member →
  Pemilik gets 403 on unlink and delete; payer removed → Anggota still 403, Pemilik unlinks — bill counts in full
  again, `spent()` delta is exactly `+full bill −payer's share` — and then deletes a second split; payer leaves by
  themselves → Pemilik deletes; payer's account deleted (`created_by_user_id` → null) → Pemilik unlinks, a second
  unlink is a no-op `'ok'`).
- `test/integration/patungan-aggregates.test.ts` (+14 lines): new test "the budget streak (FN-34b) judges a day
  by the payer share, through dailyTotals" — a day with a Rp 300.000×days allowance is `within` when only the
  Rp 250.000 effective amount (share + an unlinked coffee) counts, which would be `over` on the raw Rp 550.000
  bill.

## Checked criteria (this cycle's focus)

- **L1 — every split write path refuses a Data demo split server-side (404/missing), totals unchanged**: PASS.
  Verified in `test/integration/patungan.test.ts`'s new "red team L1" block (ran directly, part of the 56
  passing): `unlink`/`link`/`ownShare`/`settle`/`update` form action/`updateSplit`/`deleteSplit` on a demo split
  all return `missing`/404; `spent()` before and after equals the real expense alone (Rp 4.500.000); the demo
  split's own title stays `'Makan siang (demo)'` throughout. Read the repo.ts diff directly: every guard now
  carries `s.is_demo = 0` (SQL) or `split.isDemo` (TS) ahead of the `createdByUserId` check, and `whyNot` answers
  `missing` for a demo split before it ever checks payer identity — matches the red-team's own fix
  recommendation exactly.
- **L2 owner decision 9 — Pemilik rescue, Anggota 403, Pemilik 403 while payer still a member, detail page gates
  the actions to the Pemilik only**: PASS. All four sub-scenarios directly verified:
  - Payer still a member → Pemilik's `unlink` and `delete` both 403 (`'while the payer is still a member, the
    Pemilik gets 403 like any other member'`, ran, passed).
  - Payer removed → Anggota (Citra) still 403; `splitPage.load` for the Pemilik returns `{ canRescue: true,
    isPayer: false }` (confirms the detail page computes and exposes the gate exactly as the server-rendered
    condition requires); Pemilik's `unlink` succeeds, the bill's `amount_minor` is unchanged (Rp 30.000.000) but
    `patungan_split_id` is cleared, and the space's counted total moves by exactly `−share (Rp 10.000.000) +
    full bill (Rp 30.000.000)`; settling by the Pemilik on the now-unlinked split is still refused 403 (payer-only
    survives the rescue); the Pemilik then deletes the split outright, a second (now-independent) split of
    Citra's is confirmed untouched.
  - Payer left by themselves (`leaveSpace`) → Anggota 403 on delete, Pemilik's delete succeeds, the bill is
    cleanly unlinked and not deleted.
  - Payer's account deleted (`deleteAccount`, `created_by_user_id` → null via `ON DELETE SET NULL`) → Anggota
    (now `scopeOf(member, ...)`) gets `'forbidden'` from `unlinkSplit`, the Pemilik's `unlinkSplit` returns `'ok'`,
    and calling it again is idempotently `'ok'` (no error on a no-op).
  - UI gating read directly in `+page.svelte`: "Ubah", "Tandai lunas", "Catat sebagian" stay behind `canAct`
    (payer-only) alone; only "Lepas tautan"/"Hapus" open up under `canAct || data.canRescue` — the rescue never
    grants settle or edit, exactly as the owner decision specifies ("Nothing else changes: settling and editing
    stay payer-only").
- **FN-34b budget streak counts only the payer's share for a linked bill**: PASS. `budgets/streak.ts`'s
  `snapshotBudgetDay` calls `dailyTotals` from `transactions/aggregate.ts`, which is one of the nine
  `EFFECTIVE_AMOUNT` substitution sites (confirmed by grep: line ~395 of `aggregate.ts` sums
  `coalesce(t.patungan_effective_amount_minor, t.amount_minor)`), so the budget-streak day-closure inherits the
  fix for free with no second raw-amount query. Directly verified by the engineer's new test (ran, passed): a
  day with an allowance of exactly Rp 300.000 × days is judged `within` when only the Rp 250.000 effective amount
  (Rp 100.000 share + an unlinked Rp 150.000 coffee) counts — the raw Rp 550.000 bill would have made it `over`.
  This closes the gap flagged as untested in the cycle-1 report (FN-34b was not yet merged into that worktree).
- **Migration chain 0040 → 0041**: PASS. Fresh local D1, migrations 0001–0041 all apply ✅ (including the renamed
  `0041_patungan.sql`); a second `db:migrate:local` run on the same DB is a clean no-op ("No migrations to apply!
  "); `PRAGMA foreign_key_check` on the fully migrated DB returns no violations. `test/integration/
  migration-0041.test.ts` (seeded at the migration-before-0041 state, then 0041 applied) passed 4/4: the two new
  `transactions` columns are added by `ALTER` with every existing row (live, tombstone, demo) preserved byte for
  byte; `feature_flags` accepts `'patungan'` and rejects an unknown module; the link CHECKs/unique index/
  same-space guard hold; a second run of the same migration file repeats cleanly and stops harmlessly at the
  first `ALTER` ("duplicate column"), losing nothing.
- **No regressions on cycle-1 criteria**: PASS. Full `npm run gates` is clean (342 files / 5496 tests, up from
  327/5237 in cycle 1 — the increase is this cycle's new tests plus tests that merged in from main). The full
  `patungan`/`patungan-aggregates`/shared-`patungan`/`form` suites (56 tests) and both e2e specs
  (`patungan.spec.ts` 7/7, `shell.spec.ts` phone 21 passed/2 standard skips) all pass. Nothing in the cycle-1
  QA report's 35 checked acceptance criteria is touched by this cycle's diff other than L1/L2 and the FN-34b
  cross-check above, so earlier evidence for the untouched criteria stands.

## Engineering checklist spot-check (cycle-2 diff only)

- **One access rule / no existence oracle**: the L1 and L2 fixes both answer `missing`/404 or `forbidden`/403
  through the same `whyNot`/guarded-`UPDATE`/`DELETE` pattern already in place — no new access code path, no new
  oracle (a demo split now answers exactly like a non-existent one, closing the gap the red team found).
- **Guarded single-statement writes**: `managerOf`/`orphanOwnerOf` are composed into the existing guarded
  `UPDATE … WHERE …` / `DELETE … WHERE …` predicates (`unlinkSplit`, `deleteSplit`) rather than a read-then-write;
  the separate `isSpaceOwner` call is informational only (used to shape the refusal reason in `whyNot`), not part
  of the authorization boundary itself, which remains atomic inside the guarded statement.
- **i18n**: the one new string has its English counterpart in `i18n-en.ts` (confirmed by reading the diff; the
  project-wide "every Indonesian phrase has an English entry" test is part of the 5496 passing).
- **Payer-only invariant preserved**: settle/edit remain gated on `canAct` alone in both the UI and every server
  action; the rescue path only ever reaches `unlink`/`delete`, matching the owner decision's "nothing else
  changes" instruction exactly.
- No new counter, cap, or concurrency primitive was introduced by this cycle's diff; no new concurrency probe was
  needed beyond what cycle 1 already ran.

## Findings

None. No blocking or non-blocking findings for cycle 2 beyond what cycle 1 already recorded (those three
accepted deviations stand unchanged, since this cycle's diff does not touch any of the three files they concern).

## Cycle-2 summary

`npm run gates` is clean (2251/0/0 check, lint clean, 342 files/5496 tests, build succeeded) after one isolated,
reproducing-elsewhere-but-not-here flaky timeout in an unrelated, untouched test file was confirmed to pass alone.
Both red-team findings (L1 demo-split write protection, L2 Pemilik rescue) are fixed exactly as specified and
covered by new, passing integration tests that exercise every sub-scenario named in the task brief. The FN-34b
budget-streak interplay — flagged as unverified in the cycle-1 report because that feature had not yet merged —
is now directly tested and confirmed to inherit the `EFFECTIVE_AMOUNT` fix for free. Migration 0041 (renumbered
from the PRD's placeholder 0040) applies cleanly on a fresh D1, re-runs as a no-op, and leaves the FK graph clean;
the seeded-at-0040-then-0041 upgrade test confirms `transactions` and `feature_flags` rows survive unchanged. No
regression found on any cycle-1 acceptance criterion. No blocking finding.
