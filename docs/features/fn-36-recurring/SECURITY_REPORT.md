# FN-36 Recurring transactions: security report (cycle 1)

Reviewed: `git diff main...fn-36-recurring` (HEAD 6ad58bc) in a detached read-only worktree, against the PRD,
ENGINEER_REPORT and `docs/ENGINEERING_CHECKLIST.md`.

## Verdict: PASS (after the cycle 2 re-check below; cycle 1 was FAIL)

One medium finding (bounded-work / cross-tenant availability in the jobs consumer). No authorization,
injection or data-exposure defect found.

## Findings

### M1 (medium): one `recurring_check` message does ~200 D1 calls (~400 statements); a batch of 10 can exceed the per-invocation D1 query limit and push other tenants' jobs to the DLQ

- `src/lib/server/recurring/repo.ts:29-30` (`MAX_INSTANCES_PER_RUN = 100`), `:626-665` (`runDueSeries`: per
  attempt one 3-statement `db.batch` in `createDueInstance` plus one `dueSeries` re-select; a refused attempt
  adds the `flag()` select and possibly a batch); `workers/jobs/wrangler.jsonc` consumer `max_batch_size: 10`;
  `workers/jobs/src/queue.ts` `handleBatch` runs every message of a batch sequentially in one invocation.
- Measured (probe, local D1, deleted): 100 due series in one space -> `runDueSeries` made **201 D1 calls
  (300 batched statements + 101 selects)** for one message. Ten such messages in one consumer batch is ~2,000
  calls / ~4,000 statements. Cloudflare's D1 limits page lists a cap on queries per Worker invocation
  (1,000 Workers Paid, 50 Free at the time of writing; re-check the official page before relying on the figure).
- Exploit: a user creates N shared spaces (no per-user space cap, `SPACE_LIST_LIMIT` only bounds the list) with
  `MAX_SERIES_PER_SPACE` = 100 series each, all monthly on the same day (or weekly on the same weekday). On that
  date the cron enqueues N heavy `recurring_check` messages in adjacent order; once the invocation's query
  budget is spent, every later message in the same batch (other users' `recurring_check`, `budget_check`,
  `bill_check`, `send_push`) throws, is `retry()`d and after `max_retries: 3` lands in the DLQ (lost pushes /
  notifications). A space held at `MAX_TRANSACTIONS_PER_SPACE` with 100 `limit`-flagged series repeats the
  heavy message every hourly tick, indefinitely (each attempt is refused, `due()` keeps `attention = 'limit'`).
  On the Free plan a single message of ~25 attempts already exceeds the 50-query cap.
- Fix direction: bound D1 work per *invocation*, not per message: e.g. lower `MAX_INSTANCES_PER_RUN` to fit
  `max_batch_size` x per-attempt calls under the limit with margin (or count calls in `handleBatch` and `retry`
  the remaining messages with a delay instead of letting them fail), skip `limit`-flagged series unless the
  space's live count has dropped (one cheap count per space before attempting), and consider a per-user cap on
  owned shared spaces. Add a test asserting the per-message D1 call budget.

### L1 (low): the queue handler uses processing-time WIB date, not the tick's date

- `workers/jobs/src/index.ts:49` (`runDueSeries(db, spaceId, wibTodayString(), …)`). A message delayed or retried
  past 00:00 WIB creates the next day's instances during quiet hours (00:00-06:00 WIB). No duplicate (dedupe key
  holds) and no cross-space effect; noted for predictability. Carrying `today` in the message (validated as a date
  and not later than the processing date) would pin it.

### L2 (low): `transactions.recurring_series_id` FK has no ON DELETE action

- `migrations/0023_recurring.sql:49`. Today the only hard delete of a series is `purgeSpaces`, which deletes
  `transactions` before `recurring_transactions` (`src/lib/server/spaces/spaces.ts:277-281`), and account
  deletion is covered by the integration test. Any future hard delete of a series row (e.g. a retention sweep of
  tombstones) would fail with a FK error unless it clears or deletes the referencing transactions first. Keep the
  order comment and add the table to any future purge path.

### Informational (no finding)

- Cron identity: `created_by_user_id` switches to whoever last edited or resumed the series. Any live member may
  do so (PRD sets no role restriction; transactions carry no creator column, so attribution has no effect beyond
  the membership check). A removed member: every page/action 404s (tested), and the cron's `isLiveMember` inside
  the insert refuses and flags `member`. User deletion sets the column to null, which also flags `member`.

## Checked and holding

- Authorization / IDOR: every load and action resolves `currentSpaceScope` -> `requireSpaceAccess`; series,
  wallet and category ids are looked up inside the space only and re-checked in the guarded SQL (`refsHold`,
  `isLiveMember`, `writable`). Another space's series id, wallet or category -> the same 404 / "not found" answer
  (probe + existing tests). Edit page `getSeries` is space-scoped.
- Tampering: `type` is a zod enum (`expense|income`) plus a DB CHECK; probe confirmed `adjustment`, `transfer`,
  day 0/32, weekday 8, `daily`, negative/scientific/oversized amounts, impossible dates refused. Dates are
  limited to 2000-2099 (`isDateString`); first run is `max(start, today)`, so no backfill bomb; end date >= first
  run. Currency is the wallet's, never the client's.
- Stale forms: `updated_at` optimistic guard on every write; stopped series are final.
- CSRF: SvelteKit origin check left on (no `csrf` override); forms POST via actions; body via `readFormBody`.
- Idempotency: `recurring:<id>:<date>` checked including tombstones (`keyExists` has no `deleted_at` filter;
  transaction tombstones keep `dedupe_key`), insert + advance in one `db.batch`, guarded on `next_run_on` and
  `updated_at`; unique index `transactions_dedupe_uq` behind it. 20-concurrent-run test passes.
- Bounded work: 100 live series per space (guarded insert), keyset pages, 100 attempts per message
  (but see M1 for the per-invocation total).
- Logging: counts only in the jobs Worker, `e.name` only in loaders; no titles, notes, amounts or ids logged.
- Output: no `{@html}` in the new routes/components; titles and notes pass `cleanText` and Svelte escaping;
  hrefs use server-generated ids only.
- Export/deletion: `recurring_transactions` in `SPACE_SCOPED_TABLES` (after `transactions`, before
  `categories`/`wallets`) and in the export decisions (`created_by_user_id` omitted). No secrets in page data.
- Money: generated rows are ordinary expense/income rows with the wallet's currency through `insertTransactions`
  (same cap and refs checks); "Aktif berulang" filter uses the same `filterWhere` for list and totals (tested).
- Migration 0023: `ALTER TABLE ADD COLUMN … REFERENCES` with NULL default is valid on SQLite/D1 with FKs on;
  `recurring_transactions.space_id` cascades, `created_by_user_id` sets null.

## Commands run

- `npx vitest run --maxWorkers=2 test/integration/recurring.test.ts workers/jobs/src/queue.test.ts workers/jobs/src/cron.test.ts src/lib/server/recurring/validation.test.ts src/lib/shared/recurring.test.ts` -> 5 files, 75 tests passed.
- Temporary probe `test/integration/zz-rt-probe.test.ts` (type/schedule tampering, cross-space ids, D1 call count) -> 3 passed; file deleted.
- Not run (RAM limit): `npm run gates`, `npm test`, Playwright.

## Re-check (cycle 2)

Scope: `git diff 6ad58bc..9d96dc7` (cycle 2 `fd0d49f` and the QA report), only M1, L1 and L2.

**Final verdict: PASS.** M1, L1 and L2 are fixed. One new low finding (L3).

### M1: fixed

- `RECURRING_STATEMENTS_PER_INVOCATION = 300` is shared by every `recurring_check` of one invocation
  (`workers/jobs/src/index.ts:39`, `src/lib/server/recurring/repo.ts:466`). Each call takes its worst case
  (`batchCost = 3 + 3n`) before it runs, and instances go 20 per `db.batch`. `handleBatch` now runs recurring
  messages after every other message (`workers/jobs/src/queue.ts:66`). Leftover work is acked and continued in
  one fresh message with the same date, so it never counts toward the DLQ.
- Probes (temporary `test/integration/zz-rt2-probe.test.ts`, local D1, a counting wrapper that throws past
  1,000 statements; deleted afterwards):
  - P1: 9 spaces with 100 due series each, after a job that used 700 statements: 995 statements in total,
    10/10 messages acked, 8 follow-ups.
  - P2: 8 spaces with 100 series each, every message sent 3 times (duplicate ticks), 3 consumers run at the same
    time, follow-ups fed back in. It finished in 3 rounds and 53 messages. Every invocation stayed at 1,000
    statements or fewer and nothing was retried. Each series has exactly one instance for the date and nothing
    is left due.
  - P3: 10 weekly series with a year-long backlog (53 runs each), continued by follow-up messages. It finished in
    6 invocations with 530 rows and 530 distinct dedupe keys (no duplicates, nothing lost).
- Follow-up storm: each message makes at most one follow-up. Messages that find the budget spent cost 0 D1 calls.
  Redundant messages cost 1 select. Creating a series never backfills, so an attacker can only cause one day's
  worth of work per series. `refs`/`member`-flagged series cost 1 select per space. A space at the transaction
  cap costs 1 select, plus 1 batch the first time it is flagged.
- Other job types can no longer fail because of recurring work, since they all run before it in the batch.

### L3 (low, new): the recurring budget does not subtract what earlier jobs in the batch used

- `src/lib/server/recurring/repo.ts:466-477`, `workers/jobs/src/index.ts:39`. The 300 statements are fixed and
  do not shrink when the batch's other jobs already used more than 700. P1b: the other jobs used 750, then 3 heavy
  recurring messages ran. The cap was hit at statement 1,002. The `send_push` job was still acked, and only the 2
  recurring messages left in the batch were retried. They go to the DLQ after 3 tries. No instance is lost,
  because the hourly cron sends them again. Suggested fix: start the recurring budget at
  `1000 - statementsAlreadyUsed - margin`, or count every D1 call in the invocation.

### L1: fixed

- The cron sends `recurring_check` with `date = plan.today` (`workers/jobs/src/cron.ts:152`). The zod schema
  requires a real date. `handleBatch` lowers any date after the processing WIB date to that date
  (`queue.ts:93-94`), so the date can never move forward. Only the jobs Worker sends to the queue; no client
  can reach it. An earlier date only creates fewer rows. Covered by `queue.test.ts` (date in the past, date in
  the future lowered, date missing or impossible) and by the integration test for an earlier date.

### L2: fixed

- `migrations/0023_recurring.sql:51` now reads `ADD … REFERENCES recurring_transactions(id) ON DELETE set null`.
  SQLite allows this in `ADD COLUMN` when the default is NULL, so the table is not rebuilt. The Drizzle schema
  and the snapshot match. Migration 0023 is not on `main` and has not been deployed, so editing it breaks no rule.
  The L2 integration test hard-deletes a series on local D1 with foreign keys enforced: the transaction stays
  and its link becomes null.

### Commands (cycle 2)

- `npx vitest run --maxWorkers=2 test/integration/recurring.test.ts workers/jobs/src/queue.test.ts workers/jobs/src/cron.test.ts src/lib/shared/recurring.test.ts src/lib/server/recurring/validation.test.ts`: 5 files, 85 tests passed.
- Temporary probe `test/integration/zz-rt2-probe.test.ts`: 3 passed (P1/P1b, P2, P3). The file is deleted.
- Not run (RAM limit): `npm run gates`, `npm test`, Playwright.
