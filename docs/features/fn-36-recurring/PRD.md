# FN-36 Recurring transactions — PRD

Catalog entry: `docs/FEATURES.md` › FN-36 (Phase 1b, owner request 2026-10-08, `docs/design/APP_PARITY.md` § 3
"Transaksi" filter chips and § 4). Tracker: `docs/TASKS.md` › App layout parity › "New features seen in the
reference app (PRDs first): FN-34 streak / close the day, FN-35 money-flow chart, recurring transactions, balance
adjustment type." This PRD closes the "recurring transactions" slice of that line. Risk tier: **Large** (new
table, a new `workers/jobs` cron+Queues path that writes real ledger rows unattended, idempotency across repeated
Cron Triggers and queue redelivery, a new filter on Riwayat's existing query shape).

## Goal

Rent, salary, a subscription paid by hand instead of auto-debit, a weekly allowance: plenty of real money never
touches Gmail or a receipt and still happens on a predictable schedule. Today the user must remember and retype
every one of these every period. FN-36 lets them describe the schedule once; `workers/jobs` creates the due
transaction on time, every time, exactly once, so these rows join the ledger the same way a manual entry would —
editable, deletable, and counted in every total — while the series itself stays visible and controllable
(paused, stopped, or changed) from Transaksi.

## Scope

- **Migration (assign `0020`, or the next free number after FN-34/FN-37 at merge — renumber per `CLAUDE.md` ›
  Data access › "Migrations"):**
  - `recurring_transactions` table: `id`, `space_id` (FK `spaces`, cascade), `type` (`expense`|`income`,
    **transfer excluded this pass** — see Out of scope), `amount_minor`, `currency`, `category_id`, `wallet_id`,
    `title`, `note`, `frequency` (`monthly`|`weekly`), `interval_day` (day-of-month 1–31 for `monthly`, ISO
    weekday 1–7 for `weekly`), `start_on` (WIB date), `end_on` (WIB date, nullable — open-ended when null),
    `next_run_on` (WIB date, the next instance still to create), `status` (`active`|`paused`|`stopped`),
    `created_by_user_id`, `created_at`, `updated_at`, `deleted_at`, `seq` — the full FN-05-style row (space-scoped,
    sync-ready, tombstoned on delete) since a recurring rule is user data like a budget or a goal.
  - `transactions.recurring_series_id` (nullable FK → `recurring_transactions.id`), indexed
    `(space_id, recurring_series_id)`. **Do not reuse or repurpose `transactions.recurrence`**
    (`migrations/0010_csv_import.sql:26`) — that column is free text copied from a CSV/Money Manager import
    (FN-18) and carries no scheduling meaning; this feature adds its own column precisely so the two are never
    confused.
  - CHECK constraints mirroring `categories_kind_check`/`transactions_type_check` style: `frequency` and `status`
    enums; `interval_day` bounded per `frequency` (1–31 monthly, 1–7 weekly); a live row always has `next_run_on`
    and the wallet/category ids `transactions_content_check` already requires of a live transaction.
- **`src/lib/server/recurring/`** (new):
  - `validation.ts` — zod schema for the create/edit-series form: `type`, `amountDigits` (same whole-unit input
    as the compose form, `src/lib/server/transactions/validation.ts:63-67`), `walletId`, `categoryId`,
    `title`/`note` (same length caps, `src/lib/shared/transactions.ts:39-40`), `frequency`, `interval_day`,
    `start_on`, `end_on`.
  - `repo.ts` — `createSeries`, `updateSeries` (edits the template; only affects instances created after the
    edit, never rewrites a past instance), `pauseSeries`, `stopSeries`, `listSeries(db, spaceId)`,
    `seriesDueBefore(db, limit, afterId)` (keyset page for the cron walk, bounded like
    `spacesWithSubscriptions` in `src/lib/server/subscriptions/repo.ts`), and `createDueInstance(db, scope,
    seriesId, runOn, now)` — builds one `NewTransaction` (`src/lib/server/transactions/repo.ts:165-172`) with
    `source: 'manual'` (a recurring instance is the user's own standing instruction, not an external capture —
    see Architecture notes) and `dedupeKey: `recurring:${seriesId}:${runOn}``, then calls the existing
    `insertTransactions` (`src/lib/server/transactions/repo.ts:181-238`) with a `guard` clause checking
    `NOT EXISTS` a transaction of that `(space_id, source, dedupe_key)` already — the same unique index
    (`transactions_dedupe_uq`) that every other capture path relies on for idempotency, never a new mechanism.
  - `schedule.ts` — `nextRunOn(series, afterDate)`: mirrors the day-of-month clamping
    `effectiveNextCharge`/`BillingCycle` already solve for subscriptions (`src/lib/shared/subscriptions.ts`,
    used by `src/lib/server/subscriptions/reminders.ts:56-60`) — reuse that module's date-rolling approach for
    `monthly` (clamp to the last day of a short month) and add the `weekly` case, rather than inventing new date
    math.
- **`workers/jobs`:** a new Cron tick kind `recurring_check`, enqueued through the existing `walk` cursor
  helper in `workers/jobs/src/cron.ts` (same shape as `budget_check`/`bill_check`, `CURSOR_KEYS` gains
  `recurring_check: 'cron:recurring_check'`), and a new queue job type `recurring_check` in
  `src/lib/shared/jobs.ts`'s `JobMessage` union, handled in `workers/jobs/src/queue.ts` by calling
  `createDueInstance` for every series of that space whose `next_run_on <= today` (WIB), then advancing
  `next_run_on` via `nextRunOn` — both the instance insert and the cursor advance happen as one `db.batch`, so a
  retried message never creates a second instance for the same `(series, date)` even though the guard clause
  already makes the insert itself safe twice over. Runs on the existing hourly 06–23 WIB schedule
  (`JOBS_CRON`, `workers/jobs/src/cron.ts:6`) — no new Cron Trigger, no new Queue binding (reuses `JOBS_QUEUE` /
  `montra-jobs`, `workers/jobs/wrangler.jsonc:21-28`).
- **Transaksi (`/riwayat`):** an "aktif berulang" filter chip (`docs/design/APP_PARITY.md` § 3) — extends
  `RiwayatView`/`TransactionFilter` (`src/lib/shared/riwayat-query.ts:16`, `src/lib/server/transactions/aggregate.ts:20-31`)
  with `recurringOnly: boolean`, translated in `filterWhere` to `t.recurring_series_id in (select id from
  recurring_transactions where space_id = … and status = 'active' and deleted_at is null)`. Each generated row in
  the list carries a small recurring indicator (new badge, distinct from the existing "Tercatat" auto-capture
  badge) linking to its series.
- **Series management UI:** a new screen/sheet (e.g. `/riwayat/berulang`) listing a space's series with pause,
  stop and two edit paths: "Ubah transaksi ini" (opens the normal transaction edit on one generated instance,
  `src/routes/(app)/riwayat/[id]/edit/+page.server.ts`, unchanged) and "Ubah seri" (opens the series template
  form, `updateSeries`, affecting only instances created after saving). Loading/empty ("Belum ada transaksi
  berulang")/error/saving/success states per `CLAUDE.md`.
- **i18n:** every new label ("Tiap tanggal {n}", "Tiap minggu pada {hari}", "Aktif berulang", "Jeda", "Hentikan",
  "Ubah seri", "Ubah transaksi ini", pause/stop confirmations) through `tr()`/`trf()` with English entries.

## Out of scope

- Recurring **transfers** (only `expense`/`income` this pass — a recurring transfer needs the same
  `transfer_to_wallet_id` plumbing FN-05 already has, but adds no new reconciliation value yet and is deferred).
- Recurring **balance adjustments** (FN-37's type is excluded from recurrence entirely — an adjustment only makes
  sense computed against the wallet's balance at the moment it runs, which contradicts "the same amount every
  period").
- Any schedule beyond monthly-by-day-of-month and weekly-by-weekday (no "every N days," no "last weekday of the
  month," no custom cron expression).
- Catch-up creation of every instance missed while a series was paused/stopped and later reactivated — reactivating
  a paused series resumes from the next due date on or after today; it never backfills the gap (Owner decision
  below).
- Editing a single past instance's amount/date retroactively changing the series template, or vice versa — the
  two edit paths are deliberately separate and neither reaches into the other's rows.
- AI-suggested recurrence (e.g. detecting that three similar manual entries look like a pattern) — this pass is
  user-declared schedules only.
- A desktop/mobile calendar view of upcoming recurring bills (FN-26 already owns a billing calendar; this pass
  does not duplicate it for recurring transactions).

## Acceptance criteria

1. Given a user creates a monthly series for day 12 starting this month, when the next hourly `recurring_check`
   tick runs on or after day 12's 06:00 WIB, then exactly one new transaction exists with that series' amount,
   wallet, category and `occurred_on` = that WIB date, and `next_run_on` has advanced to next month's day 12.
2. Given the same series and a redelivered queue message (simulated retry) or a second cron tick before the
   cursor would naturally re-visit it, when both are processed, then exactly one transaction exists for that
   `(series, date)` — the dedupe key and the guarded insert hold under a concurrency test
   (`docs/ENGINEERING_CHECKLIST.md` › "Idempotent capture" and "Concurrent writes").
3. Given a series scheduled for day 31 and a month with 30 (or 28/29) days, when `nextRunOn` computes that
   month's instance, then it clamps to that month's last day — the same rule already proven for subscription
   billing days, not a second, divergent implementation.
4. Given a series the user pauses, when the next due date arrives, then no instance is created, and when the
   user later resumes it, then the next instance created is for the next due date on or after the resume date,
   never a backfilled instance for a date that passed while paused.
5. Given a series the user stops, when any later cron tick runs, then it is never visited again (same guarantee
   as a paused series, and it no longer counts toward "aktif berulang").
6. Given a user opens Transaksi and selects "Aktif berulang," when the list renders, then it shows only
   transactions whose series is still `active`, and the header total for that filter equals the sum of exactly
   those rows (same reconciliation rule as every other Riwayat filter).
7. Given a generated instance, when the user opens "Ubah transaksi ini" and changes its amount, then only that
   one transaction changes; the series' template and every other instance are unaffected.
8. Given a series, when the user opens "Ubah seri" and changes the amount, then the series template updates and
   the next instance created uses the new amount; every already-created instance keeps its original amount.
9. Given a series whose wallet is archived or whose category is hidden/deleted between creation and a due date,
   when `recurring_check` tries to create that instance, then it is refused the same way a manual form submission
   would be (the existing `refsHold` check inside `insertTransactions`) and the series is flagged (e.g. surfaced
   in the series list as "Perlu perhatian") rather than silently skipped forever or crashing the tick.
10. Given a request to create, edit, pause, stop or list a series, or to generate an instance, when it is
    handled, then every one goes through `requireSpaceAccess`/`isLiveMember` for that series' `space_id` — no
    route or job handler trusts a `space_id` read from the request or the stored row without that check
    (`docs/ENGINEERING_CHECKLIST.md` › "One access rule" and "One validator").
11. Given `occurred_on` computation at the WIB month/week boundary, when a series is due at 23:30 WIB on the
    last day of a month or 00:30 WIB on the first, then the created instance's WIB date is correct, tested at
    both instants (`docs/ENGINEERING_CHECKLIST.md` › "WIB dates").
12. Given the UI language is English, when series creation, pause/stop, edit-series/edit-one and the "aktif
    berulang" chip render, then every phrase has an English entry.
13. Given 360 px width, when the series list, the pause/stop controls and the edit-series form render, then
    every touch target is ≥ 44 px and there is no horizontal scroll.
14. Given a space at `MAX_TRANSACTIONS_PER_SPACE`, when `recurring_check` tries to create a due instance, then it
    is refused the same `limit` reason an over-cap manual save gets (`src/lib/server/transactions/repo.ts:258-263`),
    never a crash, and the series is left due for the next tick rather than silently losing that instance.

## Architecture notes

- Touches: new migration (table `recurring_transactions`, column `transactions.recurring_series_id`);
  `src/lib/server/db/schema.ts`; `src/lib/server/recurring/{validation,repo,schedule}.ts` (new);
  `src/lib/server/transactions/repo.ts` (reused unchanged — `insertTransactions`'s existing `guard` parameter is
  exactly what this feature needs, no change to that function's signature); `src/lib/server/transactions/aggregate.ts`
  (`TransactionFilter` gains `recurringOnly`, `filterWhere` gains the one new clause); `src/lib/shared/riwayat-query.ts`
  (`RiwayatView` gains the chip's query param); `src/lib/shared/jobs.ts` (`JobMessage` union gains
  `recurring_check`); `workers/jobs/src/cron.ts` (`CURSOR_KEYS`, one more `walk` call) and
  `workers/jobs/src/queue.ts` (`JobDeps` gains the handler); a new route for series management; i18n files.
- Reuses: `src/lib/shared/subscriptions.ts`'s billing-cycle date math (study before writing `schedule.ts`'s
  monthly case — do not re-derive day-of-month clamping); `src/lib/server/subscriptions/repo.ts`'s keyset-page
  pattern for `seriesDueBefore`; `workers/jobs/src/cron.ts`'s `walk` helper (do not write a second cursor
  mechanism); `transactions_dedupe_uq` (`migrations/0004_transactions_categories.sql:52`) for idempotency —
  no new uniqueness mechanism.
- Explicitly does not touch: `transactions.recurrence` (FN-18's free-text column stays exactly as it is).

## Prerequisites

None beyond what is already provisioned: `workers/jobs`' `JOBS_QUEUE`/`montra-jobs` Queue and the hourly Cron
Trigger already exist (FN-24). No new secret, provider or credential.

## Owner decisions

- **A — Transfer and adjustment recurrence.** Default: **excluded this pass** (see Out of scope). Trade-off: a
  user cannot set up a recurring "move Rp500rb to savings every payday" yet; adding it later only needs
  `transfer_to_wallet_id` plumbing already proven in FN-05, so it is a small follow-up, not a redesign.
- **B — Missed instances while paused/stopped-then-reactivated.** Default: **never backfilled** — resuming jumps
  to the next due date on or after today. Trade-off: a user who pauses for two months and resumes does not get
  two months of instances created retroactively (which could also silently misstate past spending); the
  alternative (catch-up creation) risks a burst of backdated transactions the user did not expect and complicates
  the idempotency story (which `runOn` dates count as "due" after a long pause).
- **C — Source tag on generated instances.** Default: `source: 'manual'` (the schedule is the user's own
  instruction, not an external capture) with the dedupe key carrying the series id, rather than adding a new
  value to `TRANSACTION_SOURCES` (`src/lib/shared/transactions.ts:16-26`, which `CLAUDE.md` itself fixes as
  "manual, gmail, voice, receipt, statement, spreadsheet, csv, slack"). Trade-off: a generated instance looks
  identical to a hand-typed one in the source column; the new recurring badge in Transaksi (driven by
  `recurring_series_id` being non-null, not by `source`) is what actually distinguishes it, so nothing is lost,
  but a future "capture accuracy by source" report would not separately bucket recurring instances without also
  checking `recurring_series_id`.
- **D — Frequency set.** Default: `monthly` (day-of-month) and `weekly` (weekday) only, matching the two
  concrete examples in the brief ("schedule, next date") and in `docs/design/APP_PARITY.md`. Trade-off: no daily
  or custom-interval recurrence this pass; the schema's `frequency` enum and `interval_day` column are written so
  adding a third value later is additive, not a breaking change.

## Tracker impact

Closes the "recurring transactions" slice of `docs/TASKS.md` › App layout parity › "New features seen in the
reference app (PRDs first): FN-34 streak / close the day, FN-35 money-flow chart, recurring transactions, balance
adjustment type." No existing `docs/ACCEPTANCE.md` row names this feature; on completion it earns new rows under
"Money and dates" (WIB month/week boundary creation, Beranda/Riwayat totals still reconcile with recurring rows
included) and strengthens the existing "Space isolation on every load, action and sync push/pull" row by adding
the series routes and the jobs handler to what is crawled.
