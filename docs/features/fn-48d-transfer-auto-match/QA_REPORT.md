# QA report — FN-48d auto-match clear transfer pairs after a statement import

**Verdict: PASS**

Worktree: `<path>`, branch
`feat/fn-48d-transfer-auto-match`, engineer commit `c64cb5e`, diff against `main`.

## Commands run

- `npm run gates` (full: check, lint, test, build) — clean, exit 0; check: 2377 files / 0 errors / 0 warnings; lint:
  prettier + eslint clean; test: 389 files / 6575 tests passed, 0 failed (local D1 workerd, real Vitest run, no
  mocked provider needed — feature has no AI/provider dependency); build: Vite + service worker + Cloudflare adapter
  built, 18 prerendered files bundled. Known flake `src/lib/ui/offline-queue/sync.test.ts` backoff test did not
  fail in this run, no rerun needed.
- `npm run db:reset:local` — exit 0, all migrations incl. `0048_transfer_auto_match.sql` applied cleanly to a fresh
  local D1 (`.wrangler/state`, real local D1 via wrangler, not a fixture).
- `npx vitest run test/integration/transfer-auto-match.test.ts test/integration/migration-0048.test.ts src/lib/server/transfers/match.test.ts test/integration/cocokkan-transfer.test.ts test/integration/migration-0029.test.ts --reporter=verbose` — 5 files / 62 tests passed, 0 failed (local D1 workerd; deterministic, no real provider, no mock needed — feature is fully deterministic per PRD Prerequisites).

## Checked criteria (PRD `docs/features/fn-48d-transfer-auto-match/PRD.md`)

1. Unambiguous OWN_PAIR auto-merged, `autoMatchedCount: 1`, no user action — PASS. `transfer-auto-match.test.ts`
   "merges the one clear pair right after the import that completes it (AC-1, AC-4)".
2. Ambiguous group never auto-merged, still listed — PASS. "an ambiguous group merges nothing; every candidate
   stays listed (AC-2)".
3. `CARD_PAIR` never auto-merged, even when otherwise unambiguous — PASS. "a card payment pair is never merged by
   itself (AC-3)"; also asserts the guarded insert itself refuses an `auto` card pair (`stillUnambiguous`'s own
   `CARD_PAIR` check), not only the chooser.
4. "Otomatis" badge + unchanged "Urungkan" restores same ids/`created_at` — PASS by code read
   (`cocokkan-transfer/+page.svelte:87` badge on `link.source === 'auto'`; `listTransferLinks` selects `source`)
   plus "an undone auto-merge is never re-applied to its rows; a hand confirm still works (AC-5)" which restores
   via the unchanged `undoTransferMatch` and checks `created_at` equality.
5. Undone auto-match never re-applied, even by a later import with a new partner — PASS, same test as above.
6. Re-import dedupes; `autoMatchedCount` 0; no second link — PASS. "a re-imported statement merges nothing again
   and writes no second link (AC-6)".
7. `AUTO_MATCH_MAX` (20) cap, newest `occurred_on` first, remainder pending with true count via
   `countTransferMatches` — PASS. "merges the newest 20; the rest stay pending with the true count (AC-7, AC-15:
   120 amounts)".
8. Space isolation; removed member's in-flight pass refused like a manual merge — PASS. "reads and writes only its
   own space (AC-8)" and "a removed member's in-flight pass is refused like their manual merge (AC-8)".
9. Concurrent edit mid-pass → `stale`, not retried/surfaced — PASS. "a row edited meanwhile is never overwritten;
   the pair stays for the user" and the sibling "a competing row that appears meanwhile makes the pair ambiguous".
10. `amount_minor`/`currency`/`occurred_on` (WIB) only, never float/UTC — PASS by code read (all SQL compares
    `amount_minor`, `currency`, `occurred_on`) plus "pairs across a WIB month end by occurred_on; two days apart
    never (month-boundary probe)" — exercises 31 Jul / 1 Aug WIB boundary explicitly.
11. CSV/spreadsheet/OCR/FN-16j never trigger the pass — PASS. "a CSV import never runs the pass; its pair stays
    for the user (AC-11)"; no call site added to those paths (confirmed by diff: only
    `statement-import.ts` calls `autoMatchTransferPairs`).
12. i18n completeness — PASS. New strings (`'{n} pasangan transfer dicocokkan otomatis.'`,
    `'Periksa di Cocokkan transfer'`) have English entries in `i18n-en.ts`; `'Otomatis'` already had one
    pre-feature. `npm run gates`' `test` step runs the i18n completeness test (`test/i18n-coverage.test.ts`),
    clean.
13. Success line only after confirmed write, true empty state at 0 — PASS by code read: `+page.svelte` derives
    `autoMatched` from the server's returned `statementForm`/`autoMatchedCount` (never optimistic), and the line
    only renders `{#if statementResult.autoMatched > 0}`.
14. Fail-before proof / gates clean before hand-off — gates verified clean above (reproduced independently). The
    "fail-before" step itself is not re-verifiable from a single `wip` commit; taken on the engineer's word per
    process, not re-run by QA.
15. 101+ ids via `json_each`, never a growing `IN(...)` — PASS by design: the restriction query never binds
    candidate row ids as parameters at all (it reads the batch's own distinct `(amount_minor, currency)` pairs via
    a correlated subquery and joins by column, not by an `IN` list of ids), so the "100 bound parameters" failure
    mode the checklist targets cannot occur; "merges the newest 20; the rest stay pending… (AC-15: 120 amounts)"
    exercises 120 distinct amounts end-to-end without hitting a parameter-count limit.
16. Migration 0048 backfills existing rows to `manual`; re-run is a no-op (changes nothing) — PASS.
    `migration-0048.test.ts`: all four cases (existing rows read `manual`; CHECK refuses other values and NULL;
    partial index present; re-run throws "duplicate column" and leaves the table byte-for-byte unchanged). This
    matches the documented precedent for 0037/0046/0047 in `docs/RUNBOOK.md` (an `ALTER TABLE … ADD` migration is
    not transactionally idempotent against a second raw re-run, but `wrangler d1 migrations apply`'s own
    `d1_migrations` bookkeeping prevents a real second run; the test proves the SQL itself is safe if ever
    re-attempted).

## Engineer-declared departures — verified

(a) **Guarded insert re-checks at write time.** `applyTransferMatch`'s guarded `insert … select` carries a new
`stillUnambiguous(spaceId, pair)` predicate (only for `source = 'auto'`) that re-checks, inside the same guarded
statement: not a `CARD_PAIR`, no live-or-undone `auto` link already naming either row, and no other candidate pair
(own or card) now exists for either row — i.e. the group still has exactly one pair at write time, not just at read
time. Verified directly: the "a card payment pair is never merged by itself (AC-3)" test calls
`applyTransferMatch(..., 'auto')` on a genuine card pair and gets `{ status: 'stale' }`, then the same pair with no
`source` (manual) succeeds — proving the extra guard is `auto`-only and fires correctly. The two "change between the
pass's read and its merge (AC-9)" tests and the "20 concurrent passes… merge the pair exactly once" probe also
exercise this guard under a real race (a `Proxy` that mutates the DB between the read and the `db.batch` call) and
all pass.

(b) **Migration 0048 also adds `transactions_space_amount_idx`, used via `indexed by`.** Confirmed in
`migrations/0048_transfer_auto_match.sql` (partial index, `WHERE deleted_at is null`), `schema.ts`'s matching
Drizzle index, and both `pairsAround()` (the write-time guard) and `autoMatchTransferPairs`'s read query use
`indexed by transactions_space_amount_idx` by name. The dedicated plan test ("its read and its guarded merge look
rows up by batch, id and amount, never by walking the space") runs `EXPLAIN QUERY PLAN` on both the read and the
merge statement and asserts no `SCAN` on `transactions`/`d`/`c` and no `SEARCH` on `d`/`c` outside the named index —
passed, confirming the index is actually used, not just declared.

## Engineering checklist (`docs/ENGINEERING_CHECKLIST.md`)

No violations found. Bounded work (`AUTO_MATCH_MAX` = 20, `AUTO_MATCH_SCAN_MAX` = 1000 + drop-incomplete-tail
logic, tested); concurrent writes are one guarded statement inside `db.batch`, proven by a concurrent test; no
growing `IN(...)` of ids; one access rule (`isLiveMember` inside the same guarded statement, no cached role,
removed-member test passes); money stays `amount_minor`/`currency` integer, dates stay `occurred_on` WIB; i18n
complete; migrations not edited, re-runnable; `npm run gates` clean.

## Findings

None. All sixteen acceptance criteria have a passing, specific test (or a direct, verifiable code read for the two
pure-UI-wiring criteria 4/13, backed by the data-layer tests that feed them). No scope creep found: `undoTransferMatch`,
`settleTransferLinksOfBatch`, `undoImportBatch`, `src/lib/shared/transactions.ts`, `aggregate.ts`, `wallet-sum.ts`
are untouched in the diff, matching the PRD's explicit "no change" list.

## Not independently re-run

- "Fail-before" proof (criterion 14, process step) — relies on the engineer's own report; a single `wip` commit
  gives QA no git history to replay this from.
- No new e2e/Playwright spec was added for the "Otomatis" badge or the import success line (PRD scope item 10 only
  asks for Vitest coverage; the two Svelte template changes are one-line conditionals on server-confirmed,
  already-tested data, consistent with this codebase having no `*.svelte` component-test convention anywhere).
  Not treated as a failing criterion, noted for visibility.
