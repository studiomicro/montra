# FN-26b Subscription check — Security Report

**Verdict: PASS** (no medium or high findings; 3 low findings tracked below)

Scope: `git diff 75824e9..19bfed3` in `<repo>-worktrees/fn-26b-qa` (Medium tier,
narrow review). Focus: the `dismissCandidate` action, the `?periksa=1` / `?kandidat=` load paths, detection over
third-party transaction titles, bounded queries and CPU, and migration 0039 with account deletion, export and purge.

## Commands run

- `npx vitest run test/integration/langganan-check.test.ts src/lib/shared/subscriptions-detect.test.ts`: 2 files,
  31 tests passed, exit 0. Local D1 (workerd); no AI and no real provider.
- A temporary PoC vitest file in `src/lib/shared/` exercised `buildCandidates` on adversarial inputs: 300 rows with
  long titles, 300 rows of many-word titles, and astral-plane letter titles. It ran green and was then deleted.
  `git status` showed the tree unchanged afterwards.

## Checked and holding

- **Authorization.** The load and every action go through `scopeOf` and `requireSpaceAccess` (`+page.server.ts:45-51`,
  `guarded` at :118). The `dismissCandidate` insert also repeats `isLiveMember` inside its own `INSERT … SELECT … WHERE`
  (`detect.ts:206-219`), so a member removed between the check and the write writes nothing and gets `missing`.
  Every read in `findCandidates` is filtered by `space_id`. The integration tests cover two users and two spaces,
  a non-member and a removed member (404 on load and action, nothing written), and a shared-space member.
- **Forged keys and no existence oracle.** `dismissCandidate` stores a key only when it is already dismissed or is
  a current candidate of the caller's own space (`detect.ts:201-205`). An unknown key gets the same 404 as another
  space's key, an over-long key or a blank key. `?kandidat=` opens a sheet only when the key equals a candidate the
  loader already returned (`+page.svelte` `candidate()`), so a crafted link cannot pre-fill arbitrary values.
- **Pre-fill integrity.** `candidateFormValues` takes the amount, currency and dates from the newest stored row. The
  name is cut to 60 and the category comes from the catalogue or falls back to `lainnya`. Nothing is saved until the
  user submits the existing `createSubscription`, which re-validates server-side. A crafted bank or merchant title
  can only change the suggested name.
- **XSS.** Titles and names are rendered only through Svelte text interpolation and attribute bindings
  (`CandidateList.svelte`, `CheckCard.svelte`, `BrandBadge`). The changed files contain no `{@html}` and no
  `innerHTML`.
- **CSRF.** The new action is a normal form action, covered by the global origin check in `hooks.server.ts`
  (`isCrossSiteForm`).
- **Idempotency and concurrency.** A partial unique index on `(space_id, match_key) WHERE deleted_at IS NULL` plus
  `onConflictDoNothing` gives one live row per key. The test with 20 concurrent posts confirms this.
- **SQL.** All queries are Drizzle `sql` templates with bound parameters. The dismissed-keys lookup passes one JSON
  parameter to `json_each`, and that parameter is bounded by the 300 rows read.
- **Bounded reads.** Detection reads at most 300 rows (`LIMIT 300`) within a 90-day window, plus at most
  `MAX_SUBSCRIPTIONS_PER_SPACE` subscriptions. It returns at most 20 candidates with at most 6 source rows each.
  Demo rows, transfers, income and tombstones are excluded.
- **Migration 0039.** It creates one new table and one index, both `IF NOT EXISTS`, and changes no existing table.
  The CHECK limits a key to 1–64 characters, which is at least `MATCH_KEY_MAX_LENGTH` (60).
  `wrangler d1 migrations apply` uses the file names, so the journal gap (idx 37, tag 0039) is harmless. QA also
  confirmed a fresh apply and a no-op second run.
- **Deletion, export and purge.** The table is in `SPACE_SCOPED_TABLES`, so it is purged with the space. `created_by`
  is `ON DELETE SET NULL`, the same as `merchant_rules`. The export ships the table as JSON without `created_by`.
  The stored key is a cleaned merchant key or a catalogue id: no amounts, dates or account numbers.

## Findings

1. **Low: storage growth (no per-space cap on `subscription_dismissals`).** `src/lib/server/subscriptions/detect.ts:191-224`.
   - Each dismissal needs a live expense whose key is a current candidate, so growth is bounded by the space's own
     transaction writes.
   - Dismissals are never tombstoned or swept. A member can still grow the table with a loop: create a recurring
     pair of expenses, dismiss the candidate, delete the expenses, repeat.
   - Each row is under 200 bytes and is purged with the space.
   - Reproduction: loop "record 2 expenses titled `X<n>` 30 days apart, POST `?/dismissCandidate matchKey=x<n>`,
     delete both expenses".
   - Suggestion: add a per-space cap, for example 1,000 rows, or tie the rows to the transaction quota.
2. **Low: candidates with astral-plane letters cannot be dismissed or opened.** `idField` (`validation.ts:185-188`)
   and `queryId` (`+page.server.ts:53`) measure UTF-16 code units against `ID_MAX_LENGTH` = 64, but a key holds up to
   60 code points.
   - Reproduction from the PoC: two expenses titled with 70 × U+20000, 30 days apart, give a candidate whose key is
     60 code points but 120 UTF-16 units.
   - "Bukan langganan" then always answers 404, and the no-JavaScript `?kandidat=` link never opens the form.
   - This is functional only; no security boundary is crossed. Suggestion: compare code points, or accept up to
     `MATCH_KEY_MAX_LENGTH` code points.
3. **Low: detection CPU on every `/langganan` load.** `detect.ts:174` runs `groupByMerchantKey`, and
   `buildCandidates` runs it again, so `cleanDescriptor` cleans each row twice. `dismissCandidate` repeats the whole
   detection.
   - PoC timings per check over 300 rows on Node: about 8 ms for realistic titles and about 15 ms for 80-character
     titles. Pathological 280-character many-word titles took about 76 ms, but the 80-character title cap
     (`TITLE_MAX_LENGTH`) makes those unreachable through normal writes.
   - This is well inside the Workers paid CPU limit and affects only the caller's own space, so it is not a DoS on
     others.
   - Suggestion: clean each row once and pass the groups to `buildCandidates`.

## ENGINEERING_CHECKLIST

- **Bounded work:** met (row cap plus period).
- **One access rule:** met (`requireSpaceAccess` plus `isLiveMember` in the write).
- **Tombstones:** the table has `deleted_at` and `seq`. Nothing undoes a dismissal yet, so no tombstone path exists.
  This is not a security issue.
- **Secrets:** no secrets or PII are serialised in the loader. The candidates carry only the space's own rows.
