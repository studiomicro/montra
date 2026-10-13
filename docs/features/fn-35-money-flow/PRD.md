# FN-35 Money-flow chart ("Alur uang") — PRD

Catalog entry: `docs/FEATURES.md` › FN-35 (Phase 1b, owner request 2026-10-08, `docs/design/APP_PARITY.md` § 4).
Tracker: `docs/TASKS.md` › App layout parity › "New features seen in the reference app (PRDs first): FN-34 streak
/ close the day, FN-35 money-flow chart, recurring transactions, balance adjustment type." This PRD closes the
FN-35 slice of that line. Risk tier: **Medium** (no schema change, but a new shared aggregate function every
later reader must treat as authoritative, plus a non-trivial new SVG layout that must reconcile exactly with
Laporan's existing totals).

## Goal

A user who asks "where did my money actually go this month" today has to mentally connect three separate screens:
Beranda's expense total, Laporan's per-category breakdown, and Dompet's wallet balances. The reference app's
"follow the money" view draws the connection directly — income sources flowing into wallets, wallets flowing out
into spending categories — as one picture for one month. It adds no new data and makes no new claim: every link
is a sum of rows already in the ledger, grouped a new way.

## Scope

- **`src/lib/server/transactions/aggregate.ts`** (the file that already states "the only functions that sum or
  list `transactions`"): add **`moneyFlowTotals(db, spaceId, filter)`**, two grouped queries reusing the existing
  `filterWhere` clause —
  - income rows of the period grouped by `(category_id, wallet_id)`, summed per currency;
  - expense rows of the period grouped by `(wallet_id, category_id)`, summed per currency.
  Same rules as every other function in this file: live rows only, one space, `is_demo = 0` excluded, one
  currency per sum, `occurred_on` (WIB) bucketing, bounded by `MAX_FILTER_DAYS`. This is additive — no existing
  export from `aggregate.ts` changes shape.
- **`src/lib/server/reports/money-flow.ts`** (new, alongside `laporan.ts`): `moneyFlowReport(db, spaceId, today,
  month)` — picks the favourite wallet's currency (Laporan's existing rule, `src/lib/server/reports/laporan.ts:165`),
  calls `moneyFlowTotals`, and shapes three node lists (income categories, wallets, expense categories) plus a
  link list `{ from, to, amountMinor }` with amounts in that one currency; a wallet or category with no flow in
  the month is left out, never shown as a zero-width link. Other-currency rows are reported as
  `otherCurrencies: string[]` (left out of the diagram, never added in — same rule `laporanReport` already
  follows at `src/lib/server/reports/laporan.ts:203-205`).
- **`src/lib/ui/kit/FlowChart.svelte`** (new): a plain SVG three-column diagram — nodes as labelled rounded rects,
  links as simple curved paths sized by amount (thicker = more), using `--accent` and the existing category hues
  from `docs/design/tokens.css` (no new tokens, no chart library, per `CLAUDE.md`). Tap/click a link or node →
  same category or wallet filter Laporan's donut already supports (`docs/design/APP_PARITY.md` § 3 "tap a slice →
  category").
- **Route `/alur-uang`** (new, reached from the Fitur section/sheet like `/kekayaan`, `/langganan`): period
  stepper (month only this pass, reusing the existing period-stepper kit component), the `FlowChart`, and a
  caption line stating the one currency shown and, when non-empty, "+N transaksi mata uang lain tidak
  ditampilkan." Loading/empty (no income or expense that month)/error/success states per `CLAUDE.md`.
- **i18n:** page title, node-less/empty-month copy, the other-currency caption, and the Fitur sheet's new row
  label, all through `tr()`/`trf()` with English entries.

## Out of scope

- Transfers in the flow diagram (a transfer is wallet-to-wallet, not income-to-wallet or wallet-to-category; it
  stays excluded, matching every other FN-05 aggregate's transfer rule).
- Balance adjustments in the flow diagram (FN-37; once that type exists it is excluded here for the same reason
  it is excluded from every other total).
- A period picker beyond one month (no year view, no custom range) — Laporan already owns multi-period reporting;
  this view answers one question for one month.
- A Fitur toggle entry that persists a user's choice to hide "Alur uang" (Owner decision below: not built this
  pass; the page simply exists or does not, like Laporan).
- Any cross-currency conversion or invented exchange rate to merge currencies into one diagram.
- Exporting the diagram as an image or PDF.
- Recomputing or caching the flow server-side; every load recomputes from live rows (same as Laporan today).

## Acceptance criteria

1. Given a space with income and expense rows in the selected WIB month, when `/alur-uang` loads, then it shows
   three columns (income categories, wallets, expense categories) and every link's amount is a real stored sum —
   never interpolated, estimated or rounded beyond the shared money formatter.
2. Given the same month, when the income-side link amounts into a wallet are added up, then the total equals that
   wallet's income total for the month from `periodTotals`/`categoryTotals` with `type: 'income'` for the same
   filter — the diagram's numbers reconcile with Laporan's and Beranda's, not a second source of truth.
3. Given the same month, when the expense-side link amounts out of a wallet are added up, then the total equals
   that wallet's expense total for the month from the same filter, for the same reason.
4. Given a month with income or expense in more than one currency, when the page renders, then exactly one
   currency (the favourite wallet's, or IDR without wallets) is drawn, and the caption names any other currency
   left out — no currency is silently summed into another.
5. Given a month with zero income and zero expense, when `/alur-uang` loads, then it shows the defined empty
   state (no blank SVG, no crash).
6. Given a wallet or category with no flow in the month, when the diagram renders, then it does not appear as a
   node (no zero-width or invisible link).
7. Given a request for `/alur-uang` from a user who is not a live member of the space (or a removed member),
   when the load runs, then it answers exactly like any other space-scoped route under `requireSpaceAccess` — 404,
   never a different status, body or timing that reveals the space exists (`docs/ENGINEERING_CHECKLIST.md` ›
   "One access rule").
8. Given the server-side query fails, when the page renders, then it shows the loading/error state defined for
   this route, never an unhandled exception, and the rest of the shell (nav, Fitur entry) still works.
9. Given the UI language is English, when the page title, captions and empty/error states render, then every
   phrase has an English entry (`docs/ENGINEERING_CHECKLIST.md` › "i18n").
10. Given 360 px width, when the three-column SVG renders, then it fits without horizontal scroll (columns stack
    or scale down; the SVG is responsive, not a fixed pixel width) and any tap target (a node, a link) is ≥ 44 px
    on a coarse pointer.
11. Given `Data demo` rows exist in the space, when the diagram renders, then they are excluded from every link
    (same rule as every other FN-05 aggregate) — never shown as real flow.
12. Given a transaction later becomes a balance-adjustment type (FN-37) or is already a transfer, when
    `moneyFlowTotals` runs, then that row contributes to no link (verifies the exclusion named in Out of scope is
    actually enforced in the query, not just documented).

## Architecture notes

- Touches: `src/lib/server/transactions/aggregate.ts` (new export only — `moneyFlowTotals`, additive);
  `src/lib/server/reports/money-flow.ts` (new); `src/lib/ui/kit/FlowChart.svelte` (new, joins `MonthLines.svelte`,
  `BarChart.svelte`, `CategoryBar.svelte` as the kit's hand-drawn SVG chart family); a new route under
  `src/routes/(app)/alur-uang/+page.server.ts` + `+page.svelte`; the Fitur sheet (wave C, `docs/design/APP_PARITY.md`
  § 3 "Fitur sheet") gains one more row once that sheet exists — if this PRD ships before wave C, the route still
  works reached only by direct link/nav entry until the sheet catches up.
- Reuses, unchanged: `filterWhere`/`TransactionFilter` and the favourite-wallet-currency rule
  (`src/lib/server/reports/laporan.ts:164-165`); `formatMoney` (`src/lib/shared/money-format.ts`, same as every
  other screen); the period-stepper and donut-tap-to-filter kit components already built for Laporan.
- No migration: every input already exists in `transactions`, `wallets` and `categories`. `moneyFlowTotals` must
  exclude `type = 'transfer'` the same way `dailyTotals`/`categoryTotals`/`monthlyTotals` already do
  (`src/lib/server/transactions/aggregate.ts:332,367,412`), and must exclude `type = 'adjustment'` the same way
  once FN-37 lands (coordinate: whichever of FN-35/FN-37 merges second updates the other's exclusion list, since
  `aggregate.ts` is the one shared module both must agree on).

## Prerequisites

None. No new secret, provider or credential. Uses the existing D1 binding only.

## Owner decisions

- **A — Where the page lives.** Default: a dedicated route `/alur-uang` reached from the Fitur section (like
  Kekayaan/Langganan), not a tab inside Laporan. Trade-off: one more nav entry/Fitur row rather than a segmented
  option on an existing page; chosen because the reference app treats it as its own screen and because Laporan's
  page is already dense (`docs/design/APP_PARITY.md` § 3).
- **B — Fitur toggle.** Default: **no togglable module this pass** (no migration to `feature_flags.module`'s
  CHECK constraint) — the page exists for everyone, same as Laporan. Trade-off: a user cannot hide the Fitur
  sheet row; adding the toggle later is a small follow-up (one migration touching
  `migrations/0007_feature_flags.sql:9` and `src/lib/shared/feature-flags.ts`) if the owner wants parity with how
  Kekayaan/Langganan/Barang/Koleksi behave.
- **C — Node granularity on the expense side.** Default: expense categories, not merchants (matches Laporan's
  existing "Ke mana uangnya" donut, which already groups by category) — merchant-level flow would need a fourth
  column and is a bigger diagram than the brief asks for. Trade-off: a user cannot see "GoPay → Starbucks" in one
  picture this pass, only "GoPay → Kopi."
