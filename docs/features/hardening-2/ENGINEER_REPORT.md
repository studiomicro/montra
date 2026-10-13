# Hardening batch 2 — engineer report

Branch `hardening-2` (worktree `.claude/worktrees/hardening-2`), from main `d5f52ec`. One commit per item, no push,
no tracker edits. Fail-before runs were made by putting the unfixed source back (`git show HEAD:<file>`) with the
new tests in place, then restoring the fix.

## 1. Invite tokens out of Workers request logs (FN-03 red team L3): done — `952ab30`, `9517572`

- Files: `wrangler.jsonc` (app Worker, top level and `env.staging`: `observability.logs.invocation_logs: false`;
  invocation logs record every full URL), `src/hooks.server.ts` (the old handle is `handleRequest`; the exported
  `handle` logs one `request` line: method, `route.id` or, when no route matched, `redactedPath(url)`, status, ms;
  never the query string; skipped while prerendering), `src/lib/server/spaces/invites.ts` (`redactedPath`: masks
  `/ruang/undangan/<token>` also when percent-encoded, drops the query, so `next=` never reaches a log),
  `docs/RUNBOOK.md` (Logs note). Jobs and inbound Workers never see invite URLs; unchanged.
- Tests: `test/request-log.test.ts` (redaction vectors, config of both blocks);
  `test/integration/ruang-routes.test.ts` "L3: the request log line never carries the invite token" (signed in,
  signed out redirect, `/masuk?next=`, unmatched path).
- Fail-before: 3 failed (both unit tests, the hook test).
- Residual: `wrangler tail` streams live URLs (keeps nothing).

## 2. Account deletion purge list chosen inside the batch (FN-03 N1): done — `0989c5b`, `9400f6a`

- Files: `src/lib/server/auth/delete-account.ts` (no pre-batch read; the batch first marks the last-member spaces
  `deleted_at = now`, guarded on the password proof, then purges the marked ones; the batch is one D1 transaction,
  so nobody sees the mark), `src/lib/server/spaces/spaces.ts` (`purgeSpaces` takes the space-id set as a SQL
  subquery), five integration tests updated to the new signature.
- Tests: `test/integration/delete-account.test.ts` "N1: a space created after deletion began and before its batch
  is deleted too" (a `db` proxy creates a shared space right before `batch`; asserts it, its audit row and the
  personal space are gone and no memberless space exists) and "marks nothing as deleted when the proof no longer
  holds".
- Fail-before: the N1 test failed (`expected 1 to be +0`: the raced space survived).

## 3. Per-user rate limit on transaction creation (FN-05 red team L2): done — `84059c6`

- Files: `src/lib/server/transactions/create-limit.ts` (`TRANSACTION_CREATES_MAX = 300` creating actions per user
  per 10-minute window, scope `transaction-create` in `auth/throttle.ts`, fails closed; `retryAfterSeconds` shared),
  `transactions/messages.ts` + `i18n-en.ts` (new message), routes `riwayat/baru` (create, adjust: 429, values
  kept), `riwayat/suara` (save counts once however many rows, `catatLagi`), `impor` (one per import, not per row),
  `sync/push.ts` + `api/v1/sync/push` (creating kinds `transaction.create`, `voice.save`, `voice.recordAgain`: 429
  with Retry-After; the device keeps the item; edits and deletes are not counted). Recurring/subscription rows from
  the jobs Worker and saved capture drafts are not counted (not user-sent creates).
- Tests: `test/integration/transaction-rate-limit.test.ts`: every path at the limit answers 429 with the message and
  writes nothing; a 3-row voice save and a 4-row import count once each; another user is not limited; 20 concurrent
  creates with 5 left write exactly 5.
- Fail-before: 3 of 4 failed (the cross-user test passes either way).
- i18n key: `Terlalu banyak transaksi baru dalam beberapa menit terakhir. Tunggu sebentar, lalu coba lagi.`

## 4. `day_closures.closed_on` format (FN-34): done — `19489fb`

- Files: `migrations/0024_day_closures_format.sql` (BEFORE INSERT and BEFORE UPDATE OF `closed_on` triggers,
  `RAISE(ABORT)` when `date(closed_on) IS NOT closed_on`; no table rebuild; `IF NOT EXISTS`), drizzle journal and
  snapshot 0024 (schema unchanged), schema comment.
- Tests: `test/integration/streak.test.ts` "migration 0024": `2026-10-8`, `2026-02-30`, `2026-13-01`,
  `2026-10-08 00:00`, `08/10/2026`, `20261008`, empty and text refused; update to `2026-10-08T00:00` refused.
- Fail-before: both tests failed with 0024 removed.

## 5. Net-worth snapshot capacity (FN-25 red team L4): done — `562ab73`

- Files: `src/lib/server/net-worth/summary.ts` (`writeSnapshots(db, book, now, statementsLeft)` pages due spaces
  while `statementsLeft()` allows `SNAPSHOT_SPACE_STATEMENTS = 5` per space plus the page query and cursor write;
  same cursor and wrap rule as before, skipped/failed spaces never hold a slot; `nextSnapshotBatch` removed),
  `src/lib/server/db/statement-count.ts` (`D1_STATEMENTS_PER_INVOCATION = 1_000` moved here from recurring),
  `workers/jobs/src/index.ts` (scheduled handler counts statements with `countStatements`),
  `workers/jobs/src/net-worth.ts` (budget = cap − statements used so far).
- Capacity: about 190 spaces per tick (cap minus the cron's own work) × 18 ticks ≈ 3,400 spaces per WIB day
  instead of 1,800. Next step beyond that: queue fan-out.
- Tests: `test/integration/net-worth-scale.test.ts` (one space ≤ 5 statements, measured; 2,000 spaces all reached
  within the 18 ticks of one WIB day with 100 statements reserved for other work, every tick ≤ 900 statements;
  nothing touched without room); `net-worth.test.ts` ticks now counted the same way.
- Fail-before: 2 failed (`expected 1799 to be 2000`; the no-room run wrote 100).

## 6. e2e `waitForHydration` (FN-00 review): done — `5b21972`, `64fc48c`

- Files: `src/routes/+layout.svelte` (root `onMount` sets `data-hydrated` on `<html>`; children mount first),
  `e2e/helpers.ts` (waits for `html[data-hydrated]`; `TX_PAGE`, `SERIES_PAGE` URL patterns), `e2e/shell.spec.ts`
  (SSR HTML lacks the mark, hydrated page has it, a tab link right after the wait is a client-side navigation).
  The mark stays set across client-side navigations (the root layout persists; marking them from
  `beforeNavigate` was tried and is racy, since SvelteKit runs it after an await), so the four specs that clicked
  into a page and then called the helper now wait for the destination URL first (`offline-queue`, `riwayat`,
  `berulang` ×2). `networkidle` had been covering that wait by accident.
- Fail-before: with the old layout the helper never resolves (the auth setup project failed: `locator.waitFor: Test
ended`). The first full run with the new helper failed `offline-queue.spec.ts:105` on both projects (the
  click-then-wait race above); fixed in `64fc48c`.

## Skipped

- FN-30 refund flow and re-claimed starter credits/vouchers: needs the real payment provider (owner decision).
- Not in scope: `__fn37_links` in 0022 (applied migration, never edited), FN-02 iOS Web Locks (needs a device),
  FN-02 resent delete wording.

## Checklist items applied

- Concurrent writes: rate-limit counter is one guarded UPDATE … RETURNING / upsert (20-concurrent test); the
  deletion's choice of spaces is inside the one `db.batch` (race test).
- Bounded work / 100 parameters: purge set and seeds bound as subqueries/JSON; snapshot pages bounded by the D1
  statement budget.
- Migrations: new numbered 0024, re-runnable (`IF NOT EXISTS`), no applied migration edited.
- Access: sync push checks space access before counting; error copy has no ids.
- i18n: the one new phrase has an English entry (i18n coverage test green).
- Fail-before proof: listed per item.

## Pre-handoff probes

- Concurrency: 20 concurrent creates with 5 left in the budget → exactly 5 rows, 15 × 429.
- Cross-space: sync push answers `no-access` before any count; the creation budget is per user, not per space.
- Month boundaries: snapshot ticks use the WIB day (06:00–23:00 WIB ticks of 9 Oct 2026 → date `2026-10-09`).
- No-JS forms: the 429 refusals are plain `fail()` data rendered by the existing error banners (same path as 409).
- User copy: the new message names no path or identifier.
- Not applicable: money vectors, two devices, 360 px (no layout change), two tabs.

## Gates (each step alone under `flock /tmp/montra-heavy.lock`)

- `npm run check`: `COMPLETED 1553 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` (plus the three worker/service
  worker `tsc` runs, exit 0).
- `npm run lint`: `All matched files use Prettier code style!`, eslint clean (exit 0).
- `npx vitest run --maxWorkers=2`: `Test Files 183 passed (183)`, `Tests 2573 passed (2573)`.
- `npm run build`: `✔ done` (exit 0).
- Fresh `npm run db:migrate:local` (`FIN_PERSIST_TO` = an empty scratch directory): 0000–0024 all ✅, exit 0.
- Playwright `--workers=1`, full suite after item 6 (second run, after `64fc48c`): `339 passed`, `24 skipped`,
  `2 failed`: `security.spec.ts:17` "health reports the database" on both projects, which expects version `0.0.1`
  while `wrangler.jsonc` has had `APP_VERSION 0.1.0` since `cbee668` (pre-existing on main, not touched here).
  Touched specs (`shell`, `offline-queue`, `riwayat`, `berulang`) alone: `69 passed`.
- `npm run clean:tmp` run at the end; no dev server left running. The e2e runs rewrite
  `docs/features/fn-35-money-flow/shots/*.png`; those were restored, not committed.
