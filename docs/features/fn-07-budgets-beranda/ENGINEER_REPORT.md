# FN-07 Budgets + safe-to-spend and FN-08 Beranda: engineer report (cycles 1–2)

Branch `fn-07-budgets-beranda`, rebased onto `main` `bb1336f` (FN-05/06, FN-10 goals, money parser), not pushed.
The WIP commits were squashed into one first, so the migration conflict is resolved once. The migration is
**`0006_budgets.sql`**, regenerated on main with its snapshot `prevId` chained to `0005_goals`. If FN-11 lands
0006 first, regenerate it as the next free number.

After that rebase:
- `npm run db:reset:local` exit 0; 0000–0006 applied.
- `npm run gates` exit 0:
  - svelte-check: 1084 files, 0 errors, 0 warnings.
  - prettier + eslint: clean.
  - Vitest: 62 files / 939 tests passed.
  - build: ✔ done.
- Full e2e (`E2E_PORT=8823`, controller `LD_LIBRARY_PATH`): exit 0, 132 passed, 15 skipped, 0 failed.

The cycle 2 figures below are from before this rebase.

## Cycle 3 (QA FAIL on criterion 28, red-team Lows L1–L4)

Rebased onto `main` `36eb361` (FN-11 drafts = 0006, FN-12 feature flags = 0007). The migration is
**`0008_budgets.sql`**: snapshot `prevId` is 0007's id, journal idx 8. `budgets` stays in `SPACE_SCOPED_TABLES`
after `transactions` (drafts → transactions → budgets → categories → wallets). The failing tests were written
first; each failed before its fix.

- **Criterion 28: BarChart touch targets (kit `BarChart.svelte`).**
  - Each day is a full-height (120 px) × 44 px transparent hit column: an SVG `<rect role="button">` with the
    click and keyboard handlers, `aria-pressed` on the selected day and a `:focus-visible` outline. The visible
    22 px bar is drawn inside it with `aria-hidden` and `pointer-events: none`.
  - Enter and Space select the day with `preventDefault`.
  - The 14 × 44 px chart scrolls horizontally inside itself and starts scrolled to today. It uses SVG attributes
    only, no inline styles.
  - New `src/lib/ui/kit/BarChart.test.ts` (4 tests; 3 failed before the fix).
  - The e2e 360 px journey asserts that all 14 bar targets are ≥44×44, today's bar is in view and pressed, and
    Space selects a day.
- **L1: set/delete churn.**
  - The unique index now covers every row: `budgets_one_per_space_uq` on `space_id`, live or tombstone. A
    create first revives the space's tombstone in the same batch (`updated_at` = max(now, old + 1), fresh
    `seq`); only a space that never had a budget gets an INSERT … WHERE NOT EXISTS.
  - Test: 5 × set/delete leaves 1 row, and the revived row is newer with a higher `seq`.
- **L2: amount parser.** The budget amount uses the shared `wholeAmountMinor` and the transaction cap
  `MAX_AMOUNT_MINOR` (10^13), with a new message "Anggaran terlalu besar." `1 200`, `12.50` and
  `100.000.000.001` are refused; `100.000.000.000` is accepted.
- **L3: currency.** New `isBudgetCurrency` in the repo: one SQL check that the currency belongs to a live wallet
  of the space, is IDR when the space has no live wallet, or is the live budget's own currency. The action
  refuses anything else with 400 and never trusts the hidden field. Tests cover IDR-only, a USD wallet, and a
  USD wallet that was later archived.
- **L4: removed member.** A guarded write that matches nothing re-checks membership (`whyNot`): a non-member gets
  `gone`, and the action throws the gate's own `error(404, 'Not found')`. `BUDGET_GONE` and its message are
  removed. The repo-level probes now expect `gone`.
- **Vitest.** `hookTimeout: 60_000` in `vitest.config.ts`. QA saw `openLocalD1` (`beforeAll`) pass the 10 s
  default under parallel load.
- **`.ts` imports.** This feature adds no relative import under `src/lib/shared` (only functions in `dates.ts`).
- **Commands.**
  - `npm run db:reset:local`: exit 0, 0000–0008 applied.
  - `npm run gates`: exit 0. svelte-check 1121 files, 0 errors, 0 warnings; prettier and eslint clean; Vitest
    72 files / 1038 tests passed; build ✔ done.
  - Full e2e (`E2E_PORT=8823`, controller `LD_LIBRARY_PATH`): exit 0, 146 passed, 15 skipped, 0 failed.
- **Note.** The e2e server log carries three broken-pipe stack lines from another worktree's workerd. This is
  probably wrangler's shared local dev registry linking the jobs/inbound service names across concurrent dev
  sessions. The app under test was this worktree's own server (every other server log line comes from it).

## Cycle 2 (controller request)

- **Rebase onto main.** The only conflict was the end of `i18n-en.ts` (both sides appended); both sides were kept.
  The 0006 snapshot was regenerated against main's 0004.
- **Overflow state.**
  - `dailyTotals` and `categoryTotals` now use main's path: `cast(sum(...) as text)`, folded in BigInt by
    `foldTotals`, and `null` past 2^53.
  - `math.ts` carries `null` through: exact BigInt sums, then `safeMinor`. A null day, or safe days whose sum is
    past 2^53, makes every figure built on them null. They are never rounded and never thrown.
  - Spending too large to show counts as over any budget: `{ kind: 'over', overMinor: null }`, shown as
    "Sudah melebihi anggaran." without an amount.
  - On the page:
    - The hero shows "Total terlalu besar untuk ditampilkan" in place of the figure, and the comparison pill
      is hidden.
    - Today's header and any other-currency figure that is too large use the same phrase, as Riwayat does.
    - A chart view with a null value shows the phrase instead of the chart.
  - A `?? 0` in the per-day lookup turned null into 0. The new null tests caught it (they failed before the
    fix), and it was fixed with an explicit lookup (`dayOut`).
- **Tests.** 3 unit tests and 2 integration tests, using 1000 × 10^13 rows on one day, and 2 × 600 × 10^13 rows on
  two days (each day safe, the month not).
- **e2e.** Added `e2e/beranda.spec.ts` with the six journeys listed at the end. Riwayat's sign-up and form helpers
  moved unchanged to the new `e2e/ledger.ts`, shared by both specs; `riwayat.spec.ts` now imports them.
- **360 px fix.** The e2e run found 52 px of horizontal overflow on phone, from the three-option chart picker
  ("Batang harian" / "Per kategori" / "Vs bulan lalu" is wider than 328 px). This overflow also failed two
  existing `shell.spec` checks on `/`. The first option is now "Harian" (EN "Daily"); auto-accepted default.
- **Gates.** `npm run gates` exit 0:
  - svelte-check: 1062 files, 0 errors, 0 warnings.
  - prettier + eslint: clean.
  - Vitest: 55 files / 540 tests passed.
  - build: ✔ done.
- **`npm run db:reset:local`.** Exit 0; 0000–0004 and 0006 applied.
- **Full e2e.** `E2E_PORT=8823 LD_LIBRARY_PATH=<scratchpad> npx playwright test`
  exit 0: 118 passed, 13 skipped, 0 failed. The skips are phone-only or desktop-only tests, including this
  spec's 360 px test on desktop.

Everything below is the cycle 1 record, updated where cycle 2 changed it.

## What works

- `/` (Beranda) load: `currentSpaceScope` (requireSpaceAccess with `locals.user`) runs on every load and action.
  It reads one summary through the FN-05 aggregates only. The hero shows "Pengeluaran {bulan}" with this WIB
  month's expense total. That total is `periodTotals` with Riwayat's month and type filter, so it is the same
  figure Riwayat shows. Next to it: `ComparisonPill` (diff and floor average/day), spending in other currencies
  listed separately ("Ditambah …", never summed in), the safe-to-spend line ("Sisa … · …/hari untuk N hari",
  over-budget in `--money-up`, "sudah habis" at exactly 0), and "Atur/Ubah anggaran".
- The disabled Suara/Struk pills and "Segera hadir" are unchanged.
- "Hari ini · Hari ke-N" section: the same day group that Riwayat's one-day range shows (`listTransactionsByDay`).
  It has whole-day `DayHeader` totals per currency and rows keyed by id. Demo rows carry the "Data demo" badge.
  When a day has more than 50 rows, a "Lihat semua di Riwayat" link appears.
- Chart picker (`Segmented`): daily bars for 14 WIB days, zero-filled; per category (`CategoryBar` plus a legend);
  vs last month (`MonthLines`, cumulative, aligned by day). All three use data that is already loaded.
- Budget sheet (`AmountInput`, Simpan, Hapus anggaran): success shows only after the server confirms. On a 409 or
  404 the page reloads its data. Without JavaScript, `/?anggaran=1` and a refused submission render the same form
  inline.
- Loading uses a skeleton during client navigation and retry. A load failure shows `ErrorState` with retry.
- `budgets` table: one live row per space (partial unique index). A guarded INSERT … WHERE NOT EXISTS with
  ON CONFLICT DO NOTHING creates it; edits are an UPDATE guarded on `updated_at`. Every write repeats
  `isLiveMember` and stamps `space_seq`. Delete leaves a content-free tombstone: the amount is cleared and a
  CHECK enforces this. `budgets` is registered in `SPACE_SCOPED_TABLES`.
- No budget id is ever read from the client.

## Files

- New:
  - `migrations/0005_budgets.sql` and its snapshot.
  - `src/lib/server/budgets/{repo,validation,messages,math,summary}.ts`.
  - `src/routes/(app)/+page.server.ts`.
  - Tests: `src/lib/server/budgets/{math,validation}.test.ts` and `test/integration/beranda.test.ts` (22).
- Changed:
  - `db/schema.ts` (+`budgets`).
  - `spaces/spaces.ts` (`SPACE_SCOPED_TABLES` += budgets).
  - `transactions/aggregate.ts` (+`dailyTotals`, `categoryTotals`: same `filterWhere` and `foldTotals`, transfers
    and demo rows excluded).
  - `shared/dates.ts` (+`formatMonthName`, `formatShortDay`).
  - kit `BarChart.svelte` (+optional `currency`, default IDR).
  - `routes/(app)/+page.svelte` (rewrite).
  - `i18n-en.ts` (+24 entries).

## Decisions (owner defaults A–G as written, plus auto-accepted ones)

1. The hero currency is the currency of the live favourite wallet, or IDR when there are no wallets. Spending in
   other currencies is listed next to the hero and never summed into it.
2. A budget stores the currency its form showed. Safe-to-spend uses this month's spending in that same currency.
3. The hero S is the whole WIB month, so it equals Riwayat's month total and safe-to-spend counts future-dated
   rows (the conservative side). The comparison and avg/day use month-to-date (decision C).
4. When B − S = 0, the line reads "Anggaran bulan ini sudah habis." instead of "melebihi sebesar Rp0".
5. FN-05 shipped `periodTotals`/`listTransactionsByDay`, not the PRD's `sumExpense*` contract. The two grouped
   variants were added to FN-05's `aggregate.ts` rather than to a second layer.
6. Month names come from Intl (`formatMonthName`), in line with `formatMonthLabel`, rather than 12 `msg()` entries.
7. `MonthLines` series are cut to min(N, days in last month), because the kit spreads each series over its own
   length.
8. A second "create" while a budget already exists returns 409 "Berubah sejak terakhir dimuat".
9. Tests follow the repo's `*.test.ts` convention.
10. The Riwayat row title/meta helpers are repeated in Beranda (about 10 lines). Extracting them to a shared
    module would change the Riwayat page, so this is left for after the merge.

## Gates

`npm run gates` exit 0:
- svelte-check: 1060 files, 0 errors, 0 warnings.
- prettier + eslint: clean.
- Vitest: 55 files / 527 tests passed.
- build: ✔ done.

## Fail-before proof (mutation runs, each reverted; `scratchpad/mutate.py`)

| Mutation | Failing tests |
| --- | --- |
| Create without NOT EXISTS / ON CONFLICT | 2 fail (20-concurrent create, stale create) |
| No `updated_at` guard | 2 fail |
| No membership in writes | 2 fail (non-member, removed member) |
| Ceil instead of floor | 1 fail |
| Remaining days without today | 6 fail |
| Same days not cut at last month's length | 4 fail (31st vs 30-day month, March vs February) |
| Demo rows counted in `dailyTotals` | 1 fail |
| budgets missing from SPACE_SCOPED_TABLES | 1 fail |

## Pre-handoff probes

- Cross-space (Vitest): a non-member with the shared space's cookie only reaches their own personal space, and
  the shared budget is unchanged. A removed member loses the budget at once. Repo calls with a non-member scope
  return `stale` and write nothing. Live HTTP (local wrangler dev :8801): B's delete with A's `updatedAt` gets
  409, B sees no budget, and A's budget is intact.
- Concurrency:
  - 20 concurrent first budgets give 1 ok, 19 × 409, and 1 row.
  - 20 concurrent edits from the same form give exactly 1 ok.
- Two tabs / stale forms: the stale edit and the stale delete both get 409 "Berubah sejak terakhir dimuat". Live:
  first 200, second 409, with the message shown.
- Totals equality:
  - The Beranda month total equals Riwayat `?type=expense` IDR out.
  - Today's totals and row ids equal Riwayat `?period=range&from=today&to=today`.
  - The `DayHeader` out equals the sum of the listed rows.
  - Transfers, income, USD and demo rows are never counted.
- WIB vectors:
  - 23:30 WIB on 31 Oct gives day 31 and R=1. A row at 00:30 WIB on 1 Nov (same UTC date) is excluded.
  - 00:30 WIB on 1 Nov gives day 1 and R=30, and that row counts.
  - The 31st is compared with all of a 30-day month; 28–31 March with February (2028: 29 days).
- No-JS budget form (curl, `Accept: text/html`, local wrangler dev :8801):
  - `/?anggaran=1` renders the inline form.
  - Amount 0 gets 400 with the error rendered.
  - A valid amount gets 200 with "Anggaran disimpan." and the "Sisa Rp3 jt · Rp125 rb/hari untuk 24 hari" line.
  - The budget survives a reload.
  - A text/plain body gets 415. Signed out, `/` redirects 303 to /masuk.

## Not verified / concerns

- Cycle 1 could not run e2e: `libnspr4.so` was missing and port 8787 was taken. Cycle 2 ran it with the
  controller's `LD_LIBRARY_PATH` and `E2E_PORT=8823`.
- The `BarChart` bars (kit, FN-00) are 22 px wide on a 30 px pitch, below PRD criterion 28's 44 px. Meeting it
  needs a kit redesign (wider bars, or a larger hit area per bar). This is not done.
- Contrast was not measured separately; the page uses only existing tokens.
- The overflow state is covered at the summary level (integration) and by `svelte-check` types. No page-render
  test exercises it, because there is no component harness for route pages with `$app/*`.
- `TEXT` vs numeric `SUM` cannot be told apart by an observable test: past 2^53 both end as null.
- The `ErrorState` path on a failed load is not covered by an automated test.
- The route's `today` uses `wibTodayString()`. The WIB vectors cover it at the helper and summary level, but no
  route test uses a fake clock.

## e2e journeys (`e2e/beranda.spec.ts`, cycle 2; phone and desktop)

1. Atur anggaran → sheet → Simpan: the Sisa line appears without a reload and is still there after a reload.
2. Ubah anggaran, then Hapus anggaran: "Atur anggaran" returns.
3. The chart picker switches between the three views with no network request; tapping a bar changes the readout.
4. At 360 px: no horizontal scroll, Segmented and bar targets ≥ 44 px, and focus returns to "Atur anggaran"
   when the sheet closes.
5. The no-JS budget form in a JavaScript-disabled context.
6. An expense added on /riwayat/baru shows up on Beranda's today list and total.
