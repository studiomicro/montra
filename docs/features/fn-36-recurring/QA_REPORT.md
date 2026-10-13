# FN-36 Recurring transactions — QA report (cycle 1)

## Verdict: PASS

All 14 acceptance criteria verified with evidence (existing engineer tests re-run plus QA's own migration
population and e2e re-runs). `npm run gates`-equivalent steps (run separately per the RAM rule) are all clean.
Note: the existing `SECURITY_REPORT.md` for this feature (same cycle) records its own verdict **FAIL** (one
medium finding, M1: per-invocation D1 call budget across a `recurring_check` queue batch) — that is a separate
agent's report and is not overridden by this one; it should still gate shipping. QA's own criteria (functional
correctness, space isolation, idempotency, WIB dates, totals, i18n, 360 px, no-JS) all PASS.

## Commands run

- `cd .claude/worktrees/fn-36-recurring && flock /tmp/montra-heavy.lock npm run check` — svelte-check 1518 files 0 errors 0 warnings; tsc worker configs clean; exit 0; local toolchain, no provider.
- `flock ... npm run lint` — Prettier clean, ESLint clean; exit 0; local toolchain.
- `flock ... npx vitest run --maxWorkers=2` — 170 files, 2419 tests passed; exit 0; local D1/miniflare, no real provider.
- `flock ... npm run build` — vite build + service worker + Cloudflare adapter bundling done; exit 0; local toolchain.
- `FIN_PERSIST_TO=<scratchpad> flock ... npm run db:migrate:local` — fresh DB, migrations 0000–0023 all ✅; exit 0; local D1 (miniflare sqlite), no real provider.
- QA-built populated-at-0022 DB (scratch wrangler config pointing `migrations_dir` at a copy of migrations 0000–0022; migrations/ in the worktree untouched) via `wrangler d1 migrations apply` then a custom richer seed (`wrangler d1 execute --file=seed-0022.sql`) — 2 users, 1 shared space (owner+member), 2 wallets, 3 categories (incl. hidden), 6 transactions covering expense/income/transfer/adjustment/CSV-import-with-legacy-`recurrence`/tombstone, a draft linked to a saved transaction, a subscription linked to a transaction, a space budget, a category budget, a day closure — exit 0; local D1, no real provider.
- `FIN_PERSIST_TO=<scratchpad> flock ... npm run db:migrate:local` (against that populated DB) — only `0023_recurring.sql` applied ✅; exit 0; local D1, no real provider.
- Post-migration verification queries (`wrangler d1 execute`, local, read-only): row counts, `sum(seq)`, `sum(amount_minor)` identical before/after; `PRAGMA foreign_key_check` empty; `t_csv1.recurrence = 'Bulanan'` and `recurring_series_id` null (FN-18 column untouched); drafts/subscriptions/budgets/category_budgets/day_closures counts unchanged (1 each); `recurring_transactions` empty (new table, no rows) — all as expected; local D1, no real provider.
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=8821 flock ... npx playwright test --workers=1 e2e/berulang.spec.ts e2e/riwayat.spec.ts e2e/parity-d.spec.ts e2e/shell.spec.ts e2e/beranda.spec.ts` — 65 passed, 2 skipped (phone-only 360 px checks correctly skipped on the desktop project), exit 0; local `wrangler dev` (3 Workers) + local D1, no real provider.
- `git status --short` in the worktree before and after all QA work — clean except the pre-existing untracked `SECURITY_REPORT.md`; migrations/ and all source untouched by QA.

## Checked criteria

1. Monthly day-12 series creates exactly one transaction on/after day 12, `next_run_on` advances to next month — PASS (`recurring.test.ts › AC1`, both tests; re-run clean).
2. Redelivery/overlap/20-concurrent-ticks → exactly one instance per `(series, date)` — PASS (`› idempotency`, 3 tests incl. stale-read `changed`).
3. Day 31 clamps to 30 Nov / 28 Feb / back to 31; 29/30 leap vs common year — PASS (`recurring.test.ts`, `src/lib/shared/recurring.test.ts`; unit test asserts equality with `nextChargeOn`, no divergent date math).
4. Paused series creates nothing; resume jumps to next due date on/after resume, no backfill — PASS (`› pause, resume, stop`).
5. Stopped series never revisited by `spacesWithDueSeries`/`runDueSeries`, excluded from "aktif berulang" — PASS (same describe block).
6. "Aktif berulang" chip lists only active-series rows; header total equals sum of exactly those rows — PASS (`› Transaksi "Aktif berulang"`, drives the real `/riwayat` `load()` function, confirms count/sum plus that a manual same-day/category row is excluded).
7. "Ubah transaksi ini" changes only that row — PASS (`› edit one instance vs edit the series`).
8. "Ubah seri" changes the template; only later instances use the new amount — PASS (same test).
9. Archived wallet / hidden category → refused like a form submission, flagged `refs`, not silently skipped/crashed, cleared by editing — PASS (`› refused instances are flagged`, 2 tests + MAX_TRANSACTIONS_PER_SPACE `limit` case retried every tick).
10. Every create/edit/pause/stop/list/instance-generation path goes through `requireSpaceAccess`/`isLiveMember`; non-member and removed member get 404 on load and every action (own and forged space); cron flags `member` — PASS (`› the series pages`, cross-space + removed-member test; confirmed by reading `currentSpaceScope` → `requireSpaceAccess` and every repo write's `writable()`/`isLiveMember` guard).
11. WIB boundary: 23:30 WIB last day of month → that day; 00:30 WIB first of next month (UTC still previous day) → next day — PASS (`recurring.test.ts › month ends and WIB boundaries`, explicit `Date.parse` UTC instants converted via `wibTodayString`).
12. English entries for every new phrase (series creation, pause/stop, edit-series/edit-one, "aktif berulang" chip) — PASS (spot-checked ~17 keys in `i18n-en.ts`; `test/i18n-coverage.test.ts` ran clean as part of the 2419-test vitest run, which fails the build if any Indonesian phrase lacks an English entry).
13. 360 px: series list, pause/stop, edit-series form — every touch target ≥44 px, no horizontal scroll — PASS (`e2e/berulang.spec.ts`, re-run: 7 passed on both phone 360 px and desktop, light+dark; `expectTargets`/`expectNoHorizontalScroll` assertions).
14. At `MAX_TRANSACTIONS_PER_SPACE`, `recurring_check` is refused with `limit`, never crashes, series stays due and retried, succeeds once room is made — PASS (`› refused instances are flagged`, `› MAX` case).

Also verified beyond the checklist: CSV export/re-import drops the series link and `recurrence` stays plain-CSV
(`› CSV round trip`); account deletion purges series and their transactions in FK-safe order (`spaces.ts`
`SPACE_SCOPED_TABLES`: `transactions` before `recurringTransactions`, which is itself before `categories`/
`wallets`) and is covered by an integration test; export decision table carries `recurring_transactions` as
`json`, omitting `created_by_user_id`.

## Engineering checklist cross-check

- Idempotent capture, concurrent writes, bounded work, tombstones, WIB dates, totals reconcile, one access
  rule, stale forms, i18n, touch targets, no-JS forms, truthful state — all followed per the engineer's own
  itemisation, independently re-verified above.
- **Exception already on record**: `SECURITY_REPORT.md` M1 — `runDueSeries`'s ~2-3 D1 calls per attempt ×
  `MAX_INSTANCES_PER_RUN=100` means one heavy `recurring_check` message can make ~200 D1 calls; with
  `max_batch_size: 10` in the jobs consumer, one batch can approach or exceed D1's per-invocation query cap,
  risking other tenants' messages in the same batch (including unrelated `budget_check`/`bill_check`/`send_push`)
  being retried into the DLQ. This is a "bounded work" checklist concern at the *batch* level, not caught by the
  per-message row cap alone. QA defers to the security report's verdict on this point rather than re-litigating
  it; it is not one of the 14 PRD acceptance criteria and does not block this QA pass, but should block shipping
  until resolved per the pipeline's own rule that a FAIL security report gates `/ship`.

## Findings

None that fail an acceptance criterion or a gate. For completeness, carrying forward from `SECURITY_REPORT.md`
(not re-verified independently by QA, cited for the tracker):

1. (Medium, security) Per-invocation D1 call budget of a `recurring_check` queue batch is unbounded across
   messages — see above. Scenario: a user with many shared spaces, each at `MAX_SERIES_PER_SPACE` on the same
   due day, causes one jobs-consumer batch to make thousands of D1 calls, risking other tenants' queue messages
   in the same batch landing in the DLQ. Expected: bounded D1 work per Worker invocation, not just per message.
   Actual: only per-message bound (`MAX_INSTANCES_PER_RUN = 100`) exists today.
2. (Low, security, informational) The queue handler uses processing-time WIB date rather than the tick's date;
   no duplication or cross-space effect, noted for predictability only.
3. (Low, security, informational) `transactions.recurring_series_id` FK has no `ON DELETE` action; today's only
   hard-delete path (`purgeSpaces`) already orders around it correctly and is tested, but a future hard-delete
   path must keep that order.

None of 1–3 were independently re-verified by QA (restated from the existing `SECURITY_REPORT.md` for the
tracker's benefit); QA's own functional/criteria verification above stands on its own evidence.
