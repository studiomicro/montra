# FN-10 Savings goals — Security report

- Scope: `git diff 98df284..b661f7f` (narrow review, Medium tier: money amounts, shared-space data).
- Date: 2026-10-08. Reviewer: red-team-pentester.

## Verdict: PASS

There are no Critical, High or Medium findings. Three Low findings are listed below so they stay tracked.

## What was attacked, and the result

Probes ran as a throwaway Vitest file against local D1 (Miniflare), plus `wrangler dev` on 127.0.0.1:8807 using a
fresh `db:reset:local` database. The throwaway file was deleted afterwards and the server was stopped. Nothing ran
with `--remote`.

| Attack | Result |
|---|---|
| Contribution id of goal A sent to goal B's `deleteContribution` (same space) | `missing`, no row changed (`contributions.ts:119-128` pins id + goal_id + space_id) |
| Contribution or goal id from another space: delete, add, `getGoal`, `listContributions` | `missing` / empty / null. Live: user B on A's goal page gets 404 and B's addContribution gets 404 `Target tidak ditemukan.` |
| Non-member scope `{spaceId: A, userId: B}` passed straight to the repo (bypassing requireSpaceAccess) | refused: `isLiveMember` sits inside every write statement |
| Removed member: add, delete, update, archive, create | all refused (`isLiveMember` in the statement plus `requireSpaceAccess` in `goalScope`) |
| Overflow race: 30 concurrent max-size contributions (Rp 9.999.999.999.999 each) to one goal | 9 accepted, saved 8 999 999 999 999 100 (safe). After topping up to exactly 2^53-1, 20 concurrent 1-minor adds were all `too_large` |
| Live: 12 parallel max-size adds over HTTP | 9×200, 3×409. `/kekayaan` and the detail page still render 200 (`Rp 90.000.000.004.997`) |
| Page-level aggregate DoS: 50 goals each at 2^53-1 | `listGoals` returns 50 rows with safe sums. No cross-goal total exists in the diff; `goalProgressPercent` uses BigInt |
| Double delete: 10 concurrent deletes of one contribution | exactly 1 `ok`, saved back to 0 |
| Deleting a contribution or adding one on an archived goal | refused |
| 50-goal cap race | the guarded `insert … select … count(*) < 50` holds. The engineer's 10-concurrent test passes |
| `wholeAmountMinor` | `1.5`, `12,50`, `1e3`, `0x10`, `-5`, `+5`, `1_000`, `1 000`, Arabic-Indic and full-width digits, `Infinity`, `NaN`, 14 digits, `1..000` are all null. Leading zeros are stripped before the 13-digit cap. `0` is refused by the schema. The regex is linear and the input is sliced to 64 chars first |
| Control and invisible chars in name and note | U+202E, U+200B, NUL, U+00AD, U+FEFF and tag chars are stripped; U+2028 becomes a space; a lone surrogate becomes U+FFFD (USVString). An all-zero-width name is refused |
| CSRF / body | cross-origin and missing-Origin POST give 403 (SvelteKit csrf); `text/plain` gives 415; a 9 KB body gives 400 (8 KiB cap) |
| URL hardening | a 5 000-char id gives 404; a malformed `?sebelum=` cursor is ignored (200); an anonymous request gets 303 to `/masuk` |
| XSS | no `{@html}` in the goal UI or routes |
| Account deletion | `goals` and `goal_contributions` are in `SPACE_SCOPED_TABLES` (children first), so the personal space is purged. Shared-space rows survive with `created_by_user_id` set to null (engineer tests) |

## Findings

### L1 (low): a contribution tombstone keeps the amount, author and time

`src/lib/server/goals/contributions.ts:111-118`. `deleteContribution` sets `deleted_at` and clears `note`, but
`amount_minor`, `created_by_user_id` and `created_at` stay on the row indefinitely. Probe output:
`{"amount_minor":700,"note":null,"created_by_user_id":"…","deleted_at":…}`. This goes against
`docs/ENGINEERING_CHECKLIST.md` › Tombstones ("deleted_at rows without content") and PRD criterion 11 ("content-free").
Today no read path returns deleted rows (`listContributions` and `savedSumSql` filter `deleted_at is null`), so no
user can see the data. Once sync pull ships, a naive pull would send the deleted amount to every member's device.
The amount cannot simply be nulled because of `NOT NULL CHECK(amount_minor > 0)`.
Fix: before sync pull lands, either make the pull serialiser emit only `{id, goal_id, deleted_at, seq}` for
tombstones, or have the retention sweep zero out (relax the CHECK for tombstones) or hard-delete tombstoned
contributions after the sync window. Also set `created_by_user_id = null` on delete.

### L2 (low): a deleted account's notes survive in shared spaces

`src/lib/server/db/schema.ts` (`goal_contributions.created_by_user_id` `on delete set null`) and the migration
`0006_goals.sql`. When a member deletes their account, their contributions in a shared space keep their free-text
`note` (only the author link is nulled). That is a deliberate PRD choice so the amounts stay. A note can still hold
personal text from a person who asked to be deleted. Fix (optional): clear `note` on that user's
contributions in `deleteAccount` (one bounded `update … where created_by_user_id = ?` before the user row goes).

### L3 (low): no per-goal or per-space bound on contribution rows

`src/lib/server/goals/contributions.ts:42-81`. Goals are capped at 50, but contributions per goal are not, and the
action has no rate limit. A member (including a scripted session) can insert rows without limit. Each row costs
D1 storage, and `goalsSavedSums` and `savedSumSql` scan every live row of the space or goal on each page load. A
single goal saturates after about 9 max-size contributions, but a stream of 1-unit contributions never reaches the
overflow cap. Impact is limited to the attacker's own spaces (and shared spaces they belong to). Fix: a per-space
row cap or a per-user write throttle (shared with the other capture actions once one exists).

## Engineering checklist

- Space access through `requireSpaceAccess`, and membership repeated inside each write statement: OK.
- Parameterised, bounded Drizzle and SQL queries (limits of 50+1 and 50; the cursor is regex-checked): OK.
- Integer `amount_minor`, no floats, safe-integer guard in SQL: OK.
- Untrusted text is cleaned before storage: OK.
- Account deletion: the tables are in `SPACE_SCOPED_TABLES`: OK.
- No secrets or other members' e-mail in page data (the loader returns only the author's display name): OK.
- Tombstones without content: deviation, see L1.

## Commands

- `npx vitest run test/integration/goals.test.ts test/integration/tabungan-routes.test.ts src/lib/server/goals src/lib/server/forms.test.ts`:
  4 files, 84 tests passed.
- Red-team probe file (7 tests, deleted afterwards): 7 passed.
- `npm run build`: done. `wrangler dev --port 8807` (local): the live probes above, then the server was stopped.
