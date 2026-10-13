# FN-09 Laporan: engineer report (cycle 1)

Branch `fn-09-laporan`, cut from the FN-07/08 head `c97640f`, not pushed. No migration. Needs a rebase onto
`main` once FN-07/08 merges. This branch touches `budgets/math.ts` (FN-08's), so expect conflicts there.

## What ships

- **`/laporan`** (`src/routes/(app)/laporan/+page.server.ts` new, `+page.svelte` replaces the empty stub).
  - The load is read-only. It calls `currentSpaceScope(locals)`, which is `requireSpaceAccess` on
    `locals.space`, and reads no space id from the URL.
  - The URL takes `period` (`bulan-ini` | `bulan-lalu` | `tahun-ini`) and `arah` (`keluar` | `masuk`). Any
    unknown value falls back to the defaults.
  - On failure the page shows `ErrorState` with a fixed message. It never 500s.
- **Stat lines.** Pemasukan, Pengeluaran and Selisih (`+`/`−` sign) are shown per currency, with the report
  currency first. Selisih is `--money-up` when below 0 and `--money-in` when 0 or more.
  - Zeros are always shown, never hidden.
  - A "Lihat semua di Riwayat" link opens the same period on Riwayat.
- **Direction chips** (links) pick what the three sections below show.
- **Category breakdown.** A `CategoryBar` plus a list with floor percentages.
- **Top-10 merchants.** Title, `{n} transaksi` and amount. Rows without a title appear as "Tanpa judul".
- **Trend.**
  - Month periods use `MonthLines`: the selected month against the month before, as running totals by day.
  - `tahun-ini` uses `BarChart`, with one bar per month from January to now (at most 12).
- **States.**
  - Loading: skeleton.
  - Empty: "Belum ada transaksi di periode ini." in each section.
  - Error: `ErrorState`.
  - Too large: "Total terlalu besar untuk ditampilkan" wherever a figure is past 2^53.
- **Without JavaScript.**
  - The period `Segmented` sits in a GET form, with a "Tampilkan" button shown until hydration.
  - The direction chips are plain links.
  - So both switches work with JavaScript off. This is better than the PRD's accepted "inert" limitation.

## Modules

- **`aggregate.ts`** (FN-05's module) adds two functions:
  - `monthlyTotals(db, spaceId, filter)`: grouped by `substr(occurred_on,1,7)`.
  - `merchantTotals(db, spaceId, filter, currency, limit≤10)`: grouped by
    `lower(trim(title, ' '||char(9,10,13)))` with `ORDER BY SUM DESC LIMIT ?` in SQL.
  - Both use the same `filterWhere`, `is_demo = 0` and transfers excluded. Sums go through
    `cast(sum() as text)` → BigInt → `safeMinor`.
  - No `LIKE`, no `inArray`.
- **`dates.ts`** adds `yearToDateRange`, `monthsBetween` and `formatShortMonth`.
- **`budgets/math.ts`** is refactored with no behaviour change:
  - The category-slice mapping moved to the exported `categorySlices(categories, currency, key)`.
  - `amountIn(...)` is new, and `outIn` now calls it.
  - `cumulative` is now exported.
  - Beranda and Laporan share all three, so there is no second copy.
- **New `src/lib/shared/laporan-query.ts`:** `parseLaporanQuery`, `laporanHref`, `periodRange`. Relative imports
  use `.ts`.
- **New `src/lib/server/reports/laporan.ts`:**
  - Pure functions: `laporanStats`, `floorPercent` (BigInt floor), `monthLines`, `yearBars`.
  - `laporanReport` calls `periodTotals`, `categoryTotals`, `merchantTotals`, and either `dailyTotals` or
    `monthlyTotals`.

## Deviations from the PRD (recorded decisions)

- **The PRD's function names do not exist in the code.**
  - The base has `monthRange`/`shiftMonth`, `categoryTotals({type})` and `dailyTotals`. The PRD names
    `wibMonthRange`, `wibPreviousMonthRange`, `sumExpenseByCategoryMinor` and `sumExpenseByDayMinor`.
  - So income categories reuse `categoryTotals` with `type: 'income'`. No `sumIncomeByCategoryMinor` was added.
  - `wibYearToDateRange` → `yearToDateRange` returns `{from, to}`, matching `monthRange`.
  - `sumByMerchantMinor`/`sumByMonthMinor` → `merchantTotals`/`monthlyTotals`. Both return the
    per-currency/overflow shapes the module already uses.
- **Chip labels are "Pengeluaran"/"Pemasukan"** (the existing Riwayat chip keys), not "Keluar"/"Masuk". The
  i18n key `Masuk` already means "Sign in", so it would mistranslate in English.
- **Breakdown currency.** Categories, merchants and trend use one currency: the favourite wallet's, IDR without
  wallets (Beranda's rule).
  - When the period has another currency, the page says "Rincian di bawah hanya dalam {mata_uang}.".
  - Stat lines list every currency separately. Nothing is ever summed across currencies.
- **Month lines are aligned by day of month.**
  - `bulan-ini` runs through today. The month before is cut to the same days.
  - When the month before is shorter, its last running total carries on.
- **The merchant display label** is `min(trimmed title)` of the group (the PRD's "lexicographically smallest").
- **Percent sign** (`52%`) is a plain number, with no i18n phrase.

## Tests

- **Unit:**
  - `src/lib/server/reports/laporan.test.ts` (10).
  - `src/lib/shared/laporan-query.test.ts` (5).
  - `dates.test.ts` (+3).
- **Integration:** `test/integration/laporan.test.ts` (18).
  - Load/defaults/empty.
  - Totals equality for 3 filters.
  - Direction switch.
  - Merchant case/whitespace collapse, blank bucket, 60+ chars, top-10 cap.
  - WIB year and month boundaries, month lines.
  - Overflow.
  - Cross-space: member, stranger with cookie and query, removed member, stale `locals.space` → 404.
  - Load failure → fixed message.
- **e2e:** `e2e/laporan.spec.ts` (4 × phone/desktop).
  - Main journey, including chips, periods and 360 px.
  - 70-character merchant at 360 px.
  - Laporan → Riwayat total.
  - No-JS: chips and period form.

**Fail-before proof:**
1. `yearBars` first used `byMonth.get(m) ?? 0`. The overflow integration test failed with
   `expected +0 to be null`, then passed once fixed with an explicit lookup.
2. Mutation: grouping without `lower()` → 3 integration tests failed.
3. Mutation: without `trim` → 2 failed.
4. Mutation: `Math.round` percent → the floor unit test failed (`2/3` → 67, `(MAX−1)/MAX` → 100).
5. At base `c97640f` the route and functions did not exist, so the whole new suite failed to import.

## Checks

- `npm run db:reset:local`: exit 0.
- `npm run gates`: exit 0.
  - svelte-check: 1121 files, 0 errors, 0 warnings.
  - prettier + eslint: clean.
  - Vitest: 65 files / 975 tests passed.
  - build: ✔ done.
- Full e2e (`E2E_PORT=8828`, `LD_LIBRARY_PATH=<scratchpad>`): exit 0, 146 passed, 15 skipped,
  0 failed. The server stopped afterwards; nothing is listening on 8828 or 8814.

## Pre-handoff probes

- **Totals equality**, Laporan vs Riwayat vs Beranda (`laporan.test.ts`): PASS.
  - `bulan-ini`: out 9.800.000 = Riwayat `?type=expense` = Beranda `spentMinor`; in = Riwayat `?type=income`.
  - `bulan-lalu`: = Riwayat `?month=<prev>`.
  - `tahun-ini`: = Riwayat `period=range&from=<Jan 1>&to=<today>`.
  - Category sum = direction total. Month bars sum = out. Merchants ≤ out.
  - Transfers, demo rows and USD are excluded from IDR.
  - e2e: Laporan → Riwayat link shows `4 transaksi · keluar Rp 85.000`.
- **Overflow**, 1000 × 10^13 rows: PASS. The load succeeds. out, net, `directionMinor`, category, percent,
  merchant amount, last line point and last month bar are all null. The UI shows the "too large" phrase.
- **Cross-space**: PASS.
  - A member sees the shared figures.
  - A non-member naming the space by cookie or `?space=`/`?spaceId=` sees only zeros from their own personal
    space.
  - A removed member sees zeros.
  - A stale `locals.space` gets 404.
- **WIB boundary**, 23:30 WIB 31 Dec vs 00:30 WIB 1 Jan (same UTC date): PASS.
  - `tahun-ini` on 2027-01-01 counts only 7.000, with 1 bar.
  - `bulan-lalu` counts only 1.000.
  - `monthlyTotals` splits Dec/Jan correctly.
- **60+ character merchant**: PASS. A 72-character title groups by equality with no D1 error. In e2e, a
  70-character title at 360 px causes no horizontal scroll.
- **No-JS** (e2e, `javaScriptEnabled: false`): PASS.
  - Status 200 with real figures.
  - The "Pemasukan" chip link switches the lists.
  - Radio + "Tampilkan" → `?arah=masuk&period=tahun-ini`.
- **360 px**: PASS (phone project + `expectNoHorizontalScroll`). Chip and segment targets are the kit's 44 px.
- **User copy**: PASS. The error state uses a fixed message. The test injects an error string containing a file
  path, and it is not shown.

## Checklist items applied

- **Bounded work.** Aggregates run in SQL, over a period of ≤ 366 days, with top-N `LIMIT` in SQL.
- **LIKE/GLOB.** None used; covered by the 60-character test.
- **100 params.** No list binding.
- **One currency per sum.**
- **Transfers excluded.**
- **WIB dates.**
- **Totals reconcile.**
- **One access rule.**
- **Keyed lists.** Keyed by index or currency code, never by merchant text.
- **i18n EN.** 14 new phrases; the unused "Laporan muncul…" removed.
- **Shared formatter.**
- **Truthful state.** Read-only: no saving or success state applies.
- **Accessibility.** h2 per section, 44 px targets, AA tokens only.
- **Gates.**
- **Fail-before.**

## Concerns

- The rebase onto main will touch `budgets/math.ts` and the end of `i18n-en.ts`.
- `lower()` is ASCII-only, so "KOPI É" and "kopi é" stay separate. Real merchant normalisation is FN-20.
- The tracker split for FN-09, and the `ACCEPTANCE.md` rename "Beranda = Riwayat = Laporan total", are left to
  `/ship`.
