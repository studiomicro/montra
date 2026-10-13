# FN-26 Subscriptions (Langganan) — engineer report (cycle 1)

Branch `fn-26-subscriptions` from `main` e2780ce. Migration `migrations/0014_subscriptions.sql` (journal idx 11,
snapshot `meta/0014_snapshot.json` chained to 0010's snapshot id; re-chain at merge after 0011–0013 land).

## What works

- **`/langganan`** (new route, `(app)` group): monthly-estimate header "Perkiraan biaya per bulan" with `≈`, one figure
  per currency (IDR first, others on a "Ditambah … dalam mata uang lain" line, never added together; a total past
  2^53 shows "Total terlalu besar untuk ditampilkan"), and an explanation of the normalisation. List "Tagihan
  berikutnya" sorted by next charge (then name): initials tile, name, cycle + schedule ("Tiap tanggal 31", "Tiap
  Jumat", "Tiap 1 Maret"), next charge as WIB short date + "hari ini / besok / N hari lagi", "Terakhir dibayar …"
  while the linked transaction is live, amount via `formatMoney`, and a 44 px "Tandai … sudah dibayar" button.
- **Add**: catalogue picker sheet (own data file, grouped by category, initials tiles; "Lainnya: ketik nama
  sendiri") → prefilled form (name and category copied from the entry, editable). Fields: name, category,
  currency + `AmountInput`, cycle (`Segmented`), day of month / month / ISO weekday (only the relevant one with JS;
  all three, labelled, without JS), optional wallet (same currency), reminder 0–14 days (default 2).
- **Edit / delete**: same form in a sheet; delete is a `<details>` confirm.
- **Tandai sudah dibayar**: "Catat transaksi baru" (wallet of the bill's currency, category defaulting to the
  catalogue category's preset tile, date default today WIB) or "Hubungkan transaksi" (30 most recent live real
  expenses of the bill's currency).
- States: `Skeleton` on retry, `ErrorState` + retry, `EmptyState`, "Menyimpan…"/disabled buttons, success lines
  only after the server answered; 404/409 reload the list and refresh an open sheet (kekayaan `track()` pattern).
  Every action and the picker work without JavaScript (`?tambah=1|<catalogue id>|lainnya`, `?ubah=<id>`,
  `?bayar=<id>`, inline refusal echo).
- **Nav (FN-12)**: `MODULE_NAV.langganan = '/langganan'`; sidebar entry "Langganan" (new `repeat` icon) filtered by
  `visibleSidebarExtra(hidden)`; phone path is a "Langganan" row on `/kekayaan`, hidden with the module. The
  settings row no longer says "Belum ada menu untuk disembunyikan" for Langganan. A hidden module's page still
  loads, with the "Langganan disembunyikan dari menu. Angkanya tetap dihitung." + "Tampilkan lagi di menu" notice.

## Data and rules

- `subscriptions` (space-scoped, in `SPACE_SCOPED_TABLES` first — it references wallets and transactions):
  `catalogue_id`, `name`, `category`, `amount_minor`, `currency`, `billing_cycle`, `billing_day`, `billing_month`,
  `wallet_id` (FK wallets), `linked_transaction_id` (FK transactions), `next_charge_on`, `reminder_days_before`,
  `created_at`, `updated_at`, `deleted_at`, `seq`. CHECK: live rows complete with a valid schedule per cycle and
  reminder 0–14; tombstones content-free (every content column null).
- `src/lib/shared/subscriptions.ts`: `nextChargeOn(schedule, from)` (first charge on/after `from`; monthly 29–31
  clamp to the month's last real day via `monthRange`; yearly Feb 29 → Feb 28 in non-leap years; weekly via
  `addDays`), `effectiveNextCharge` (stored date kept only while it is after today, else recomputed from schedule +
  today — AC4), `followingCharge`, `isBillReminderDue`, `billReminderDataKey`, `monthlyTotals` (exact BigInt
  twelfths per currency, floored once, null past safe range).
- Repo (`src/lib/server/subscriptions/repo.ts`), goals pattern: guarded insert with live-member + cap (100 live) +
  wallet (same space, live, same currency) in one statement; `writable` = id + space + `updated_at` + live + member;
  `whyNot` → stale/missing; edit keeps a paid-ahead next charge unless the schedule changed. Mark paid (existing):
  one guarded update requiring a live real expense of the space in the bill's currency. Mark paid (new): one
  `db.batch` = `bumpSpaceSeq` + FN-05 `insertTransactions` (source `manual`, guarded on the subscription's
  `updated_at`) + the subscription update guarded on the new transaction existing — both or neither. The new
  expense is validated by FN-05's `capturedTransactionInput` with refs looked up inside the space.
- Amounts: `wholeAmountMinor` in the chosen currency, 1 … `MAX_AMOUNT_MINOR` (10^13).
- Access: every load/action runs `requireSpaceAccess(locals.db, user.id, locals.space.id)`; writes repeat
  `isLiveMember`. Unknown, deleted and other-space subscription ids → 404 "Langganan tidak ditemukan."; foreign /
  unknown / income / other-currency transaction ids on "hubungkan" → one 404 answer.
- Deleted linked transaction: the list's LEFT JOIN only matches live transactions, so it reads "not linked".

## Decisions taken (own recommendation, recorded)

1. **Yearly schedule = `billing_month` + `billing_day`**, not the PRD's 1–366 ordinal: an ordinal drifts by a day
   after 28 Feb between leap and non-leap years; month + day with the same month-end clamp is what a bank does.
2. **Delete is a content-free tombstone** (binding), so "archive" is not restorable; the UI says "Hapus langganan".
3. **Next charge semantics**: a charge due today is shown as today until marked paid; paying advances one cycle past
   the charge now due (paying ahead advances further each time).
4. **`category` column added** (PRD AC1 copies the catalogue category; markPaid guesses the FN-06 preset tile from
   it: streaming/musik/game → Hiburan, belajar → Pendidikan, others → Tagihan).
5. **Monthly estimate floored once** on the exact per-currency sum (not per row), so it never overstates.
6. **Phone navigation**: no fifth tab (fixed tab order); a Kekayaan row plus the sidebar entry on desktop.
7. Catalogue: 38 services (names only), ids stable; no logos or images anywhere (tested).

## FN-24 hook (not wired)

FN-24 is not on `main`, so no `bill_reminder` kind or cron call exists yet and no reminder is sent.
`src/lib/server/subscriptions/reminders.ts` exports `dueBillReminders(db, today, afterId)` (paged, read-only,
live subscriptions of live spaces whose reminder window `isBillReminderDue` covers today on the never-stale next
charge) returning `dataKey = bill:<subscriptionId>:<nextChargeOn>`. Wiring at merge: add `bill_reminder` to
`NOTIFICATION_KINDS`/`SPACE_NOTIFICATION_KINDS` + template, and from the FN-24 cron tick call `createIfAbsent` per
live member with that `dataKey`, enqueuing `send_push` for created rows. Tested: due window, same key on a repeated
tick, nothing due after mark-paid.

## Files

- New: `migrations/0014_subscriptions.sql`, `migrations/meta/0014_snapshot.json`,
  `src/lib/shared/subscriptions.ts` (+ `.test.ts`), `src/lib/shared/subscriptions-catalogue.ts`,
  `src/lib/server/subscriptions/{messages,validation,repo,reminders}.ts` (+ `validation.test.ts`),
  `src/lib/ui/kit/InitialsTile.svelte`, `src/lib/ui/kit/initials.ts` (+ `initials.test.ts`),
  `src/lib/ui/subscriptions/{SubscriptionForm,CataloguePicker,PayForm}.svelte`,
  `src/routes/(app)/langganan/+page.{server.ts,svelte}`, `test/integration/langganan.test.ts`, `e2e/langganan.spec.ts`.
- Changed: `src/lib/server/db/schema.ts`, `migrations/meta/_journal.json`, `src/lib/server/spaces/spaces.ts`
  (`SPACE_SCOPED_TABLES`), `src/lib/ui/shell/{nav.ts,nav.test.ts,Sidebar.svelte}`, `src/lib/ui/icons.ts`,
  `src/routes/(app)/kekayaan/+page.svelte`, `src/lib/shared/i18n-en.ts` (78 entries), `e2e/fitur.spec.ts` and
  `e2e/shell.spec.ts` (Langganan now has a nav entry: 3 modules say "Belum ada menu", sidebar has 8 links).

## Checks

- `npm run gates`: check 0 errors / 0 warnings (1212 files); lint clean; test 95 files, 1456 passed; build ok.
- `e2e/langganan.spec.ts` alone (`E2E_PORT=8853 --workers=2`): 9 passed (phone + desktop + setup).
- Full e2e (`E2E_PORT=8853 --workers=2`): 198 passed, 2 failed, 15 skipped. Both failures were
  `accounts.spec.ts` (phone) "Tearing down context exceeded the test timeout" (not FN-26 code; another agent's
  server ran on 8852 at the same time). Rerun of `e2e/accounts.spec.ts` alone: 23 passed, 6 skipped.
  After adding a 360 px no-scroll check on `/langganan`: `langganan` + `fitur` + `shell` specs, 39 passed.
- Fail-before: clamp removed → 15 of 66 shared vectors fail; cap clause removed → the 20-concurrent cap test fails.

## Pre-handoff probes

- Date math vectors: day 31 across all 12 months of 2026 + Feb 2028 (leap) + Feb 2100 (non-leap century); days
  28–30 in Feb leap/non-leap; 31 × 48 consecutive cycles all real dates; yearly Feb 29; weekly across month/year;
  23:30 WIB 31 Oct vs 00:30 WIB 1 Nov → PASS (66 tests).
- Cross-space: stranger and removed member → 404 "Not found" on load and all 4 actions with a forged
  `locals.space`; 404 "Langganan tidak ditemukan." with their own space; shared rows byte-identical → PASS.
- Stale edit 409: integration (edit, mark paid replay) + e2e two-tab edit shows "Berubah sejak terakhir dimuat" → PASS.
- Caps: 20 concurrent creates at 99 live → exactly 1 ok, 19 × 409 limit, 100 live; amount 10^13 ok, +1 refused;
  20 KB body → 400, text/plain → 415 → PASS.
- Toggle: flag off → layout `hiddenModules` has `langganan`, page and totals still load; e2e: sidebar entry and
  Kekayaan row disappear, notice + "Tampilkan lagi di menu" → PASS.
- No-JS: picker link → prefilled form → refusal inline → save → listed (e2e) → PASS.
- 360 px: e2e phone project, no horizontal scroll on `/langganan`, `/riwayat` and `/pengaturan/fitur` → PASS.
- User copy: no paths or internal ids in messages → PASS.

## Gaps

- Bill reminders are not sent until FN-24 lands (hook above).
- No `Data demo` seed rows for subscriptions (seed script untouched).

## Cycle 2 (controller)

- Rebased onto `main` fa58797 (FN-21, FN-24). Migration regenerated as `0013_subscriptions` (journal idx 13, snapshot
  chained to 0012's id). It also rebuilds `notification_prefs` and `space_notifications` so their kind CHECKs accept
  `bill_reminder` (copy, drop, rename; no PRAGMA lines: nothing references those tables). `SPACE_SCOPED_TABLES`:
  `subscriptions` first, then FN-24's `spaceNotifications`.
- **Bill reminders wired**: `bill_reminder` is a space kind (`shared/notifications.ts`: label "Tagihan langganan" in
  /pengaturan/notifikasi, `BillParams`, `parseParams`, `notificationText` in the reader's language, URL `/langganan`).
  The jobs cron walks `spacesWithSubscriptions` (live spaces with a live real subscription) as an endless rotation
  each open tick (`tickPlan.bills`, off in quiet hours) and enqueues `bill_check`; the queue runs
  `evaluateBills` → `dueBillReminders(db, spaceId, today)` → `createIfAbsent` per live member, key
  `bill:<subscription>:<charge date>`, then `send_push` for new rows (push skips quiet hours as before).
  Preferences, active account and live membership are checked inside `createIfAbsent`.
- **Data demo**: `subscriptions.is_demo`; `scripts/demo-seed.ts` adds 3 fictional subscriptions per eligible space.
  They are listed with the "Data demo" badge, left out of the monthly total, the cron walk and reminders, and
  "Tandai sudah dibayar" refuses them (400, no pay button).
- `src/lib/shared/i18n.ts` now imports `./i18n-en.ts`, so the seed script (which pulls shared/subscriptions.ts)
  runs under plain Node.
- Tests added: replayed `evaluateBills` creates nothing new (same ids), every live member gets one, removed member
  and preference-off get nothing, nothing after mark-paid, cron walk excludes empty and deleted, ID/EN text,
  cron `bill_check` rotation and quiet hours, queue `bill_check` → `send_push` for new rows only, demo seed and
  demo exclusions, e2e "Tagihan langganan" switch.
- Checks: `npm run db:reset:local` exit 0 (0000–0013 applied, seed ran); `npm run gates` clean (check 0 errors in
  1246 files, lint clean, 102 files / 1641 tests passed, build ok); full e2e `E2E_PORT=8853 --workers=2`:
  220 passed, 15 skipped, 0 failed (no rerun needed).

## Cycle 3 (red team Lows)

- L1: `evaluateBills` caps single `bill_reminder` rows at `BILL_REMINDERS_PER_DAY` (5) per recipient per WIB day, counted
  inside the insert guard over every single bill reminder created today (blanked ones included, so delete/recreate
  churn cannot reset it). Bills past the cap become one grouped notification per space and day
  (`bills:<space>:<date>`, params `{ count, date }`, "{n} tagihan langganan lagi segera jatuh tempo", no names).
  Test: 3 rounds of deleting and recreating 8 bills → per member 5 singles + 1 group, 12 new rows (pushes) in total.
- L2: `deleteSubscription` tombstones every member's `bill:<id>:…` reminders (params/read_at null, deleted_at set) in
  the same `db.batch`, only once the subscription is a tombstone; keys stay, so a replayed tick never recreates them
  (`substr` match, no LIKE). Test covers both members, the list, and a replayed tick.
- L3: RUNBOOK rollback note corrected (rebuild migrations, Time Travel restore, row counts before/after).
- Fail-before: both new integration tests failed before the fix (2 failed, 31 skipped).
- Checks: `npm run check` 0 errors (1246 files), prettier and eslint clean, build ok. `npm run test` in gates hit
  timeouts under load average ~50; `npm run test -- --maxWorkers=4`: 102 files, 1644 passed. e2e
  `langganan.spec.ts` + `notifikasi.spec.ts` (`E2E_PORT=8853 --workers=2`): 15 passed.
