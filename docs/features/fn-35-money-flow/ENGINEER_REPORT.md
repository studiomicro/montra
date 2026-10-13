# FN-35 Money-flow chart ("Alur uang") — engineer report, cycle 1

Branch `fn-35-money-flow` (from main 72dd561). No migration.

## What was built

- `moneyFlowTotals(db, spaceId, filter)` in `src/lib/server/transactions/aggregate.ts` (additive): one grouped SQL
  query on the shared `filterWhere`, grouped by `(type, category_id, wallet_id, currency)`, exact `CAST(SUM AS TEXT)`
  sums, `is_demo = 0`, and the money types selected **by name**: `t.type in ('income', 'expense')` (not
  `<> 'transfer'`), so transfers and FN-37's `adjustment` can never enter a flow whichever branch merges first.
- `src/lib/server/reports/money-flow.ts`: `moneyFlowReport(db, spaceId, month)` + pure `shapeMoneyFlow`. Currency =
  favourite wallet's (IDR without wallets), Laporan's rule. Other currencies are named (`otherCurrencies`) and counted
  (`otherCount`), never drawn or added in. A sum past 2^53 is `null` and propagates (chart replaced by "Total terlalu
  besar untuk ditampilkan"). (PRD signature had a `today` argument; it is not needed, so it was left out.)
- `src/lib/shared/money-flow.ts`: `?p=YYYY-MM` parsing (Laporan's month parameter and floor), stepping (reuses
  `stepPeriod`), and Riwayat hrefs (reuses `riwayatHref`).
- `flowLayout` in `src/lib/ui/charts/geometry.ts` + `src/lib/ui/charts/FlowChart.svelte` (placed with the other
  hand-drawn charts in `src/lib/ui/charts` per the task brief rather than `ui/kit`): plain SVG, drawn 1 unit = 1 px at
  the container width (bind:clientWidth; 360 before hydration), nodes as rounded panel rects with a colour strip
  (category hue via `series.css`, wallets `--accent`), bands as cubic strokes sized by amount. Text is ink/muted on
  `--panel`, never on a coloured fill.
- Route `/alur-uang` (`src/routes/(app)/alur-uang`): `currentSpaceScope` (→ `requireSpaceAccess`), period stepper
  (`PeriodStepper`), summary, currency caption, chart, "Rincian alur" text list (wallet totals and every link with
  exact amount, each row a ≥ 60 px link to the matching Riwayat list), loading skeleton, empty and error states.
- Reachability: sidebar Fitur section entry, a row in the Fitur sheet's "Buka fitur" list (always shown — owner
  decision B, no toggle), and "Lihat alur uang" on Laporan's month view. New icon `flow`.

## Acceptance criteria

1. Three columns from stored sums — integration "reconciles" tests; e2e checks `Gaji → BCA Rp 9.000.000`.
2. Income links into each wallet = `periodTotals({walletId, type:'income'})` — integration test (BCA, GoPay).
3. Expense links out of each wallet = `periodTotals({walletId, type:'expense'})` — same test; transfer out of BCA not counted.
4. One currency; caption "+N transaksi mata uang lain (USD) tidak ditampilkan." — integration (IDR drawn / USD
   favourite flips it), unit `shapeMoneyFlow` (SGD+USD named, never summed).
5. Empty month → "Belum ada alur uang" heading, no SVG — integration (empty report) + e2e.
6. No-flow wallet/category not a node — integration (idle wallet, last-month-only category absent; all links > 0) + unit.
7. Non-member / removed member / stale `locals.space` → 404 identical to Laporan's answer — integration.
8. Failing query → fixed `loadError`, log has `errorLabel` only (no D1 text) — integration; page shows `ErrorState` with retry.
9. English entries for every new phrase — `test/i18n-coverage.test.ts` passes.
10. 360 px: no horizontal scroll, nodes ≥ 44 px (min node 48 units, drawn 1:1) — e2e phone project. Bands are
    `pointer-events: none` on coarse pointers; the touch path for each link is its ≥ 44 px row in "Rincian alur".
11. Demo rows excluded — integration (a 1.23 M demo expense in Hiburan never appears).
12. Transfer and a non-income/expense row (`adjustment`, inserted with `PRAGMA ignore_check_constraints`) contribute to
    no link — integration test. **Fail-before proof:** with the filter swapped to `t.type <> 'transfer'` the test fails
    (`expected [['expense', 5000000], …] to deeply equal [['expense', 1000]]`); restored afterwards.

## Pre-handoff probes

- Cross-space: member sees shared flow; non-member naming the space (cookie/query) sees only own space; removed
  member sees nothing; stale space → 404 equal to Laporan's — PASS (`test/integration/alur-uang.test.ts`).
- Totals reconcile: flow in/out = Laporan `stats[0]` (950 000 000 / 11 000 000); each category node = `categoryTotals`;
  each wallet = `periodTotals` per wallet — PASS.
- Month boundaries: 23:30 WIB 31 Oct → October only (300), 00:30 WIB 1 Nov → November only (500) — PASS.
- 360 px: no horizontal scroll (seeded and empty), node targets ≥ 44 px, light + dark — PASS (e2e phone).
- User copy: no path or id; error text fixed — PASS. No-JS: period steps are plain links; nodes/rows are links — by construction (not separately e2e-tested).
- Not applicable: concurrency, two tabs/stale forms (read-only page), money vectors (no parsing), two devices.

## Gates (each run separately under the heavy-work lock; `npm run gates` not run per RAM rule)

- `npm run check`: `COMPLETED 1491 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`
- `npm run lint`: `All matched files use Prettier code style!`, eslint no output (clean)
- `npx vitest run --maxWorkers=2`: `Test Files 165 passed (165)`, `Tests 2329 passed (2329)`
- `npm run build`: `✔ done`
- `npx playwright test e2e/alur-uang.spec.ts --workers=1` (E2E_PORT=8795): `9 passed`

## Screenshots

`shots/360-light.png`, `shots/360-dark.png`, `shots/1440-light.png`, `shots/1440-dark.png` (produced by the e2e spec).
The phone full-page shots show the floating tab bar over the list mid-page (fixed element in a full-page capture).

## Not verified

- AA contrast measured by eye on screenshots only (ink/muted on `--panel`, tokens already used the same way elsewhere);
  no automated contrast check of the band colours (decorative; the list is the text alternative).
- Screen-reader behaviour of the SVG links (accessible names checked via Playwright's accessibility tree only).
- Very many categories/wallets (tall diagram) not stress-tested visually.
- FN-37 interplay tested only with a CHECK-bypassed row, not with FN-37's real migration.
