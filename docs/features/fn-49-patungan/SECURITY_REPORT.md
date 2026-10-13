# FN-49 Patungan — Security report (pass 1, cycle 1)

Reviewed: `git diff c50fa17..3d46e1c` (worktree fn-49-qa, detached at 3d46e1c), against PRD.md and
docs/ENGINEERING_CHECKLIST.md. QA report read (QA PASS).

## Verdict: PASS

There are no medium or high findings. Two low findings and two informational notes are recorded below so they are tracked.

## What was attacked and held

- **Money integrity.**
  - Effective amount: the `transactions_patungan_check` CHECK keeps it within 1…`amount_minor`, requires both columns set or both null, and allows a link only on a live `expense` row.
  - Linking is refused for another space's transaction, an income, a transfer, an adjustment, a demo row, an already-linked row, or a row whose amount or currency differs from the total. Each refusal is enforced inside the guarded UPDATE (`linkable`, `linkSplit`, `setLink`).
  - Linking twice is refused by the partial unique index `transactions_patungan_split_uq`.
  - Editing a linked bill's amount, currency or type is refused with `linked`. The guard is inside the UPDATE (`linkedBillKept`, transactions/repo.ts) and is shared by the edit page, `PATCH /api/v1/transactions/:id` and the sync push.
  - Deleting a bill (single delete or import undo) clears the link through `TOMBSTONE_CONTENT`. Deleting a split unlinks in the same batch.
  - `updateSplit` keeps a bill's amount. Its closing `batchAssert` fails the whole batch if the total, shares or link drift.
  - Same-space triggers: a PoC raw `UPDATE transactions SET patungan_split_id = <space A split>` on a space B row was refused by `transactions_patungan_same_space_update`. No app code path updates `transactions.space_id`.
- **Authorization.**
  - Every load and action goes through `currentSpaceScope`. Other-space and missing ids get the same 404, and a removed member gets 404.
  - Payer-only writes repeat `created_by_user_id` and `isLiveMember` inside the statement and return 403.
  - Forged participant or member ids match nothing. Member ids come only from `spaceMemberNames`, and the insert re-checks live membership.
  - CSRF uses the global origin check in hooks.server.ts.
- **XSS.** No `{@html}` in any new Svelte file. Participant and payer names render escaped. The API `patungan` field carries only `split_id` and `effective_amount_minor`: no names reach API tokens. The export is JSON only (`patungan_participants` without `member_user_id`). There is no CSV column for names.
- **Migration 0040.**
  - The ALTERs add nullable columns, so the CHECK passes on every existing row: live rows, tombstones, demo rows and adjustments.
  - The `feature_flags` rebuild copies every row and recreates the unique index. Nothing references the table, and main's 0038 and 0039 do not touch `feature_flags` or `transactions`.
  - The column FK is to `patungan_splits` with no action. The purge order (transactions, then participants, links and splits) holds.
- **Bounded work.**
  - Lists are capped at 100 splits, 30 bill candidates and 20 participants. Each space holds at most 1000 splits.
  - Form fields are cut before parsing.
  - Participants are bound once as JSON, so there is no per-item parameter growth.
  - Shares are summed with BigInt or in SQL.

## Findings

### L1 (low): demo splits are protected only by the UI, not by the server

- **Where:**
  - `src/lib/server/patungan/repo.ts:815` (`linkSplit`), `:867` (`createOwnShare`), `:588` (`updateSplit`), `:681` (`updateSplitDetails`).
  - `src/routes/(app)/patungan/[id]/+page.server.ts:132`, `:141`.
  - `src/routes/(app)/patungan/[id]/ubah/+page.server.ts:108`, `:137`.
- **What the UI does:** the detail load hides link and own-share for `isDemo` (`:55`), and the edit load redirects demo splits. The actions and repo writes never check `patungan_splits.is_demo`.
- **PoC (run, then deleted):**
  1. On a demo split (seeded "Makan siang (demo)", Rp 45.000, 3 people), the payer posts `?/unlink`.
  2. The payer then posts `?/link` with `transaction=<a real Rp 45.000 expense>`.
  3. The response is 303 `saved=linked`.
  4. The space's real spending drops from Rp 45.000 to Rp 15.000.
  5. `owedToViewer` stays `[]`, because demo splits never count. The Rp 30.000 owed is therefore in no real total.
  6. A direct `?/update` POST on a demo split also succeeds (303 `saved=updated`).
- **Impact:** a real row ends up counted against fictional `Data demo` data, so the totals no longer reconcile with "Belum dilunasi". Only the split's payer, who is the space owner for the seed, can do this, and only by a hand-made request on their own space. No other user or space is affected.
- **Fix:** add `s.is_demo = 0` to `payerOf`, or to each write's split guard, and to the `linkSplit` split predicate. Answer with `missing` or 409.

### L2 (low): a split becomes unmanageable when its payer leaves or deletes their account

- **Where:** `src/lib/server/patungan/repo.ts:352` (`payerOf`). On account delete, `created_by_user_id` becomes NULL through ON DELETE SET NULL.
- **PoC (run, then deleted):**
  1. In a shared space, member Bima creates a split linked to a Rp 300.000 bill.
  2. The owner removes Bima.
  3. The owner's `?/unlink` returns 403 "Hanya pembayar…".
  4. The owner's amount edit of the bill returns `linked`.
  5. The space keeps counting only Bima's Rp 100.000 share. Nobody left can unlink, settle or delete the split.
- **Impact:**
  - The only way out is to delete the transaction.
  - Space totals stay understated with no remaining member able to correct them through Patungan.
  - The removed member's own Patungan view is correctly gone. This is not an access leak.
- **Fix (owner decision):** let the Pemilik unlink or delete orphaned splits, or unlink a removed or deleted payer's splits when the member is removed or deletes their account.

### I1 (info): guest names are stored verbatim

- **Example:** `<img src=x onerror=alert(1)>` and `=HYPERLINK("http://e")` are saved as typed (PoC).
- **Current state:** safe today. Svelte escapes the text, and export is JSON only.
- **Pass 2:** the public share-link page must render these names escaped, with no `{@html}`, and any future CSV must apply the formula prefix rule from the checklist.

### I2 (info): un-settling works on a locked split

As QA noted, `setParticipantPaid(paid=false)` works on a locked split. Un-settling every participant unlocks the split, so its shares become editable again. This is a payer-only action on their own records, consistent with the PRD ("settling/un-settling still works"). No exposure.

## ENGINEERING_CHECKLIST

- Space-access helper, bounded queries, the 100-parameter rule, guarded single-statement writes, stale `updated_at` checks, tombstones without content, i18n messages, keyed `{#each}` (ids, guests by index) and the form-body guard were all checked. No violations.
- The "hidden button is not authorization" rule is the L1 gap, which applies to demo splits only.

## Commands run

- PoC: `npx vitest run test/integration/zz-secpoc.test.ts` → 5 passed (P1 demo link, P2 orphan, P3 names, P4 demo update, P5 trigger). The file was deleted afterwards and `git status` is clean.
- `npx vitest run test/integration/migration-0040.test.ts test/integration/patungan.test.ts test/integration/patungan-aggregates.test.ts` → 3 files, 33 tests passed.

## Cycle 2

Reviewed: `git diff f81571f..e3f458c -- src test migrations` (worktree fn-49-rt2, detached at e3f458c, rebased on
main a39d1e4). Files that arrived from main through the rebase were not reviewed.

### Verdict: PASS

L1 is fixed. The L2 Pemilik rescue path held under every attack below. There are no medium or high findings.

### L1: fixed

- **Server change:** `payerOf` now requires `s.is_demo = 0`, and `updateSplit` and `updateSplitDetails` add
  `is_demo = false` to the guarded UPDATE.
- **Refusal answers:** the `whyNot` path and the refusal paths in setParticipantPaid, linkSplit and createOwnShare
  treat a demo split as `missing`. The ownShare, update and details actions answer 404.
- **PoC re-run (the new test "red team L1", read and run):**
  - unlink → 404, link of a real Rp 45.000 expense → 404.
  - Unlinked by hand in raw SQL, then linked again → 404.
  - ownShare, settle, update (repo and action) and delete → `missing`/404.
  - The real row stays unlinked, `spent` is unchanged, and the demo title is unchanged.

### L2 rescue path: what was attacked (temporary PoC, run, then deleted)

- **Payer still a member:**
  - The Pemilik's unlink and delete → `forbidden`, and the bill stays linked.
  - The check `not exists (… pm.user_id = s.created_by_user_id and pm.deleted_at is null)` sits inside the UPDATE
    statement itself. There is no check-then-write gap.
- **Payer removed, then re-invited and accepted:**
  - acceptInvite revives the tombstoned row (`deleted_at` null).
  - The Pemilik's unlink and delete then → `forbidden`, and the bill stays linked.
  - The rescue follows the current membership, read in the same statement as the write.
- **Tombstoned or deleted membership:**
  - removeMember and leaveSpace tombstone the membership row. deleteAccount deletes the row and nulls
    `created_by_user_id`.
  - All three make the split orphaned. A NULL payer can never match `pm.user_id`, so a split with no payer is
    treated as orphaned.
- **Payer is the Pemilik:** a live member, so the split is never orphaned. The normal payer path applies.
- **Ownership handed over:**
  - The owner deletes their account. The remaining member becomes `owner`.
  - The owner's old split shows `createdByUserId` null and `payerIsMember` false. The new Pemilik's unlink → `ok`.
  - This is the intended rescue. The role is read in the same statement (`o.role = 'owner' and o.deleted_at is null`).
- **Anggota:**
  - unlink and delete → `forbidden`.
  - The Anggota also owns another shared space: still `forbidden`, because the role check is bound to `${spaceId}`.
- **Cross-space:**
  - The owner of another space (personal or shared) passes their own scope with the victim's orphaned split id.
    unlink and delete → `missing`.
  - `orphanOwnerOf` ties `s.space_id = ${spaceId}`, and the transaction UPDATE also requires
    `transactions.space_id = ${spaceId}`.
  - A forged scope with the victim's space id and a non-member user → `forbidden`. `isLiveMember` fails, and
    nothing is written.
- **Scope of the rescue:**
  - The orphan Pemilik's settle → `forbidden`. The details and update actions → 403.
  - ownShare and link still use `payerOf` only.
  - The title and the bill link are unchanged.
- **Deleted account:**
  - The rescue adds only the boolean `payerIsMember` and a `canRescue` flag to page data. `createdByUserId` is
    already null.
  - No user id, e-mail or other data of the deleted user is newly exposed. The stored `payer_name` was already
    visible to the space (see I3).
- **Migration 0041:**
  - Re-chained after 0040: journal idx 41, and the snapshot `prevId` equals the 0040 snapshot id.
  - 0040 only alters `import_batches`, with no overlap with `transactions` or `feature_flags`.

### Findings (cycle 2)

- **I3 (info): a deleted payer's display name stays on shared-space splits.**
  - **Where:** `patungan_splits.payer_name`, and `display_name` on participant rows.
  - **Detail:** the name survives the payer's account deletion. This is pre-existing cycle-1 behaviour, the same as
    other shared-space rows.
  - **Owner decision:** scrub the name to a neutral label in deleteAccount if the PRD's deletion promise requires it.
- **I4 (info): repo-level existence oracle.**
  - **Where:** `whyNot` (repo.ts:606) and `unlinkSplit`.
  - **Detail:** for a scope whose user is not a member, these answer `forbidden` rather than `missing`.
  - **Why not exploitable:** routes always build the scope through `currentSpaceScope`, so this cannot be reached.
    It is noted for future API or sync callers.

### Commands

- `npm ci --no-audit --no-fund`: exit 0.
- `npx vitest run test/integration/patungan.test.ts test/integration/patungan-aggregates.test.ts`: 2 files,
  35 tests passed.
- Temporary PoC `test/integration/zz-rt2-poc.test.ts`: 3 passed (outputs above), then deleted. The worktree's
  source is unchanged.

### ENGINEERING_CHECKLIST

- Every server write keeps its authorization inside a parameterised, bounded statement.
- A hidden button (`canRescue`) is not the authorization: the server re-checks.
- No secrets or PII were added to page data. No `{@html}`. The new phrase has an English entry.
