# Engineer report — UI parity wave B (Laporan), cycle 1

Scope: `docs/design/APP_PARITY.md` § 3 (Laporan) and § 3a (visual language). Branch `ui-parity-b`, rebased on
`main` 131eb67 (wave A merged). No schema change, no migration.

## What works, per spec item

| Spec item | State | Where |
| --- | --- | --- |
| Header: segmented Bulanan/Tahunan + period stepper | Done. Kit `Segmented` inside a GET form (field `m`, works without JS; with JS it navigates at once) and kit `PeriodStepper` (links; next step disabled in the future; floor year 2000). URLs: `?p=YYYY-MM`, `?y=YYYY`, `arah=masuk`; the old `period=bulan-lalu`/`tahun-ini` links still open their period. | `src/lib/ui/laporan/PeriodNav.svelte`, `src/lib/shared/laporan-query.ts` |
| HeroAmount "Uang keluar" (or "Uang masuk") + "dari Rp… pemasukan · Rp… tersisa" | Done with kit `HeroAmount` (eye toggle; every Laporan amount honours it through `shown()`). Bold figures via `richParts`. A deficit reads "Rp… melebihi pemasukan" in red. Other currencies are listed on their own lines and never added in. | `src/routes/(app)/laporan/+page.svelte` |
| Monthly "Tren harian" heatmap calendar | Done. Mon–Sun grid, 4 steps `--heat-1..4` (ceil of quarters of the largest day), today outlined, future days blank, legend "sedikit ▢▢▢▢ banyak". Tapping a day opens `/riwayat?type=…&period=range&from=D&to=D`, which totals the same figure. | `src/lib/ui/charts/HeatCalendar.svelte`, `heatmapDays()` |
| "Tren pengeluaran": cumulative this month vs last month | Done. Accent line (this month through today) and grey line (whole month before, cut at this month's length / carried when shorter: Beranda's same-days rule). Tooltip pill (pointer or arrow keys), dashed "today" marker. ComparePill under it (money-out direction only: "lebih boros/hemat" is wrong wording for income). | `CumulativeChart.svelte`, `monthLines()` |
| Two columns "Tempat teratas" (rank, title, count ×, total) and "Pengeluaran terbesar" | Done (top 5 each, month view only as the spec places them). Biggest rows link to their edit page. | `largestTransactions()` (new aggregate), `merchantTotals()` |
| Right column "Ke mana uangnya" donut + category list | Done. Centre: label, compact total, "N kategori". Slices link to the category's Riwayat list; list rows show "62% · Rp313 rb/hari" (or "/bln" in the year view), amount and a chevron. Percentages are floored. Uncategorised rows have no filter in Riwayat, so they get no link. | `Donut.svelte`, `CategoryList.svelte` |
| Yearly "Tren bulanan" stacked bars | Done. Top 4 categories + Lainnya per month (segments add up to the month exactly), dashed average line with its label (floor of total ÷ months so far), legend chips, tap a bar for its total. | `StackedBars.svelte`, `yearStack()` |
| Yearly "Tren pengeluaran" cumulative vs last year | Done (12-month axis; ComparePill against the same months last year). | `yearLines()` |
| "Kategori dari waktu ke waktu" heatmap table | Done. Top 8 categories + Lainnya, cells shaded against the table maximum, row total; scrolls inside its own box at 360 px. | `CategoryGrid.svelte`, `categoryGrid()` |
| Two-column layout | Main ~740 px + side ~420 px at ≥ 1200 px; single column below. | page CSS |
| § 3a visual language | Panel fills, ink actions, `--accent` and `--heat-*` tokens (no fallbacks), category hues for the other series (`src/lib/ui/charts/series.css`), tabular figures. | — |
| Dev gallery | `/dev/ui/charts` (separate route, dev routes only, badged "Data demo"). | `src/routes/(app)/dev/ui/charts/` |

Figures: all of them come from SQL aggregates in `src/lib/server/transactions/aggregate.ts` (new
`categoryMonthlyTotals` and `largestTransactions` share `filterWhere`). That means the space is scoped through
`currentSpaceScope` → `requireSpaceAccess`, buckets use `occurred_on` (WIB), money is integer per currency with
BigInt sums, demo rows and transfers are excluded, and every scan is bounded (≤ 366 days, `LIMIT 5`). A figure past
2^53 is null and shown as "Total terlalu besar untuk ditampilkan", never rounded.

## TODO(wave-a) list

All placeholders are resolved after the rebase. HeroBlock → HeroAmount, ComparisonPill → ComparePill,
local stepper → PeriodStepper, local link segmented → kit Segmented in a GET form, ‹ › glyphs → chevron icons,
and the token fallbacks are removed. There is no `TODO(wave-a)` left in the diff.

## Deviations

- The tooltip pill is local to `CumulativeChart` (the kit has no tooltip component).
- The heatmap and donut taps go to Riwayat (the filtered list) rather than an in-page day list. This keeps
  "a figure equals the list it links to".
- The ComparePill is shown only for money out.
- The month view's per-day figure divides by the days so far (today's day of month), or by the whole month for a
  past month. The year view divides by the months so far.
- Removed e2e coverage: the FN-09 e2e tests for the old stat lines and radio periods are replaced by the wave B
  specs (heatmap day tap; Bulanan/Tahunan switch with and without JS; no horizontal scroll at 360 px).
  Equivalent server-side coverage for Laporan = Riwayat = Beranda totals stays in `test/integration/laporan.test.ts`.

## Gates

The steps were run separately, each under `flock /tmp/montra-heavy.lock`, because the RAM rule
forbids `npm run gates`:

- `npm run check`: `COMPLETED 1454 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` (exit 0)
- `npm run lint`: `All matched files use Prettier code style!`, eslint clean (exit 0)
- `npx vitest run --maxWorkers=2`: `Test Files 154 passed (154)`, `Tests 2223 passed (2223)` (exit 0)
- `npm run build`: exit 0
- `npx playwright test e2e/laporan.spec.ts e2e/shell.spec.ts --workers=1` (LD_LIBRARY_PATH workaround, port
  8871): `33 passed` (exit 0). No server was left running.

## Pre-handoff probes

- Cross-space: integration tests cover a member of a shared space, a non-member naming the space by cookie or
  query, a removed member, a stale `locals.space` (404), and two spaces that never mix in the new aggregates. Pass.
- Month boundaries: 23:30 WIB 31 Dec / 00:30 WIB 1 Jan (year, month, heatmap, lines, largest) and
  23:30 WIB 31 Oct / 00:30 WIB 1 Nov (heatmap cells, lines). Pass.
- 360 px: e2e `expectNoHorizontalScroll` on the month and year views (phone project). Pass. The first run caught a
  76 px overflow from absolutely positioned screen-reader text in the category table; it is fixed.
- No-JS forms: the e2e switches Bulanan → Tahunan with JavaScript off. Pass. Stepper and chips are plain links.
- User copy: no paths or ids. The load error stays the fixed FN-09 message.
- Concurrency, two tabs, two devices, money vectors: not applicable (the page is read-only and parses no money).

## Not verified

- Dark-mode contrast of the heatmap steps and chart text: not measured. The steps use wave A's dark tokens.
- Desktop two-column layout: only the e2e desktop project ran, with no visual review.
- English number format in the charts follows `locale`, but the English e2e did not run.

## Cycle 2 — QA fixes (QA_REPORT.md, 22993bc)

### Finding 1: desktop two-column layout

Laporan's wrapper is now `class="cols two-col"`, which opts into the shell's 1200 px content width
(`:has(.two-col)`) the way Beranda does. At ≥ 1200 px the columns are `minmax(0, 37fr) minmax(300px, 21fr)`:
740 : 420 at full width, keeping that ratio when the content is narrower. `.pair` ("Tempat teratas" / "Pengeluaran
terbesar") now splits on its column's own width (`.col { container-type: inline-size }`,
`@container (min-width: 600px)`) instead of the window's.

I measured this with Playwright on the desktop project, light and dark, with a 38-character merchant title:

| Viewport | `main` max-width | `.cols` columns | `.pair` columns | Narrowest title | Clipped amounts | Page overflow |
| --- | --- | --- | --- | --- | --- | --- |
| 1024 | 1280px | 696px (one column) | 338px 338px | 134 px | none | 0 |
| 1200 | 1280px | 530.75px 301.25px | 530.75px (one column) | 326 px | none | 0 |
| 1440 | 1280px | 683.86px 388.14px | 331.92px 331.94px | 128 px | none | 0 |

At 1440 px the columns are 684 + 388 px (the 1280 px cap minus the sidebar and padding), up from QA's 350 + 350 px.
Shots: `shots/cycle2-monthly-1440-light.png` and `shots/cycle2-monthly-1440-dark.png`.

### Finding 2: dark-mode heatmap level 4

I measured every token text colour on `--heat-4`. Light #6c63f0: `--bg`/white 4.49:1, `--ink` 4.00:1. Dark #8b85f5:
`--ink` 2.85:1, `--bg` 6.09:1. No text token clears AA on the light fill, and I may not change tokens.css. So level 4
keeps its full shade and draws the day number on a 26 px `--bg` dot with `--ink` text. That is the existing
`--ink` on `--bg` pair, ≥ 4.5:1 in both themes. Levels 0–3 keep `--ink-2` on `--chart-track` and `--ink` on
`--heat-1..3` (5.35:1 or better in both themes).

`test/contrast.test.ts` gains "AA heatmap day numbers (light/dark)". The test reads each level's text and fill from
`HeatCalendar.svelte`'s own CSS, requires both to be tokens, and checks ≥ 4.5:1 in each theme. Fail-before: on the
cycle 1 component, level 4 (`#fff` on `var(--heat-4)`) failed in both themes and levels 0–3 passed (`Tests 2 failed
| 54 passed`). After the fix: `56 passed`.

### Also fixed (my defect from cycle 1, not a QA finding)

The cycle 2 shots showed the hero's context line stacking word by word ("dari / Rp0 / pemasukan ·"). HeroAmount's
context slot is a grid, and the page passed it bare text nodes. The line is now wrapped in one `<p>`, as Beranda
does. Visible in the cycle 2 shots.

### Gates (cycle 2)

Each step was run separately under `flock /tmp/montra-heavy.lock`:

- `npm run check`: `COMPLETED 1454 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` (exit 0)
- `npm run lint`: `All matched files use Prettier code style!`, eslint clean (exit 0)
- `npx vitest run --maxWorkers=2`: `Test Files 154 passed (154)`, `Tests 2233 passed (2233)` (exit 0)
- `npm run build`: exit 0
- `npx playwright test e2e/laporan.spec.ts e2e/shell.spec.ts --workers=1` (LD_LIBRARY_PATH workaround, port
  8871): `33 passed` (exit 0). No server was left running.

### Still not verified

- Category emoji render as boxes in headless Chromium (no emoji font on this machine); the cause is the environment,
  not the page.
- The year view at 1440 px was not re-shot. It shares the same `.cols` and `.col` rules as the month view.
