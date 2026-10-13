# FN-09 Reports (Laporan) — PRD

Catalog entry: `docs/FEATURES.md` › FN-09 (line 89-92). Phase: 1 — Core ledger. Tracker: `docs/TASKS.md` › Phase 1
› "FN-04 Wallets · FN-05 Transactions and history · FN-06 Categories · FN-07 Budgets · FN-08 Beranda · **FN-09
Laporan** · FN-10 Goals · FN-11 Drafts inbox · FN-12 Feature toggles · FN-13 PWA and push" (`docs/TASKS.md:61-62`).
Risk tier: **Medium** (no migration, no new auth/access-control subsystem, no write actions at all — strictly
lighter than FN-07/08, which rated Medium despite shipping a migration; the only reason it is not Small is that it
adds three new money-aggregating SQL query shapes to the one shared module FN-05 owns, and "Money is never
invented" means those queries get the same scrutiny as any other aggregate).

Owner decisions already fixed before this pass (do not re-litigate, per the brief): server-first in D1,
signed-in only, every query scoped by `event.locals.space.id` exactly as FN-07/08 already established for
Beranda (no client-supplied space id on this route); FN-05 (`docs/features/fn-05-transactions/PRD.md`) ships
`src/lib/server/transactions/aggregate.ts` and `src/lib/shared/dates.ts`; FN-07/08
(`docs/features/fn-07-budgets-beranda/PRD.md`) extends both with `sumExpenseByCategoryMinor`,
`sumExpenseByDayMinor`, `wibMonthRange`, `wibPreviousMonthRange` and friends — this feature is a **pure consumer**
of that module plus the three small, additive extensions described in Scope; it owns no migration (**no
`migrations/` file is added by this pass**) and performs no mutation at all. "Beranda total = Riwayat total =
Laporan total for the same filter" (the brief's own framing of `CLAUDE.md` › Data and runtime conventions) is true
here only because Laporan calls the exact same `periodTotals`/`sumExpenseByCategoryMinor`/`sumExpenseByDayMinor`
functions FN-05/FN-07 already built and tested, never a parallel SQL query.

## Goal

Beranda answers "how am I doing this month"; Riwayat answers "what exactly happened"; Laporan is the third,
free-forever insight screen the main journey needs before a user trusts the app with a whole month of spending:
"where did it go, and who did I pay the most?" (`docs/FEATURES.md:91`: "month and period summaries, per-category
and per-merchant breakdowns, in versus out"). Today `/laporan` is a permanent empty-state stub with no load
function at all (`src/routes/(app)/laporan/+page.svelte:1-11`). FN-09 turns it into a real report: in-versus-out
totals for a chosen period, a per-category breakdown (reusing `CategoryBar`), a per-merchant top list, and a
month-over-month trend (reusing `MonthLines` for a single month and `BarChart` for a year-to-date view) — every
figure computed by the one aggregate module every insight screen shares, so nothing on this page is a second,
independently-computed source of truth for a number Beranda or Riwayat already show.

## Scope

- **No migration.** This feature reads `transactions`/`categories` (FN-05/FN-06's tables) and writes nothing; no
  `migrations/*.sql` file is added.
- **`src/lib/shared/dates.ts`** (touched, additive — FN-05/FN-07 own this module; this feature adds one export,
  it does not change any existing one): `wibYearToDateRange(date: string): { fromDate: string; toDate: string }`
  → `{ fromDate: '<year>-01-01', toDate: date }` for the WIB year containing `date` — the one new date-range shape
  this feature needs that FN-07/08's `wibMonthRange`/`wibPreviousMonthRange` do not already provide.
- **`src/lib/server/transactions/aggregate.ts`** (touched, additive — the **only** module permitted to query
  `transactions`, per FN-05's own "Reuse / do not duplicate" note, `docs/features/fn-05-transactions/PRD.md:380-381`;
  this feature extends it, it does not fork a second query layer): three new exported functions, each
  parameterised, indexed and bounded (checklist › Data access › "Bounded work"), none changing the signature of
  any function FN-07/08 already depend on:
  - `sumIncomeByCategoryMinor(db, spaceId, fromDate, toDate)` — same shape and contract as FN-07/08's existing
    `sumExpenseByCategoryMinor` (`docs/features/fn-07-budgets-beranda/PRD.md:279-281`) but grouped over
    `type = 'income'` instead of `'expense'`; added as a **new** function, not a parameter added to the existing
    one, so FN-08's Beranda call site needs no change.
  - `sumByMerchantMinor(db, spaceId, fromDate, toDate, type: 'expense' | 'income', limit = 10)` →
    `{ title: string; amountMinor: number; count: number }[]`, grouped by `lower(trim(title))` (never `LIKE`/`GLOB`
    per checklist), rows with a blank/null title grouped under one bucket shown as "Tanpa judul"/"Untitled",
    transfers always excluded, `ORDER BY SUM(amount_minor) DESC LIMIT ?` computed in one SQL query — the display
    label for each group is the lexicographically smallest raw `title` seen in that group (a deterministic,
    arbitrary pick; real merchant-name normalisation is FN-20's job, Phase 2, not this feature's — see Out of
    scope).
  - `sumByMonthMinor(db, spaceId, fromDate, toDate, type: 'expense' | 'income')` →
    `{ month: string; amountMinor: number }[]`, one zero-filled row per WIB calendar month (`'YYYY-MM'`) touching
    `[fromDate, toDate]` (`GROUP BY substr(occurred_on, 1, 7)`), bounded to at most 12 rows since this feature only
    ever calls it with a year-to-date range (criterion 9 below) — the "month summaries" half of
    `docs/FEATURES.md:91`.
  - `periodTotals(db, spaceId, filter)`, `sumExpenseByCategoryMinor`, `sumExpenseByDayMinor` — **reused unchanged**
    (FN-05/FN-07's existing functions); this feature adds no new parameter to any of them.
- **Route:** `src/routes/(app)/laporan/+page.server.ts` (new — today `/laporan` has no server file at all) —
  `load` reads `period` (`'bulan-ini' | 'bulan-lalu' | 'tahun-ini'`, default `'bulan-ini'`) and `arah`
  (`'keluar' | 'masuk'`, default `'keluar'`) from the query string, resolves the matching WIB date range via
  `wibMonthRange`/`wibPreviousMonthRange`/`wibYearToDateRange`, and returns: `periodTotals` for the header (in vs
  out vs net, unfiltered by `arah` — always both directions), the matching category breakdown
  (`sumExpenseByCategoryMinor`/`sumIncomeByCategoryMinor` per `arah`), the matching merchant top-10
  (`sumByMerchantMinor` per `arah`), and the trend data: for `bulan-ini`/`bulan-lalu`, `sumExpenseByDayMinor` for
  the selected month and for `wibPreviousMonthRange(<selected month's fromDate>)` (the month immediately before
  it, whichever month is selected — `wibPreviousMonthRange`'s existing contract is already generic over "the
  month containing this date", not hard-coded to "last calendar month from today", so this is a reuse, not a
  reinterpretation); for `tahun-ini`, `sumByMonthMinor` over the year-to-date range. No actions — this route
  never writes.
- **`src/routes/(app)/laporan/+page.svelte`** (rewrite, replaces the stub at
  `src/routes/(app)/laporan/+page.svelte:1-11` entirely): a `Segmented` period picker (Bulan ini / Bulan lalu /
  Tahun ini), three stat lines (Pemasukan, Pengeluaran, Selisih — the "in versus out" mirror line, `Selisih` =
  `inMinor - outMinor`, shown with `--money-up`/`--money-in` colouring the same way `TransactionRow`'s direction
  colours already work), a `Chip` pair (Keluar/Masuk, default Keluar) governing which direction's category and
  merchant sections render below, a `CategoryBar` + ranked list (category emoji/label, amount, percent of the
  direction's total) for the per-category breakdown, a ranked list for the top-10 merchants (title, amount, a
  `trf('{n} transaksi', …)` count — reusing the exact existing template at `src/lib/shared/i18n-en.ts:52`), and
  the trend chart: `MonthLines` (this period vs the month before it) for `bulan-ini`/`bulan-lalu`, `BarChart`
  (one bar per WIB month elapsed this year, re-using its generic `{ label, minor }[]` prop shape — it has never
  required its bars to be *days*) for `tahun-ini`.
- **i18n:** every new Indonesian phrase added to `src/lib/shared/i18n.ts` call sites with an English entry in
  `src/lib/shared/i18n-en.ts`. `'Bulan ini'` and `'Periode ini'` already exist (`src/lib/shared/i18n-en.ts:80-81`)
  but `'Periode ini'` is **not reused** by this feature (Laporan's own three fixed periods are distinct from
  whatever "Periode ini" ends up meaning in Riwayat's filter — see Owner decision A); new phrases needed: `'Bulan
  lalu'`, `'Tahun ini'`, `'Pemasukan'`, `'Selisih'`, `'Pemasukan per kategori'` (the income-side counterpart to
  the already-seeded `'Pengeluaran per kategori'`, `src/lib/shared/i18n-en.ts:91`), `'Merchant teratas'`, `'Tanpa
  judul'`, `'Belum ada transaksi di periode ini.'`, and the `'Masuk'`/`'Keluar'` chip labels — `'Keluar': 'Out'`
  already exists (`src/lib/shared/i18n-en.ts:78`); `'Masuk': 'In'` is FN-05's addition
  (`docs/features/fn-05-transactions/PRD.md:106-107`) and this feature **reuses that exact key**, never re-adding
  it under a second phrase. The coverage test (`src/lib/shared/i18n.test.ts`) fails the build if one is missing.
- **UI states:** loading (skeleton stat lines + skeleton chart while `load` runs), empty (zero transactions in the
  selected period and direction: the three stat lines still render honestly at `Rp 0` — never hidden, matching
  Beranda's own "an honest number, not hidden" rule, `docs/features/fn-07-budgets-beranda/PRD.md:80-81` — only the
  category/merchant lists show `'Belum ada transaksi di periode ini.'` instead of an empty chart), error
  (`ErrorState` with retry on a failed load, never an unhandled 500). **No saving/success states apply** — this
  feature adds no form action and writes nothing; `CLAUDE.md`'s "loading, empty, error, saving and success" list
  is satisfied by the three states that actually exist on a read-only screen (no mutation, nothing to save).
- **UI kit reuse (no new primitives):** `Segmented`, `Chip`, `CategoryBar`, `BarChart`, `MonthLines`, `Skeleton`,
  `ErrorState`, `ScreenTitle`, `EmptyState` — all from `src/lib/ui/kit/` and `src/lib/ui/shell/`, reused exactly as
  FN-08 already uses them on Beranda. `formatMoney`/`formatMoneyCompact`/`moneyParts`
  (`src/lib/shared/money-format.ts:36,62,82`) for every figure.

## Out of scope

- Any write action, draft, or edit on this screen — Laporan is read-only this pass; `Chip`/`Segmented` just
  change the query string the same `load` re-runs against.
- A custom date-range picker ("Periode ini" as an arbitrary from/to range) — three fixed periods only this pass
  (Owner decision A); Riwayat's own "Periode ini" semantics (`docs/features/fn-05-transactions/PRD.md:76`) are
  not yet fully specified by FN-05 either, so this feature does not borrow an undefined contract.
- Real merchant-name normalisation/recognition (grouping "GOJEK*GOFOOD" and "Gofood" as one merchant) — that is
  FN-20's job (Phase 2); this feature's `sumByMerchantMinor` groups only by exact case/whitespace-normalised
  `title` text, nothing smarter.
- Exporting a report (PDF/CSV/share) — viewing only.
- Any "Semua" (all-directions) view of the category or merchant breakdown — categories and merchants are
  inherently directional (an expense category list and an income category list are different vocabularies); the
  Keluar/Masuk chip is mandatory context for those two sections, unlike Riwayat's list-level "Semua" chip.
- Budgets, safe-to-spend, or goals progress on this screen (FN-07, FN-10) — Laporan shows transaction-derived
  figures only.
- Assistant-generated commentary on the report (FN-22) — numbers and charts only, no generated text about them.
- A year picker (last year, two years ago) — `tahun-ini` is always the current WIB year to date; no year
  selector this pass.

## Acceptance criteria

**Period and direction selection**

1. Given no query parameters, when `/laporan` loads, then `period = 'bulan-ini'` and `arah = 'keluar'` are the
   defaults, and the WIB range used is exactly `wibMonthRange(wibTodayString())` — the current WIB month, never a
   UTC-boundary approximation.
2. Given the `Segmented` period picker set to "Bulan lalu", when the page re-renders, then every figure on the
   page (stat lines, category breakdown, merchant list, trend chart) is recomputed over
   `wibPreviousMonthRange(wibTodayString())` — no client-side re-derivation of any total from a previously loaded
   month's figures.
3. Given "Tahun ini", when selected, then every figure uses `wibYearToDateRange(wibTodayString())`, and the trend
   section switches from `MonthLines` to `BarChart` (one bar per elapsed WIB month this year, from `sumByMonthMinor`).
4. Given the Keluar/Masuk `Chip` pair, when "Masuk" is active, then the category breakdown uses
   `sumIncomeByCategoryMinor` and the merchant list uses `sumByMerchantMinor(..., 'income', 10)`; the three stat
   lines (Pemasukan/Pengeluaran/Selisih) do **not** change with this chip — they always show both directions for
   the selected period, from one call to `periodTotals`.

**In versus out (the FN-09 "Mirror" line: `docs/FEATURES.md:91`)**

5. Given any period, when the stat lines render, then `Pemasukan = periodTotals.inMinor`,
   `Pengeluaran = periodTotals.outMinor`, and `Selisih = inMinor - outMinor` (never computed a second time from
   the rendered category/merchant lists — the "totals reconcile" checklist item: a unit test sums the fixture
   rows directly and asserts the three figures match `periodTotals`'s own output exactly, proving **"Beranda
   total = Riwayat total = Laporan total for the same filter"** for the one function all three screens now share).
6. Given `Selisih < 0` (spent more than earned in the period), when it renders, then it is shown in `--money-up`
   (over, matching the over-budget colour FN-07 already uses for the same "spent more than" meaning,
   `docs/features/fn-07-budgets-beranda/PRD.md:157`); given `Selisih >= 0`, it renders in `--money-in`.
7. Given zero transactions anywhere in the selected period, when the page renders, then all three stat lines
   still show `formatMoney(0)` (an honest zero, never hidden) and the category/merchant sections show
   `'Belum ada transaksi di periode ini.'` instead of an empty chart.

**Per-category breakdown**

8. Given the Keluar chip active and at least one expense transaction in the period, when the category section
   renders, then `CategoryBar`'s stacked segments and the ranked list below it sum to exactly
   `periodTotals.outMinor` for that same period — not a separately-rounded or re-derived figure (checklist ›
   Money and dates › "Totals reconcile"), and each row shows its percentage as `floor(categoryMinor * 100 /
   outMinor)` (floor, never rounds up — the same "never overstate" discipline as FN-07's safe-to-spend rounding,
   `docs/features/fn-07-budgets-beranda/PRD.md:154-155`).
9. Given the Masuk chip active, then the same shape applies using `sumIncomeByCategoryMinor` and
   `periodTotals.inMinor`.
10. Given a category with zero amount in the period, when the list renders, then it is omitted entirely (both
    functions already filter zero-amount categories per their contract) — no "Rp 0" row ever shown in this list.

**Per-merchant breakdown**

11. Given at least one expense transaction with a non-blank `title` in the period, when the Keluar merchant list
    renders, then it shows at most 10 rows, ordered by amount descending, each with its total and a
    `trf('{n} transaksi', { n: count })` count; the sum of the shown rows is **less than or equal to**
    `periodTotals.outMinor` (there may be more than 10 distinct merchants; the list is a top-10, not an exhaustive
    breakdown, and never claims to be — no "and N more" total is fabricated for the untruncated remainder).
12. Given transactions with a blank or whitespace-only `title`, when grouped, then they appear as one
    `'Tanpa judul'`/`'Untitled'` row, never silently dropped and never one row per blank transaction.
13. Given two transactions with titles `"Kopi Kenangan"` and `"kopi kenangan "` (differing only in case/leading-
    trailing whitespace), when grouped, then they fall into the same merchant row (`lower(trim(title))` grouping)
    — a regression test asserts this exact pair collapses to one row with `count = 2`.
14. Given a 60+ character merchant title (pre-handoff-style probe, checklist › Data access › "LIKE and GLOB
    patterns" — this feature performs no `LIKE`/`GLOB` at all, grouping is by exact normalised equality, not
    pattern match), when it is the only transaction in the period, then the query completes without a D1 error —
    a regression test proves why grouping avoids the 50-byte `LIKE` pattern cap entirely by construction.

**Trend chart**

15. Given `period = 'bulan-ini'` or `'bulan-lalu'`, when the trend chart renders, then `MonthLines`'s `thisMonth`
    array is `sumExpenseByDayMinor` over the selected month's range and `lastMonth` is the same function over
    `wibPreviousMonthRange(<selected month's fromDate>)` — the month immediately before whichever month is
    selected, reusing FN-07/08's existing, already-generic function unchanged.
16. Given `period = 'tahun-ini'`, when the trend chart renders, then `BarChart` receives one bar per WIB month
    from January through the current WIB month (inclusive), each bar's `minor` equal to `sumByMonthMinor`'s
    expense total for that month under the Keluar chip (or income total under Masuk) — never more than 12 bars
    (bounded, per checklist › Data access › "Bounded work").
17. Given the WIB-boundary vectors (checklist › Money and dates › "WIB dates"), when a transaction occurs at
    23:30 WIB on the last day of a month and another at 00:30 WIB on the first day of the next month, then each
    falls into the correct respective month's bucket in every aggregate this feature calls — never off by one
    UTC day (the same vectors FN-05/FN-07 already test against `wibMonthRange`/`sumExpenseByDayMinor`; this
    feature's own regression test calls `wibYearToDateRange`/`sumByMonthMinor`/`sumByMerchantMinor` against the
    same fixture rows to prove its three new functions inherit the same correctness).

**Cross-cutting (engineering checklist, every item that applies to this feature)**

18. The `/laporan` load resolves the space through `event.locals.space.id` exactly as FN-08's Beranda load already
    does (`docs/features/fn-07-budgets-beranda/PRD.md:59-60`) — no route param or form field ever supplies a space
    id on this route; there is nothing for a cross-space probe to guess (same reasoning as
    `docs/features/fn-07-budgets-beranda/PRD.md:210-213`).
19. A pre-handoff cross-space probe (a second user, member of a different space, requesting `/laporan` with
    manipulated query parameters) never sees another space's figures — every aggregate call is parameterised on
    `locals.space.id`, never a client-supplied id.
20. `{#each}` lists (category rows, merchant rows, month bars) key by `category`/`title`-derived stable key or
    array index from a server-returned, already-deduplicated array — never by re-deriving a key from untrusted
    display text at render time in a way that could collide (the merchant grouping key is computed once, in SQL,
    before the list reaches the template).
21. Every Indonesian phrase added for this feature has an English entry in `i18n-en.ts`; `npm run test`
    (`src/lib/shared/i18n.test.ts`) fails if one is missing.
22. Currency display anywhere on `/laporan` uses `formatMoney`/`formatMoneyCompact`/`moneyParts`
    (`src/lib/shared/money-format.ts:36,62,82`); no hand-built `Rp` string; every date range shown or computed
    goes through `src/lib/shared/dates.ts`, never a raw UTC date.
23. Touch targets ≥ 44 px (the period `Segmented` and direction `Chip`, matching their existing kit defaults);
    WCAG AA contrast in both themes, including the `--money-up`/`--money-in` `Selisih` colouring (FN-00 token
    system, no new colours).
24. User-facing error text on this feature never contains a file path, stack trace, row id, or internal
    identifier.
25. Given JavaScript is disabled, when `/laporan` is requested, then the default period and direction
    (`bulan-ini`/`keluar`) render with real, server-computed figures via SSR; the `Segmented` and `Chip` controls
    are inert without JavaScript (the same accepted limitation FN-04/FN-05/FN-07 already carry for their own
    `Segmented`/`Chip` filters, e.g. `docs/features/fn-05-transactions/PRD.md:223-224`) — the page itself never
    500s with JavaScript off.
26. `npm run gates` (check, lint, test, build) is clean on the branch before hand-off; every new regression test
    (merchant case/whitespace-collapse, blank-title bucketing, 60+ character title, WIB year-boundary vector,
    "stat lines = `periodTotals`" totals-reconcile test, month-bar bound at 12) is shown failing on the unfixed
    code first (checklist › Tests › "Fail-before proof").

## Architecture notes

**Modules touched / added**

- `src/lib/shared/dates.ts` — add `wibYearToDateRange` only; every other export (`wibDateString`,
  `wibMonthRange`, `wibPreviousMonthRange`, `wibDaysRemainingInclusive`, `wibLast14Days`, …) is FN-05/FN-07's and
  is reused unchanged.
- `src/lib/server/transactions/aggregate.ts` — add `sumIncomeByCategoryMinor`, `sumByMerchantMinor`,
  `sumByMonthMinor` as described in Scope; `periodTotals`, `sumExpenseByCategoryMinor`, `sumExpenseByDayMinor`
  imported and called, never re-implemented.
- `src/routes/(app)/laporan/+page.server.ts` (new), `+page.svelte` (rewrite of the stub at
  `src/routes/(app)/laporan/+page.svelte:1-11`).
- `src/lib/ui/kit/CategoryBar.svelte`, `BarChart.svelte`, `MonthLines.svelte`, `src/lib/ui/kit/Segmented.svelte`,
  `Chip.svelte` — reused unchanged; `BarChart`'s props (`days: { label, minor }[]`) are already generic over any
  labelled bar, not literally "WIB days" — the year view passes month labels into the same prop, no component
  change.
- `src/lib/shared/i18n.ts`/`i18n-en.ts` — add every new phrase listed in Scope.
- `src/lib/ui/shell/nav.ts` — no change; `/laporan` is already a tab (`src/lib/ui/shell/nav.ts:20`).
- `src/params/stub.ts` — no change; `laporan` has never been in the stub `SLUGS` set
  (`src/params/stub.ts:1`) because it already had a real (empty-state) page before this feature.
- `test/helpers/d1.ts` (`withLocalD1`) — reused unchanged for Vitest coverage of the three new aggregate
  functions against a real local D1 with FN-05/FN-06's migration applied.
- Worker: app Worker only (SSR, load) — no `workers/jobs`/`workers/inbound` involvement; no write path exists on
  this route for a Queue/Workflow to ever need.

**Reuse / do not duplicate**

- No second space-authorization check; `locals.space.id` is already the validated current space for a route with
  no space-id param, exactly the FN-07/08 precedent.
- No second money formatter, WIB date module, i18n table, or aggregate-query layer against `transactions` — the
  three new functions live in FN-05's `aggregate.ts`, nowhere else.
- No new UI kit primitive — every chart/control this feature needs already exists; a year-view bar chart reuses
  `BarChart` as-is rather than adding a dedicated "month bars" component.

## Prerequisites

- No new external credentials. This feature uses only D1 (already bound). No "Belum dikonfigurasi" degraded
  state applies.
- **Build-order dependency (not a credential, but load-bearing):** this feature is implemented against FN-05's
  `aggregate.ts`/`dates.ts` and FN-07/08's extensions to both (`sumExpenseByCategoryMinor`,
  `sumExpenseByDayMinor`, `wibMonthRange`, `wibPreviousMonthRange`, `periodTotals`). If any of those has not
  merged when this feature's implementation starts, it is **blocked** on it per `docs/TASKS.md` phase ordering —
  do not stub a "pretend" aggregate (`CLAUDE.md` › "Money is never invented"), wait for the real ones, exactly the
  posture FN-07/08 itself took toward FN-05 (`docs/features/fn-07-budgets-beranda/PRD.md:269-271`).

## Tracker impact

- Closes the FN-09 slice of `docs/TASKS.md` › Phase 1's combined line (`docs/TASKS.md:61-62`); recommend the
  engineer tick/split this FN's row independently, continuing the split FN-04/FN-05/FN-07's PRDs already
  recommended.
- Moves `docs/ACCEPTANCE.md` rows:
  - "Beranda total = Riwayat total for the same filter" — recommend the qa-tester/owner **rename this row** to
    "Beranda total = Riwayat total = Laporan total for the same filter" once this feature lands (matching the
    exact framing the build brief uses) and move it toward a named check (Automated: Vitest proving criterion 5)
    once FN-05/FN-07/FN-09 are all built and the three screens' totals are compared against the same fixture
    rows; stays **Not run** until then.
  - "Month/day buckets use the WIB date (23:30 WIB on the last day)" — this feature's slice (criteria 3, 16, 17)
    extends coverage to year-to-date and month-grouped aggregates specifically; the row stays **Not run** overall
    until every feature touching `occurred_on` is covered.

## Owner decisions

**Every trade-off below is auto-accepted per owner instruction 2026-10-08 ("just auto accept your recomm"). No
question in this PRD is left open; the defaults below are the shipped behaviour.**

- **A. Period choices: three fixed periods, or a custom date-range picker.** *Auto-accepted default:* ship
  exactly three periods — Bulan ini, Bulan lalu, Tahun ini — with no arbitrary from/to picker this pass.
  *Trade-off:* a user who wants "1 Mar – 15 Apr" cannot build that range on this screen; the three fixed options
  cover the mirror's "month and period summaries" wording without inventing a new date-range UI whose contract
  Riwayat itself has not yet fully specified either (`docs/features/fn-05-transactions/PRD.md:76`'s "Periode ini"
  remains undefined pending that feature's own implementation).
- **B. Merchant grouping key: exact normalised text, or fuzzy/real merchant recognition.** *Auto-accepted
  default:* group by `lower(trim(title))` only, with the smallest raw title in each group chosen as the display
  label. *Trade-off:* "Kopi Kenangan" and "Kopi Kenangan Cabang Senopati" are two different merchant rows even
  though a human would call them the same shop; real normalisation needs FN-20's merchant-recognition work
  (Phase 2), which does not exist yet — building a bespoke fuzzy-match heuristic here would duplicate work FN-20
  is already scoped to do properly.
- **C. Merchant list size: top 10, or an exhaustive, paginated list.** *Auto-accepted default:* top 10 by amount,
  no pagination, no "show more." *Trade-off:* a user with 30 distinct merchants in a month cannot see merchant
  #11 onward from this screen; Riwayat's search (FN-05) already lets them find any individual merchant's
  transactions directly, so a paginated exhaustive list here would duplicate that path for a "report" screen
  whose job is a summary, not a full listing.
- **D. Trend chart for the year view: 12 month-bars via `BarChart`, or a dedicated new chart component.**
  *Auto-accepted default:* reuse `BarChart` unchanged, feeding it month labels/totals instead of day
  labels/totals. *Trade-off:* `BarChart`'s tap-a-bar readout and horizontal-scroll behaviour were designed for 14
  daily bars; with at most 12 month bars the scroll affordance is mostly unused (all 12 fit most phone widths),
  which is a harmless, slightly oversized touch target rather than a defect.
- **E. Category/merchant sections when "Semua" rather than a direction is selected.** *Auto-accepted default:*
  no "Semua" option exists for the direction chip on this screen — only Keluar/Masuk, defaulting to Keluar.
  *Trade-off:* none significant; a combined expense+income category list would mix two different category
  vocabularies (expense categories vs. income categories) into one ranked list, which would misrepresent "percent
  of total" for either direction — splitting them is the more honest reading, not a limitation to fix later.
