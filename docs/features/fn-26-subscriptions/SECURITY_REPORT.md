# FN-26 Subscriptions (Langganan): security report

Reviewer: red-team-pentester. Scope: `git diff fa58797..623b0a2` (narrow review, Medium tier). Code under review:
623b0a2 (detached worktree). Checked against `docs/ENGINEERING_CHECKLIST.md`.

## Verdict: PASS

There are no critical, high or medium findings. Three low findings are listed below so they are tracked.

## What was checked and how

| Area | Result | Evidence |
|---|---|---|
| 0013 table rebuild: data preserved | OK | Scratch harness (`node:sqlite`, `PRAGMA foreign_keys = ON`, 0000–0012 applied, rows seeded in `notification_prefs` and `space_notifications` including a tombstone, then 0013 applied in one transaction): every row was byte-identical afterwards. `foreign_key_check` returned nothing and `integrity_check` returned ok. |
| 0013: constraints and indexes identical | OK | `sqlite_master` on the local D1 after `db:reset:local`: the CHECKs were rewritten to the final table names by the RENAME. `notification_prefs_user_kind_uq` and the 4 `space_notifications` indexes match 0012. The only difference is that `bill_reminder` was added to the two kind CHECKs. A bad kind and a tombstone with params are still refused. |
| 0013: no `PRAGMA foreign_keys` lines | Safe | No migration has `REFERENCES notification_prefs` or `REFERENCES space_notifications`, so the implicit DELETE that `DROP TABLE` runs with FK enforcement on (D1 always enforces) cascades into nothing. The tables' own outgoing FKs (users, spaces) are not affected when child rows are dropped. Space delete still cascades notifications after the rebuild (tested). |
| 0013: partial failure | Safe | The harness injected a failing statement after the `DROP`. The whole file rolled back (tables, data and the `__new_*` tables were all as before; `subscriptions` was not created). D1 runs each migration file in a transaction, so a failed remote apply leaves 0012's schema. |
| IDOR: load and all 4 actions | OK | `scopeOf` → `requireSpaceAccess` (`+page.server.ts:43-49`). Every read and write has `space_id = scope.spaceId`. Each write repeats `isLiveMember` inside its guarded statement (`repo.ts:276-283`, `:238`). Probe: user A forged `locals.space = B` → HttpError. A's own space with B's subscription id → 404, and B's row was unchanged. |
| markPaid: space, wallet and category | OK | The new expense goes through `capturedTransactionInput`, then `insertTransactions` (live member, `refsHold` for wallet/category in the space, cap) in one statement. Amount, currency and title come from the stored bill and are never taken from the form. A linked id must be a live, real expense of the space in the bill's currency (`repo.ts:376-378`). Foreign, income and other-currency ids all get the same 404. |
| markPaid replay and duplicates | OK | The insert is guarded on the subscription's `updated_at` (`repo.ts:445-455`), and the link and advance run in the same `db.batch`. Probe: 20 concurrent submissions of one form gave exactly 1 ok and +1 transaction. A sequential replay gets 409 (existing test). Paying again after a reload advances one more cycle (pay-ahead), which is the intended behaviour. |
| Catalogue | OK | `catalogueEntry` uses `Array.find` on our own data file, and categories use `Object.hasOwn`. `__proto__` and `constructor` → 400 (probe). User names go through `cleanText`, are capped at 60 code points and are rendered as text only (no `{@html}` in the diff). Push and in-app text also render as text. |
| Bill reminders | OK | `dueBillReminders` is limited to the space, skips `is_demo` rows and spaces that are deleted, and is capped at 100. `createIfAbsent` checks that the account is active, that the preference is not off and that the recipient is a live member, all inside the insert. The key `bill:<id>:<date>` dedupes repeated ticks and retried messages. The cron walk is limited by `MAX_PAGES_PER_TICK × SCHEDULE_PAGE_SIZE` and resumes from the stored `cron:bill_check` cursor, as in FN-24. Bills do not run in quiet hours (`tickPlan.bills = open`) and push skips quiet hours. The sweep tombstones the rows of removed members. |
| Demo rows | OK | No form path sets `is_demo`. It is hard-coded to `0` on create and is not in the update `.set`. Probe: an edit with `isDemo=0` kept `is_demo = 1`, and a create with `isDemo=1` stored 0. Demo rows cannot be paid (400) and are excluded from the totals, the walk and reminders. |
| Amount cap and other caps | OK | The amount must be 1 … `MAX_AMOUNT_MINOR` (10^13 + 1 → 400, probe). There is a DB CHECK `amount_minor > 0`. The 100-per-space cap is part of the guarded insert, and the existing test of 20 concurrent creates at 99 live rows gives exactly 1. |
| CSRF and body caps | OK | `readFormBody` caps the body at 8 KB with a timeout and returns 415 or 400, never 500 (tested). SvelteKit's default `checkOrigin` applies, because `vite.config.ts` sets no `csrf` override and the diff does not touch it. Not re-probed live: the machine was loaded, so there was no build and no wrangler dev. |
| Tombstones and purge | OK | The `subscriptions_content_check` CHECK forces every content column to be null on a tombstone (refused in the harness). `deleteSubscription` nulls all of them. `subscriptions` comes first in `SPACE_SCOPED_TABLES`, ahead of wallets and transactions (its FKs are NO ACTION). No code path hard-deletes transactions or wallets outside the space purge. |
| Secrets and logs | OK | The only new log line is `console.error('langganan: list failed', e.name)`, which carries no content. |

## Findings

### L1: A co-member can send a flood of bill-reminder pushes (low)

- Location: `src/lib/server/notifications/triggers.ts:154-180`, `src/lib/shared/subscriptions.ts:131` (key `bill:<subscriptionId>:<date>`), `src/lib/server/subscriptions/repo.ts:196` (create).
- Scenario: a member of a shared space creates 100 subscriptions that charge tomorrow. Each hourly tick from 06 to 23 WIB, they delete and recreate them, which gives new ids and therefore new keys. Every other member then gets up to 100 new `bill_reminder` rows and 100 Web Push messages per tick, and this can continue every day. The recipient's only remedy is to turn off "Tagihan langganan", which also hides real reminders.
- Fix: cap new `bill_reminder` rows per recipient and space per WIB day (for example 10), as a guarded count in `createIfAbsent`'s insert. Alternatively, collapse one tick's due bills for a space into a single notification.

### L2: A deleted subscription's name and amount stay in notifications for up to 90 days (low)

- Location: `src/lib/server/subscriptions/repo.ts:341-373` (delete), `src/lib/server/notifications/schedule.ts:84-85` (sweep after `NOTIFICATION_RETENTION_MS`).
- Scenario: a user deletes "Aplikasi X" and the subscription row becomes a content-free tombstone. However, every member's `bill_reminder` row still holds `params.name`, the amount and the date, and it stays listed until the 90-day sweep.
- Fix: in the `deleteSubscription` batch, tombstone the space's live `space_notifications` rows with `kind = 'bill_reminder'` and `data_key like 'bill:' || id || ':%'`. Set `params`/`read_at` to null and `deleted_at` to now. The row keeps its key, so dedupe still holds.

### L3: The RUNBOOK still says migrations are additive (low, docs)

- Location: `docs/RUNBOOK.md:133` ("migrations are additive").
- Scenario: 0013 is a copy, drop and rename rebuild. Rolling back code alone still works, because the new kind CHECK accepts more kinds than 0012's. However, an operator who relies on "additive" might hand-edit or partially re-run the rebuild instead of using the Time Travel bookmark.
- Fix: change the line to say that 0013 rebuilds two tables and that the rollback is the Time Travel restore.

## Checklist notes

- Concurrent writes (cap and markPaid) use guarded single statements in `db.batch` and have concurrent tests.
- Bounded work: every query is limited (100 subscriptions, 30 payable expenses, cron pages).
- The demo seed builds SQL by string interpolation, but only from constants in the script and only locally (`seed-local.ts`). It takes no user input.

## Commands run

- `npm ci` → exit 0. `npx svelte-kit sync` → exit 0. `npm run db:reset:local` → exit 0 (0000–0013 applied, seed ran).
- `npx vitest run --maxWorkers=2 test/integration/langganan.test.ts test/integration/notifications.test.ts src/lib/server/subscriptions src/lib/shared/subscriptions.test.ts src/lib/shared/notifications.test.ts workers/jobs/src scripts/demo-seed.test.ts` → 8 files, 204 passed.
- Scratch probe `test/integration/zz-secprobe.test.ts` (deleted after the run): concurrent markPaid replay, forged space and foreign id, demo flag via form, `__proto__` catalogue, amount cap → 3 tests passed.
- Scratch migration harness (`node:sqlite`, outside the repo): data preserved, injected failure rolled back, FK and integrity checks clean, CHECKs enforced.
- `wrangler d1 execute DB --local` schema dump → constraints and indexes as listed above.
- Not run: the full Playwright suite and a live wrangler dev CSRF probe (machine load). Never run: `--remote`, login or deploy.
