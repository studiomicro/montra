# MONTRA design system v3

Version 3.0, 2026-10-08 (v2: 2026-10-08, v1: 2026-10-07). Tokens: [`tokens.css`](tokens.css) (FN-00 imports it from `src/app.css`).

## Source and limits

These are Montra's own design rules: a neutral palette, type scale, radii, spacing, motion, component shapes and
layout patterns, written down so every screen follows one system. Most of it is generic Apple-style UI (`#F5F5F7`
panels, pill buttons; the typeface is Geist, see § Typography).

What identifies Montra as a brand is ours alone:

- the accent: our own `--brand` (blue, the final hue is an open decision);
- the mascot (Koko), illustrations, logo, favicon and app icon;
- product names and copy: taglines and headline wording are written for Montra.

**Why:** a lookalike of another product's brand risks passing-off and trade-dress claims, and it would confuse users
about who holds their financial data. The final brand hue and logo are open decisions (`docs/TASKS.md`).

## Principles

1. **One number first.** Every main screen leads with one big tabular figure, then the context in plain words.
2. **Rupiah, not percent.** Comparisons say "Rp 120.000 lebih hemat", not "−8 %". Percent only as a secondary label.
3. **Black and white, colour for meaning.** Primary actions are ink on white (white on ink in dark mode). Colour
   means money in, money up, "about the same", or a category, never decoration.
4. **Grouped lists, not tables.** Records sit in rounded grey groups with hairline separators, like iOS Settings.
5. **Fills, not frames (v2).** In-app cards and grouped lists are `--panel` fills, radius 20, no border, no
   shadow. Shadows only on floating things: tab bar, sheets, popovers and the selected segment.
6. **Ink is the only action colour (v2).** Primary = ink pill, secondary = panel pill, icon buttons = 40 px round
   panel, switch on = ink. `--brand` blue is only the focus ring and inline text links; one data accent
   (`--accent`) marks the selected chart series, never an action.
7. **Quiet motion.** Short eased transitions; buttons shrink to 0.97 on press; nothing moves under reduced motion.

## Colour

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#FFFFFF` | `#111112` | page background |
| `--bg-soft` | `#FAFAFA` | `#141415` | alternate section background |
| `--panel` | `#F5F5F7` | `#1C1C1E` | groups, chips, secondary buttons, pills |
| `--panel-2` | `#EBEBEF` | `#262628` | pressed/hover panel, panel on panel |
| `--line` | `#E5E5EA` | `#2C2C2E` | hairlines between rows |
| `--ink` | `#171717` | `#F5F5F7` | text, primary button fill |
| `--ink-2` | `#3A3A3C` | `#D1D1D6` | secondary strong text |
| `--muted` | `#6E6E73` | `#A1A1A6` | meta text, labels |
| `--faint` | `#A1A1A6` | `#6E6E73` | placeholders, disabled |
| `--money-in` | `#16813A` | `#3DBE68` | income amounts, "lebih hemat", success tag |
| `--money-up` | `#CF3339` | `#FF6B70` | "lebih banyak", over budget, destructive |
| `--same` | `#5B52E0` | `#8A81F8` | "hampir sama" state |
| `--brand` | `#1F6FEB` | `#4C8DFF` | **ours**: links in text and the focus ring only (v2: never a fill) |
| `--accent` | `#6C63F0` | `#8B85F5` | the one data accent: selected chart series, trend line, today's bar, top heat step |
| `--heat-1..4` | `#E2E0FC` `#C4C0F8` `#9C95F3` `#6C63F0` | accent at 22/40/62/100 % on `--panel` | heatmap steps |
| `--warn` | `#C27A0E` | `#E0A032` | "ahead of pace" bars |
| `--warn-text` | `#A15F00` | `#E8AA45` | "ahead of pace" text (AA; `--warn` is only 3.5:1 on white) |
| `--raised` | `#FFFFFF` | `#3A3A3C` | the selected segment on its panel track |
| `--dark*` | see tokens | | always-dark bands (security section, media) |

Expense amounts are **ink** with a minus sign (`−Rp 25.000`), not red. Red is only for "more than" and errors.

**Category hues** (`--cat-*`): a category tile is a circle filled with 16 % of the hue mixed into the surface
(`color-mix(in srgb, var(--c) 16%, var(--bg))`) holding an emoji. Presets: Kopi `#B07A4F` ☕, Makan & Minum
`#0EA5E9` 🍜, Belanja Harian `#14B8A6` 🛒, Belanja `#F59E0B` 🛍️, Transportasi `#6366F1` 🛵, Tagihan `#A78BFA` 🧾,
Hiburan `#8B5CF6` 🎬, Kesehatan `#EF4444` 💊, Pendidikan `#3B82F6` 📚, Tempat Tinggal `#64748B` 🏠, Gaji `#22C55E`
💼, Bonus `#84CC16` 🎁, Freelance `#06B6D4` 💻, Hadiah `#EC4899` 🎀, Lainnya `#A1A1AA` ✨. (Kopi, Makan, Belanja Harian, Transportasi, Tagihan, Hiburan and Gaji follow common
expense-app conventions; the rest are ours.)

**Themes.** Sistem (follows the device), Terang, Gelap and **Hitam-putih** (mono, FN-40) — chosen in Pengaturan ›
Tampilan, stored only in the `theme` cookie (no account setting). The sidebar's theme button cycles the same four choices (Sistem → Terang → Gelap → Hitam-putih), its icon showing the one in force. Mono is one `:root[data-theme='mono']` block of pure greys (r = g = b) for every surface, text,
chart, heat, warn, `--same`, `--ok`, `--dark*` and category hue, plus a `prefers-color-scheme: dark` block with the
dark greys: mono follows the device scheme, there is no separate mono-light/mono-dark choice. Exceptions, by owner
decision: `--money-in`/`--money-up` keep their green/red (colour only for meaning) and `--brand` keeps its blue (focus
ring, inline links). Mono light: `--bg` #FFFFFF, `--panel` #F4F4F4, `--ink` #141414, `--muted` #6C6C6C, `--accent`
#2E2E2E; mono dark: `--bg` #121212, `--panel` #1D1D1D, `--ink` #F5F5F5, `--muted` #A3A3A3, `--accent` #D6D6D6 (all
values in `tokens.css`). `<meta name="theme-color">` follows the theme's `--bg` (hooks.server.ts).

**Pro look (FN-46).** Two more themes for Pro and Agen only: **Emas** (`gold`) and **Hijau tua** (`emerald`), listed
after Hitam-putih and structured like it (a light block plus a `prefers-color-scheme: dark` block). They tint the
surfaces, charts and heat steps; `--ink`, `--money-in`/`--money-up`, `--warn-text` and `--brand` keep the base
scheme's values. The sidebar button never cycles into them. The plan decides, not the cookie: hooks.server.ts shows
`system` for a Pro theme from an account without a paid plan in force. Three Pro tokens serve the rest of the look:
`--pro` (the crown on Koko and the badge, 3:1), `--pro-text` (the badge's word) and `--pro-soft` (badge pill, the
Paket card, Beranda's hero frame — a gradient from `--pro-soft` to `--panel`, background only). All three are greys in
mono. `<ProBadge>` (Koko's 8 × 3 pixel crown + "Pro") sits beside the account name; Agen shows the same badge.

**Glass** (FN-40; rules in `src/app.css` `.glass`, `.glass-soft`):

| Token | Light | Dark | Mono | Use |
| --- | --- | --- | --- | --- |
| `--glass-bg` | white 78 % | `#1C1C1E` 78 % | white / `#1D1D1D` 78 % | glass fill |
| `--glass-solid` | `#FFFFFF` | `#1C1C1E` | `#FFFFFF` / `#1D1D1D` | opaque fallback; text contrast is tested on it |
| `--glass-border` | white 70 % | white 10 % | as light/dark | 1 px specular inner edge |
| `--glass-shadow` | ring 6 % + 2 soft layers | ring white 8 % + 2 layers | as light/dark | glass elevation, press lift |
| `--glass-blur` | blur 16 + saturate 180 % | same | blur 16, no saturate | backdrop filter |
| `--glass-bg-soft` / `--glass-blur-soft` | `--bg` 72 % / blur 10 | `--bg` 72 % | `--bg` 72 %, no saturate | sticky bars, cards over colour |

Contrast: every text/background pair meets WCAG AA in all eight theme variants — light, dark, mono-light,
mono-dark, gold, gold-dark, emerald, emerald-dark — and text on glass is checked against `--glass-solid`; a contrast test gates this (FN-00, FN-40).

## Typography

**Geist** (Vercel; SIL Open Font License 1.1; npm `geist@1.7.2`), self-hosted as one variable WOFF2 (weights 100-900,
Latin + Latin-Ext, includes U+2212) under `static/fonts/geist/<version>/` with its `OFL.txt`; stack
`"Geist", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` (`--font`). **Owner decision 2026-10-10**, replacing
the earlier "system font, no web font download" rule. Rules that follow from it: no third-party font request (CSP stays
`font-src 'self'`); `font-display: swap`; the file is preloaded in `app.html`, precached by the service worker and
served `immutable` from its versioned path. **Geist Mono** (`--font-mono`) is only for keys, endpoints and code samples
on settings pages, never for amounts. Numbers always use `font-variant-numeric: tabular-nums`. Base body 17 px / 1.5,
antialiased. Geist runs slightly wider than SF: the sizes and tracking below are unchanged and every fit is checked
at 320-360 px (`e2e/ios-responsive.spec.ts`).

**App scale** (inside the app, phone first):

| Style | Size / line | Weight | Tracking | Use |
| --- | --- | --- | --- | --- |
| `hero-num` | 56 px phone / 52 px desktop, 1.05 | 700 | −0.045em | the one number; "Rp" as a 0.42em superscript in `--muted` |
| `title` | 34 px / 1.1 desktop, 28 px phone | 800 | −0.03em | page H1, with a 15 px muted subtitle line |
| `h3` | 20 px / 1.2 | 700 | −0.02em | section title inside a screen, 13 px muted subtitle |
| `h4` | 19 px / 1.25 | 600 | −0.012em | card title |
| `body` | 17 px / 1.5 | 400 | 0 | text |
| `row-title` | 15 px | 600 | 0 | row title; the row amount is 15 px / 700 |
| `label` | 14 px / 1.2 | 600 | −0.005em | field labels, day headers |
| `meta` | 13 px | 400 | 0 | "16.32 · Kopi · GoPay", timestamps |
| `chip` | 13 px | 600 | 0 | filter chips, segmented options |
| `tab` | 11 px | 500 | 0 | tab bar labels |

**Site scale** (landing, blog): `display` clamp(44px, 7.2vw, 100px)/1, 600, −0.044em; `h2` clamp(36px, 5.4vw,
72px)/1.02, 600, −0.042em; `lead` clamp(18px, 1.55vw, 21px)/1.45 muted; `stat` clamp(96px, 14vw, 200px)/0.86, 600,
−0.065em. Headlines use `text-wrap: balance`, paragraphs `text-wrap: pretty`.

## Shape, spacing, elevation

- Radii: 8 (small controls), 12 (inputs, thumbnails), **20 (grouped lists and in-app cards; v1: 18)**, 20, 28 (sheets,
  phone-sized cards), 36 (hero cards), pill 999 for every button, chip, badge and the tab bar; service logos use
  app-icon corners (28 %).
- Spacing on a 4 px grid; screen side padding 20 px on phones; page gutter `clamp(16px, 4vw, 40px)`; content max
  width 1200 px (site) and 640 px (app column on desktop).
- Elevation is rare: floating cards (`--shadow-card`), popovers (`--shadow-float`), bottom sheets
  (`--shadow-sheet`). Lists and panels are flat.
- **Glass** (FN-40) only on floating chrome: tab bar, the sidebar's sticky bottom block, the sticky screen title
  (soft), sheets and PickerSheets (glass tinted with `--bg` at 86 %, so the forms inside keep their panel fills),
  notification banners and floating cards/toasts. Content cards stay flat `--panel` fills; a card directly over a
  colour or photo background uses the soft variant, never full glass. Segmented tracks and selected chips get the
  glass edge and shadow without a blur (they sit in the page, not over it).
- A component opts in with `class="glass"` (plus `glass-soft`) and never sets its own background, box-shadow or
  backdrop-filter; it may tint with `--glass-fill`/`--glass-fallback`. `backdrop-filter` appears only in `app.css`.
- **Fallback:** `prefers-reduced-transparency: reduce` and browsers without `backdrop-filter` show `--glass-solid`
  (soft: `--bg`) with `--shadow-float` and no blur.
- **Blur budget: at most 3 blurred layers on screen.** Page chrome holds 2 (tab bar *or* sidebar, plus the sticky
  title); under an open sheet every glass surface outside the dialog drops its blur (it is under the scrim), so each
  open sheet is 1 layer; in-page glass content is counted per route. `test/glass-budget.test.ts` enumerates this.
- **Press lift:** glass tabs and chips add `--glass-shadow` while pressed, on top of the press scale, only under
  `prefers-reduced-motion: no-preference`.

## Motion

- Easing `--ease` (0.2, 0.8, 0.2, 1) for most transitions, `--ease-in-out` for sliding content, `--spring` only for
  small confirmations (saved tick).
- Durations (v3 tokens, mirrored in `src/lib/ui/motion.ts`): `--duration-fast` 150 ms (press, chips),
  `--duration-base` 200 ms (rows, charts, page fade-in), `--duration-slow` 300 ms (sheets, the counting hero
  number). Nothing runs longer than 300 ms except the illustrations' slow float (three 6 s
  cycles after a scene appears, then still; nothing is infinite).
- Press: `transform: scale(0.97)` on buttons, chips, tappable and checkbox rows.
- Placements (FN-40 Part 2): the sheet rises in and sinks out (`@starting-style` + `display`/`overlay`
  transitions); the hero number counts from the old to the new figure in whole minor units after a change on the
  page, never on first paint; charts grow in on mount; a list's first 8 rows fade in 30 ms apart (row 9 on has no
  delay); the new page fades in (opacity only, on `<main>`) after a client-side navigation. Not the View
  Transitions API: Chromium drops taps while a view transition runs, so a quick tap on the next page was lost.
- Placements (FN-51, both form factors): the new page rises 8 px as it fades in (`<main>`, transform + opacity,
  fill `none`); a day header arrives with its first row; the import batch an action named replays `row-in`; a
  discarded Kotak masuk row fades out (150 ms, Web Animations); Donut, CumulativeChart, StackedBars, TrendChart,
  AllocationBar, CategoryBar and ProgressBar draw in on mount (rotate, dash, scale, fade — never width or height);
  the skeleton shimmer (`--duration-loop` 1.2 s) is the one `infinite` animation besides MascotLoading, allowed
  because both leave the DOM with the loading branch; client-only banners slide in 6 px; the streak chip hops once
  when the count grows; the Tambah "+" turns 45° while its sheet is open. Desktop (≥ 1024 px, fine pointer):
  tappable rows and cards lift 1 px on hover/focus (colour only under reduce, no shadow) and the centred dialog
  scales in from 0.96. Installed app only: Koko waves once per WIB day beside the hero label, and a pull from the
  top of Beranda or Riwayat reloads the page (indicator moved by a paused Web Animation). Script-driven motion also
  stops in a hidden tab (`motionAllowed`).
- Every addition sits inside `@media (prefers-reduced-motion: no-preference)` (or checks `prefersReducedMotion`),
  so `reduce` shows the end state at once — `test/motion-css.test.ts` and `e2e/motion.spec.ts` check it. The older
  global rule in `src/app.css` ends animations at once and switches transitions off (0 s, not 0.01 ms: a
  tiny transition still showed the old value for a frame). A rising sheet takes no taps until it has settled.

## Illustrations

- `<Illustration name size alt>` (`src/lib/ui/kit/Illustration.svelte`): original isometric scenes drawn for this
  app from `illustrations/iso.ts` boxes and discs — never another product's mascot or artwork. Five tones (neutral,
  accent, gold from `--cat-belanja`, paper, device), three faces each, all from theme tokens via `light-dark()`, so
  they repaint in light, dark and both mono variants; no colour inside the SVG.
- Decorative by default (`aria-hidden`); the text beside it carries the meaning. Placements: `EmptyState`'s
  optional `illustration` prop (the domain empty states). Since FN-44 the error pages, the sign-in/sign-up hero and
  Beranda's first-wallet card show Koko instead (below). A later Rive file can replace a scene behind the same `name`; no Rive runtime ships yet.

## Mascot (FN-44)

- **Koko**, a living coin: original pixel art drawn for Montra on a 24×24 grid (`src/lib/ui/kit/mascot/poses.ts`)
  — never Clawd or any other brand's character. `<Mascot pose size alt>` draws each run of pixels as
  an inline `<rect>` with `shape-rendering: crispEdges`.
- v2 (2026-10-10, owner request "more cute"): a squat round coin with a lit top-left side and gleam, round dark eyes
  with a glint, pink cheeks, a small smile.
- Colours from tokens only: body `--accent` (grey in mono), outline `--ink`, coin edge and legs `--ink-2`; eyes and
  mouth dark with a light glint (`light-dark()` of `--ink`/`--bg`; light eyes in mono light, whose body is dark);
  lit side and cheeks are `color-mix()` of `--accent` / `--cat-hadiah` with that light. No new token or contrast
  pair.
- Poses: `idle` (blinks twice), `wave` (sign-in/sign-up hero above 768 px, Beranda's first-wallet card), `hop`
  (a new transaction in Riwayat, the voice toast), `celebrate` (right after closing the day; a monthly budget save
  while safe-to-spend is left — never when spent or over), `sad` (error pages), `sleep` (`EmptyState` without an
  `illustration`; `mascot={false}` keeps it text only), `loading`. Frames cut with `steps(1)`, a few cycles, then
  rest on frame 0; nothing moves under reduced motion. A scene and Koko never share an empty state.
- Decorative (`aria-hidden`); the text beside Koko carries the meaning. Koko never speaks and has no copy.
- `MascotLoading`: the one loop — Koko walks at the top of the app while a client-side navigation is in flight,
  and is not in the DOM otherwise. Under reduced motion it is the text "Memuat…" only.
- The favicon and the PWA/apple-touch icons are Koko's idle frame in the light colours, written by
  `node scripts/generate-mascot-icons.ts` (Playwright's Chromium; outputs committed, not part of the build).

## Components

**Button** — pill, 600 weight, no border. Sizes: `lg` 52 px high / 24 px padding / 16 px text; `md` 44 px; `sm` 40
px / 18 px / 15 px. Variants: `primary` ink fill + bg text (hover adds `--shadow-btn-hover`); `secondary` panel fill
(hover panel-2); `ghost` transparent; `destructive` money-up text on panel. Disabled = 50 % opacity. Full-width in
sheets ("Simpan 2 transaksi", "Masukkan 128 transaksi").

**Capture buttons on Beranda** — two big pills side by side: **Suara** (panel fill, mic icon) and **Struk** (ink
fill, receipt icon); the + tab opens all capture paths.

**Badge** — 28 px pill, panel fill, 13 px / 600. **Status tag** — inline green text with a filled green check
circle ("Tercatat", "AI setuju").

**Chip** — 32 px pill on panel (44 px on coarse pointers), 13 px / 600; selected = ink fill, bg text, a glass
top highlight; pressed adds the glass lift; an icon chip
(Kategori, Dompet) opens a PickerSheet. **Segmented control** — options on a panel track; the selected option is a
`--raised` pill with the glass edge and `--glass-shadow`; the track carries the glass edge (Bulanan/Tahunan). **Period stepper** — panel pill ‹ label ›; next is disabled
in the future.

**ComparePill** — panel pill with a coloured glyph: "≈ Hampir sama dengan September" (`--same`), "↑ Rp120 rb lebih
boros dari September" (`--money-up`), "↓ Rp80 rb lebih hemat dari September" (`--money-in`). Rupiah, never percent.

**HeroAmount** — muted label ("Pengeluaran Oktober"), `hero-num`, an eye button that hides every amount on the page
("••••", remembered per device), then one muted context line with bold figures. Left-aligned in the app.

**Grouped list** — panel fill, radius 20, no border; rows 60 px+ separated by a hairline that starts after the icon
(inset 68 px). **Day header** above each group: day name left ("Hari ini", "Kemarin", "Sabtu, 3 Okt"), that day's in/out right,
muted 14 px.

**Transaction row** — 40 px category tile (circle, tinted, emoji) · title (15 px / 600, one line, ellipsis) over
meta "16.32 · Kategori · Dompet" (muted 13 px; transfers "BCA → Tunai") · amount right (700, tabular; income in
`--money-in` with "+"). Optional status
tag under the meta. Row min height 56 px; whole row tappable.

**Service logo** — subscriptions: the service mark on its brand colour, 28 % corner radius, same size as a category
tile.

**Floating card** — glass card, radius 20, used for "just captured" toasts and onboarding
illustrations of a transaction.

**Notification banner (in-app)** — glass panel, radius 22, icon 38 px, small muted top line (app name, "baru
saja"), bold title, one-line text. Mirrors the system push look for in-app confirmations ("Dicatat dari Gmail").

**Tab bar** — phone layout v3 (owner request 2026-10-10): a compact floating glass pill, 68 px high, bottom-left,
16 px from the left edge and above the bottom safe area, holding four icon-only tabs (Beranda · Riwayat · Laporan ·
Dompet; 52 px cells, `aria-label` names; the current tab is ink on a darker pill, the others `--muted`, 3:1 icon contrast), plus a
separate 68 px round ink "+" (Tambah) bottom-right. On ≥ 1024 px both give way to the sectioned left sidebar
(APP_PARITY § 1). See APP_PARITY § 3b for the rest of the phone layout (header link, toolbar, outlined chips, record rows).

**PickerSheet** — bottom sheet (phone) / centred dialog (desktop), radius 28, radio rows with icon, title and muted
subtitle, an optional "+ Tambah …" row; dims the page. **Toggle row** — icon circle, title, muted description,
switch (on = ink), optional "Beta" badge.

**Charts** — daily bars: rounded 4 px bars in `--chart-bar`, the selected day in `--accent`, day numbers under
the bars with today bold and underlined, horizontal swipe
over the last 14 days, a tap shows the day's figure; calendar heat view; category breakdown as a horizontal stacked
bar plus list; month-vs-month as two lines (this month `--accent`, last month faint). Simple SVG, no chart library.

**Sheets and review screens** — bottom sheet radius 28 on phones, centred dialog on desktop; title row with close;
sticky primary action at the bottom. Review screens (Periksa draf, Tinjau impor, Transaksi dari Gmail) use a summary
card, segmented filter, grouped rows with checkboxes, flags ("Mungkin duplikat" in `--same`, "Periksa totalnya" in
`--money-up`), bulk actions "Atur kategori" / "Atur dompet", and one sticky primary button with the count.

**Inputs** — 48 px high, radius 12, panel fill, no border; the search field is a full-width panel pill with a
leading magnifier; focus ring 2 px `--brand`; amount field uses `hero-num`
size with the "Rp" prefix and live thousand separators.

**Empty, loading, error** — empty: one muted sentence and one primary action; loading: skeleton rows in panel-2
with a soft pulse (none under reduced motion); error: one sentence in ink, a retry button, never a raw code.

## Layout patterns

- **Phone (default):** single column, 20 px side padding, floating tab bar, sticky screen title that shrinks on
  scroll, space avatar at the top right of Beranda opens Settings.
- **Desktop web dashboard (v2):** sectioned sidebar (APP_PARITY § 1); page header row (H1 + subtitle left,
  actions right); content left-aligned next to the sidebar, two columns (main ≤ 740 px + side ≤ 420 px, 40 px gap)
  from 1200 px, one column (≤ 740 px) below.
- **Site:** sections alternate `surface-white`, `surface-panel`, `surface-dark`; section padding clamp(88px, 12vw,
  160px); phone mock-ups to show the app; sticky header 64 px; floating "Mulai gratis" button on phones.

## Formatting

- Currency: `Rp 1.264.000` (id-ID grouping, non-breaking space after Rp); compact: `Rp5,24 jt`, `Rp187 rb`. In
  English: `Rp 1,264,000`, compact `Rp5.24m`, `Rp187k`.
- Signs: `−Rp 25.000` (U+2212) for expense, `+Rp 9.500.000` for income.
- Dates: "Minggu, 4 Okt"; "Hari ini", "Kemarin"; times `09.41` (WIB, dot separator; English `09:41`).

## Accessibility

- Touch targets ≥ 44 px; text links get an invisible 44 px tap area.
- AA contrast in every theme (light, dark, mono light and dark); focus visible on every control (2 px `--brand` ring, 2 px offset).
- Colour is never the only signal: amounts carry signs, comparison pills carry words.
- `prefers-reduced-motion` and `prefers-contrast` respected; layout works at 360 px and with 200 % text zoom.

## Change log

- **v3.2 (2026-10-12)** — FN-51 more motion (`docs/features/fn-51-motion/`): route rise, chart draw-ins, skeleton
  shimmer, desktop hover lift and dialog scale-in, FAB turn, streak hop, banner enter, Koko welcome and
  pull-to-refresh in the installed app; one new token `--duration-loop`. Keyframes stay transform/opacity/
  stroke-dashoffset only (`test/motion-css.test.ts`).
- **v3.1 (2026-10-10)** — phone layout v3 and iOS responsive pass (`docs/features/ios-responsive/`): icon-only pill tab bar
  plus round Tambah button, outlined chips, record rows, header text links; no new token or colour.

- **v1 (2026-10-07)** — first version: neutral system with Montra's own brand accent, mascot and copy.
- **v1.1 (2026-10-07)** — FN-00 contrast test: light `--money-in`, `--money-up` and `--same` darkened to meet WCAG AA
  (4.5:1) for 16 px amount text on `--bg` and `--panel`. Dark theme unchanged.
- **v3 (2026-10-08)** — FN-40 parts 1 and 4: the **Hitam-putih** (mono) theme as a 4th choice in Pengaturan ›
  Tampilan (cookie only, follows the device scheme, money and brand keep their hue) and the **glass material** on
  the floating chrome: new `--glass-solid`, `--glass-border`, `--glass-shadow`, `--glass-bg-soft`,
  `--glass-blur-soft` (`--glass-ring` replaced by `--glass-shadow`), shared `.glass`/`.glass-soft` rules with the
  reduced-transparency and no-`backdrop-filter` fallbacks, a 3-layer blur budget and the press lift. Contrast is
  tested in four variants. Parts 2 and 3: `--duration-*` motion tokens and placements (§ Motion) and the isometric
  illustrations (§ Illustrations).
- **v2 (2026-10-08)** — visual language revamp (APP_PARITY § 3a): panel fills without borders or shadows, ink as
  the only action colour, `--brand` only for focus and inline links; new `--accent`, `--heat-1..4`, `--warn`,
  `--warn-text`, `--raised`; group radius 20; H1 800 weight (28 px phone); chips 32 px / 13 px; segmented selected =
  raised pill; HeroAmount with hide toggle, ComparePill, PeriodStepper, PickerSheet, toggle row; Dompet replaces
  Kekayaan in the tab bar; sectioned desktop sidebar; English number separators.
