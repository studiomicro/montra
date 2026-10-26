# Design polish audit (whole app, 2026-10-15)

Owner request: "polish the design", whole-app pass. The audit changed no app source; the fixes and their status follow
in § Status.

## How the screens were captured

- Local build (`npm run build`), `wrangler dev` on port 8799 with its own LOCAL persist dir
  (`.wrangler/audit-state-8799`, migrated with `scripts/migrate-local.ts`). No remote D1 or other remote service.
- Throwaway scripts outside the repo, in the session scratchpad `design-audit/` folder: `seed.mjs` signs up two
  fictional accounts through `/daftar` and fills one through the app's own form actions. `shoot.mjs` captures
  the screens and `crop.mjs` slices the tall captures for review.
- Fictional, non-demo data: 5 wallets (BCA, GoPay, Tunai, Mandiri Tabungan, Kartu Kredit BNI with limit and due
  day) and 59 transactions over 81 days. They include salary, freelance income, rent, bills, daily spending,
  3 transfers and one very long title. Also: a monthly budget of Rp 7 jt, 3 category budgets, 2 goals, 4 net-worth
  items (house, motorbike, mortgage, mutual fund) and one shared space "Keluarga Pratama". A second, empty account
  supplies the empty states.
- 208 PNGs in `shots/`, named `<screen>-<360|1280>-<light|dark>.png` (prefixes `empty-` and `auth-`; sheets are
  `sheet-tambah-*` and `sheet-sapaan-*`). They cover 36 signed-in screens, 11 empty states, 2 auth screens and
  2 sheets, each at 360x780 and 1280x800 in light and dark. Phone and desktop pages are full-page captures. In a
  full-page phone capture the fixed tab bar sits at y≈700 (the first viewport's bottom).
- Automatic checks on every capture: no horizontal scroll on any screen (`scrollWidth - clientWidth = 0`
  everywhere), all HTTP 200.

Findings are ranked by visible impact. Shared-component fixes come first: one fix repairs many screens.

## Status after the polish pass (cycle 1, 2026-10-15)

Branch `polish/design-pass`. After-screenshots: session scratchpad `design-audit/shots-after/` (same names as
`shots/`; the originals are kept in `shots-before/`). Owner decisions applied: fields and secondary buttons lose their
1 px frame (A8); on phones Struk is the ink pill and Suara the panel one (B11).

| Id | Status | What changed, or why not |
| --- | --- | --- |
| A1 | Fixed | `ScreenTitle` measures whether the actions fit beside the title (`screen-title.ts`); if not, they follow the subtitle. A form's `button.btn.secondary` in the header is the underlined text link too. |
| A2 | Fixed | `joinMeta` (`row-text.ts`, also used by Laporan): the space before each "·" is non-breaking, so a wrapped meta line never starts with "· Tunai"; record rows cap the amount column at 44 %. Tried first: no breaks inside a segment at all; at 360 px that pushed the wallet past the two-line clamp ("Makan & Minum ·…"), so a long segment may still wrap at its own spaces. |
| A3 | Fixed | Dompet meta writes `&nbsp;· ` inside the block; the masked number never breaks. |
| A4 | Fixed | `CategoryList`: amount 15 / 700, detail on one line, the name may take two lines, no chevron below 480 px. |
| A5 | Fixed | One global `.text-link` (ink-2, 15 px, underline offset 3 px) for Beranda, the bar chart's "Lihat transaksi", Kekayaan "Lihat semua", Akun "Kelola passkey" and the Gmail, E-mail and Integrasi standalone links. Blue stays for links inside running text (auth "Masuk"/"Daftar" line, the legal links in the consent sentence). |
| A6 | Fixed (contrast partly) | `cappedBars` caps the scale at 2× the median of the non-zero days and draws a break mark on the outlier; non-zero days are at least 6 px. Dark `--chart-bar` #3a3a3a → #444444 (1.9:1 on `--bg`, light is 1.4:1). 3:1 is not reachable without dropping the tested accent-vs-bar 3:1; every figure stays in the readout and the bar's accessible name. |
| A7 | Fixed | Beranda `.muted` padding `8px 0`. |
| A8 | Fixed | Hairline removed from fields (`app.css`), kit secondary/destructive buttons, Impor's buttons and pickers and the OCR capture button. On a panel card (`.on-panel`) or group (`.group`) fields and secondary buttons take `--bg`. The 2 px `--brand` focus ring stays (checked by keyboard on /masuk, /riwayat/baru, /impor in both themes). `/riwayat/baru` wallet selects get the app's chevron; they stay native selects (no-JS forms). DESIGN_SYSTEM § Inputs updated. |
| A9 | Fixed | Dark and mono-dark `--heat-1..3` raised to 32 / 48 / 68 % (dark `#403e63 #514e85 #6763b0`, mono-dark `#424242 #575757 #6e6e6e`); contrast test green. |
| A10 | Fixed (Beranda) | With no wallet, the first-wallet card leads Beranda, so "Tambah dompet" is on the first screen at 360 px. Laporan, Kalender and Anggaran: content (not a primary action) under the bar at first paint, padding correct; no change. |
| B1 | Fixed | Alur uang leads with `HeroAmount` ("Uang keluar") and the in/out line. Below 480 px the right labels get a fixed 104 px column and the middle labels sit centred on their bar with the halo. |
| B2 | Fixed | Average label at the left on a `--bg` halo; the category grid opens scrolled to the latest months with the names pinned. |
| B3 | Fixed | One rule: every Laporan list is signed (expense "−Rp", income "+Rp" green); Tempat teratas uses 15 / 600 names and 15 / 700 amounts. |
| B4 | Partly | Name wraps to two lines below 480 px and the star overlaps the row padding (44 px target kept). Deferred: the hero's "Rp… tersedia" line needs a new computed figure (out of a UI-only pass); monogram case is kept: brand monograms follow each service's own wordmark (FN-43, e.g. mandiri). |
| B5 | Fixed | Plain debt is ink; Dompet rows get their brand tile and 15 px names (two lines allowed, chevron hidden below 480 px); "Tambah aset" is the last row of the last group; "Pembagian" heading visible. A kind with one asset still shows as a one-row group. |
| B6 | Partly | Laporan: one empty state (no heatmap, flat line or "Rp0 tersisa"). Anggaran: one muted line, rows without the repeated sentence (the list stays so a first budget can be set). Impor: second empty card text only. Beranda: first-wallet card first, chart band hidden while there is no recent transaction. Deferred: hiding "Atur/Lihat anggaran" and "Tutup hari ini" for a new account conflicts with FN-34 owner decision B ("closing needs nothing") and with setting a budget before the first transaction; owner call. |
| B7 | Fixed | Category budget row: `grid-template-columns: minmax(0, 1fr) auto`; the name ellipsises, the figure stays right. |
| B8 | Fixed | `formatDayHeader`: "Kamis, 1 Okt", year only outside the current year (Riwayat, Kotak masuk, Periksa draf). Transfers use the transfer tile (`rowTile`). |
| B9 | Fixed | Riwayat, Kalender and Beruntun steppers use `periodStepLabel` ("Okt '26"). |
| B10 | Fixed | Below 600 px the Impor source track keeps each label's width and scrolls sideways edge to edge of the card (still the native radios, so it works without JavaScript). Buttons lose their frames (A8). |
| B11 | Fixed | Phone: Struk ink, Suara panel (owner decision 2026-10-15); desktop header unchanged (Struk secondary, Suara primary), as the spec says. |
| B12 | Fixed | Dark `--scrim` 55 % → 72 %. |
| B13 | Deferred | An uncommitted change to `DailyStory.svelte` in the main checkout already moves focus to the card on open; not duplicated here to avoid a conflicting edit. |
| B14 | Partly | Fixed: streak chip reads "Mulai hari ini" at 0; the "Hari ini" card drops its date caps label; Kekayaan laporan adds the waiting sentence under the plot below two values (the steppable slots stay, FN-53); Ruang "Sedang dipakai" is a status tag, not a pill; Kotak masuk empty state offers "Teruskan e-mail"; Integrasi AI uses the bolt icon and Pemakaian says "Kredit terpakai dan batas pakai". Not a bug: the "Pesan Antar Makanan" tile is not cut, the fixed tab bar overlapped it in the full-page capture. Deferred: PeriodTrend keeps its green/red rising/falling colour, the rule it shares with TrendChart (FN-25b, FN-53). |

## A. Shared components (one fix, many screens)

### A1. ScreenTitle: phone header actions wrap between the H1 and its subtitle
- Screens: Ruang detail, Kartu kredit, Tambah transaksi (`/riwayat/baru`), any page with a back arrow and a
  long title. 360, both themes.
- Shots: `ruang-detail-360-light.png`, `dompet-kartu-360-light.png`, `riwayat-baru-360-light.png`.
- Problem: when the title fills the row, the action ("Pakai ruang ini", "Ubah kartu", "Sesuaikan saldo dompet")
  drops to its own line. That line sits under the H1 and above the subtitle, so it splits title and subtitle.
  "Pakai ruang ini" is a `<button>` inside a form, so it stays a bordered pill. Only `a.btn.secondary` becomes the
  v3 underlined text link.
- Rule: APP_PARITY § 3b.1 (subtitle on its own line under the title; secondary actions as small underlined
  links).
- Fix: `src/lib/ui/shell/ScreenTitle.svelte` (phone block, `.actions { order: 2 }` and `.subtitle { order: 3 }`).
  Put the subtitle (order 2) directly under the title, and the wrapped actions after it. Extend the text-link
  style to `button.btn.secondary` inside `.actions`.

### A2. Record rows on phones: meta wraps to two lines and titles truncate early
- Screens: Riwayat, Beranda "Terbaru", Laporan "Pengeluaran terbesar", Kalender day list. 360, both themes.
- Shots: `riwayat-360-light.png` (e.g. "12.15 · Makan & Minum / · Tunai", "Gaji bulana…"),
  `beranda-360-light.png`, `laporan-360-light.png`.
- Problem: the right column (grey "Pengeluaran" label over a 17 px amount; `.end` up to 52 %) leaves about 140 px
  for the text. The page-level 2-line clamp on `.meta` breaks inside a segment, so a line can start with an
  orphaned "· Tunai". Row heights vary from 72 to 92 px down the list. "Gaji bulanan PT Sinar Kencana" truncates
  even though the meta below has room.
- Rule: DESIGN_SYSTEM § Transaction row (title one line; meta "16.32 · Kategori · Dompet"); APP_PARITY § 3b.4.
- Fix: in `src/routes/(app)/riwayat/+page.svelte` (`.day :global(.meta)`) and `src/routes/(app)/+page.svelte`
  (`.list :global(.meta)`), break only between segments. Build the meta in
  `src/lib/ui/transactions/row-text.ts` with non-breaking spaces inside each segment and a breakable " · ".
  Consider capping `.end` in `src/lib/ui/kit/TransactionRow.svelte` at about 44 % on phones.

### A3. Wallet type meta is missing a space: "Bank· •••• 4821"
- Screens: Dompet (phone and desktop), Kekayaan card section. All themes.
- Shots: `dompet-360-light.png`, `dompet-1280-dark.png` ("Kartu kredit· •••• 7710").
- Problem: Svelte trims the leading whitespace of the `{#if wallet.lastFour}` block, so the separator sticks to
  the type.
- Rule: DESIGN_SYSTEM § Formatting (meta uses " · ").
- Fix: `src/routes/(app)/dompet/+page.svelte` around line 390. Write `{' · '}` (or `&nbsp;·&nbsp;`) inside the
  block.

### A4. Laporan category list: names truncated to 7–9 characters
- Screens: Laporan monthly and yearly (phone), Laporan desktop side column.
- Shots: `laporan-360-light.png`, `laporan-tahunan-360-light.png` ("Tempat T…", "Belanja H…", "Makan & …"),
  `laporan-1280-light.png` ("Tempat Tin…", "Makan & Minu…").
- Problem: the name shares a row with a 17 px amount and a chevron. The detail "66% · Rp233 rb/hari" wraps to two
  lines under it. The category name is the row's meaning, but the amount gets the space.
- Rule: DESIGN_SYSTEM § Grouped list / Transaction row (title 15/600, amount 15/700).
- Fix: `src/lib/ui/laporan/CategoryList.svelte`. Set the amount to 15 px as the spec says, and keep the detail
  on one line (`white-space: nowrap`).
- Desktop: the side column is about 330 px at 1280. Let `.name` take the free space, or move the percent into the
  amount column as a secondary label.

### A5. Two link styles side by side: blue unstyled vs ink underlined vs ink bold
- Screens: Beranda ("Lihat transaksi" blue, "Lihat semua" ink underlined), Kekayaan ("Lihat semua" ink bold, no
  underline), Akun ("Kelola passkey" blue bold), Daftar/Masuk ("Masuk", legal links blue).
- Shots: `beranda-1280-light.png`, `kekayaan-1280-light.png`, `pengaturan-akun-360-dark-0` (crop of
  `pengaturan-akun-360-dark.png`), `auth-daftar-360-light.png`.
- Rule: DESIGN_SYSTEM principle 6 (`--brand` only for focus and inline text links), APP_PARITY § 3b.1
  (underlined text links).
- Fix: pick one "section link" style (ink, 15 px, underline offset 3 px). The chart link in
  `src/routes/(app)/+page.svelte` (`chartLink`, line ~237) uses blue. The "Lihat semua" in
  `src/lib/ui/net-worth/CreditCardCard.svelte` / `src/routes/(app)/kekayaan/+page.svelte` has no underline.
  Keep blue only for links inside running text.

### A6. Bar chart scale: one outlier flattens every other day (Beranda daily bars)
- Screens: Beranda phone and desktop, both themes.
- Shots: `beranda-1280-light.png`, `beranda-1280-dark.png`, `beranda-360-light.png`.
- Problem: rent (Rp 3,5 jt on 3 Okt) sets the max in `barHeights`, so 12 of 14 bars are 2–8 px tall under a
  ~120 px empty band. In dark, `--chart-bar` #3a3a3a on #111 makes those stubs nearly invisible. The chart reads
  as "no data" although every day has spending.
- Rule: DESIGN_SYSTEM § Charts (daily bars, tap shows the figure); principle 1 (the chart supports the number).
- Fix: `src/lib/ui/kit/chart-scale.ts` `barHeights` (used by `src/lib/ui/kit/BarChart.svelte`). Scale to a
  capped maximum (e.g. 2× the median of non-zero days) and draw a clipped bar with a small break mark for the
  outlier. Or raise `minVisible` to about 6 px for non-zero days. Check the dark `--chart-bar` contrast against
  `--bg` (≥ 3:1 for a graphic object).

### A7. Empty and placeholder text indented 4 px from the section edge
- Screens: Beranda "Terbaru" / "Akan datang" empty lines (full and empty account).
- Shots: `beranda-1280-light.png` ("Tidak ada tagihan dalam 7 hari ke depan." at x=24 vs heading x=20),
  `empty-beranda-360-light.png`.
- Fix: in `src/routes/(app)/+page.svelte`, the `.muted` rule (`padding: 8px 4px`, line ~993) should become
  `padding: 8px 0`. Better still, use the shell `EmptyState` with `mascot={false}` so every empty line is the
  same component.

### A8. Form fields: a hairline everywhere, and the spec says no border
- Screens: Masuk, Daftar, Tanya, Impor, Akun, Tambah transaksi.
- Shots: `auth-daftar-360-light.png`, `auth-masuk-1280-dark.png`, `tanya-360-light.png`,
  `impor-360-light.png`.
- Problem: `src/app.css` gives every input, select and textarea a 1 px inset ink hairline (16 %). Secondary
  buttons get the same, so "Struk", "Pratinjau" and "Baca dengan AI" look outlined, not filled. The reason is
  documented in code: a field on a panel card disappears. But DESIGN_SYSTEM § Inputs and § Button still say
  "no border". On white pages (auth), the frame is not needed.
  - Impor's pickers use a white fill and a frame inside a panel card.
  - `/riwayat/baru` uses a native `<select>` with the browser chevron, next to custom pickers elsewhere
    (`riwayat-baru-360-light.png`).
- Fix: decide one rule. Either (a) update DESIGN_SYSTEM § Inputs/Button to "panel fill + 1 px 16 % ink inset" and
  accept it, or (b) scope the hairline to fields inside a `--panel` container (`.card :where(input…)`) and use
  `--bg` fill there. Also restyle the Dompet select in `src/lib/ui/transactions/TransactionForm.svelte` like the
  Impor picker.

### A9. Dark heat steps: step 1 matches a zero-spend day
- Screens: Laporan "Tren harian", Kalender. Dark, both widths.
- Shots: `laporan-360-dark.png` (cells 1, 5, 7, 9 vs 2, 6, 8), `kalender-360-dark.png`.
- Problem: dark `--heat-1` #34334d against the zero-day cell (panel-2 grey) differs by about 1.2:1. The legend
  "sedikit ▢▢▢▢ banyak" first swatch is also hard to see. In light, the steps read clearly.
- Rule: DESIGN_SYSTEM § Colour (`--heat-1..4`), Accessibility (colour readable in every theme).
- Fix: `docs/design/tokens.css` / `src/app.css` dark and mono-dark `--heat-1` (lines ~226, 283, 443). Raise it to
  about 32 % accent. Alternatively, draw zero days as an outline only in `src/lib/ui/charts/HeatCalendar.svelte`.

### A10. Phone sections placed under the tab bar at first paint
- Screens: Beranda (empty account: the first-wallet card's "Tambah dompet" button), Laporan (the "Tren
  pengeluaran" tooltip pill), Kalender (day list), Anggaran (third category row).
- Shots: `empty-beranda-360-light.png` (the primary CTA sits behind the tab bar at y≈705),
  `laporan-360-light.png`, `anggaran-360-light.png`.
- Problem: bottom padding is correct, so nothing is unreachable. But the most important action for a new user
  is covered until they scroll.
- Rule: APP_PARITY § 3b.5; CLAUDE.md main journey ("add a wallet" first).
- Fix: `src/routes/(app)/+page.svelte`. With no wallet, render the first-wallet card before the greeting hero, or
  collapse the hero's scene strip, so the CTA lands above 640 px.

## B. Screen-specific findings

### B1. Alur uang: no hero number, and the Sankey labels clip at 360
- Shots: `alur-uang-360-light.png` ("Tem…", "Makan & …", "Ojek Onl…", "Kartu …", "−Rp4,16…", the column header
  "Pengeluaran" cut at the right edge), `alur-uang-1280-light.png` (the labels "BCA −Rp4,16 jt" and
  "Kartu Kredit BNI" sit on top of the ribbons; 10 px labels).
- Rule: principle 1 (one number first: the page leads with a 20 px line "Rp 12.500.000 masuk · Rp 5.267.000
  keluar"), DESIGN_SYSTEM § Charts.
- Fix: `src/routes/(app)/alur-uang/+page.svelte`. Lead with `HeroAmount` (selisih or uang keluar) plus the
  in/out line. In `src/lib/ui/charts/FlowChart.svelte`, give the right-hand label column a fixed width on phones
  (or move the labels under the nodes). Put a `--bg` halo (`paint-order: stroke`) on middle-node labels so they
  stay readable over the ribbons.

### B2. Laporan yearly: average label sits on a bar; the category heatmap opens on empty months
- Shots: `laporan-tahunan-360-light.png`. "Rp2,12 jt" is drawn across the Okt bar (`text-anchor=end` at `x=W`).
  "Kategori dari waktu ke waktu" shows Jan–Jun (all empty) at 360. Agu–Okt, the only data, is off-screen to the
  right.
- Fix: in `src/lib/ui/charts/StackedBars.svelte` (line ~93), place the average label at the left (`x=0`,
  `anchor=start`) or above the plot, on a `--bg` pill. In `src/lib/ui/laporan/CategoryGrid.svelte`, scroll the
  `overflow-x: auto` track to the current month on mount (`scrollLeft = scrollWidth`), or pin the latest months.

### B3. Laporan: "Tempat teratas" duplicates "Pengeluaran terbesar" and drops the minus sign
- Shots: `laporan-360-light.png`, `laporan-1280-light.png`.
- Problem: the two neighbouring lists use different row styles. Tempat teratas has 17 px regular names, no tile
  and "Rp 3.500.000"; Pengeluaran terbesar has 15/600 names, a tile and "−Rp 3.500.000". The category list also
  has no sign. One page shows the same expense with and without "−".
- Rule: DESIGN_SYSTEM § Formatting (expense `−Rp`), principle 4 (one grouped-list pattern).
- Fix: `src/routes/(app)/laporan/+page.svelte` lines ~265–280. Use the same `GroupRow` and 15/600 title for
  places. Decide one sign rule for "expense in an expense-only list" and apply it to both lists and
  `CategoryList`.

### B4. Dompet (phone): wallet names truncated to 6 characters; card row 4 lines tall
- Shots: `dompet-360-light.png` ("Mandir…", "Kartu …"; the card meta runs to 3 lines plus the due badge).
- Problem: tile 48 + "Saldo" label + 17 px balance + star icon leave about 70 px for the name. Desktop is fine
  (`dompet-1280-dark.png`).
- Rule: APP_PARITY § 3b.4, § 3 Dompet (name, type line, balance, chevron).
- Fix: `src/routes/(app)/dompet/+page.svelte` (`.name-text`, line ~625, and the favourite star). On phones,
  move the star into the edit sheet or under the balance, and let the name wrap to 2 lines.
- Also: the hero lacks the spec's context line ("Rp… tersedia · Rp… disisihkan untuk tujuan"). The monogram
  tiles mix cases ("BCA", "TU", "mdr"; `src/lib/ui/kit/BrandBadge.svelte` / `initials.ts`).

### B5. Kekayaan bersih: mixed list patterns, red used for plain debt
- Shots: `kekayaan-360-light.png`, `kekayaan-1280-light.png`.
- Problems:
  - "Utang −Rp 417.115.000" is `--money-up` red, while the KPR row below is ink.
  - The Dompet section rows have no tiles and 17 px names, unlike `/dompet`.
  - Each asset sits in its own panel card instead of one group per kind.
  - "+ Tambah aset" is a separate card about 4 px under the KPR card.
  - On desktop the AllocationBar floats at the top of the side column with no heading.
- Rule: DESIGN_SYSTEM § Colour ("Red is only for 'more than' and errors"), principle 4/5 (grouped lists).
- Fix: `src/lib/ui/net-worth/AllocationBar.svelte` (debt line colour to ink), and
  `src/lib/ui/net-worth/NetWorthSection.svelte` (one `GroupList` per kind, add row inside the group). In
  `src/routes/(app)/kekayaan/+page.svelte`, add an h3 "Pembagian" visibly over the bar on desktop.

### B6. Empty account: stacked "nothing here" blocks, and actions that cannot work yet
- Shots: `empty-beranda-360-light.png`, `empty-laporan-360-light.png`, `empty-anggaran-360-light.png`,
  `empty-impor-360-light.png`.
- Problems:
  - Beranda shows Rp 0, a full chart band, "Atur/Lihat anggaran", Struk/Suara and "Tutup hari ini" (closing an
    empty day) before the user has a wallet. Below come four separate empty sentences.
  - Laporan renders an empty heatmap, a flat cumulative line and green "Rp0 tersisa".
  - Anggaran lists all 17 expense categories, each "Belum ada pengeluaran bulan ini".
  - Impor stacks two illustrated empty cards (~300 px each).
- Rule: DESIGN_SYSTEM § Empty ("one muted sentence and one primary action").
- Fix:
  - `src/routes/(app)/+page.svelte`: hide the chart band, budget links and "Tutup hari ini" while no
    transaction exists.
  - `src/routes/(app)/laporan/+page.svelte`: one EmptyState when the period has no rows.
  - `src/routes/(app)/anggaran/+page.svelte`: list only categories with spending; otherwise one line.
  - `src/routes/(app)/impor/+page.svelte`: text-only empty for the second card.

### B7. Anggaran category row: the "tersisa" figure jumps under a long name
- Shot: `anggaran-360-light.png`. "Makan & Minum" puts "Rp645 rb tersisa" on its own line, left-aligned, while
  Kopi/Hiburan show it right-aligned on the name row.
- Fix: the category budget row in `src/routes/(app)/anggaran/+page.svelte`. Use
  `grid-template-columns: 1fr auto` with the name ellipsised, so the amount always stays right.

### B8. Riwayat day headers: long dates wrap
- Shots: `riwayat-360-light.png` ("Kamis, 1 Oktober / 2026" wraps when the day has both +in and −out),
  `riwayat-1280-light.png`.
- Rule: DESIGN_SYSTEM § Grouped list / Formatting ("Sabtu, 3 Okt"; year only when not the current year).
- Fix: `src/lib/ui/kit/DayHeader.svelte` / the day label helper used by `src/routes/(app)/riwayat/+page.svelte`.
  Use the short month and drop the year in the current year.
- Related: the transfer row "Isi saldo GoPay" uses the ✨ (Lainnya) tile, not a transfer glyph
  (`src/lib/ui/kit/CategoryTile.svelte` / `category.ts`).

### B9. Period stepper labels differ per screen
- Shots: `riwayat-360-light.png` and `kalender-360-light.png` ("Oktober 2026"); `laporan-360-light.png` and
  `alur-uang-360-light.png` ("Okt '26").
- Rule: DESIGN_SYSTEM § Chip/Period stepper ("Okt '26").
- Fix: pass the same label formatter to `src/lib/ui/kit/PeriodStepper.svelte` from Riwayat and Kalender.

### B10. Impor: the 4-way source switch is cramped at 360; mixed button styles
- Shot: `impor-360-light.png`. "CSV · Spreadsheet · Mutasi bank · Foto" is squeezed inside the card; "Foto" touches
  the card edge. "Pratinjau" (outlined) and "Impor" (ink) are both full-width, and "Baca dengan AI" is a
  disabled outlined pill.
- Rule: APP_PARITY § 3b.3 (chip rows scroll sideways and never squeeze), § 3 Impor.
- Fix: `src/lib/ui/impor/*` source switch (`Segmented` → scrolling `Chip` row on phones).

### B11. Beranda capture buttons: primary and secondary roles swapped on phone
- Shots: `beranda-360-light.png` (Struk outlined, Suara ink), `beranda-1280-light.png`.
- Rule: DESIGN_SYSTEM § Capture buttons. On phones Struk is ink and Suara panel; from 1024 px Struk is secondary
  and Suara primary.
- Fix: `src/routes/(app)/+page.svelte` lines ~527–545. Alternatively, update the spec if Suara-primary on phones
  is the intended change. While AI is off, Struk is disabled, so the "primary" capture is the unavailable one.
  Make the spec say which wins.

### B12. Desktop dialog scrim too light in dark mode
- Shot: `sheet-tambah-1280-dark.png`. The sidebar and Beranda stay fully readable behind the Tambah dialog.
- Fix: the scrim alpha for dark in `src/lib/ui/shell/Sheet.svelte` (`::backdrop`); about 55 % black in dark.

### B13. Sapaan sheet opens with a visible focus ring on the close button
- Shot: `sheet-sapaan-360-dark.png` (blue ring around ×).
- Fix: `src/lib/ui/home/DailyStory.svelte` / `src/lib/ui/shell/Sheet.svelte`. Focus the sheet heading
  (`tabindex=-1`) on open, so the ring appears only after keyboard use.

### B14. Smaller items
- Streak chip "0 hari berturut-turut" on Beranda for every user without a streak (`beranda-360-light.png`).
  Hide it at 0 or show "Mulai hari ini" (`src/routes/(app)/+page.svelte`).
- The date repeats four times on Beranda (badge, hero, "Hari ini" card caps label, chart "15 Okt"). Drop the
  card's caps label (`src/routes/(app)/+page.svelte`, Hari ini card).
- Kekayaan laporan: a single month shows one green dot at the far right of an empty plot, and green is
  `--money-in`, not `--accent`. Use `--accent` and show the empty-chart sentence below 2 points
  (`src/lib/ui/net-worth/PeriodTrend.svelte`; `kekayaan-laporan-360-light.png`).
- Ruang list: the "Sedang dipakai" badge (28 px, outlined) and the "Pakai" button (44 px, white outlined) sit in
  the same column at different sizes (`ruang-360-light.png`; `src/routes/(app)/ruang/+page.svelte`).
- Kotak masuk empty state has no action. Add "Hubungkan Gmail" or "Teruskan e-mail"
  (`kotak-masuk-360-light.png`; `src/routes/(app)/kotak-masuk/+page.svelte`). The "Alat pengembang" block shows
  only with `DEV_ROUTES`, which is expected.
- Tambah transaksi category grid: "Pesan Antar Makanan" is cut at the tile's bottom edge
  (`riwayat-baru-360-light.png`; `src/lib/ui/transactions/TransactionForm.svelte`). Use a 2-line clamp with
  ellipsis, or a min-height.
- Pengaturan: Passkey and Integrasi AI use the same key icon, and the subtitles of "Paket & kredit" and
  "Pemakaian" nearly repeat each other (`pengaturan-360-light.png`; `src/routes/(app)/pengaturan/+page.svelte`).

## Checked and fine

No horizontal scroll at 360 on any captured screen. The floating tab bar never covers the last row; the bottom
padding works. Hero numbers lead on Beranda, Laporan, Dompet, Anggaran, Kekayaan and Kartu. Expense amounts are
ink with U+2212 and income is green with "+". Dark mode text contrast on panels and glass looked correct
everywhere checked. The desktop sidebar, page header rows and the two-column layout at 1280 follow APP_PARITY
§ 1. Auth screens (ASCII card and Koko) are consistent across themes.

## Not covered

Mono and Pro themes; 601–1023 px widths; signed-in screens of feature modules not on the list (Langganan,
Barang, Koleksi, Patungan, Agen); the public site. The sapaan capture shows only its first card.
