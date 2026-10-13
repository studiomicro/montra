# UI polish pass — engineer report (cycle 1)

Branch `ui-polish` (worktree `.claude/worktrees/ui-polish`). Before/after screenshots in `shots/`
(`<screen>-<width>-<theme>-before|after.png`), taken by `e2e/ui-polish-shots.spec.ts`
(`SHOTS_PHASE=before|after`, phone project only; skipped otherwise). No migrations; no transaction write path touched.

## 1. Alur uang flow diagram

- `src/lib/ui/charts/geometry.ts` `flowLayout` rewritten: nodes are 8 px colour bars with labels beside them (first
  column left of the bar, the others right of it); ribbons are closed cubic-Bézier bands (two curves + `Z`), thickness
  = amount × one money scale, minimum `FLOW_MIN_BAND` = 3 px; a bar grows to carry its stacked ribbons; slots (tap
  areas) stay ≥ 48 px; columns are centred on the tallest (so the income ribbon curves instead of a flat block).
- `FlowChart.svelte`: ribbon fill = **source node's** colour at 35 % (60 % on hover/focus, ink outline on focus) in both
  themes; column titles moved into the SVG (`heads` prop) so they align with the bars; labels carry a 4 px halo in the
  page colour (the middle column's labels sit over ribbons). Accessible names, `<title>`s, node links (≥ 44 px) and the
  "Rincian alur" list are unchanged.
- Note: with source colouring, wallet → category ribbons take the wallet accent; the category hue is on the target bar
  and in the list dot.
- Tests: `geometry.test.ts` flow cases rewritten for the new contract + new cases for proportionality (5:1 ratio) and
  the 3 px minimum with the bar growing to carry it (10 geometry tests).

## 2. Beranda "Struk"

- `src/routes/(app)/+page.svelte`: Struk and Suara are both kit `Button size="lg"` in equal columns. Struk: secondary,
  `disabled`, small "Segera" badge, `describedby` → "Membaca foto struk belum tersedia."; label in `--muted` instead of
  50 % opacity. Suara (the working path) is the primary ink pill.

## 3. Langganan rows

- `src/routes/(app)/langganan/+page.svelte`: row = two independent lines: name | amount, then "Bulanan · tgl 8" /
  "Mingguan · Jumat" / "Tahunan · 3 Nov" | due chip ("Hari ini"/"Besok" inverted, otherwise the date; sr-only "Jatuh
  tempo"). "Terakhir dibayar …" moved to the top of the edit sheet. `e2e/langganan.spec.ts` updated (texts, last-paid in
  the sheet, row body ≤ 50 px). Shots spec asserts 4 rows ≤ 50 px and no cut schedule line at 360 px.
- Barang/Koleksi: already one-line name and meta with ellipsis (2 lines at 360 px, see `barang-360-light-*`,
  `koleksi-360-light-*`); the Barang meta ellipsizes the purchase date at 360 px. Not changed.

## 4. Compare pill with nothing spent

- `hasComparison(currentMinor, diffMinor)` in `src/lib/ui/kit/category.ts`; `ComparePill` takes `currentMinor` and
  renders nothing when both periods are zero. Beranda passes `spentMinor`, Laporan (month and year) the last running
  total. Unit tests in `category.test.ts`.

## Red-team lows

- FN-34 L1: `closeDay` action uses `locals.user` only (redirect to `/masuk` when signed out; CSRF = SvelteKit origin
  check). New tests in `test/integration/streak.test.ts`: removed member with a stale `locals.space` closes their own
  day (failed before the fix: `kind: 'error'` 404), and signed-out → 303 `/masuk`.
- FN-35 L1: `moneyFlowTotals` orders by sum and has `LIMIT MONEY_FLOW_MAX_GROUPS + 1` (1000), returns
  `{ rows, truncated }`; `MoneyFlowReport.truncated`; Alur uang shows "Terlalu banyak alur bulan ini: hanya yang
  terbesar yang ditampilkan dan dijumlahkan." Tests in `test/integration/alur-uang.test.ts` (1001 groups → 1000, the
  smallest left out, flag set; normal month not truncated).

## i18n (English entries added)

`Segera`, `Membaca foto struk belum tersedia.`, `tgl {tanggal}`, `Jatuh tempo`, the truncation note.

## Contrast (measured, WCAG formula)

Light / dark: muted on panel (disabled Struk label) 4.66 / 6.61; ink-2 on panel-2 (badge) 9.55 / 9.93; bg on ink (soon
chip) 17.93 / 17.33; muted on bg (date chip) 5.07 / 7.34 — the badge and chip pairs added to `test/contrast.test.ts`.
Flow labels over a ribbon: ink on 35 % accent 11.28 / 9.79; muted directly on 35 % accent would be 3.19 / 4.14, which is
why labels carry the page-colour halo (adjacent colour = bg: 5.07 / 7.34). Ribbons themselves are 1.59 / 1.77 against
the page (decorative: bars, labels and the list carry the information).

## Gates (each step separately, under the heavy-work lock)

- `npm run check`: 1493 files, 0 errors, 0 warnings.
- `npm run lint`: prettier clean, eslint clean.
- `npx vitest run --maxWorkers=2`: 165 files, 2340 tests passed.
- `npm run build`: done.
- Playwright `--workers=1` (beranda, alur-uang, alur-uang-qa, laporan, langganan, kekayaan, shell, suara, barang,
  koleksi, ui-polish-shots): 121 passed, 8 skipped (shots spec outside the phone project and existing skips).

## Not verified

- Real devices / system fonts other than headless Chromium's (DejaVu, wider than phone fonts).
- Kekayaan bersih spec not run (only `kekayaan.spec.ts`). The 1440 Langganan/Beranda dark shots were reviewed only for
  layout, not pixel-compared.
