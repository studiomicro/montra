# FN-26 Subscriptions (Langganan) — QA report

**Verdict: PASS**

Reviewed at `623b0a2` (detached, on top of `main` `fa58797`). Diff: `git diff fa58797..623b0a2` (46 files,
+8105/-40). PRD: `docs/features/fn-26-subscriptions/PRD.md`. Engineer report: cycles 1–2.

## Commands run

- `npm ci` — 246 packages installed, exit 0 (local npm registry).
- `npx svelte-kit sync` — exit 0, no output.
- `npm run db:reset:local` — migrations 0000–0013 applied, demo seed ran, exit 0 (local D1/miniflare).
- `npm run gates` — check 0 errors/0 warnings (1246 files); lint clean; test 102 files/1641 passed; build ok; exit 0 (mocked/fixture test doubles, no real provider).
- `npx vitest run test/integration/langganan.test.ts src/lib/shared/subscriptions.test.ts src/lib/server/subscriptions/validation.test.ts src/lib/ui/kit/initials.test.ts scripts/demo-seed.test.ts src/lib/ui/shell/nav.test.ts src/lib/shared/notifications.test.ts workers/jobs/src/cron.test.ts workers/jobs/src/queue.test.ts test/integration/notifications.test.ts` — 10 files, 235 tests passed, exit 0 (local D1/miniflare, no real provider).
- `npx vitest run test/i18n-coverage.test.ts` — 1 file, 3 tests passed, exit 0.
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=8857 npx playwright test --workers=2` — 220 passed, 15 skipped, 0 failed (4.4m), exit 0 (real browser against local wrangler dev, mocked AI/providers; no rerun needed, no failures).
- Manual migration-rebuild check (own wrangler commands, separate persist dir, not part of the npm scripts): applied 0000–0012 fresh, inserted sample `notification_prefs`/`space_notifications`/`notification_deliveries` rows, applied 0013, re-read all four and the two tables' indexes — byte-identical before/after; confirmed `bill_reminder` now insertable into both CHECKs. Exit 0 throughout (local D1/miniflare).

## Migration 0013 rebuild (staging-data safety)

PASS. `migrations/0013_subscriptions.sql` creates `subscriptions` and separately rebuilds `notification_prefs`
and `space_notifications` (copy → drop → rename, no `PRAGMA foreign_keys` toggling needed since nothing
references those two tables by FK) purely to widen their `kind` CHECK to include `bill_reminder`. Verified with
a fresh persist dir: applied 0000–0012, inserted 2 `notification_prefs` rows (one disabled), 2
`space_notifications` rows (one live, one tombstoned with `seq=2`), 1 `notification_deliveries` row referencing
`sn1`; applied 0013; re-selected all rows and the `sqlite_master` index list for both tables — identical in
every column, including the tombstoned row's nulls and the two tables' five indexes (unique + plain). Then
inserted a `bill_reminder` row into both rebuilt tables successfully, proving the CHECK was actually widened and
not just copy-pasted. `notification_deliveries` (no FK to either rebuilt table) was untouched and intact.

## Checked criteria

1. **PASS** — catalogue add copies name/category, initials tile only (`CataloguePicker.svelte`,
   `subscriptions-catalogue.ts` has no logo/URL field at all). e2e `langganan.spec.ts:75`.
2. **PASS** — typed name → `catalogueId: null`, initials still render from the typed name
   (`initials.ts`/`InitialsTile.svelte` take `name` only). Unit `initials.test.ts`; integration
   "a typed name has no catalogue id".
3. **PASS** — `nextChargeOn`/`clampedDate` clamp day 31 to the month's real last day via `monthRange`, never a
   hand-rolled table; `subscriptions.test.ts` vectors cover day 31 across all 12 months of 2026, Feb 2028
   (leap) and Feb 2100 (non-leap century, i.e. divisible by 100 but not 400), days 28–30 in leap/non-leap Feb,
   31×48 consecutive cycles, yearly Feb 29.
4. **PASS** — `effectiveNextCharge` recomputes from schedule+today whenever the stored date is today or past;
   `getSubscription`/`listSubscriptions` always call it with the request's WIB `today`, never trusting the
   stored column directly. Test "uses the WIB date: 23:30 WIB on 31 October is still October" exercises the
   exact 23:30/00:30 WIB boundary from the task brief and passes.
5. **PASS** — `markPaidWithNew` is one `db.batch` (bump seq + FN-05 `insertTransactions` + guarded subscription
   update, both-or-neither); `markPaidWithExisting` requires the chosen id to be a live, real, same-currency
   expense of the same space (`payableExpense` SQL), cross-space/foreign/income/other-currency ids all answer
   the same 404 (`PAY_TRANSACTION_NOT_FOUND`, no oracle). Integration tests for both branches and the refusal
   case pass.
6. **PASS** — `dueBillReminders` → `evaluateBills` → `createIfAbsent` keyed `bill:<subscriptionId>:<chargeDate>`
   (unique index + `onConflictDoNothing`), one row per live member, re-fires only after `next_charge_on`
   advances. Integration tests: replay creates nothing new, every live member gets one, removed member and
   preference-off get nothing, nothing more until the next cycle nears; `cron.test.ts`/`queue.test.ts` cover the
   rotation, quiet hours and `bill_check` → `send_push` wiring.
7. **PASS** — `monthlyTotals` sums exact BigInt twelfths per currency (yearly ÷12, weekly ×52/12), floors once,
   never adds across currencies, null past `Number.MAX_SAFE_INTEGER`; shown with "≈" in the UI. Unit vectors
   plus integration "never adds across currencies" test.
8. **PASS** — hiding `langganan` via FN-12 only removes the nav entries; `/langganan` still loads and its total
   still computes (`data.hiddenModules` check only gates the notice, not the load/action logic). Integration
   "hiding Langganan changes the nav only" + e2e `langganan.spec.ts:184`.
9. **PASS** — every load/action goes through `scopeOf` → `requireSpaceAccess`, every write repeats
   `isLiveMember` inside its own guarded statement; stranger and removed-member get 404 on load and all 4
   actions (create/update/delete/markPaid), same message, same shape. Integration "a non-member and a removed
   member get 404 on the load and every action; nothing changes"; e2e cross-space coverage via `ruang.spec.ts`
   patterns reused.
10. **PASS** — `writable()` compares `updated_at`; stale → 409 "Berubah sejak terakhir dimuat" family message,
    missing → 404; success only returned after the guarded write actually changed a row. Integration "a stale
    form gets 409" + e2e "a second tab's stale edit is refused with 'changed meanwhile'".
11. **PASS** — `subscriptions` is first in `SPACE_SCOPED_TABLES` (ahead of `spaceNotifications`, `transactions`,
    `wallets`), so account-deletion purge removes it cleanly before its FK targets; a shared space's rows
    survive for remaining members (integration "purges the subscriptions of a space the user was the last
    member of; a shared space keeps its own"). A linked transaction's deletion degrades the list's LEFT JOIN
    (`t.deleted_at is null`) to "not linked" rather than a broken reference (integration "a deleted linked
    transaction reads as 'not linked'").
12. **PASS** — i18n coverage test (`test/i18n-coverage.test.ts`) passed with the new strings included; every
    money figure in `+page.svelte`/`PayForm.svelte`/`SubscriptionForm.svelte` goes through `formatMoney`;
    dates through `wibTodayString`/`formatShortDay`; catalogue file (`subscriptions-catalogue.ts`) is plain
    `{id, name, category}` data with no image/logo/URL field, confirmed by the "brand safety" unit test
    (`has unique ids and names, known categories, and nothing but plain text`).

## Additional verification (beyond the numbered ACs)

- **Caps**: `MAX_SUBSCRIPTIONS_PER_SPACE = 100` enforced inside the guarded insert statement itself (
  `liveCount(spaceId) < 100`), so a concurrent-create race cannot pass it; integration "20 concurrent creates at
  99 live rows: exactly one passes" and amount cap `10^13` tests both pass.
- **Demo rows**: `is_demo` column, excluded from `monthlyTotals` input (`.filter((s) => !s.isDemo)` in
  `+page.server.ts`), excluded from `dueBillReminders` (`s.is_demo = 0`) and from `payableExpense`
  (`t.is_demo = 0`); `markPaid` refuses a demo subscription with 400 `DEMO_NOT_PAYABLE` before any write.
  Integration "Data demo subscriptions… are listed badged, never counted in the total, and never marked paid".
- **i18n EN**: confirmed by the project-wide i18n coverage test (fails if any `tr()`/`trf()` Indonesian phrase
  lacks an English entry) plus e2e `langganan.spec.ts` "English labels" coverage in `fitur.spec.ts`.
- **No-JS**: `?tambah=1|<catalogue id>|lainnya`, `?ubah=<id>`, `?bayar=<id>` all render inline without
  JavaScript (verified by reading `+page.server.ts`'s `open` object and `+page.svelte`'s conditional rendering,
  and by the passing e2e "works without JavaScript: picker, refusal and save are plain form posts").
- **360 px**: `expectNoHorizontalScroll` assertions in `langganan.spec.ts` ran on both the `phone` (360×780) and
  `desktop` Playwright projects as part of the full e2e run; 0 failures.
- **ENGINEERING_CHECKLIST.md**: no violations found — bounded queries with `limit`, no growing `inArray`,
  guarded single-statement reads/writes for every concurrency-sensitive path, BigInt exact money math, one
  access rule (`requireSpaceAccess`/`isLiveMember`), content-free tombstones, `{#each}` lists keyed by id
  everywhere in the new Svelte files, user-facing messages contain no ids/paths (`messages.ts` reviewed in
  full).

## Findings

None. No acceptance criterion failed; no gates failure; no migration-rebuild data loss; no cross-space leak
found in the code or its tests.
