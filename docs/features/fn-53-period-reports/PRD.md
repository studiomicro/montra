# FN-53 Quarterly and yearly money flow, and a net-worth report — PRD

Catalog entry: `docs/FEATURES.md` › FN-53 (owner request 2026-10-13: "add quarterly and yearly moneyflow, net worth
report"). Extends FN-35 (`docs/features/fn-35-money-flow/PRD.md`, `/alur-uang`, which is month-only) and FN-25/FN-25b
(Kekayaan; daily `net_worth_snapshots`, 30-day change, trend chart). No reference-app parity is claimed; this is ours.
Tracker: no open `docs/TASKS.md` item covers it (the nearest finished line is "FN-35 money flow `/alur-uang`
(2026-10-08, no migration)", which this extends without reopening). `/ship` adds one new line and moves it to
`docs/HISTORY.md` when done.

**Risk tier: Large** (`/build-feature`): one migration (0046, additive column), a money calculation that every reader
must be able to reconcile, and a change to the jobs Worker's snapshot write. Full sequence: engineer, QA and red team,
full e2e on `main` before the deploy that ships it.

## Goal

Today a user can ask "where did my money go" only one month at a time (`/alur-uang`) and "how is my wealth moving"
only as a daily line and a 30-day figure (`/kekayaan`). The questions people actually ask at a quarter's end or at
New Year are "what came in and went out over the whole quarter or year, and how does that compare with the one
before" and "was I richer or poorer at the end than at the start, by how much, and what moved it". FN-53 answers
both from rows the app already stores, with no new estimate: the money-flow picture and breakdown aggregated over a
calendar quarter or year (WIB), and a net-worth report for a month, quarter or year (opening value, closing value,
change in rupiah, monthly points, change by asset group). Nothing is invented: a figure is a sum of stored rows or a
stored snapshot, and where a snapshot is missing the page says so.

## Scope

### A. One shared period type (`src/lib/shared/report-period.ts`, new, pure, client and Worker)

- `ReportPeriod`: `bulan {month}` | `kuartal {year, quarter 1–4}` | `tahun {year}`. Calendar quarters by WIB date:
  Q1 Jan–Mar, Q2 Apr–Jun, Q3 Jul–Sep, Q4 Oct–Dec. Built on `monthRange`, `shiftMonth`, `monthsBetween`, `addDays`,
  `daysBetween` (`src/lib/shared/dates.ts:105-166`) and the floor `LAPORAN_MIN_YEAR` (2000,
  `src/lib/shared/laporan-query.ts:10`). Laporan's `LaporanView` and `/laporan` URL grammar are not changed.
- URL grammar (plain query parameters, same style as Laporan's `p`/`y`): `?p=YYYY-MM` month (already used by
  `/alur-uang`, `src/lib/shared/money-flow.ts:10-14`), `?k=YYYY-Qn` quarter (e.g. `k=2026-Q3`), `?y=YYYY` year. If
  several are present the order is `k`, then `y`, then `p`; an unparsable value is ignored and the next parameter is
  tried; none valid means the page's default. `?m=bulan|kuartal|tahun` is the switcher's form field (no-JS): it
  converts the period named by the other fields into that kind (month → its quarter or year; quarter → its last
  month so far, or its year; year → its last quarter so far; Laporan's `switchMode` rule,
  `src/lib/shared/laporan-query.ts:91-101`).
- Clamping: a future period becomes the current one; before 2000 becomes 2000 (`parseLaporanQuery` rule,
  `laporan-query.ts:35-59`). Never throws.
- Helpers (all pure): `parseReportPeriod(params, today, defaultKind)`, `reportPeriodHref(path, period, today,
  defaultKind)` (the default period is the plain path), `stepReportPeriod(period, ±1, today)` (null in the future or
  below the floor), `switchReportKind(period, kind, today)`, `periodDates(period, today)` and
  `previousPeriodDates(period, today)`.
- `periodDates` returns `{ from, to, months[], elapsedMonths, partial }`. For a **current quarter or year**, `to` is
  `today` and `months` runs through today's month (the year rule Laporan already uses,
  `laporan-query.ts:72-76`, so a Tahun total here equals Laporan's Tahun total). A past period uses its full dates.
  A **month keeps FN-35's behaviour** (the whole calendar month, `monthRange`, even when current).
- `previousPeriodDates`: the previous period of the same kind, compared like with like: if the period is still
  running (including the current month, capped at today for this purpose only), the previous period is cut at the
  same day offset from its start, clamped to its own end; a complete period is compared with the whole previous
  one. A year is at most 366 days, a quarter at most 92, so every range satisfies `MAX_FILTER_DAYS`
  (`src/lib/server/transactions/aggregate.ts:48,114-118`; a leap year spans 365 days apart and must not throw).

### B. Money flow for Bulan, Kuartal, Tahun (`/alur-uang`, extended in place)

- Route `/alur-uang` keeps its path and its month default. `+page.server.ts` (`src/routes/(app)/alur-uang/
  +page.server.ts:11-23`) parses the period with `parseReportPeriod` (default `bulan`, this WIB month) instead of
  `parseFlowMonth`; `parseFlowMonth`/`alurUangHref`/`stepFlowMonth` stay as thin month wrappers so existing links
  (Laporan's "Lihat alur uang", nav) keep working.
- `moneyFlowReport` (`src/lib/server/reports/money-flow.ts:175-195`) takes a `ReportPeriod` and `today`. It still
  calls `moneyFlowTotals` once with the period's `{from, to}` (`aggregate.ts:758-788`; grouped by type, category,
  wallet, currency; income and expense only, live rows of one space, `is_demo = 0`). It additionally returns:
  - `previous`: `inMinor`, `outMinor`, `netMinor` (null when too large) and `hasRows` for the previous period,
    from one `periodTotals` call (`aggregate.ts:211`) in the same currency;
  - for Kuartal and Tahun: `months[]` (`{month, inMinor, outMinor}`, one `monthlyTotals` call,
    `aggregate.ts:468-483`) and `averagePerMonth` (`{inMinor, outMinor}` = `floorPer(total, elapsedMonths)`,
    `src/lib/server/reports/laporan.ts:184-188`, so a total past `Number.MAX_SAFE_INTEGER` stays null);
  - the same `currency` rule as today (favourite wallet's, IDR without wallets, `money-flow.ts:193`),
    `otherCurrencies`/`otherCount`, `truncated`.
- **Fold into "Lainnya" (Kuartal and Tahun only; Bulan unchanged).** `foldMoneyFlow` (pure, exact via `sumExact`):
  at most 7 income categories and 7 expense categories by amount, the rest folded into one node keyed `in:*` /
  `out:*` named "Lainnya"; at most 6 wallets, the rest folded into `w:*` named "Dompet lainnya". A fold happens only
  when it would absorb two or more nodes (never a "Lainnya" holding exactly one). Folding merges links that share
  both ends, so node sums, link sums and the period totals all stay exact. Rows without a category stay their own
  "Tanpa kategori" node (`''`) and count toward the cap. Folded nodes have no Riwayat link (no filter can express
  them) and are drawn like any node.
- Page, top to bottom, for all three kinds:
  1. Period header (see C), subtitle = the dates, e.g. "Kuartal 3 · Jul–Sep 2026", with "sejauh ini" when partial.
  2. Totals line (existing `{masuk} masuk · {keluar} keluar`) and the existing caption naming the one currency and
     the other-currency count.
  3. **Perbandingan** (new, all kinds): three short lines — masuk, keluar, selisih — each "Rp … lebih banyak / lebih
     sedikit / sama dari {periode sebelumnya}" in rupiah (never percent, `docs/design/DESIGN_SYSTEM.md:23`), the
     direction carried by words and a glyph as `ComparePill` does (`src/lib/ui/kit/ComparePill.svelte:24-25`),
     colour only for the net line's sign. When the previous period has no rows: "Belum ada data {periode}"
     (the `CompareLine` pattern, `src/lib/ui/laporan/CompareLine.svelte:19-21`), never "lebih hemat/boros". For a
     partial period a note says what it was compared with ("dibanding Q2 sampai 13 Jun").
  4. **Rata-rata per bulan** (Kuartal and Tahun): masuk and keluar, with "dibagi {n} bulan berjalan" (Laporan's
     rule: the current month counts as one month).
  5. The existing `FlowChart` (`src/lib/ui/charts/FlowChart.svelte`) and "Rincian alur", unchanged in look.
     In Kuartal and Tahun the lists show the 12 largest links per direction and one non-link row "Alur lainnya
     ({n})" with their exact sum, so the list still adds up to the totals. Node and link taps open Riwayat for the
     same period as a date range (`/riwayat?type=…&period=range&from=…&to=…&category=…&wallet=…`; `flowRiwayatHref`
     gains a range form beside its month form, `money-flow.ts:32-52`; Riwayat already parses a 366-day range,
     `src/lib/shared/riwayat-query.ts:17,53-62`).
  6. **Per bulan** (Kuartal and Tahun): a grouped list, one row per month so far (`Okt '26 · +Rp … · −Rp …`), each
     linking to that month's Alur uang. The rows' sums equal the period totals.
  7. `ChevronLinks`: "Lihat di Laporan" (the Bulan/Tahun period's Laporan; Kuartal links to Laporan's Tahun of that
     year, since Laporan has no quarter) and, new, "Lihat laporan kekayaan" to the same period in D.
- Loading (skeleton while the period changes, as today `+page.svelte:39-43`), empty ("Belum ada pemasukan atau
  pengeluaran di {periode}"), error (`ErrorState` with retry, fixed copy), success.

### C. Period switcher (shared by B and D)

- New `src/lib/ui/laporan/ReportPeriodNav.svelte`, modelled on `PeriodNav.svelte` (a GET form with field `m` plus
  hidden fields for the current period, a "Tampilkan" button only before hydration, then `goto` on change;
  `src/lib/ui/laporan/PeriodNav.svelte:20-58`) and the existing `Segmented` + `PeriodStepper` kit components.
  Three options "Bulan | Kuartal | Tahun". Stepper steps are plain links, so Back returns to the previous period and
  the page works without JavaScript. Stepper label: month `Okt '26`, quarter `Q3 '26`, year `2026` (same text in
  both languages).
- 360 px: the three-option control is wider than the two-option one Laporan keeps on one row with the stepper
  (`PeriodNav.svelte:70-74`), so below 600 px it sits on its own full-width row under the title and the stepper
  below it; ≥ 1024 px both sit inline in the title's actions slot. No horizontal scroll, every target ≥ 44 px on a
  coarse pointer (the stepper steps already are, `PeriodStepper.svelte:61-66`).
- `PeriodNav.svelte` (Laporan's) is not modified.

### D. Net-worth report (new route `/kekayaan/laporan`, "Laporan kekayaan")

Reached from a new row under the trend chart on `/kekayaan` ("Laporan kuartal dan tahun") and from B's chevron link.
Default period: the current quarter (so far). Works for Bulan, Kuartal and Tahun with the C switcher
(`?p=` / `?k=` / `?y=`). Read-only: no form action. The Kekayaan module toggle (FN-12, `src/lib/shared/
feature-flags.ts:8`) only hides the menu row, as for `/kekayaan`; the route still answers, with the same
"disembunyikan dari menu" note.

- **Data (`src/lib/server/net-worth/period.ts`, new, `netWorthPeriodReport(db, spaceId, period, today, live)`)**:
  - One bounded query of the period's `net_worth_snapshots` rows (`space_id`, `deleted_at is null`, `date` between
    `from` and `min(to, today)`, `order by date`, `limit 400`; the primary key `(space_id, date)`,
    `src/lib/server/db/schema.ts:1653-1654`, serves it) returning `date, total_minor, partial, classes`.
  - One lookup of the latest **complete** snapshot (`partial = 0`) with `date <= from − 1 day`, `limit 1`
    (the query shape of `netWorthChange`, `src/lib/server/net-worth/summary.ts:246-249`).
  - For a period that contains today only: the live summary (`readPriceBook` + `netWorthSummary`, exactly what
    `/kekayaan` loads, `src/routes/(app)/kekayaan/+page.server.ts:108-120`) so the closing value equals the number
    on the Kekayaan hero. A past period reads snapshots only (no KV, no wallet-sum scan).
  - Folding into monthly points and the boundary rules below is pure TypeScript over those ≤ 400 rows.
- **Boundary rules (no invented value, always labelled):**
  - *Opening* = the latest complete snapshot dated on or before the day before `from`, but no more than **7 days**
    before it (basis `exact` when dated exactly that day, else `earlier`; the date is always shown). If none
    qualifies: the first complete snapshot inside the period (basis `since_start`, shown as "sejak {tanggal}"). If
    still none: no opening, change unavailable.
  - *Closing* = for the current period the live total (basis `live`, "sekarang"); for a past period the latest
    complete snapshot dated inside the period (at or before `to`). A snapshot dated before `from` is never a closing
    value (that would claim "no change" for a period with no records).
  - Opening and closing must be two different snapshots; otherwise change is unavailable ("Belum cukup catatan
    untuk menghitung perubahan"). A value is never interpolated or carried forward past a snapshot's own date.
  - A *partial* snapshot (a price or rate was missing that day, `summary.ts:423-426`) is never an opening or closing
    value, as in `netWorthChange` (`summary.ts:231-236`); the live total is allowed to be partial exactly as the
    Kekayaan hero is, and then carries the same "sebagian harga belum tersedia" note.
- **Output**: `openingMinor/Date/basis`, `closingMinor/Date/basis`, `changeMinor` (BigInt subtraction, null when
  not safe), `points[]` (below), `groups[]` (below), `foreign` (the live `rates` when any non-IDR holding exists,
  for the caption).
- **Monthly points**: an "awal" point (the opening value) then one point per month so far: the latest snapshot of
  that month (complete or partial, `partial` flagged), or the live total for the current month. A month with no
  snapshot is a **gap**: no point, and the line is not drawn across it. New `PeriodTrend.svelte` in
  `src/lib/ui/net-worth/` (modelled on `TrendChart.svelte`, hand-drawn SVG, no library): month slots on the x axis, a
  read-out pill (keyboard-steppable), partial points hollow, gaps visible as empty slots.
- **Change by group (needs migration 0046, section F)**: when both the opening and the closing snapshot (or the live
  summary) carry a `classes` record, a list of `NET_WORTH_CLASSES` (`src/lib/shared/net-worth.ts:55-74`; labels from
  `NET_WORTH_CLASS_LABELS`) with opening, closing and change in rupiah, sorted by the size of the change (largest
  first: this is the "largest movers" list), classes that did not change omitted. A class absent from one side's
  record counts as 0 there. The group changes add up to `changeMinor` exactly (both totals are the sum of their
  classes, `summary.ts:163-165`). Debt is phrased by what happened to the debt ("Utang berkurang Rp …" is good,
  "Utang bertambah Rp …" is bad) while its number follows the signed convention; the colour follows the effect on
  net worth. If either boundary lacks `classes`: the section shows "Rincian per kelompok tersedia mulai {tanggal}"
  (the date of the space's first snapshot with `classes`, or "setelah pembaruan berikutnya" when none), never a
  guess. Item-level movers (one stock, one wallet) are out of scope: no per-item history is stored.
- **Page**: `ScreenTitle` + C; hero = the change ("Naik" / "Turun", `+Rp`/`−Rp` with U+2212, green/red by sign,
  both words and sign, never colour alone) via `HeroAmount`, with its eye toggle; under it "dari {awal} ({tanggal})
  menjadi {akhir} ({tanggal | sekarang})" and a basis note when not `exact` ("dihitung sejak 3 Jan: belum ada
  catatan sebelum itu"); the monthly trend; "Perubahan per kelompok"; the foreign-rate caption ("Aset mata uang
  asing dinilai dengan kurs harian; perubahan bisa berasal dari kurs", with the rate dates the live summary
  already exposes); `ChevronLinks`: "Kembali ke kekayaan bersih", "Lihat alur uang" (same period).
- Loading, empty ("Belum ada catatan kekayaan di periode ini. Catatan harian mulai setelah kamu menambahkan dompet
  atau aset." with links to `/dompet` and `/kekayaan?aset=baru`), error (`ErrorState` + retry; a KV or price
  outage never fails the page, items fall back to manual values as on Kekayaan), success.

### E. i18n

Every new Indonesian phrase through `tr()`/`trf()` with an entry in `src/lib/shared/i18n-en.ts` (the test that fails
without one covers this): period kind labels and aria labels, quarter and year titles, "sejauh ini", comparison
lines, average caption, "Lainnya"/"Dompet lainnya"/"Alur lainnya ({n})", "Per bulan", all net-worth report headings,
basis notes, gap/empty/error texts, the Kekayaan entry row. Server messages (load-failed texts) are `msg()` constants
like `FLOW_LOAD_FAILED` (`money-flow.ts:19`).

### F. Migration `migrations/0046_net_worth_snapshot_classes.sql`

Number: next free after 0045 at `47d9811`; recheck other open branches (FN-52's among them) at build time and
renumber if it collides.

- `ALTER TABLE net_worth_snapshots ADD COLUMN classes text` with `CHECK (classes is null or json_valid(classes))`.
  Nullable, no default, no backfill (old rows stay null; a value would have to be invented). Shape: a JSON object
  `{ "<NetWorthClass>": <IDR minor integer> }`, only classes that hold something, debt negative, exactly the
  `summary.classes` of the run that wrote the row. Update `schema.ts:1633-1661` to match and keep the schema-wide
  export/purge tests green (`net_worth_snapshots` is exported as a whole table, `src/lib/server/export/tables.ts:132`).
- `upsertSnapshot` (`summary.ts:310-350`) gains an optional `classes` argument written on insert and overwritten on
  conflict under the same `setWhere` (a partial run never replaces a complete day), and `snapshotSpace`
  (`summary.ts:408-434`) passes `summary.classes` (left null if any class is null "too large"). Existing callers and
  tests that pass no `classes` keep working (null).
- Anything that tombstones a snapshot must also null `classes` (grep every `deleted_at` write on this table).
- `workers/jobs` imports `writeSnapshots` (`workers/jobs/src/net-worth.ts:5`): no new binding, no cron change, but
  it must be redeployed. Remote order: apply 0046 first (additive, old code ignores the column), then deploy the app
  and jobs Workers. RUNBOOK notes the Time Travel bookmark before the remote apply; local and remote commands stay
  separate.

## Out of scope

- "Year to date" and custom date ranges as separate choices: the current quarter and year already run "so far" to
  today, and Riwayat covers arbitrary ranges.
- PDF, CSV or image export, sharing links, e-mail or push of these reports, and agent-report (FN-23) changes.
- Quarter in Laporan (`/laporan` keeps Bulanan/Tahunan unchanged); quarter in the public API
  (`/api/v1/laporan/ringkasan`) and in Tanya's tools.
- Fiscal or non-calendar quarters; weeks.
- Net-worth history for periods before the first snapshot (no reconstruction from the ledger even though
  `walletTransactionsSums(upTo)` exists, `src/lib/server/transactions/wallet-sum.ts:23-45`: foreign holdings and
  priced items cannot be revalued for a past day without inventing a rate or price), and any backfill of `classes`.
- Item-level or wallet-level net-worth movers; splitting the change into "saved from income − expense" versus
  "revaluation and other" (a residual that would mix currencies and manual edits); the previous period's own change
  beside this one; forecasts.
- Merchant-level flow; cross-currency conversion of the flow (one currency is drawn, others are named, as FN-35).
- Server-side caching of any of this (every load recomputes from live rows, as Laporan and FN-35 do).
- Changing the month view of Alur uang beyond adding the comparison lines (no fold, no new nodes).

## Acceptance criteria

Verification level in brackets: **Automated** (Vitest, local D1), **Browser** (Playwright), **Mocked** (fakes; none
needed here, no provider is called). Test data is fictional; setup goes through the app's own actions. "Two-space"
tests use two users in two spaces.

Periods and URL
1. Given `today` = 2026-10-13, when `parseReportPeriod` reads `k=2026-Q3`, `y=2025`, `p=2026-05`, `k=2026-Q5&y=2025`,
   `k=2027-Q1`, `y=1999`, `p=garbage`, then it returns Q3 2026, year 2025, May 2026, year 2025, the current quarter
   (future clamps), 2000, and the default period; `k` wins over `y` over `p`; it never throws. [Automated]
2. Given each quarter, when `periodDates` runs, then Q1 = 01-01..03-31, Q2 = 04-01..06-30, Q3 = 07-01..09-30, Q4 =
   10-01..12-31; for 2028 (leap) the year is 2028-01-01..2028-12-31 and a query over it does not throw
   `RangeError('period out of range')`. [Automated]
3. Given the current quarter or year, when `periodDates` runs on 2026-10-13, then `to` is `2026-10-13`, `months` is
   `['2026-10']` for Q4 and `2026-01..2026-10` for the year, `partial` is true; given a past period, the full dates
   and `partial` false; given the current month, `to` is the month's last day (FN-35 unchanged). [Automated]
4. Given `previousPeriodDates` for Q4 2026 on 2026-10-13, then the previous range is 2026-07-01..2026-07-13 (same
   day offset); for the complete Q3 2026 it is the whole Q2; for year 2026 on 2026-03-31 it is 2025-01-01..2025-03-31;
   for the 31st of a month the offset is clamped to a shorter previous month. [Automated]
5. Given the stepper, when a period is the current one, then "next" is disabled; at Q1 2000 / 2000 / 2000-01 "previous"
   is disabled; each step is a link whose `href` re-parses to the stepped period (round trip). [Automated]
6. Given `?m=kuartal` on a month, quarter or year, then the result is that month's quarter / the same quarter / the
   year's last quarter so far (Q4 for a past year); `?m=tahun` and `?m=bulan` likewise; this works with JavaScript
   disabled (GET form with a visible "Tampilkan" button before hydration). [Automated + Browser, JS off]
7. Given the user steps Bulan → Kuartal → Tahun and presses the browser Back button twice, then each earlier
   period and its URL return (every change is a navigation, not a client-only state), and reloading any URL shows the
   same period. [Browser]

Money flow
8. Given income and expense rows spread over a quarter, when `/alur-uang?k=…` loads, then every link, node and total
   is an exact stored sum, and the totals equal `periodTotals` for the same `{from, to}` and the Riwayat range list the
   totals link to (checklist: "Totals reconcile"). [Automated]
9. Given a year, then the sum of the `Per bulan` rows' in and out equals the year's in and out, and equals Laporan's
   Tahun `stats[0]` for the same year (same space, same date cap). [Automated]
10. Given WIB boundary rows `occurred_on` 2026-12-31 (entered 23:30 WIB = 16:30 UTC) and 2027-01-01 (00:30 WIB =
    2026-12-31 17:30 UTC), when the report runs for year 2026 and year 2027, then the first counts only in 2026 / Q4 2026
    / Dec 2026 and the second only in 2027 / Q1 2027 / Jan 2027; the same pairs at 03-31/04-01, 06-30/07-01,
    09-30/10-01 fall on the correct side of each quarter. A UTC-bucketing bug must fail this test. [Automated]
11. Given more than 7 expense categories (and, separately, more than 7 income categories, more than 6 wallets) in a
    quarter or year, when the report is shaped, then exactly the 7 (6) largest are nodes, the rest are one "Lainnya"
    (or "Dompet lainnya") node, the folded node's amount equals the exact sum of the folded nodes, link sums per
    node are unchanged, and the sum of all expense nodes equals the period's expense total. Given exactly 8 expense
    categories, then all 8 are shown and no "Lainnya" is drawn. Bulan with 9 categories shows all 9 (unchanged). [Automated]
12. Given a quarter, then "Rata-rata per bulan" is `floor(total / elapsedMonths)` per direction: a complete quarter
    divides by 3, Q4 on 2026-10-13 by 1 with the caption "dibagi 1 bulan berjalan", and an amount past
    `Number.MAX_SAFE_INTEGER` shows "Total terlalu besar untuk ditampilkan", never a rounded number. Test amounts
    where `total / n` is not an integer (the figure is floored). [Automated]
13. Given the previous period, then each comparison line shows the difference in rupiah between the two exact sums
    with the words "lebih banyak", "lebih sedikit" or "sama"; no percent appears; a previous period with no rows shows
    "Belum ada data {periode}" and no "lebih hemat/boros"; a partial period names what it was compared with. [Automated + Browser]
14. Given income and expense in two currencies in the period, then exactly one currency (the favourite wallet's, IDR
    without wallets) is drawn, the caption names the others and their row count, and no amount of one currency is
    added into another's total, average or comparison (the comparison uses the same currency). [Automated]
15. Given transfers, balance adjustments (FN-37), a merged own-transfer pair (FN-48c: the debit row became a
    transfer, the credit row is a tombstone), deleted rows and `Data demo` rows in the period, then none contributes to
    any link, total, average, comparison or month row; an unmatched Transfer-keluar/-masuk row (still expense/income)
    does count, and the existing caption says transfers between wallets are not counted. [Automated]
16. Given the current quarter, when a row dated after today exists (future-dated), then it is not in the quarter or
    year totals; it is in the month view of its month (documented difference, month unchanged). [Automated]
17. Given a period with no income and no expense, then the defined empty state shows (no blank SVG, no crash, no
    NaN), the chevron links still work; given the query fails, the error state with retry shows and the shell still
    works. [Automated + Browser]
18. Given more than `MONEY_FLOW_MAX_GROUPS` groups, then `truncated` is true and the existing warning shows for the
    period ("Terlalu banyak alur …", wording generalised from "bulan ini"). [Automated]

Net-worth report
19. Given complete snapshots on 2026-06-30 (Rp 100.000.000), 2026-07-31 (Rp 110.000.000), 2026-08-31
    (Rp 120.000.000) and 2026-09-30 (Rp 130.000.000) and no others, when Q3 2026 is requested, then opening =
    2026-06-30 `exact` (Rp 100.000.000), closing = 2026-09-30 (Rp 130.000.000), change = +Rp 30.000.000, and the
    points are awal, Jul, Aug, Sep with those values. [Automated]
20. Given the last complete snapshot before Q3 is 2026-06-26 (4 days earlier), then opening basis is `earlier` with the
    date shown; given it is 2026-06-15 (15 days earlier, over the 7-day limit) and the first complete snapshot inside
    Q3 is 2026-07-04, then opening is that one with basis `since_start` and the page says "sejak 4 Jul". Given no
    complete snapshot at all, then change is unavailable and the page says why; never zero. [Automated]
21. Given a past period whose only complete snapshot dated at or before its end is from before the period began, then
    there is no closing value (change unavailable), not "no change". Given exactly one complete snapshot in the period
    and no usable opening, then change is unavailable. [Automated]
22. Given a complete snapshot on 2026-09-28 and a partial one on 2026-09-30, when Q3 2026 is requested, then the closing
    value is the 09-28 figure (a partial snapshot is never an opening or closing value) and the Sep point is the 09-30
    figure drawn hollow with the partial note. [Automated]
23. Given a month with no snapshot in a quarter, then its slot is a gap: no point and no line segment across it; the
    read-out says "Belum ada catatan". [Automated + Browser]
24. Given the current period, then the closing value is the live total and equals the Kekayaan hero total for the same
    state (same prices, same wallets), labelled "sekarang"; a KV outage still renders with manual values. Given a past
    period, then no KV or wallet-sum query runs (assert through statement counting). [Automated]
25. Given snapshots carrying `classes` at both ends, then each group row shows opening, closing and rupiah change; the
    rows sum to the total change exactly (use values whose naive float sum would differ); unchanged groups are
    omitted; rows sort by absolute change; a debt that fell reads "Utang berkurang" with a positive effect and one that
    grew reads "Utang bertambah" with a negative one. Given an unknown class key in the JSON, it is shown under
    "Lainnya", never dropped. [Automated]
26. Given either boundary snapshot has `classes = null`, then the group section shows the "tersedia mulai {tanggal}"
    note and no numbers, while the total change still shows. [Automated]
27. Given the jobs Worker tick runs, then `upsertSnapshot` stores `classes` equal to the run's `summary.classes`; a
    later partial run the same day does not overwrite a complete day's `total_minor` or `classes`; the statement
    budget `SNAPSHOT_SPACE_STATEMENTS` (`summary.ts:273`) still holds (its existing test passes unchanged). [Automated]
28. Given a snapshot dated 2026-12-31 and one dated 2027-01-01, then they fall in Q4 2026 / year 2026 and Q1 2027 /
    year 2027 respectively as opening, closing or points; the Dec point of 2026 is the 12-31 value. [Automated]
29. Given foreign-currency holdings, then values are the stored IDR figures, the caption states they use daily rates
    and shows the rate dates; no new conversion happens in this feature. Given none, no such caption. [Automated]
30. Given a space with only `Data demo` items, then the report is empty (demo is excluded from snapshots,
    `summary.ts:124`) with the empty state, and no demo figure appears. [Automated]

Access, privacy and states (both routes)
31. Given a user who is not a live member of the current space, or a removed member, when `/alur-uang` or
    `/kekayaan/laporan` loads, then it answers like every space-scoped route under `requireSpaceAccess`
    (`src/lib/server/spaces/current.ts:9-15`): 404 with the same body, no existence oracle; signed-out → redirect to
    `/masuk`. No space id is read from the URL. [Automated]
32. Given two users in two spaces, each with distinct rows and snapshots, when each loads every period kind, then
    neither sees any figure, category, wallet name, snapshot date or class of the other; a member of a shared space
    (owner or member role) sees the same figures as the owner. [Automated]
33. Given amounts are hidden (eye cookie), when either page is server-rendered, then every figure is masked in the
    first HTML (both pages call `applyAmountsHiddenAtLoad()` before their markup; `/alur-uang` does not today,
    `+page.svelte:18,23-24`), including the comparison lines, averages, month rows, group rows and the read-out; the
    net-worth trend line, area, dots, its rising/falling colour and the group bars are not drawn (as
    `TrendChart.svelte:88-98`); dates and labels stay. [Automated + Browser]
34. Given 360 px width in light and dark, then both pages have no horizontal scroll, the switcher is on its own row,
    the diagram and trend fit, targets ≥ 44 px on a coarse pointer, AA contrast holds; at ≥ 1024 px the switcher
    sits in the title row. [Browser]
35. Given keyboard-only use, then the segmented control (radio group), stepper links, trend slider (arrow keys) and
    chart links are reachable, headings do not skip a level, and focus is sensible after a period change. [Browser]
36. Given English UI, then every new phrase, `trf()` template and server message has an English entry (the i18n test
    passes), quarter titles read naturally ("Quarter 3 · Jul–Sep 2026"), and money is formatted only through the shared
    formatters (`Rp 1.264.000`, compact `Rp5,24 jt`, expense `−Rp` with U+2212). [Automated]
37. Given user-visible copy and errors, then none contains a file path, SQL, an id or an error message (loaders log
    only `errorLabel(e)`). [Automated]
38. Given a hidden Kekayaan module, then `/kekayaan/laporan` still answers (not 404) with the existing note. [Automated]

Performance and bounds
39. Given a space with 20,000 live transactions in the year and 366 snapshots, then `/alur-uang?y=…` runs at most 5 D1
    statements for the report (wallets, `moneyFlowTotals`, `periodTotals` for the period and for the previous
    period, `monthlyTotals`; record the exact number the build ends with and assert it) and none loads raw
    transaction rows into the Worker; `/kekayaan/laporan` for a past year runs at most 2 statements (period
    snapshots, opening lookup). Assert by statement counting. [Automated]
40. Given a space with 100 categories and 30 wallets, then the folded flow has at most 8 income, 7 wallet and 8 expense
    nodes, renders without overflow at 360 px, and the link lists are capped at 12 per direction plus the remainder
    row. [Automated + Browser]

Checklist items turned into criteria (`docs/ENGINEERING_CHECKLIST.md`)
- D1 bounded work / aggregates in SQL (AC 39, 40); no growable `inArray` (the new queries bind scalars only; if a
  list is ever bound, `json_each`); no LIKE.
- Migration: 0046 is re-runnable in the repo's sense, never edits an applied file; RUNBOOK gets the Time Travel note
  (section F); `npm run db:migrate:local` runs on a DB at 0045 and on a fresh DB. [Automated]
- Money/dates: integers only, one currency per sum, sign convention, WIB vectors incl. 23:30/00:30 (AC 10, 28),
  totals reconcile (AC 8, 9, 25).
- Access: one access rule, no existence oracle (AC 31, 32); untrusted text: category and wallet names are rendered
  as text only, never HTML, clipped by `FlowChart`'s `clip`.
- UI: i18n (AC 36), shared currency formatter, truthful state (read-only pages show nothing as "saved"), a11y (AC 34,
  35), keyed `{#each}` by node key / month / class, never by user text.
- Tests: `npm run gates` clean; every regression test shown failing before its fix; no real providers in tests
  (there are none here); pre-handoff probes that apply: cross-space crawl, month boundaries, 360 px, no-JS forms
  (switcher), user copy.

## Architecture notes

- Reuse, unchanged: `moneyFlowTotals`, `periodTotals`, `monthlyTotals`, `MONEY_ROWS`/`EFFECTIVE_AMOUNT` (FN-49
  substitution, so a split bill counts the payer's share here too) in `src/lib/server/transactions/aggregate.ts`
  (the only module that sums `transactions`; no addition needed unless the engineer wants a month-keyed flow);
  `shapeMoneyFlow` (`money-flow.ts:82-172`) and its tests as the base of the fold; `floorPer`, `floorPercent`
  (`laporan.ts`), `sumExact`/`amountIn` (`src/lib/server/budgets/math.ts`); `FlowChart`, `Segmented`,
  `PeriodStepper`, `HeroAmount`, `ErrorState`, `Skeleton`, `ChevronLinks`, `GroupList`; `netWorthTrend`
  (`src/lib/server/net-worth/trend.ts:22-37`) is not used (daily points, 3,660-row cap) — the report has its own
  bounded query; `readPriceBook` + `netWorthSummary` for the live value; `currentSpaceScope` for access.
- New: `src/lib/shared/report-period.ts` (+ test), `src/lib/server/net-worth/period.ts` (+ test),
  `src/lib/ui/laporan/ReportPeriodNav.svelte`, `src/lib/ui/net-worth/PeriodTrend.svelte`, route
  `src/routes/(app)/kekayaan/laporan/{+page.server.ts,+page.svelte}` (a static segment beside
  `kekayaan/tabungan/[id]`; no clash), `migrations/0046_…sql`.
- Changed: `src/routes/(app)/alur-uang/*`, `src/lib/server/reports/money-flow.ts`, `src/lib/shared/money-flow.ts`,
  `src/lib/server/net-worth/summary.ts` (`upsertSnapshot`, `snapshotSpace`), `src/lib/server/db/schema.ts`, the
  Kekayaan page (one row under the trend), Laporan's chevron links (Tahun gets "Lihat alur uang" with `?y=`,
  `src/routes/(app)/laporan/+page.svelte:415-417` shows it for the month view only today), `i18n.ts`/`i18n-en.ts`.
- Workers: app Worker for all pages; `workers/jobs` redeployed for the snapshot write (no config change);
  `workers/inbound` untouched.
- Performance: the transaction scans use `transactions_space_day_idx (space_id, deleted_at, occurred_on)`
  (`migrations/0004_transactions_categories.sql:49`), so a year is one index range; groups are bounded by (categories
  + 1) × wallets × currencies, independent of period length, with the 1,000-group cap and `truncated` flag
  (`aggregate.ts:737,775-776`). No new index. Compute stays on the server in SQL; the client only draws SVG. If the
  engineer finds the year's grouped query slow on a seeded 50,000-row space, report it before adding an index.
- Tests to extend or add: `src/lib/server/reports/money-flow.test.ts`, `src/lib/shared/money-flow.test.ts`,
  `test/integration/alur-uang.test.ts`, `test/integration/kekayaan-page.test.ts` (its `upsertSnapshot` seeding at
  `:188,248-262` shows the pattern), `e2e/alur-uang.spec.ts` (seed helper, screenshots into this feature folder), a
  new `test/integration/period-reports.test.ts` and `e2e/period-reports.spec.ts`.

## Prerequisites

None. No new secret, provider or credential; `.dev.vars.example` is unchanged. The live net-worth value reads the
price cache the jobs Worker already fills (`CACHE` KV); when it holds no prices the report behaves exactly like
`/kekayaan` (items fall back to manual values, "N belum dihitung" note). Group changes depend on snapshots written
after 0046 is applied and the jobs Worker is redeployed: until then the page says "Rincian per kelompok tersedia mulai
…" (unavailable, not zero).

## Tracker impact

- `docs/TASKS.md`: no existing open line. `/ship` adds and closes "FN-53 period reports (owner request 2026-10-13,
  migration 0046)" and records evidence in `docs/HISTORY.md`. Nothing is unblocked or blocked by it.
- `docs/ACCEPTANCE.md` (rows change only with a named check): "Month/day buckets use the WIB date (23:30 WIB on the last
  day)" (Not run) may move to Automated, citing AC 10 and 28 in `test/integration/period-reports.test.ts`, only if
  QA also names the month and day checks; "Beranda total = Riwayat total for the same filter" and "Space isolation on
  every load, action and sync push/pull" stay Not run (this feature adds evidence for Alur-uang, Riwayat and Laporan
  reconciliation and two-space isolation, not the whole row); "Foreign currency converted at the day's rate, original
  kept" stays Not run (this feature converts nothing). The 360 px row's Browser evidence gains
  `e2e/period-reports.spec.ts`.

## Owner decisions

Answer once before the build. Each has a proposed default; the build follows the default if unanswered.

1. **Period choices.** Bulan, Kuartal, Tahun only. Default: no "year to date" and no custom range (the current quarter
   or year already runs to today; Riwayat takes ranges). Trade-off: no "last 90 days" style view.
2. **Where the net-worth report lives.** Default: its own page `/kekayaan/laporan`, linked from Kekayaan and from Alur
   uang, not a section of the Kekayaan page. Trade-off: one more route; chosen because Kekayaan already loads wallets,
   items, prices, trend and cards and has its own `?rentang=` control.
3. **Group changes need migration 0046 (a `classes` JSON column on daily snapshots).** Default: yes. Trade-off: group
   change exists only for periods whose boundaries were recorded after the jobs Worker is redeployed (no backfill,
   by rule: no invented values); older periods show total change only. The alternative (no migration) would ship the
   report with totals and trend only, no "change by group", and drop the risk tier to Medium.
4. **Current-period closing value.** Default: the live total, equal to the Kekayaan hero. Trade-off: the current-period
   report runs the same wallet-sum and price-cache reads as `/kekayaan` (a past period costs two small queries).
5. **Opening value when the boundary day has no snapshot.** Default: carry the latest complete snapshot back at most
   7 days and always print its date; beyond 7 days use the first complete snapshot inside the period ("sejak …");
   months without any snapshot are gaps, never bridged. Trade-off: a short outage shows "earlier" dates; a space
   younger than the period shows a shorter span, stated.
6. **Average per month divisor.** Default: months so far including the current month (Laporan's rule), caption says
   so. Alternative: completed months only. Trade-off: the current-quarter average is low in its first weeks.
7. **How many nodes before "Lainnya".** Default: 7 categories per side and 6 wallets, Kuartal and Tahun only (month
   unchanged), never fold a single node. Trade-off: a user with 9 categories sees 7 + Lainnya in a quarter but all 9
   in a month.
8. **Comparison on Bulan too.** Default: yes, the three comparison lines appear on the month view as well (additive).
   Trade-off: touches the live FN-35 page; the alternative is Kuartal and Tahun only.
9. **Default period.** Default: Alur uang opens on the current month (as now); the net-worth report opens on the
   current quarter so far. Trade-off: the two pages open on different kinds.
10. **Quarter label.** Default: "Q3 '26" on the stepper in both languages, "Kuartal 3 · Jul–Sep 2026" in the
    subtitle (English "Quarter 3 · Jul–Sep 2026").
11. **Plan gating.** Default: none; Free, like Laporan, Alur uang and Kekayaan (FN-30 lists "budgets and reports" as
    Free, `docs/FEATURES.md` FN-30). Trade-off: forgoes a possible Pro hook later.
12. **AI credits, retention, caching.** Default: no AI and no credits; no new retention rule (snapshots are kept as
    now: at most 366 rows per space per year, `classes` adds about 100 bytes each, about 37 KB per space per year);
    no server cache. Trade-off: recomputed on every load.
13. **Laporan gets Kuartal too?** Default: no (out of scope). Trade-off: Laporan stays Bulanan/Tahunan while Alur uang
    has three kinds; Laporan's richer charts would each need a quarter variant.
14. **Export or share (PDF, CSV, image).** Default: not in this pass.

## Owner decisions — answered 2026-10-13

- Group split: yes. Migration 0046 adds the nullable `classes` JSON column to `net_worth_snapshots`; no backfill, so
  older periods show the total change only. (Number it after the highest migration on main when built: main has
  0043–0045 now.)
- Report page: its own page, `/kekayaan/laporan`, linked from Kekayaan.
- Every other default accepted: average per month over months so far including the current one; more than 7
  categories or 6 wallets fold into "Lainnya" on Kuartal and Tahun; the month view also gets the vs-previous-period
  line; opening value carried back at most 7 days with its date printed, otherwise a gap; Laporan stays without
  Kuartal; no plan gating.
