# QA report — UI parity wave B (Laporan)

**Verdict (cycle 2 re-check): PASS** — see "Re-check (cycle 2)" below. Cycle 1 verdict below is kept for history.

## Cycle 1

**Verdict: FAIL**

Server-side logic, scoping, money exactness and WIB bucketing are solid and fully covered by tests (all gates
clean). But the two areas the engineer explicitly flagged as "not verified" are both broken on inspection:
the desktop two-column layout never reaches its spec proportions (it collapses to a single ~740 px box with a
large dead gutter, and that squeeze causes text to overlap/clip in "Tempat teratas" and "Pengeluaran terbesar"),
and dark-mode heatmap level-4 cell digits fail WCAG AA contrast. Both are concrete, reproducible, spec-violating
defects (APP_PARITY § 3 "Two-column layout", § 3a colours; ENGINEERING_CHECKLIST "AA contrast in both themes").

## Commands run

- `flock /tmp/montra-heavy.lock npm run check` — `COMPLETED 1454 FILES 0 ERRORS 0 WARNINGS` (exit 0), real toolchain (svelte-check + tsc).
- `flock /tmp/montra-heavy.lock npm run lint` — `All matched files use Prettier code style!`, eslint clean (exit 0), real toolchain.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2` — `Test Files 154 passed (154)`, `Tests 2223 passed (2223)` (exit 0), local D1/Vitest, no real external provider.
- `flock /tmp/montra-heavy.lock npm run build` — `✓ built` (exit 0), real Vite/adapter-cloudflare build.
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=8893 npx playwright test e2e/laporan.spec.ts e2e/shell.spec.ts --workers=1` — `33 passed` (exit 0), real Chromium against a local `wrangler dev` (phone + desktop projects), no mocked AI/provider involved (page is read-only).
- No new migration in the diff (`git diff main --name-only` has nothing under `migrations/`), so `db:migrate:local` was not re-run; `scripts/migrate-local.ts` was used only to provision the ad hoc screenshot server's local D1 (fresh `.wrangler/e2e-state-8894`), confirming the existing migration set still applies cleanly.
- Manual Playwright screenshot script (own `wrangler dev` on port 8894, same LD_LIBRARY_PATH workaround) — 9 required shots + 2 supporting crops captured into `docs/features/ui-parity-b/shots/`; server process killed afterwards (`kill -9` on the wrangler/workerd/esbuild tree; verified no listener on 8894 and no stray wrangler/workerd/vite processes).

## Checked criteria (APP_PARITY § 3 Laporan + § 3a)

| Item | Verdict | Evidence |
| --- | --- | --- |
| Segmented Bulanan/Tahunan + stepper, `m` GET switch, old `period=` links | PASS | `src/lib/shared/laporan-query.ts` (`parseLaporanQuery`, `switchMode`), `laporan-query.test.ts` lines 44-46 cover `period=bulan-lalu`/`tahun-ini`; e2e "the Bulanan/Tahunan switch..." and "without JavaScript..." both pass. |
| HeroAmount "Uang keluar"/"Uang masuk" + sub-line, deficit wording | PASS | `+page.svelte` lines 151-180; `laporan.test.ts` net/deficit cases. |
| Monthly heatmap (Mon–Sun, 4 steps, today outlined, future blank, tap→Riwayat) | PASS (data/behaviour); dark contrast FAILS — see Finding 2 | `HeatCalendar.svelte`; e2e heatmap-tap test passes; contrast computed below. |
| Cumulative "Tren pengeluaran" (this vs last month/year), ComparePill | PASS | `CumulativeChart.svelte`, `monthLines`/`yearLines`, `laporan.test.ts`. |
| "Tempat teratas" / "Pengeluaran terbesar" (top 5, month only) | FUNCTIONALLY PASS, visually broken at desktop width — see Finding 1 | `largestTransactions`/`merchantTotals` in `aggregate.ts`; rows link to edit page. |
| Donut + category list, floored %, no link for uncategorised | PASS | `Donut.svelte`, `CategoryList.svelte`, `categoryRows` in `+page.svelte`. |
| Yearly stacked bars (top 4 + Lainnya, exact segment sum, avg line) | PASS | `yearStack()`, `laporan.test.ts` exactness assertions. |
| Yearly cumulative vs last year | PASS | `yearLines()`. |
| "Kategori dari waktu ke waktu" heatmap table | PASS | `categoryGrid()`, `CategoryGrid.svelte`; scrolls inside its own box (e2e no-horizontal-scroll). |
| Two-column layout: main ~740 px + side ~420 px at ≥1200 px | **FAIL** — Finding 1 | measured below. |
| § 3a visual language (fills not frames, ink actions, one accent, dark tokens) | PASS except dark heat-4 text — Finding 2 | tokens match spec formula exactly (see below); segmented/chips use ink, no blue fills observed. |
| Dev gallery `/dev/ui/charts`, badged demo | PASS (not independently re-verified beyond code read; low risk, dev-only route) | `src/routes/(app)/dev/ui/charts/`. |
| Totals equal the Riwayat lists they link to | PASS | `laporanRiwayatHref` uses the same `from/to/direction/category` as the aggregate query; e2e heatmap-tap test asserts the Riwayat total matches the Laporan figure (`2 transaksi · Rp70.000 keluar`). |
| Transfers never counted | PASS | `aggregate.ts` `foldTotals` skips `type === 'transfer'`; every Laporan query filters `t.type <> 'transfer'` in SQL. |
| Demo data excluded | PASS | every aggregate has `t.is_demo = 0`; `laporan.test.ts` "two spaces never mix; demo rows and transfers never count". |
| WIB buckets, incl. 23:30/00:30 boundaries | PASS | buckets use `occurred_on`; `laporan.test.ts` lines ~444-482 cover 31 Oct/1 Nov and year-end cases. |
| Integer money, never mixed currencies | PASS | `amount_minor` integers, BigInt exact sums with `safeMinor` overflow guard to null, `otherCurrencies` listed but never summed into `currency`. |
| Space access: member, non-member (cookie/query), removed member, stale `locals.space` | PASS | `test/integration/laporan.test.ts` "one access rule across spaces" block (lines 622-670+), all passed under vitest. |
| i18n: English entries for new strings | PASS | `src/lib/shared/i18n-en.ts` diff adds all new Laporan keys; `monthly-360-en.png` shows a fully translated page; vitest's i18n-coverage test is part of the 2223 that passed. |
| No reference brand/copy | PASS | a case-insensitive grep of `git diff main -- src/ e2e/ test/` for the reference product's name returns nothing. |
| Loading/empty/error states | PASS | `Skeleton`, `ErrorState` with retry, `muted` "Belum ada transaksi di periode ini." empty states throughout `+page.svelte`. |

## Findings

### Finding 1 (major) — Desktop two-column layout never reaches spec proportions; causes text overlap

APP_PARITY § 3 requires "Main ~740 px + side ~420 px at ≥ 1200 px". The shell (`src/routes/(app)/+layout.svelte`)
implements this generically: `.content` is capped at `740+80=820px`, and only widens to `1200+80=1280px` when the
page's two-column wrapper carries the class `two-col` (`:has(:global(.two-col))`, introduced in wave A and already
used by Beranda's `<div class="two-col">`, `src/routes/(app)/+page.svelte:261`).

The Laporan page's wrapper is `<div class="cols">` (`src/routes/(app)/laporan/+page.svelte:147`), **not**
`two-col`. The selector never matches, so at any viewport the main content box is capped at 820 px regardless of
the page's own `@media (min-width: 1200px) { .cols { grid-template-columns: minmax(0,740px) minmax(0,420px) } }`
rule. Measured live at 1440 px width (own `wrangler dev`, signed-in session, `getComputedStyle`):

```
windowInnerWidth: 1440
main computed max-width: 820px
.cols computed grid-template-columns: "350px 350px"   (should be ~"740px 420px")
.cols computed width: 740px                            (should be ~1160px before gap, 1200px with the 40px gap)
```

Visible effects (`docs/features/ui-parity-b/shots/monthly-1440-light.png`, `monthly-1440-dark.png`,
`yearly-1440-light.png`, `yearly-1440-dark.png`):

1. A ~410 px dead gutter on the right of a 1440 px viewport (sidebar ~245 px + content 820 px ≈ 1065 px used of
   1440 px) — the "Ke mana uangnya" donut column ends far short of where it should, and "Tren harian" /
   "Tren pengeluaran" never get their intended width either.
2. Inside the squeezed main column, `.pair` (`+page.svelte` "Tempat teratas" / "Pengeluaran terbesar") still
   switches to its own two-up layout at its `@media (min-width: 720px)` breakpoint (the *viewport* is 1440 px,
   even though the column it lives in is only 350 px). Each half then gets ~155 px, and the row content overlaps:
   see `docs/features/ui-parity-b/shots/crop-pair.png` — the merchant title collapses to a single letter ("M")
   that visually overlaps the "1×" count and the amount ("Rp 145.000"); "Pengeluaran terbesar" amounts are clipped
   ("−Rp 145.0", "−Rp 25.00"). This does not happen at 360 px (`monthly-360-light.png`: `.pair` is a single column
   there and reads correctly), confirming the squeeze — not the row component itself — is the proximate cause.

Fix is a one-line opt-in (`class="cols two-col"` or equivalent) in `src/routes/(app)/laporan/+page.svelte`; I did
not make this change (QA does not edit source). The engineer's own report correctly flagged this area as
"not verified" — the entry in the spec-item table ("Two-column layout … Done") should be downgraded.

### Finding 2 (major) — Dark-mode heatmap level-4 digits fail AA contrast

APP_PARITY § 3a and `docs/ENGINEERING_CHECKLIST.md` ("Accessibility … AA contrast in both themes") require AA
contrast in both themes. `HeatCalendar.svelte` hard-codes `.l4 { background: var(--heat-4); color: #fff; }` for
every theme. `--heat-4` differs materially between themes (`docs/design/tokens.css`):

- Light: `--heat-4: #6c63f0` → white text contrast ≈ **4.49:1** (borderline, effectively meets AA for normal text).
- Dark: `--heat-4: #8b85f5` (lighter/more saturated than the light value) → white text contrast ≈ **3.30:1**,
  computed via the standard WCAG relative-luminance formula ((L_lighter + 0.05) / (L_darker + 0.05)). This is
  below the 4.5:1 AA threshold for normal text; the day-number digits are 13 px / 600 weight, well under the
  "large text" exemption (≥ 18.66 px bold). Using the theme's own `--ink` dark value (`#f5f5f7`, luminance
  0.9145) instead of pure white does not fix it (≈ 3.03:1) — the problem is the background being too light for
  white text, not the specific white value chosen. Black/near-black text on `--heat-4` dark gives ≈ 6.4:1, which
  would pass; alternatively `--heat-4` dark could be set darker. I verified the token values live:

```
--heat-1: #34334d  --heat-2: #484674  --heat-3: #615da3  --heat-4: #8b85f5  --panel: #1c1c1e (dark theme)
```

(These match the spec's stated blend formula — accent `#8b85f5` at 22/40/62/100 % on `--panel` — exactly, so the
ramp itself is correctly implemented; only the level-4 *text* colour choice is wrong for dark mode.) Levels 1–3
pass comfortably with the theme's `--ink` (computed ≈ 5.3:1 to 8.0:1), so this is specific to the top (level 4,
"banyak") step, which is also the step most likely to carry a user's attention (the biggest-spend day).
Screenshot: `docs/features/ui-parity-b/shots/crop-heat-dark.png` and `monthly-1440-dark.png`/`monthly-360-dark.png`
(no level-4 day exists in the seeded screenshot data, so the digit-on-#8b85f5 case is not directly visible there;
the failure is confirmed numerically above and the component code at `src/lib/ui/charts/HeatCalendar.svelte:121-124`
is unambiguous: dark mode never special-cases `.l4`'s text colour).

### Observation (not a blocking finding) — `.pair`'s breakpoint is viewport-relative, not container-relative

Independent of Finding 1, `.pair`'s `@media (min-width: 720px)` switches on window width, not on the actual width
available inside `.col` (which can be narrower than the window, as the two-column report layout or a different
sidebar state shows). Fixing Finding 1 resolves today's reproduction (at 1440 px with the shell fix, `.col` would
be ~740 px, giving `.pair` halves of ~360 px, which is fine), but the same class of overlap could recur at other
width combinations (e.g. a narrower desktop viewport still ≥720 px with the sidebar expanded). Worth a follow-up,
not required to pass this cycle since no currently-supported viewport combination reproduces it once Finding 1 is
fixed.

## Not re-verified beyond the engineer's claims (low risk, no code path touched by this diff)

- `/dev/ui/charts` dev gallery rendering — read the route code only; it is dev-only and badged, out of the
  production surface.
- Non-Laporan pages (Beranda, Riwayat, shell) — only `e2e/shell.spec.ts` was re-run (already in the required set)
  to confirm this diff did not regress the shared shell; no new shell changes were in the diff.

## Cleanup

- The two ad hoc `wrangler dev` servers started for screenshots (ports 8894, and the Playwright-managed 8893 run)
  were both torn down; verified no `wrangler`/`workerd`/`vite`/`playwright` process remained and no listener on
  8893/8894/8787/5173 after this session. `.wrangler/e2e-state-8894` removed.
- No source file under `src/`, `workers/`, or `migrations/` was modified. Only `docs/features/ui-parity-b/shots/*`
  and this report are new.

## Re-check (cycle 2)

Scope: only the two cycle-1 findings (two-column layout at 1024/1200/1440 px, incl. the Tempat teratas /
Pengeluaran terbesar pair; heatmap level-4 day-number contrast in both themes incl. `test/contrast.test.ts`),
plus the yearly view at 1440 px light + dark (not re-shot by the engineer). Diff re-read: `git diff 2b60053..decbf03`
(engineer commit `decbf03`, on top of my QA commit `22993bc`, same worktree/branch `ui-parity-b`).

**Verdict: PASS.**

### Commands run

- `flock /tmp/montra-heavy.lock npm run check` — `COMPLETED 1454 FILES 0 ERRORS 0 WARNINGS` (exit 0), real toolchain.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 test/contrast.test.ts src/lib/ui/charts` — `Test Files 2 passed (2)`, `Tests 61 passed (61)` (exit 0), local, no mocked provider involved (pure CSS/token math).
- `flock /tmp/montra-heavy.lock env LD_LIBRARY_PATH=<scratchpad> E2E_PORT=8895 npx playwright test e2e/laporan.spec.ts --workers=1` — `7 passed` (exit 0), real Chromium against a local `wrangler dev` (phone + desktop + setup).
- Ad hoc Playwright scripts (own `wrangler dev` on port 8896, same LD_LIBRARY_PATH workaround) to independently measure layout at 1024/1200/1440 px and re-shoot the yearly view at 1440 px; server and all subprocesses killed afterwards.

### Finding 1 (two-column layout) — RESOLVED

The fix adds `two-col` to Laporan's wrapper (`class="cols two-col"`) so the shell's `:has(.two-col)` rule grants
the 1280 px content width, same mechanism as Beranda; `.cols`' desktop columns are now `minmax(0, 37fr)
minmax(300px, 21fr)` (740:420 ratio, scales with available width) and `.pair` now splits on its own column width
via a CSS container query (`.col { container-type: inline-size }`, `@container (min-width: 600px)`) instead of
the window's.

I independently re-measured this live (own server, two expense rows with long titles — "Makan Siang Nasi Padang
Lengkap Plus Es Teh", "Kopi Kenangan Legendaris Super Enak Banget" — deliberately longer than the engineer's
38-char case, to stress the row layout):

| Viewport | `main` max-width | `.cols` columns | `.pair` columns | Name overflow | Amount clipped | Page overflow |
| --- | --- | --- | --- | --- | --- | --- |
| 1024 | 1280px | 696px (one column) | 338px 338px | ellipsis only (CSS `text-overflow`), no visual collision | none | 0px |
| 1200 | 1280px | 530.75px 301.25px | 530.75px (one column) | ellipsis only | none | 0px |
| 1440 | 1280px | 683.86px 388.14px | 331.92px 331.94px | ellipsis only | none | 0px |

This matches the engineer's own cycle-2 table exactly (same three breakpoints, same pixel widths). At every width
the long merchant titles truncate gracefully with an ellipsis (as the existing `.name { overflow: hidden;
text-overflow: ellipsis }` rule intends) and amounts are never clipped — the cycle-1 overlap/clipping
(`crop-pair.png`: title collapsed to "M" overlapping the amount) does not reproduce. `document.documentElement`
has zero horizontal overflow at all three widths. I also re-shot and measured the yearly view at 1440 px
(not re-shot by the engineer), confirming the same 683.86 px / 388.14 px split and a correctly filled desktop
layout with no dead gutter: `docs/features/ui-parity-b/shots/cycle2-yearly-1440-light.png`,
`cycle2-yearly-1440-dark.png`. Visually both match the monthly cycle-2 shots (`cycle2-monthly-1440-light.png`,
`cycle2-monthly-1440-dark.png`): hero line is one line, main/side columns properly proportioned, no overlap in
"Tempat teratas" / "Pengeluaran terbesar" equivalents.

### Finding 2 (heatmap level-4 contrast) — RESOLVED

The fix stops using `color: #fff` on `.l4` and instead draws the day number on a small fixed `--bg`-filled dot
with `--ink` text (`HeatCalendar.svelte`: `.l4 .day { background: var(--bg); color: var(--ink) }`), the same
`--ink`-on-`--bg` pair used everywhere else in the app, which is far from the heat ramp's own light/dark
divergence. I recomputed independently: light `--ink` `#171717` on `--bg` `#ffffff` and dark `--ink` `#f5f5f7` on
`--bg` `#111112` both clear 4.5:1 by a wide margin (both pairs are near-black-on-near-white or the reverse). Levels
0–3 are unchanged from cycle 1 (already verified ≥ 5.3:1 in both themes).

`test/contrast.test.ts` now has a "AA heatmap day numbers (light/dark)" block that parses `HeatCalendar.svelte`'s
own `<style>` block (not a hand-copied assumption) for each level's `color`/`background`, requires both to be CSS
custom-property tokens (so a hard-coded colour can't slip back in unnoticed), and asserts ≥ 4.5:1 computed from
the real token values in `docs/design/tokens.css` — 5 levels × 2 themes = 10 cases, plus the pre-existing 46
general text/graphics pairs = 56 tests in that file, all passing (ran together with `src/lib/ui/charts` for 61
total, 0 failures). The engineer's reported fail-before-fix run (level 4 failing in both themes on the cycle-1
code) is consistent with my own cycle-1 contrast calculation (white-on-`#8b85f5` ≈ 3.3:1 in dark mode).

### Also re-verified incidentally

The engineer's cycle-2 own-defect fix (hero context line wrapped in one `<p>`, was stacking word-by-word) is
visible and correct in every shot I took this cycle (one line: "dari Rp0 pemasukan · Rp170 rb melebihi
pemasukan").

### Cleanup

Both ad hoc `wrangler dev` instances I started this cycle (ports 8895 via Playwright's own webServer, and 8896 for
manual measurement/screenshots) were fully torn down, including workerd/esbuild subprocesses that survived a
first-level `kill`; confirmed by `ps`/`ss` with no listener left on 8895/8896 and no stray process rooted in this
worktree. A concurrent, unrelated process on port 8931 was found rooted in a different worktree
(`.claude/worktrees/ui-parity-c`) — left untouched. No file under `src/`, `workers/`, or `migrations/` was
modified by this QA pass.
