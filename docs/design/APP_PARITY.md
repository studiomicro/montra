# App layout, page structure and interactions (2026-10-08)

Montra's own layout rules, written 2026-10-08: page structure, interaction and information density for desktop and
phone. The name, logo, mascot, illustrations, product names and every sentence of copy are Montra's — all text is
ours, Indonesian first with English via `tr()`. Category icons stay emoji in pastel circles (generic).

Our current gaps (screenshots of our app at the same sizes, 2026-10-08): desktop is a single 600 px centred column with a
flat 11-link sidebar; Laporan is a small summary card without charts; Beranda has no daily bars, no big Struk/Suara
buttons and no recent list; Riwayat has a labelled search form and no day groups; there is no Anggaran page and no
Dompet page.

## 1. Global shell

**Desktop (≥ 1024 px)**
- Left sidebar ~240 px, white, no border line. Top row: our wordmark, then three icon buttons — notifications (bell,
  `/notifikasi`), theme toggle (moon/sun), settings (gear, `/pengaturan`).
- Space card under it: rounded grey card with the space avatar, space name (bold) and a second line ("Kekayaan bersih
  penuh" / scope), up/down chevron; opens the space switcher.
- "Tanya Montra…" pill (assistant entry, `/tanya`; disabled state "Belum dikonfigurasi" while FN-22 waits).
- Grouped nav with small grey section labels:
  - **Uang:** Ringkasan (`/`), Transaksi (`/riwayat`), Laporan (`/laporan`), Anggaran (`/anggaran`), Dompet (`/dompet`).
  - **Fitur:** Jelajahi fitur (opens the Fitur sheet), then one link per enabled feature module (Kekayaan bersih
    `/kekayaan`, Langganan, Barang, Koleksi).
  - **Catat:** Impor (`/impor`), Kotak masuk (`/kotak-masuk`), Aplikasi terhubung (`/pengaturan/aplikasi`).
  - Active link: light grey pill background, bold text, filled icon.
- Bottom: plan card (sparkle icon, "Montra Pro", second line "Punya voucher?", chevron → `/pengaturan/paket`); a
  full-width black pill "+ Tambah transaksi" with a keyboard hint `N` (pressing `n` outside inputs opens the Tambah
  sheet); account row (initial avatar, name, small status line).
- Main area: page header row — H1 (~34 px, 800 weight) with a grey one-line subtitle under it (counts and totals, e.g.
  "15 transaksi · Rp 4.025.500 keluar"); actions right-aligned: secondary grey pills, primary black pill with `+` icon.
- Content is **two columns** on wide screens: main column (~740 px) + right column (~420 px), 40 px gap, max width
  ~1200 px, left-aligned next to the sidebar (not centred in the viewport). Single column below 1200 px.

**Mobile (< 1024 px)**
- Floating glass tab bar, 5 items with icon + label: Beranda, Riwayat, Laporan, Dompet, Tambah (Tambah = filled
  circle-plus icon). Active item: grey pill behind icon + label. **Superseded on phones by "Phone layout v3" below.**
- Page top bar: left = date line ("Kamis, 8 Okt") with a small grey chip under it (streak day once FN-34 exists;
  until then the month day "Hari ke-8"); right = round grey icon buttons: assistant, notifications, space avatar.
- No large H1 on Beranda (the number is the hero); other pages keep the H1.

## 2. Shared components (src/lib/ui/kit)

- **HeroAmount:** small grey label above ("Pengeluaran Oktober", "Sisa untuk dibelanjakan", "Total saldo"); "Rp" in
  small grey raised text, number in ~56 px (mobile) / ~52 px (desktop) bold tabular figures; eye icon toggles hiding all
  amounts on the page (persisted per device; hidden = "••••"). Under it: one grey line of context with **bold**
  figures and green for income.
- **ComparePill:** grey pill with a small coloured glyph: "≈ Hampir sama dengan September" / "↑ Lebih boros dari
  September" / "↓ Lebih hemat…".
- **GroupedList:** light grey (`--surface-2`) container, radius ~20 px, rows 60–68 px with hairline separators inset
  after the icon; row = 40 px pastel circle with emoji, title (medium) + grey second line, right-aligned amount, optional
  chevron.
- **Chips:** filter chips 32 px, grey background, black filled when selected; icon chips (Kategori, Dompet).
- **Segmented control:** two or three options in a grey track, selected option white with shadow (Bulanan/Tahunan).
- **Period stepper:** grey pill with ‹ label › (e.g. "Okt '26", "2026"); next disabled in the future.
- **PickerSheet:** centred white modal (desktop) / bottom sheet (mobile), radius 28 px, list of radio rows with icon,
  title and grey subtitle, optional "+ Tambah dompet" row at the end; dims the page behind.
- **Toggle row:** for the Fitur sheet (icon circle, title, grey description, switch on the right; "Beta" badge).
- Number format follows the UI language: Indonesian `Rp 4.025.500`, compact `Rp4,03 jt` / `Rp503 rb`; English
  `Rp 4,025,500`, compact `Rp4.03m` / `Rp503k`.

## 3. Pages

**Beranda (`/`)** — mobile order: top bar; HeroAmount "Pengeluaran <bulan>"; ComparePill; row "rata-rata Rp359 rb/hari"
left + "Batang harian ▾" select right (daily bars / per kategori / vs bulan lalu); daily bar chart of the last 14 days
(grey rounded bars, today labelled bold with an underline, tap a bar → that day's list); a thin progress bar with
"Rp2,47 jt tersisa · Rp103 rb sehari untuk 24 hari" (from budgets; hidden without a budget); two big buttons side by
side: **Struk** (black, receipt icon) and **Suara** (grey, mic icon); "Hari ini" card (grey, small caps date label,
title, one line, full-width grey button — today's entries or an empty prompt); a centred link to enabled features;
**Terbaru** list (3 rows, "Lihat semua" → Riwayat; second line "7 Okt, 16:32 · Makan & Minum · Tunai"); **Akan
datang** list (bills from FN-26 and reminders, "dalam 2 hari"). Desktop: same content in the two-column layout (hero +
chart + buttons left; Hari ini, Terbaru, Akan datang right).

FN-54 (2026-10-13) changes the top of Beranda: the top bar is the date badge (→ `/kalender`) left and the actions
right, with the streak chip under them; the first card is the **greeting hero** (WIB date, "Selamat pagi." and so on,
one line about today, the month figure with the comparison and budget chips, an ask field that prefills Tanya, the
scene strip with a still Koko), then the charts. Phone keeps Struk and Suara at the bottom of the main column. Desktop
(≥ 1024 px) has a visible H1 "Beranda" with the streak chip under it and the badge, **Struk** and **Suara** on the
right of that header row (the bottom pair is not rendered). The centred features link becomes a **"Fitur"** tile grid
at the end of the side column (after Akan datang; "Kelola fitur" opens the Fitur sheet). Once per WIB day a short
greeting sheet of the user's own figures may open (switch in Pengaturan › Tampilan).

**Transaksi (`/riwayat`)** — header actions: Pilih (bulk select), Ekspor CSV, + Tambah transaksi. Row 1: search field
("Cari judul, catatan, kategori, dompet atau nominal", magnifier icon, no label above, searches on input with debounce)
+ period chips (Periode ini, 30 hari, 90 hari, Tahun ini, Semua). Row 2: type chips (Semua, Pengeluaran, Pemasukan,
Transfer, Penyesuaian saldo) + Kategori and Dompet picker chips + sort select (Terbaru dulu) at the far right. List
grouped by day: day label left ("Kemarin", "Sel, 6 Okt 2026"), day totals right (green +income, grey −expense); each
day is one GroupedList. Desktop row columns: icon + title / time · category · wallet (transfer "BCA → Tunai") · amount
right. Mobile row: icon, title, "16:32 · Makan & Minum · Tunai", amount.

**Laporan (`/laporan`)** — header right: segmented Bulanan/Tahunan + period stepper. Left column: label "Uang keluar"
+ HeroAmount + line "dari Rp9,5 jt pemasukan · Rp5,47 jt tersisa". Monthly: "Tren harian" calendar heatmap (Mon–Sun
grid of the month, cells shaded by spend in 4 steps of one accent colour, today outlined, legend "sedikit ▢▢▢▢
banyak", tap a day → that day); "Tren pengeluaran" cumulative line for this month vs last month (accent line + grey
line, tooltip pills, dashed "today" marker) and a ComparePill under it; then two columns: "Tempat teratas" (rank,
title, count ×, total) and "Pengeluaran terbesar" (GroupedList). Yearly: "Tren bulanan" stacked bars per month by top
4 categories + Lainnya, dashed average line with label, legend chips; "Tren pengeluaran" cumulative vs last year;
"Kategori dari waktu ke waktu" heatmap table (rows = categories, columns = months, darker = bigger, total at the end).
Right column (both): "Ke mana uangnya" donut (centre: "Uang keluar", compact total, "5 kategori"; tap a slice →
category) and a category GroupedList with "62% · Rp313 rb/hari" (or "/bln" yearly) and chevrons.

**Anggaran (`/anggaran`, new page using FN-07 data)** — subtitle "1 Okt – 31 Okt 2026 · 23 hari lagi"; actions:
"Awal periode anggaran" (grey; uses FN-07's period start if it exists, else opens a picker), "Ubah anggaran" (black).
HeroAmount "Sisa untuk dibelanjakan" + "Rp216 rb sehari sampai 31 Okt" + a progress bar with a pace marker + "Rp1,53 jt
terpakai dari Rp6,5 jt · diperkirakan Rp5,91 jt di akhir periode". "Per kategori" GroupedList: name, "Rp364 rb
tersisa" right, progress bar with a pace marker, grey "Rp 836.000 / Rp 1.200.000"; amber text + bar with "Lebih cepat
dari jadwal" when projected over budget; red when over. Right column: "Belum ada anggaran" list of spending
categories without a budget, then a small grey note explaining the pace marker (our wording).

**Dompet (`/dompet`, wallets + goals; replaces the Kekayaan tab)** — actions: Transfer (grey), + Tambah dompet (black).
HeroAmount "Total saldo" + "Rp15,92 jt tersedia · Rp5,7 jt disisihkan untuk tujuan". "Dompet kamu" GroupedList (wallet
logo/icon, name with ★ for the favourite, type line, balance, chevron). Right column: "Tujuan" with "Lihat semua"; goal
rows with a thin coloured progress bar, "%" right, "Rp4,5 jt dari Rp30 jt". `/kekayaan` becomes the Kekayaan bersih
feature page (FN-25 net worth) reached from the Fitur section; existing `/kekayaan` rows for Langganan/Barang/Koleksi
move to the sidebar Fitur section and the Fitur sheet.

**Fitur sheet** (from "Jelajahi fitur") — back arrow + title, one grey intro line (our words), toggle rows: Kekayaan
bersih, Barang, Langganan, Koleksi (FN-12 toggles); planned features appear only once they exist (Streak FN-34, Alur
uang FN-35, Agen FN-23).

**Impor (`/impor`)** — subtitle line; left: "Impor mutasi" card (Dompet picker + Template bank picker opening
PickerSheets, the latter with Deteksi otomatis + bank/e-wallet list with coloured dots, then the dashed drop zone with
upload icon, title, grey explanation, CSV badge, "Pilih file" black + the AI-reading button disabled with its reason),
"Riwayat impor" card with empty state; right: "Cara lain memasukkan data" list (Impor/ekspor CSV, Pindai struk, Gmail,
Pintasan) and "Pekerjaan membaca terbaru" card.

## 3a. Visual language revamp (owner request 2026-10-08)

The whole app follows one visual language, not only the pages above. Our neutral tokens already carry the colours (`--bg` #FFFFFF, `--panel` #F5F5F7, `--chart-track` #ECECEF,
`--chart-bar` #D9D9DD, `--ink` #171717, hairlines ≈ `--line`); what follows is how we apply them. Rules for every screen:

- **Fills, not frames.** In-app cards and grouped lists are `--panel` fills, radius 20 px, no border, no shadow.
  Shadows only on floating things: tab bar, sheets, popovers, the selected segment.
- **Ink is the only action colour.** Primary = ink pill (white text), secondary = panel pill, icon buttons = 40 px
  round panel. `--brand` blue stays only for the focus ring and inline text links; remove blue fills from toggles,
  segmented controls, charts, the sidebar and forms (switch on = ink).
- **One data accent.** New tokens: `--accent` #6C63F0 (dark: #8B85F5) for the selected chart series, trend line,
  today's bar and the heatmap's top step; `--heat-1..4` = #E2E0FC, #C4C0F8, #9C95F3, #6C63F0 (dark: accent at 32/48/68/100 %
  on `--panel`). Income stays `--money-in`, over-budget `--money-up`, "ahead of pace" amber: `--warn` #C27A0E for bars (new),
  `--warn-text` #A15F00 for text (#C27A0E is only 3.5:1 on white, below AA).
  Other chart series use the category hues already in `tokens.css`.
- **Type scale.** Page H1 34 px / 800 desktop, 28 px mobile, with a 15 px grey subtitle line; section title 20 px /
  700 with a 13 px grey subtitle; HeroAmount as in § 2; row title 15 px / 600, second line 13 px grey; chips 13 px / 600.
  Typeface is Geist since the owner decision of 2026-10-10 (DESIGN_SYSTEM § Typography); tabular figures for every amount.
- **Rows.** 40 px pastel circle (category hue at 16 %) with emoji or wallet logo; amount right-aligned, bold;
  chevron only when the row opens something.
- **Inputs.** 48 px, radius 12, panel fill, no border; search field is a full-width panel pill with a leading icon.
- **Dark mode.** Same rules on the existing dark tokens; ink pill becomes white pill with dark text.
- **Hitam-putih and glass (FN-40, design system v3).** A 4th theme, mono greys that follow the device scheme
  (money in/out and the brand focus colour keep their hue), picked in Pengaturan › Tampilan. Floating chrome — tab
  bar, the sidebar's sticky bottom block, sticky screen titles, sheets, banners, floating cards — uses the shared
  `.glass` material (`--glass-bg`, `--glass-border`, `--glass-shadow`, `--glass-blur`; `.glass-soft` for sticky bars:
  `--glass-bg-soft`, `--glass-blur-soft`). "Fills, not frames" still holds for content. Fallback to `--glass-solid`
  under reduced transparency or without `backdrop-filter`; at most 3 blurred layers on screen
  (DESIGN_SYSTEM.md § Shape, spacing, elevation).

Every page not covered by § 3 gets the same treatment (**wave D**): Pengaturan and all sub-pages, Paket, Privasi,
Notifikasi, Kotak masuk, Ruang, Tanya, Kekayaan bersih, Langganan, Barang, Koleksi, Tambah sheet and its forms,
and the auth pages (`/masuk`, `/daftar`). Pattern: page header row (§ 1), panel GroupedLists instead of bordered
cards, chips/segmented from the kit, ink primary action top-right on desktop and full-width at the bottom on mobile.
The public site (FN-32) keeps its own layout but uses the same tokens. Brand rules from DESIGN_SYSTEM.md § Brand still
apply: no other product's name, logo, mascot, product names or copy.

## 3b. Phone layout v3 (owner request 2026-10-10: "make the phone layout simple")

A simple phone layout pattern; Montra keeps its own name, copy, icons, tokens, light/dark and currency format
(`Rp 1.264.000`). Applies up to 600 px; the desktop sidebar and the 601–1023 px layout keep their earlier shape.

1. **Page header** (`ScreenTitle`): big bold title left, the grey subtitle on its own line under it, and the page's
   secondary links as small underlined text on the right of the title row (`a.btn.secondary` in the header actions). A
   primary add action that carries an icon (Dompet "Tambah dompet", Berulang "Tambah") becomes a 44 px square outlined
   "+" there; its text stays the accessible name.
2. **Toolbar row** (Riwayat): the full-width grey search field and, to its right, a square outlined "+" (`/riwayat/baru`).
3. **Filter chips** (`Chip`): one row, the active chip filled ink, the others outlined; the row scrolls sideways, it never wraps.
4. **Record rows** (`GroupList records`, Riwayat, Beranda's Terbaru, Dompet, Langganan, Kotak masuk): no panel, a 48 px
   rounded-square tile, bold 17 px title and a grey 14 px meta line, on the right a small grey label over the bold
   amount (Pengeluaran / Pemasukan / Transfer, "Saldo" for a wallet), rows at least 72 px high, the hairline starting
   after the tile. The one big number on Beranda and every other hero is unchanged; a long figure shrinks to its line.
5. **Bottom navigation** (`TabBar`): a compact floating glass pill at the bottom-left with the four tabs as icons only
   (Beranda, Riwayat, Laporan, Dompet; each has an `aria-label` and `aria-current`; the current one is ink on a darker
   pill, the others grey) and, separate, a round ink "+" at the bottom-right that opens Tambah (the `N` shortcut stays).
   Both sit `16px + --sai-bottom` above the bottom and clear of the side insets; the page keeps `--tabbar-h + 40px`
   of bottom padding so the last row is never covered.

## 4. Not in this pass (feature gaps)

Streak with daily close and coins (FN-34), "Follow the money" flow chart (FN-35), recurring transactions + the "aktif
berulang" filter, a "Penyesuaian saldo" transaction type if FN-05 lacks it, bulk select actions beyond select/delete,
guest mode ("tersimpan di perangkat ini", FN-02 — deferred by owner decision 2026-10-07). Listed in `docs/TASKS.md`.
