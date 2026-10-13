# Parity wave A — engineer report (cycle 1)

Source: `docs/design/APP_PARITY.md` § 1, § 2, § 3 (Beranda, Transaksi) and § 3a (owner request 2026-10-08).
Branch `ui-parity-a`, rebased on `main` 46ffea9. No migrations, no change to money calculation or access control.

## What works, per spec section

**§ 3a tokens and design system**
- `docs/design/tokens.css` (imported by `src/app.css`): `--accent`, `--heat-1..4`, `--warn`, `--warn-text` in light
  and both dark blocks with the values from § 3a (dark heat steps = accent at 22/40/62/100 % mixed on `--panel`,
  as hex); `--raised` for the selected segment; `--r-group` 18 → 20 px; Tailwind mappings for accent/warn.
- `test/contrast.test.ts` now gates `--warn-text` on bg/panel (AA 4.5), `--ink` on `--raised`, and `--accent`/
  `--warn` as graphics (3:1) on bg, panel and chart bars, light and dark.
- `docs/design/DESIGN_SYSTEM.md` bumped to v2 with a changelog line (fills not frames, ink-only actions, brand blue
  only for focus/links, new tokens, type scale, chips, segmented, new components, Dompet tab, English numbers).

**§ 3a kit restyle (`src/lib/ui/kit`)** — every page inherits it.
- Button: ink primary / panel secondary, no hover shadow, optional `href` (link pill) and leading `icon`.
- Chip: 32 px / 13 px / 600 (44 px on coarse pointers), ink when selected, optional icon and picker chevron.
- Segmented: panel track, selected = `--raised` pill with `--shadow-float` (was an ink fill).
- GroupList/GroupRow: panel fill, radius 20, rows ≥ 60 px, hairline inset 68 px after the 40 px tile.
- TransactionRow/DayHeader: 15 px / 600 titles, bold amounts, tabular figures, locale-aware numbers.
- BarChart: selected bar in `--accent`, day numbers under the bars with today bold + underlined, optional link to
  the selected day's list. MonthLines: this month in `--accent`. ProgressBar: `tone="over"` (money-up).
- Toggle: switch-on stays ink; optional `badge` ("Beta"). InitialsTile: `round` avatar option.
- Money format follows the UI language (`formatMoney/Compact/moneyParts` take a locale; Indonesian default, so
  existing callers are unchanged): `Rp 4,025,500`, `Rp4.02m`, `Rp503k` in English. Kit components read the locale.

**§ 2 new kit components** (all on `/dev/ui`): HeroAmount (eye toggle; hidden = "••••"; stored per device in
localStorage with try/catch; masks every kit amount on the page), ComparePill (≈ ↑ ↓ glyph + rupiah words),
PeriodStepper (link steps, next disabled in the future), PickerSheet (radio rows or link rows, "+ Tambah …" row;
bottom sheet on phones, centred dialog on desktop via the existing Sheet), ToggleRow, SearchField (panel pill with
magnifier), IconButton (40 px round panel). GroupedList = the restyled GroupList; chips = Chip; segmented = Segmented.

**§ 1 shell**
- Desktop sidebar: wordmark + notifications (`/kotak-masuk/notifikasi`), theme toggle (writes the existing `theme`
  cookie), settings; space card (avatar, name, "Ruang pribadi" / "Ruang bersama · Pemilik", → `/ruang`); disabled
  "Tanya Montra…" pill with "Asisten · Belum dikonfigurasi"; sections Uang / Fitur / Catat; plan card
  ("Montra Pro · Punya voucher?" → `/pengaturan/paket`); "+ Tambah transaksi" with an `N` key hint; account row.
  The bottom block is sticky so it stays in view on short screens. Exactly one entry is `aria-current` per page.
- `N` (no modifier, not repeated, outside text fields/selects/editables, no dialog open) opens the Tambah sheet.
- Page header row: `ScreenTitle` takes an optional subtitle and actions (H1 28 px phone / 34 px 800 desktop).
- Content is left-aligned next to the sidebar (≤ 740 px); a page with `.two-col` gets 740 + 420 px columns from
  1200 px. Other pages keep one column and the new kit look (no page redesigns outside wave A).
- Phone tab bar: Beranda, Riwayat, Laporan, Dompet, Tambah (filled circle-plus). `/dompet` redirects (307) to the
  existing wallets page `/kekayaan` until wave C; Dompet is the active tab there.
- Hiding Kekayaan (FN-12) now removes "Kekayaan bersih" from the sidebar's Fitur section; the Dompet tab stays.
- The phone tab bar sets `scroll-padding-bottom`, so focused fields are never hidden under it (WCAG 2.4.11).

**§ 3 Beranda (`/`)** — top bar (date "Kamis, 8 Okt", "Hari ke-8" chip; assistant, notifications and space avatar
on phones), visually hidden H1; HeroAmount "Pengeluaran Oktober" + ComparePill; "rata-rata Rp… /hari" with bold
figure and a "Batang harian ▾" select (daily bars / per kategori / vs bulan lalu; client-side, no request); 14-day
bars with today's tick and a "Lihat transaksi" link to that day's list; budget progress bar + "Rp2,48 jt tersisa ·
Rp103 rb sehari untuk 24 hari" (hidden without a budget; "Atur/Ubah anggaran" sheet unchanged); Struk (ink, still
"Segera hadir") and Suara (panel) buttons; "Hari ini" card (small-caps date, today's totals, count, full-width
button or empty prompt); "Jelajahi fitur" link; Terbaru (3 newest rows, "7 Okt, 16.32 · Makan & Minum · Tunai",
"Lihat semua" → Riwayat); Akan datang (FN-26 bills due within 7 days, "Hari ini/Besok/dalam N hari", demo rows
badged). Desktop: hero, chart, budget, buttons left; Hari ini, Terbaru, Akan datang right.
- Loader: `berandaLists()` in `src/lib/server/budgets/summary.ts` reuses `listTransactionsByDay` (last 366 days,
  limit 3) and `listSubscriptions`, behind the same `currentSpaceScope` gate; it fails independently of the hero.

**§ 3 Transaksi (`/riwayat`)** — H1 "Transaksi" with "7 transaksi · Rp 514.000 keluar"; actions Ekspor CSV
(existing `/impor/ekspor` with the shown range) and + Tambah transaksi (desktop; the tab bar's Tambah on phones);
search pill that searches as you type (350 ms debounce, focus kept; Enter submits the GET form without JS); period
chips (Periode ini, 30 hari, 90 hari, Tahun ini, 1 tahun terakhir) + month stepper; type chips (Semua, Pengeluaran,
Pemasukan, Transfer) with counts; Kategori and Dompet picker chips (PickerSheet with JS, `?pilih=` inline list
without JS); day groups with "Hari ini/Kemarin/date" and green +in / grey −out; rows "16.32 · Makan & Minum ·
Tunai", transfers "BCA → Tunai". The `type=transfer` filter is a WHERE clause only; totals logic is unchanged
(transfers still never count as money in or out).

## Deviations and why
- **"Semua" period chip → "1 tahun terakhir"**: every list scan is bounded to 366 days (aggregate contract,
  engineering checklist "Bounded work"); labelling a one-year window "Semua" would be untrue.
- **Search placeholder** stays "Cari judul atau catatan": search matches title and note only; claiming category,
  wallet or amount search would be false.
- **Not built (needs server work beyond wave A's "reuse loaders" scope):** "Pilih" bulk select (needs a bulk
  delete action), the sort select (only newest-first keyset paging exists), "Penyesuaian saldo" chip (§ 4).
- **Anggaran sidebar entry** waits for its page (wave C); no dead link. "Jelajahi fitur" opens `/pengaturan/fitur`
  until the Fitur sheet (wave C). "Kekayaan bersih" and Dompet both open `/kekayaan` until wave C; Dompet wins the
  active state.
- **Hide amounts** applies to the page that shows the hero (Beranda); other pages always show amounts, so a hidden
  state can never leave a page without a way to show them again. The server renders amounts shown (it cannot read
  the device choice), so a hidden choice applies right after hydration.
- **English separators** are wired through the kit and the two wave-A pages; other pages' own `formatMoney` calls
  keep Indonesian separators in English until their waves (B–D).
- Mobile "Transaksi" hides the duplicate header "+ Tambah transaksi" (the tab bar's Tambah is one tap away).
- Removed `HeroBlock` and `ComparisonPill` (replaced by HeroAmount and ComparePill; no other users).

## Files
Tokens/docs: `docs/design/tokens.css`, `docs/design/DESIGN_SYSTEM.md`.
Kit: `src/lib/ui/kit/{Button,Chip,Segmented,GroupList,GroupRow,TransactionRow,DayHeader,BarChart,MonthLines,
ProgressBar,Toggle,InitialsTile}.svelte` (restyled); new `HeroAmount, ComparePill, PeriodStepper, PickerSheet,
SearchField, IconButton, ToggleRow .svelte`, `amount-visibility.ts`, `amounts.svelte.ts`, `picker.ts`, `rich.ts`.
Shell: `src/lib/ui/shell/{nav.ts,Sidebar.svelte,TabBar.svelte,ScreenTitle.svelte}`, new `ThemeToggle.svelte`,
`shortcut.ts`, `theme.ts`, `shell-data.ts`; `src/lib/ui/i18n-context.ts` (`useLocale`), `src/lib/ui/icons.ts`.
Shared: `money-format.ts`, `dates.ts` (`rowTimeLabel`, `formatWeekdayDay`), `riwayat-query.ts` (transfer type,
period presets), `budget-progress.ts`, `i18n-en.ts`; `src/lib/ui/transactions/row-text.ts`.
Server: `src/lib/server/budgets/summary.ts` (`berandaLists`, `billsDueWithin`), `transactions/aggregate.ts` (type
union widened). Routes: `(app)/+layout.*`, `(app)/+page.*`, `(app)/riwayat/+page.*`, `(app)/dev/ui/+page.svelte`,
new `(app)/dompet/+page.server.ts`.
Tests: unit `amount-visibility`, `rich`, `shortcut`, `theme`, `row-text`, `budget-progress`, `nav` (rewritten),
`money-format`, `dates`, `riwayat-query`, `contrast`; integration `beranda` (lists, cross-space, window edges),
`transactions` (transfer filter totals), `riwayat-routes` (transfer chip, `?pilih=`). E2E: new N shortcut, 360 px
tab bar, hide toggle; updated `shell, beranda, riwayat, fitur, accounts, aplikasi, notifikasi, pwa, laporan, suara`.

## Gates (last run, Vitest at 2 workers)
- check: `COMPLETED 1387 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`
- lint: `All matched files use Prettier code style!`, eslint clean
- test: `Test Files 140 passed (140)`, `Tests 2091 passed (2091)`
- build: `✔ done`

## E2E (Playwright, LD_LIBRARY_PATH workaround, E2E_PORT=8795, 2 workers)
- After the final layout fixes: shell, kit, beranda, riwayat, fitur, accounts → `91 passed, 8 skipped`.
- Earlier in the cycle (before the last CSS-only fixes): fitur, accounts, notifikasi, aplikasi, pwa, tabungan,
  paket, ruang, impor, kotak-masuk → 99 passed (pwa re-run 19 passed after one locator fix); laporan, suara,
  langganan, kekayaan → passed; account-key, barang, kekayaan-bersih, koleksi, security, site → `55 passed`.
- Screenshots (fictional data, 360 px full page and 1440 px viewport, light and dark):
  `shots/beranda-{360,1440}-{light,dark}.png`, `shots/transaksi-{360,1440}-{light,dark}.png`. Emoji tiles show
  as boxes because the headless browser has no emoji font.

## Pre-handoff probes
- Cross-space: `berandaLists` — owner's personal space, a stranger naming the shared space by cookie, and the
  member in the shared space each see only their own space's rows and bills (integration test passes). `/dompet`
  carries no data (redirect only).
- 360 px: no horizontal scroll on Beranda and Transaksi; tab bar cells equal and ≥ 44 px (e2e passes).
- No-JS forms: Beranda budget form refusal and success without JS (e2e passes); Transaksi renders without JS;
  `?pilih=` picker fallback covered by an integration test.
- Month boundaries: `rowTimeLabel` WIB vectors (23:30 WIB on the 31st, 00:30 WIB on the 1st) pass.
- Concurrency, two tabs, two devices, money vectors: not applicable (no new writes, no parser change).
- User copy: no file paths or internal identifiers in new strings.

## Not verified
- Real devices (iOS Safari, Android Chrome), screen readers and 200 % text zoom were not tested.
- Fail-before runs were not separately recorded: the new tests cover new behaviour that did not exist before.
- The full e2e suite was run in parts, not once end to end after the final CSS-only fixes.
