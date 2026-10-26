# FN-54 — Greeting hero, calendar page, daily greeting and feature icons

Owner request 2026-10-13: "add greetings page and calendar update the app icon and placement", with three screenshots of
the reference app (local only, never committed): a desktop Beranda with a greeting hero, an "on this day" story sheet
and a sidebar whose every item has its own icon. We mirror **behaviour and layout structure only**. The reference app's
name, mascot, illustrations, colours as a brand, copy and product names are not used (`CLAUDE.md` § Product boundaries;
`docs/design/DESIGN_SYSTEM.md:5-18`). Montra uses Koko (FN-44), its own isometric drawing style (FN-40) and its own
words. Nothing here is read from the reference app's code or bundles.

**Risk tier: Large.** No migration, no auth change and no new external provider by default, but it rebuilds the top of
Beranda (the most-visited screen), adds a route with space-scoped reads, touches shared shell components (`nav.ts`,
`Sidebar`, `FiturSheet`, `HeatCalendar`, the icon set) and adds a content pipeline with a fact-checking rule. Build in four
parts, each with its own gate run, in this order: **A** feature icons and chips, **B** greeting hero and header
placement, **C** calendar page, **D** daily greeting sheet. A and C can ship without B; D waits for the owner's content
answers (Owner decisions 2 and 3). Pipeline: engineer, then QA and a narrow red team (cookie handling, outbound links,
`?q=` prefill, calendar space scoping) in parallel.

## Goal

Beranda today opens with a date line, a streak chip and four round buttons, then the month figure
(`src/routes/(app)/+page.svelte:297-356`). It works, but it reads as a report, not as a daily companion, and the capture
buttons sit at the bottom of the main column (`:484-505`). This feature gives the first screen of each day a human
opening: a time-of-day greeting in WIB, the date, one honest line about today, the month figure, an ask field for the
assistant and two comparison chips, all computed from stored rows. It adds a calendar entry in the header that opens a
month view (spending per day, closed days, bills and recurring items still to come), puts Struk and Suara next to it on
desktop, gives every feature a distinct icon on a coloured chip (sidebar, Jelajahi fitur, a "Fitur" tile grid on
Beranda), and offers a short daily greeting sheet (once per WIB day, skippable, switch-off-able) built from the user's
own figures, with optional owner-reviewed "on this day" cards. The home-screen app icon depends on the owner's open logo
decision and is scoped separately (Part A6).

## Current behaviour (so the engineer does not rediscover it)

- Beranda load: `src/routes/(app)/+page.server.ts:17-45` resolves `currentSpaceScope`, sets `today = wibTodayString()`
  (`:19`), loads summary, lists and streak in parallel, each failing to `null` on its own. The page keeps an `sr-only`
  `<h1>` (`+page.svelte:293`), the `topbar` (`:297-313`: date line `:299`, streak chip link `:301-303`, four icon buttons
  `:306-309`), then `HeroAmount` with `CompareLine` inside (`:331-356`).
- `HeroAmount.svelte:97-125`: label, eye button (hides every amount through `shown()`), `hero-num` figure that shrinks
  to its column (`:178-193`), context slot, a `beside` snippet used by Koko's FN-51 welcome wave (`:100`,
  `+page.svelte:339-343`, once per WIB day in the installed app, localStorage key `montra-welcome-wib-date`,
  `src/lib/ui/motion.ts:126-142`). The Pro frame is a `pro` prop on the hero (`HeroAmount.svelte:141-146`).
- The month-versus-last-month difference is already computed over the same number of elapsed days
  (`src/lib/server/budgets/summary.ts:42-65` through `berandaFigures`, `src/lib/server/budgets/math.ts:206-246`) and shown
  by `ComparePill` (rupiah, never percent). `ComparePill.svelte:23` formats the difference with currency `'IDR'` whatever
  the favourite wallet's currency is; this PRD does not change that (see Out of scope).
- Safe-to-spend and its progress bar sit under the charts (`+page.svelte:435-471`); the "Hari ini" card, the "Jelajahi
  fitur" link, "Terbaru" and "Akan datang" fill the side column (`:508-627`). Struk is disabled with a visible reason
  when the AI Gateway is not configured (`:484-505`, `data.receiptReady` from `src/routes/(app)/+layout.server.ts:31`).
- Sidebar: `src/lib/ui/shell/nav.ts:48-83` (sections Uang, Fitur, Catat) each with an icon from `src/lib/ui/icons.ts`;
  the Tanya pill is separate (`Sidebar.svelte:71-78`). Duplicated glyphs today: `sparkle` is Koleksi (`nav.ts:68`), the
  Tanya pill and the plan card (`Sidebar.svelte:76,105`) and the Emas theme (`theme.ts:29`); `star` is Kekayaan bersih
  (`nav.ts:65`) and the Emas theme (`theme.ts:28`); `file` is Impor (`nav.ts:78`) and Mutasi in Tambah (`nav.ts:136`).
  Items sit on plain icons with no chip (`Sidebar.svelte:92`); the Fitur sheet draws its own `--bg` circle per row
  (`FiturSheet.svelte:23-54,127,139,208-216`).
- Calendars that exist: Laporan's spending heat calendar (`src/lib/ui/charts/HeatCalendar.svelte:9-57`, data from
  `heatmapDays`, `src/lib/server/reports/laporan.ts:259-278`) and `/beruntun`'s closed-day calendar
  (`src/lib/ui/kit/StreakCalendar.svelte`, `src/routes/(app)/beruntun/+page.server.ts:22-62`, which clamps `?bulan=` to this
  or last month at `:27`). No month view mixes spending, closed days and upcoming bills.
- Next-charge helpers exist in shared code: `nextChargeOn`, `effectiveNextCharge`, `followingCharge`
  (`src/lib/shared/subscriptions.ts:87,108,117`) and `nextRunOn`, `followingRun` for recurring series
  (`src/lib/shared/recurring.ts:47,53`); subscriptions are capped at 100 per space
  (`src/lib/server/subscriptions/repo.ts:20`).
- Illustrations: `<Illustration>` draws 4:3 isometric scenes from theme tokens (`Illustration.svelte:23-37`, scenes in
  `illustrations/index.ts:18-30`, including `calendar`, `history`, `budget`). Koko: `Mascot.svelte:39-58`; Koko never speaks
  and carries no copy (`DESIGN_SYSTEM.md:210`).
- Tanya: its composer is a `q` textarea posting to `?/ask` (`src/routes/(app)/tanya/+page.svelte:141-161`) with the
  "not configured" and "needs your own key" notes at `:171-186`; it has no prefill from the URL today.
- CSP: `img-src 'self' data:`, no inline styles (`src/lib/server/csp.ts:10-26`). Per-device display preferences use
  cookies the server reads (`theme`: `src/lib/ui/shell/theme.ts:36-40`; amounts hidden:
  `src/lib/ui/kit/amount-visibility.ts:37-45`, read in `src/routes/+layout.server.ts:20`).
- App icon: PWA and apple-touch icons are Koko's idle frame, generated by `scripts/generate-mascot-icons.ts`, listed in
  `src/lib/server/pwa/manifest.webmanifest:17-18`, with Pro variants (`src/lib/shared/pro-look.ts:23-31`).

## Scope

### Part A — Feature icons, chips and the "Fitur" tile grid (Medium)

**A1. One feature registry.** The icon, chip hue, label and one-line hint of every sidebar and feature item live in one
list in `src/lib/ui/shell/nav.ts`, read by the sidebar, the Fitur sheet, the tile grid and `/pengaturan/fitur`, so the
four surfaces cannot drift. Existing `NavItem` fields stay; `tone` is added.

**A2. A distinct glyph for every item.** No two sidebar/feature items share a glyph. Keep: Ringkasan `home`, Transaksi
`list`, Laporan `chart`, Anggaran `gauge`, Dompet `wallet`, Jelajahi fitur `grid`, Alur uang `flow`, Langganan `repeat`,
Barang `box`, Patungan `people`, Agen `bolt`, Kotak masuk `inbox`, Aplikasi terhubung `link`. Change: Impor `file` →
`upload` (already in `icons.ts:44`); Kekayaan bersih `star` → a new rising-line glyph; Koleksi `sparkle` → a new gem or
album glyph; add a `calendar` glyph for the Part B/C badge and `/kalender`. `sparkle` stays the AI mark (Tanya and Pro
only). New glyphs are 24 × 24 strokes in `icons.ts`, our own geometry.

**A3. Coloured chips.** Each item's icon sits on a round tinted chip: `color-mix(in srgb, var(--c) 16%, var(--bg))`, the
exact recipe of the category tile (`DESIGN_SYSTEM.md:60-65`), with the glyph in `--ink-2`. `--c` is an existing `--cat-*`
hue (no new token, so the contrast, mono and Pro-theme behaviour is inherited; mono turns every chip grey). A fixed table
in `nav.ts` assigns hues; proposed: Ringkasan `--cat-pendidikan`, Transaksi `--cat-makan`, Laporan `--cat-hiburan`,
Anggaran `--cat-gaji`, Dompet `--cat-belanja`, Jelajahi fitur `--cat-tempat-tinggal`, Alur uang `--cat-freelance`,
Kekayaan bersih `--cat-bunga`, Langganan `--cat-tagihan`, Barang `--cat-kopi`, Koleksi `--cat-hadiah`, Patungan
`--cat-ojek-online`, Agen `--cat-pajak`, Impor `--cat-tarik-tunai`, Kotak masuk `--cat-kartu-kredit`, Aplikasi terhubung
`--cat-transfer`. The tab bar stays icon-only on its own pill (no chip; `DESIGN_SYSTEM.md:259-263`). Sizes: sidebar chip
28 px (24 px in the compact short-window rules, `Sidebar.svelte:347-391`), Fitur sheet and `/pengaturan/fitur` rows 40 px,
Beranda tile 36 px. A new `FeatureChip` kit component draws it. Design-system note: chips carry feature identity, the
same job category hues already do; a change-log entry in `docs/design/DESIGN_SYSTEM.md` records the exception to "colour
only for meaning" (Owner decision 11).

**A4. "Fitur" tile grid on Beranda.** A section "Fitur" at the end of Beranda's side column on phone and desktop (after
"Akan datang"; Owner decision 12): a two-column grid of tiles, each a link with the chip, the name and a one-line static
hint (reusing the Fitur sheet's existing hint phrases, `FiturSheet.svelte:23-54`, plus one new hint for Agen). Tiles for
hideable modules follow the user's FN-12 flags (`data.hiddenModules`); Alur uang and Agen are always shown
(`nav.ts:63-64,71-72`). Order = sidebar order. A link "Kelola fitur" opens the Fitur sheet (same handler as
`+page.svelte:568`, with the `/pengaturan/fitur` no-JS href), replacing the centred "Jelajahi fitur" link. Tiles show no
figures in this pass (no new query; Owner decision 12).

**A5. Placement.** Sidebar item = 28 px chip + label (the active item keeps the grey pill and bold label). Fitur sheet and
`/pengaturan/fitur` toggle rows use the 40 px chip in place of today's plain `--bg` circle (`ToggleRow` gains an optional
`tone`). The sidebar order and sections do not change.

**A6. The home-screen app icon (separate, honest scope).** The PWA, apple-touch and favicon files are Koko's idle frame.
The owner has asked for a new logo ("Geometric Lion Emblem on Orange", `docs/TASKS.md:253`, image not supplied) and has
not decided whether it replaces Koko as the icon; product name, domain and brand hue are also open (`docs/TASKS.md:58`).
What ships now: nothing visual for the home-screen icon. What ships to make the swap one step: (1) a test that today's
maskable icons keep Koko inside the 80 % safe zone and that the manifest still lists them; (2) a RUNBOOK section
"Replacing the app icon" naming the path (source image → `scripts/generate-mascot-icons.ts` → `static/icons/*`,
`static/favicon.svg`, splash screens, Pro variants) so the owner's file can be dropped in; (3) no placeholder logo is
drawn. What waits: any new home-screen, favicon, splash or Pro icon art, until the owner sends the file and answers Owner
decision 14. An installed app's icon never updates live (FN-46 scope, `docs/features/fn-46-pro-look/PRD.md`); a release
note says "reinstall to see the new icon" only when an icon really changes.

### Part B — Greeting hero and header placement (Large)

**B1. Greeting helper.** A pure function in `src/lib/shared/greeting.ts` maps a UTC instant to a period by the WIB hour:
`pagi` 04:00–10:59, `siang` 11:00–14:59, `sore` 15:00–17:59, `malam` 18:00–03:59. The server computes it once per request
and returns it from the Beranda load; the client never recomputes on hydration (no mismatch). Phrases: "Selamat pagi.",
"Selamat siang.", "Selamat sore.", "Selamat malam." (English: Good morning., Good afternoon., Good afternoon., Good
evening.; Owner decision 4). No user name in the line (Owner decision 5).

**B2. The hero card.** A new `GreetingHero` component wraps the existing `HeroAmount` (the month figure stays the one big
number, `DESIGN_SYSTEM.md:22`) in a card (`--panel` fill, radius `--r-l`, no border, no shadow, flat: no new blur layer;
`DESIGN_SYSTEM.md:139-150`). Top to bottom:
1. Date line, muted 13 px, `formatWeekdayDay(data.today, locale)` ("Selasa, 13 Okt"). It replaces the topbar's date line
   (`+page.svelte:299`).
2. Greeting, 28 px / 800 on phone, 34 px on desktop (the `title` style), a `<p>`, not a heading. The page keeps its
   `sr-only` `<h1>Beranda</h1>`; headings never skip.
3. State line, muted 15 px, one of: "Belum ada catatan hari ini." (no rows today), or the existing count phrase
   "{n} transaksi tercatat hari ini" (with the `+` when `todayHasMore`, `+page.svelte:529-533`). The count is the length of
   the same day group Riwayat shows for today (`summary.ts:56-64`), demo rows included and badged exactly as the "Hari ini"
   card does today.
4. `HeroAmount` unchanged in behaviour (label "Pengeluaran {bulan}", eye button, count-up, shrink-to-fit). Its context
   slot now holds the chips (B3). Its `pro` frame moves to the card (the card takes `--pro-soft` → `--panel`, the hero gets
   `pro={false}`) so a Pro account shows exactly one frame.
5. Ask field (B4).
6. Illustration strip (B5), bottom edge of the card, full card width.

Koko's FN-51 welcome wave keeps its `beside` slot and rules unchanged.

**B3. Comparison chips** (rupiah, never percent; both from stored rows):
- Chip 1 is the existing `CompareLine`/`ComparePill` output ("↓ Rp80 rb lebih hemat dari September", "≈ Hampir sama…",
  "Belum ada data September"), same-length windows as today. Not recomputed.
- Chip 2 is the budget chip, a link to `/anggaran`: with a budget and `safeToSpend.kind === 'left'`: "{sisa} masih bisa
  dipakai" with the compact remaining amount (the figure Beranda's budget line shows, `+page.svelte:443-452`); `spent`:
  "Anggaran bulan ini sudah habis." (existing phrase); `over`: the existing "Sudah melebihi anggaran sebesar {jumlah}" in
  `--money-up`; no budget: "Atur anggaran" (existing phrase) linking to `/anggaran`. Colour is never the only signal:
  every chip carries words.
- Both chips use `shown()` for every amount, so the eye button masks them ("••••") on server render (cookie) and after
  hydration, including their accessible names. Chips wrap to two rows at 360 px; each is at least 44 px tall on coarse
  pointers.
- The older budget progress block under the charts stays; its figure and the chip's must be equal.

**B4. Ask field.** A `<form method="GET" action="/tanya">` with one text input named `q` (max length `TANYA_QUESTION_MAX`,
`src/lib/shared/tanya`), a send button and the placeholder "Tanya apa saja soal uangmu". Tanya's load reads `?q=`, cleans
it with the existing `cleanQuestion`, and prefills the composer; it never sends anything by itself (a prefill costs no AI
call, no credit and no key use; the user presses Kirim there). When the AI Gateway is not configured (`data.receiptReady`
is the same `isAiGatewayConfigured` flag; the engineer may add an explicit alias) the field is disabled and the visible
reason "Asisten AI belum dikonfigurasi." (existing phrase, `tanya/+page.svelte:174`) sits under it; when it is configured
but the user has no key, Tanya's own note explains on arrival. Works without JavaScript.

**B5. Illustration.** One new original scene, `HeroScene`, drawn from `iso.ts` boxes and discs in the FN-40 style
(isometric city blocks with a coin tower; not a copy of the reference app's skyline composition, palette or mascot
placement). Rules:
- Inline SVG, no image file, no request, no inline `style` (classes and SVG attributes only; CSP `img-src` stays
  `'self' data:`). Decorative, `aria-hidden`, `focusable="false"`.
- Colours only from the existing tone classes (`n-*`, `a-*`, `g-*`, `p-*`, `d-*`), so light, dark, mono, Emas and Hijau tua
  repaint with no new token. No gradients, filters or blur.
- Time-of-day: the same scene with one celestial disc that follows the period (low sun `pagi`, high sun `siang`, low warm sun
  `sore`, moon and two star ticks `malam`); the period comes from the server value in B1.
- Budget: at most 40 shapes and 8 KB of markup (one shared component, all four variants), zero extra requests.
- No layout shift: the strip has a fixed height (96 px phone, 120 px from 1024 px) and `preserveAspectRatio` slice, so a
  narrow card crops instead of stretching; the card reserves its full height from the server render.
- Koko rests at the strip's right end (`idle` pose, 48 px, blinks twice then still); no speech bubble, no copy
  (`DESIGN_SYSTEM.md:210`). Nothing else moves: the scene is static, no float loop.
- Reduced motion: the scene is static in every case; Koko's blink follows its existing reduced-motion rule.

**B6. Header placement.**
- Phone (< 1024 px): the topbar becomes: row 1 = `CalendarBadge` left, bell, gear and space avatar right (the Tanya
  sparkle button stays); row 2 = streak chip (as today, `+page.svelte:705-734`). The date text moves into the hero. Struk
  and Suara stay in the main column in their current position (Owner decision 9).
- Desktop (≥ 1024 px): a page header row: visible `<h1>Beranda</h1>` (34 px / 800; the `sr-only` copy is hidden there so
  there is one h1) with the streak chip as its subtitle line; right-aligned `CalendarBadge`, **Struk** (secondary, md) and
  **Suara** (primary, md), in that order. The bottom `.capture` pair is not rendered on desktop. When Struk is unavailable
  it stays disabled with `aria-describedby` and the reason line visible under the header row (not only a tooltip). The
  markup is two blocks switched by CSS (`display: none` removes the hidden one from the accessibility tree and tab order);
  each viewport has exactly one visible Struk and one visible Suara, with distinct element ids.
- The hero card sits first in the main column on both layouts, above the charts.

**B7. `CalendarBadge`** (kit, used by Part C): a 48 × 52 px link (44 px minimum target on coarse pointers) drawn as a small
page: a top band in `--ink` holding the month abbreviation in `--bg` 11 px / 700 uppercase ("OKT", "OCT"), and the day
number below in `--ink` 18 px / 800 tabular. Flat, no shadow, `--r-s` radius; mono-safe. It shows the **server's WIB date**
(`data.today`), never the client clock. Accessible name: "Kalender, {weekday day month year}" through `formatDayLabel`. It
links to `/kalender` (Part C); until Part C ships it is not rendered.

### Part C — Calendar page `/kalender` (Medium)

**Default decision: a page, not a sheet** (Owner decision 8): real URL, back button, no-JS, deep-linkable days, no
shallow-routing risk. Tapping the badge goes to `/kalender`.

**C1. Route.** `src/routes/(app)/kalender/+page.server.ts` + `+page.svelte`, a `ScreenTitle` with a back link to Beranda
(`beruntun/+page.svelte:57` pattern), title "Kalender".
- Query `?bulan=YYYY-MM`: validated with `isMonthString`; accepted only from 23 months before to 2 months after this WIB
  month; anything else shows this month (the `beruntun` clamp pattern, generalised). A `PeriodStepper` moves one month (prev
  and next are links; next is disabled at the window's end).
- Query `?hari=YYYY-MM-DD`: validated with `isDateString`, must lie in the shown month, else ignored. Default selected day:
  today in the current month, none in other months.

**C2. The month grid.** Reuses `HeatCalendar` (Monday-first grid, four heat steps, today ringed, future days blank) with an
additive `marks` prop and a `hrefFor` that returns the page's own `?bulan=&hari=` URL (so a cell opens the day detail under
the grid; each cell still says its date and figure to assistive tech). Per day:
- Spending shade and figure: expense totals of the space, favourite wallet's currency (as Beranda: `summary.ts:58`), through
  `dailyTotals` and `heatmapDays` (`laporan.ts:259`); demo rows excluded (`aggregate.ts:365,397`). A month that has money in
  other currencies shows one line "Transaksi dalam mata uang lain tidak dihitung di sini." only when such rows exist (exact
  figures stay on Riwayat).
- Marks, shape-coded not colour-coded, each with a screen-reader phrase: a small ring for "hari ditutup" (the signed-in
  account's own closures, `streakDetails` → `closedOn`, account-scoped), a small square for "ada tagihan atau transaksi
  berulang" on days from today forward only.
- A legend under the grid: `HeatCalendar`'s plus the two marks.

**C3. Upcoming projection.** A pure function in `src/lib/shared/calendar.ts` lists, for a month, each live subscription's
charges (start from `effectiveNextCharge`, step with `followingCharge`, stop after the month's last day or 40 steps) and each
**active** recurring series' runs (`nextRunOn`/`followingRun`, within `end_on`), on dates on or after today only. Past days
show what actually happened (spending), never a projection. Demo subscriptions show badged "Data demo" as on Beranda.
Bounded: at most 100 subscriptions, series capped by their existing per-space limit, both read once per load.

**C4. Day detail** (below the grid, driven by `?hari=`): the day label; that day's expense figure (through `shown()`, so the
eye setting masks it); the day's transactions as `TransactionRow` rows (same query and filter as Riwayat's one-day view,
`listTransactionsByDay`, first page) with "Lihat semua di Riwayat" linking to the existing `dayHref`
(`/riwayat?period=range&from=D&to=D`); bills and recurring items due that day (name, amount, wallet when known); a line
"Hari ini ditutup" / "Hari ini belum ditutup" for the account on closed or today dates. Future days show only the due items.
A day with nothing: one muted sentence.

**C5. States.** Loading: `Skeleton` while the month changes (`navigating` check, as `beruntun/+page.svelte:30-33`). Empty
month: the grid without shading plus "Belum ada transaksi bulan ini." Error: each of spending, closures and upcoming loads
independently to `null` with its own `ErrorState` and retry (`beruntun` `failed()` pattern, `+page.server.ts:17-20`); one
failing never blanks the others. No saving state (read-only page).

**C6. Entry points.** The Beranda badge (Part B). Until Part B ships, an `IconButton` with the `calendar` glyph beside the
"Hari ini" card heading. Not in the sidebar (Owner decision 13). `/beruntun` keeps its own page; its calendar is unchanged.

### Part D — Daily greeting sheet (Medium; content-gated)

**Decision: the "greetings page" is the hero (Part B) plus an optional once-a-day sheet** built like a short story: a `Sheet`
(bottom sheet on phone, centred dialog on desktop, one glass layer) with progress segments, a close button, a card per step
and a "Berikutnya" / "Selesai" button. No auto-advance (a timer would fail WCAG 2.2.1); the progress segments show the step,
they do not run. Owner decisions 1–3 can reduce this to hero-only (then Part D is dropped and nothing else changes).

**D1. Cards, from the user's own stored figures only** (no new query: they read what Beranda's load already holds):
1. "Kemarin": yesterday's expense figure from the 14-day bars (`s.bars`, `summary.ts:54`), or "Tidak ada catatan kemarin."
   Skipped on a brand-new account without wallets.
2. "Hari ini": bills due in the next 7 days (`data.lists.upcoming`) or, with a budget and `left`, "{per_hari} sehari untuk
   {hari} hari" from safe-to-spend. Skipped when it has neither.
3. "Pada hari ini" (optional): the owner-reviewed history card for today's WIB `MM-DD`, only when an entry exists (D4). No
   filler card when none exists.
A story with no cards is not opened. Each card reuses an existing FN-40 scene (`history`, `calendar`, `budget`) and Koko only
as a still pose; Koko says nothing (`DESIGN_SYSTEM.md:210`), so there is no nudge line.

**D2. Once per WIB day, per device.** Two cookies, set and read like the amounts cookie (`amount-visibility.ts:37-45`;
`Path=/`, `SameSite=Lax`, `Secure` on https, one year): `montra-sapaan-seen` = the WIB date last dismissed and
`montra-sapaan-off` = `1` when the user turned the story off. The Beranda load reads them (`cookies.get`) and returns the
story payload only when `off` is absent and `seen !== today`, so a seen day or an off setting costs no extra payload. The
sheet opens after hydration (never on first paint, never without JavaScript, never in a hidden tab, never while the budget
sheet or another dialog is open, never on a load error) and sets `seen = today` when it is dismissed or finished (close
button, Escape, backdrop, "Selesai"). A story the user navigates away from without closing shows again on the next Beranda
visit that day. Device-only by design: the setting is not synced across devices (Owner decision 3).

**D3. Switch-off.** The last card carries a text button "Matikan sapaan harian" (posts a form action; success is shown only
after the server confirmed and set the cookie; the sheet then closes). The same switch lives in Pengaturan › Tampilan as a
toggle row "Sapaan harian" with a one-line hint, as a plain form action that works without JavaScript (the `theme` action
pattern, `src/routes/(app)/pengaturan/tampilan/+page.server.ts`). Turning it back on clears the `off` cookie.

**D4. "On this day" content, honest by construction.**
- Source of truth: one reviewed content file `src/lib/content/on-this-day/entries.json` (same folder family as the release
  notes), never fetched at runtime, never scraped, never produced by a model at runtime or from model memory.
- Entry shape: `date` (`MM-DD`, `02-29` allowed), `year`, `headline` and `body` each as `{id, en}`, `sources` (at least 2,
  each `{label, url}` with an `https` URL), `reviewedOn` (a date), `reviewedBy`. Headline at most 60 characters, body at
  most 2 sentences and 180 characters, both written in our own words (facts are free, a source's sentences are not), no
  copying of the reference app's day list or wording.
- What may appear: verifiable events only; no deaths, wars, disasters or violence; no party politics or religion; nothing
  that reads as an investment tip, prediction or "lesson" for the user's money (`CLAUDE.md` no-advice boundary); no outbound
  image (CSP stays `img-src 'self' data:`; the art is our own scene).
- Review gate: an entry exists only after a person (the owner, or an agent with web access under the owner's approval)
  opened both sources and confirmed the date, year and wording. The check and the pages opened are recorded in
  `docs/features/fn-54-greeting-calendar/ON_THIS_DAY_REVIEW.md` (one line per entry). A Vitest validator enforces the shape,
  lengths, https, at least 2 sources, no duplicate `date`+`year`, `MM-DD` validity and non-empty id and en text.
- Coverage: the build ships with exactly the entries the owner has approved, which may be zero (the card is then simply
  absent). Target 366 days (one per date, leap day included) as a separate content task after launch; the sheet never shows a
  day without an entry. Source links render as text, open in a new tab with `rel="noopener noreferrer"`, and are labelled
  "Sumber:" / "Sources:".
- Licensing and privacy: facts are not copyrightable but wording is; sources are cited, not reproduced; outbound links
  reveal nothing about the user. `/privasi` needs no new data statement (no new data is collected); the two cookies are
  display preferences, and if the privacy text lists the theme and amounts cookies, it gets the two new names (check at
  build time).

## Out of scope

- A new logo, a new home-screen icon, favicon, splash or Pro icon art (waits for the owner's file; Part A6 only prepares).
- Live figures inside the Fitur tiles (net worth, subscription totals, item counts): a later pass with its own queries.
- A calendar sheet or overlay with shallow routing, month navigation beyond the stated window, editing or adding anything
  from the calendar, drag and drop, week or agenda views, exporting to Google Calendar (FN-29 owns that).
- A per-account (cross-device) setting for the daily greeting: it needs a migration; only if the owner picks it (Owner
  decision 3).
- Generating "on this day" facts with AI, fetching them from a public API or website, or showing any unreviewed entry; images
  for those cards; tragic, political, religious or investment-flavoured entries.
- Auto-advancing or timed story steps, sound, confetti, new Koko poses, Koko speech.
- A visible user name in the greeting; greetings in languages other than Indonesian and English (FN-52's scope); updating a
  greeting already on screen when the clock crosses a boundary while the page stays open.
- Fixing `ComparePill`'s hard-coded `'IDR'` formatting for a non-IDR favourite wallet (`ComparePill.svelte:23`); noted as a
  follow-up so the new chip is not blamed for it.
- Moving Struk and Suara on phone, changing the tab bar, the Tambah sheet's paths, Tanya's answering logic, budgets, the
  streak rules, or any money, import or capture code.
- New usage-statistics screen names (the FN-31 allow-list is unchanged).

## Acceptance criteria

Levels follow `docs/ACCEPTANCE.md`: **Automated** = Vitest (incl. local D1), **Browser** = Playwright, **Pass** = manual or
real-device. Every Vitest case that guards a bug class (WIB boundary, authorization, mask) is shown to fail before the fix in
the engineer's report.

**Greeting and date (Part B)**

1. Given the UTC instants below, when `greetingPeriod` and `wibDateString` are evaluated, then they return exactly:
   `2026-10-12T20:59:59Z` → `malam`, `2026-10-13`; `2026-10-12T21:00:00Z` → `pagi`, `2026-10-13`; `2026-10-13T03:59:59Z` →
   `pagi`; `04:00:00Z` → `siang`; `07:59:59Z` → `siang`; `08:00:00Z` → `sore`; `10:59:59Z` → `sore`; `11:00:00Z` → `malam`;
   `16:59:59Z` → `malam`, `2026-10-13`; `2026-10-13T17:00:00Z` → `malam`, `2026-10-14`. From 17:00Z to 23:59Z the UTC date
   differs from the WIB date. (Automated: `src/lib/shared/greeting.test.ts`.)
2. Given the page is server-rendered at 2026-10-31T16:59:59Z (23:59:59 WIB, 31 Oct), then the date line is "Sabtu, 31 Okt",
   the badge reads OKT / 31 and the hero label is "Pengeluaran Oktober"; at 2026-10-31T17:00:00Z (00:00 WIB, 1 Nov) the date
   line is "Minggu, 1 Nov", the badge NOV / 1, the label "Pengeluaran November", the state line "Belum ada catatan hari ini."
   and the chips compare against October. A transaction saved at 23:30 WIB on 31 Oct counts in October's figure and the 31st's
   day count; one at 00:30 WIB on 1 Nov counts in November. (Automated: load test with a faked clock; Browser: one case at
   360 px.)
3. Given an English account, then the greeting, state line, chips, ask field and badge month are English (Good morning., Oct,
   and so on); given Indonesian, then Indonesian; the language is the account's `tr()` locale. (Automated: render test per
   locale.)
4. Given no rows today, then the state line is "Belum ada catatan hari ini."; given 3 rows, "3 transaksi tercatat hari ini";
   given more than one page of rows, the count carries the `+`. The number equals the row count of Riwayat's one-day view for
   today. (Automated: integration, seeded rows including a demo row.)

**Chips, masking, hero composition (Part B)**

5. Given last-month and this-month figures, then chip 1 shows the same words and rupiah difference as Beranda showed before
   this change for the same data (same window, `berandaFigures`); no percent appears anywhere in the hero. (Automated: figure
   vectors, one per `same` / `more` / `less` / no-previous state.)
6. Given a budget with remaining money, then chip 2 reads "{sisa} masih bisa dipakai" with the amount equal, character for
   character, to the amount in the budget line under the charts; given spent, over and no budget, then the exact phrases in B3
   appear; the chip links to `/anggaran`. (Automated: render test per `safeToSpend.kind`.)
7. Given the eye button is on, or the `montra-amounts-hidden` cookie is set on a cold load, then every rupiah figure in the
   hero, both chips (text and accessible name) and the day detail on `/kalender` shows "••••" from the first server render,
   while greeting, date, counts and the badge stay readable. (Browser: cookie set before navigation; Automated: render test.)
8. Given a Pro or Agen account, then the Pro frame shows once (on the card), the month figure keeps its size rules, and
   `hero-num` still shrinks a 13-character figure to one line at 360 px. A Gratis account shows no frame. (Automated:
   component test; Browser: 360 px screenshot.)
9. Given 360 px, then the hero card, chips (wrapping to two rows), ask field, badge and header row cause no horizontal scroll,
   every control is at least 44 px on coarse pointers, and the greeting and the month figure are inside the first viewport.
   Given 1024, 1280 and 1440 px, then the layout in B6 holds. (Browser: `e2e/ios-responsive.spec.ts` projects plus a new
   `e2e/beranda-hero.spec.ts`.)

**Ask field (Part B)**

10. Given the AI Gateway is configured and the user types "Bulan lalu habis berapa buat kopi?" and sends, then the browser goes
    to `/tanya?q=…` with that text in the composer, **nothing is sent to the model, no credit or key is used, no message row
    is written**, and the user must press Kirim. Given a 600-character or control-character `q`, then it is trimmed and cleaned
    by `cleanQuestion` and never rendered as HTML. (Automated: Tanya load test; Browser.)
11. Given the AI Gateway is not configured, then the hero field and its button are disabled and "Asisten AI belum
    dikonfigurasi." is visible under them; given no JavaScript, the GET form still works when enabled. (Automated + Browser,
    JS-disabled context.)

**Illustration and motion (Part B)**

12. Given the four periods, then the rendered scene differs only in the celestial elements; the SVG has no `style` attribute,
    no `<image>`, `<filter>`, gradient or external reference, at most 40 shapes and at most 8 KB of markup, and the page makes
    no new network request for it. (Automated: component render and size test; Browser: zero CSP violations and zero new
    requests on `/` in light, dark, mono, Emas and Hijau tua.)
13. Given `prefers-reduced-motion: reduce`, then nothing in the hero, scene or badge animates (no running animation on any of
    them) and the end state is on screen at once; given motion allowed, then the only new motion is Koko's finite blink plus
    the existing count-up. The hero card's height is identical at first paint and after hydration (the hero contributes 0 to
    layout shift). (Automated: `test/motion-css.test.ts` gains the new files in `MOTION_FILES`; Browser: `e2e/motion.spec.ts`
    and a layout-shift observer.)
14. Contrast: text on the card, on the chips and on `CalendarBadge` meets AA in all eight theme variants; the chip glyph
    (`--ink-2` on the 16 % tint) meets 3:1 for every hue in A3 in every variant. (Automated: `test/contrast.test.ts` extended
    with the sixteen chip pairs and the badge pair.)

**Header and placement (Part B)**

15. Given 1024 px or wider, then one visible `<h1>Beranda</h1>`, the badge, Struk and Suara sit right of it in that order, the
    bottom capture pair is not rendered, and tabbing order is badge → Struk → Suara; given under 1024 px, then the badge is
    top-left, the capture pair keeps its old position and exactly one visible Struk and one visible Suara exist. (Browser: both
    viewports, plus an accessibility-tree count of the Struk and Suara controls.)
16. Given Struk is unavailable (no AI Gateway), then on both layouts it is disabled, exposes its reason through
    `aria-describedby`, and the reason sentence is visible. (Automated + Browser.)
17. Given the badge, then tapping it opens `/kalender` and its accessible name is "Kalender, Selasa 13 Oktober 2026" for that
    WIB date. (Browser.)

**Calendar page (Part C)**

18. Authorization. Given user A (space SA) and user B (space SB), when B requests `/kalender` with any `?bulan=` or `?hari=`,
    then only SB's rows, subscriptions and recurring series appear; a signed-out visitor is redirected to sign-in; a member
    removed from a shared space gets the same 404 the other space pages give; a `hari` or `bulan` value never reveals that
    another space has data. Closed-day marks are the signed-in account's own, never another member's. (Automated:
    two-users-two-spaces integration test on local D1, plus the removed-member case.)
19. Given `?bulan=` is missing, malformed (`2026-13`, `abc`, 200 characters), earlier than 23 months back or later than 2
    months ahead, then this WIB month is shown with no error; given a valid month in the window, that month is shown and the
    stepper's next is disabled at the window's end. Given `?hari=` outside the month or invalid, it is ignored. (Automated.)
20. Given transactions at 23:30 WIB on 31 Oct and 00:30 WIB on 1 Nov, then the first appears on the 31st and the second on the
    1st of the next month; February 2028 shows 29 cells. (Automated: WIB vectors through `heatmapDays`; leap-year case.)
21. Reconciliation. Given any day with rows, then the figure in its cell and in the day detail equals the sum Riwayat's one-day
    view shows for the same date and filters, and the listed rows are the same rows in the same order; demo rows are excluded
    from the figure and badged "Data demo" in the list. (Automated: integration comparing `dailyTotals` for a day with
    `listTransactionsByDay` for the same day.)
22. Given a monthly subscription charging on day 31 and an active weekly recurring series, then the marks appear on the right
    future dates in the shown month (day 31 handled exactly as `followingCharge` does today), never on past dates, never for a
    paused or stopped series, and the day detail names the item with its amount; demo subscriptions are badged. A space with
    100 subscriptions loads within a fixed read count (no per-item query). (Automated: `src/lib/shared/calendar.test.ts` plus
    an integration read-count check.)
23. Given a closed day, then it carries the ring mark and the phrase "Hari ditutup" for assistive tech; given the same day with
    heavy spending, then both the heat shade and the mark are present (shape, not colour, tells them apart). (Automated:
    render test; Browser: keyboard focus ring visible on a cell.)
24. States. Given a slow month change, then a `Skeleton` shows and no stale figure is announced; given an empty month, then
    "Belum ada transaksi bulan ini." with an unshaded grid; given the closures read fails, then spending still renders and the
    closures area shows its own error with retry; given every read fails, one `ErrorState` with retry, never a raw code.
    (Automated: load test with injected failures; Browser.)
25. Given no JavaScript, then the stepper, the day cells and "Lihat semua di Riwayat" are plain links and the page is fully
    usable. (Browser: JS-disabled context.)
26. Persisted state: the shown month and day live in the URL; a reload shows the same month and day. (Browser.)

**Icons, chips, tiles (Part A)**

27. Given the registry, then no two sidebar/feature items share a glyph; Impor uses `upload`, Kekayaan bersih and Koleksi use
    their new glyphs; `sparkle` appears only for Tanya and Pro; every item has a hue token that exists in `tokens.css`;
    Sidebar, Fitur sheet, `/pengaturan/fitur` and the Beranda tiles show the same glyph and hue for the same feature.
    (Automated: `src/lib/ui/shell/nav.test.ts` extended.)
28. Given the tile grid, then hidden modules (FN-12) have no tile, Alur uang and Agen always have one, tiles keep sidebar
    order, each tile is a link of at least 44 px with the feature's page as `href`, and "Kelola fitur" opens the Fitur sheet
    with JavaScript and `/pengaturan/fitur` without. A user with every module hidden still sees the two always-on tiles.
    (Automated + Browser.)
29. Given the mono, Emas and Hijau tua themes, then chips render without a new colour token (greys in mono, the same category
    hues elsewhere) and the sidebar still fits at 768–900 px and in the compact short-window rules without scrolling the nav
    region unexpectedly. (Browser: `e2e/shell.spec.ts` extended; Automated: contrast.)
30. App icon: a test confirms the manifest still lists the maskable icons and that the generated maskable PNGs keep the artwork
    inside the safe zone; the RUNBOOK section for replacing the icon exists; no icon file changes in this feature unless the
    owner has delivered the logo. (Automated + doc review.)

**Daily greeting (Part D)**

31. Given a signed-in user with at least one wallet and data for card 1 or 2, no cookies set, when Beranda opens with
    JavaScript, then the sheet opens after hydration with focus inside, the progress segments equal the number of cards,
    "Berikutnya" advances, the last button reads "Selesai", Escape and the close button dismiss, and focus returns to
    `<main>`. Nothing advances on its own. (Browser.)
32. Given the sheet is dismissed, then `montra-sapaan-seen` holds the WIB date of that day; a reload and a second tab the same
    WIB day do not open it again; at 00:00 WIB the next day it opens again; a dismissal at 23:59:59 WIB followed by a reload at
    00:00:00 WIB opens it. (Automated: pure `storyDue(cookies, today)` vectors; Browser.)
33. Given `montra-sapaan-off=1` (or the Tampilan switch off), then the Beranda load returns no story payload and the sheet never
    opens; given the switch turned back on, the cookie is cleared and the story is due again that day. The toggle works without
    JavaScript, shows success only after the server wrote the cookie, and survives reload. (Automated: action test; Browser:
    JS-disabled context.)
34. Given the story must not open, then it does not: first paint, no JavaScript, a hidden tab, the budget sheet or any
    `dialog[open]`, a load error, a brand-new account with no wallet and no rows, or zero cards. (Automated: decision helper
    table; Browser for the dialog case.)
35. Given card text, then every figure equals the figure Beranda shows (yesterday's bar value, per-day safe-to-spend, due
    bills) and respects the hidden-amounts mask. (Automated.)
36. Given `entries.json`, then the validator test passes and fails when any of these is planted: one source, a non-https URL,
    a missing English text, a 200-character body, a duplicate `date`+`year`, `13-40`, a missing `reviewedOn`; given today has
    no entry, then card 3 is absent and nothing else changes; given an entry, then year, headline, body and "Sumber:" links
    render in the user's language, links carry `target="_blank" rel="noopener noreferrer"`, and no request leaves the page
    except by the user's click. (Automated.)
37. Given the review log, then every entry in `entries.json` has a matching line in `ON_THIS_DAY_REVIEW.md` naming the two
    pages opened and the date checked; an entry without one fails a docs test. (Automated: file cross-check.)
38. The sheet counts as one blurred layer; with it open every other glass surface drops its blur (`DESIGN_SYSTEM.md:148-150`).
    (Automated: `test/glass-budget.test.ts` extended.)

**Checklist-derived (every part)**

39. Access: Beranda's load and actions keep `currentSpaceScope`; `/kalender` calls it first; no space id, date or account id is
    read from the client beyond the validated `bulan`/`hari`/`q` strings; every new query is bounded (day totals for one
    month, one day's list page, 100 subscriptions, the existing series list) and runs through the existing aggregate and repo
    functions that take `spaceId`. A hidden control is not the authorization. (Automated + diff review.)
40. Money and dates: all amounts are integer minor units formatted by `formatMoney`/`formatMoneyCompact`; one currency per sum;
    day and month buckets use `occurred_on` (WIB); the greeting hour and the badge use the WIB conversion in
    `src/lib/shared/dates.ts`, never `new Date().getHours()` or the UTC date. (Automated: grep test over the new files.)
41. i18n: every new Indonesian phrase, including `trf()` templates, server messages and the new `aria-label`s, has an
    `i18n-en.ts` entry; the expected set is listed in the engineer's report. (Automated: `test/i18n-coverage.test.ts`.)
42. Untrusted text: `q`, `bulan`, `hari` and cookie values are length-capped and validated before use; `entries.json` text is
    rendered as text, never as HTML; no secret or internal id appears in loader output or user copy.
43. CSP: no inline `style` attribute, no `<style>` injection, no third-party image, font or script is added; zero CSP
    violations while visiting `/`, `/kalender` and `/pengaturan/tampilan` in e2e in every theme. (Browser: the CSP watch used
    in `e2e/motion.spec.ts`.)
44. Accessibility: headings never skip (one `h1`, the greeting is a paragraph, sections are `h2`); focus returns to the opener
    or `<main>`; the calendar is usable by keyboard alone; touch targets at least 44 px; colour is never the only signal; AA
    contrast. (Browser; a manual screen-reader pass is noted as run or not run.)
45. Truthful state: loading, empty, error, saving and success states exist for every new surface (the Tampilan toggle and
    "Matikan sapaan harian" show saving, then success only after the cookie write is confirmed; the calendar has no write).
    (Automated + Browser.)
46. No-JS: hero, chips, ask form, badge link, calendar navigation and the Tampilan toggle work without JavaScript; the story is
    the documented JavaScript-only part. (Browser: JS-disabled context.)
47. Gates: `npm run gates` is clean; existing specs that assert Beranda's old structure (`e2e/beranda.spec.ts`,
    `e2e/fitur.spec.ts`, `e2e/shell.spec.ts`, `e2e/struk.spec.ts`, `e2e/pwa.spec.ts`, `e2e/beruntun.spec.ts`) are updated for
    the moved controls with the same intent, and each change is listed in the report. The full e2e suite is run before merge
    and its result stated as run or not run. (Automated + Browser.)
48. Real-device checks the engineer cannot do are listed as **You** items, not reported as passed: the hero and calendar at
    360 px on a real iPhone and Android phone, the badge target size, and the greeting at a real WIB boundary. (Pass, manual.)

## Architecture notes

- **Modules touched.** `src/routes/(app)/+page.svelte` and `+page.server.ts` (hero, header, tile grid, story payload and its
  sheet mount), new `src/routes/(app)/kalender/`, `src/routes/(app)/tanya/+page.server.ts` (`?q=` prefill),
  `src/routes/(app)/pengaturan/tampilan/` (toggle row and action), `src/lib/ui/shell/{nav.ts,Sidebar.svelte,FiturSheet.svelte}`,
  `src/lib/ui/icons.ts`, `src/lib/ui/kit/{HeroAmount,ToggleRow}` and `src/lib/ui/charts/HeatCalendar.svelte` (additive props
  only: `tone`, `marks`; `pro` stays).
- **New files.** `src/lib/shared/greeting.ts`, `src/lib/shared/calendar.ts` (+ tests), `src/lib/server/calendar/month.ts`
  (bounded reads), `src/lib/ui/home/{GreetingHero,HeroScene,FeatureTile,DailyStory}.svelte`,
  `src/lib/ui/kit/{CalendarBadge,FeatureChip}.svelte`, `src/lib/shared/daily-story.ts` (cards, `storyDue`, cookie names and
  helpers), `src/lib/shared/on-this-day.ts` (validator, lookup), `src/lib/content/on-this-day/entries.json`, and the review log.
- **Reuse, do not duplicate.** `currentSpaceScope`, the data `berandaSummary`/`berandaLists` already return, `dailyTotals`,
  `heatmapDays`, `listTransactionsByDay`, `listSubscriptions`, `listSeries`, `streakDetails`, `followingCharge`,
  `followingRun`, `isMonthString`/`isDateString`/`addDays`/`shiftMonth`/`formatDayLabel`/`formatShortMonth`/
  `formatWeekdayDay`, `shown()`, `PeriodStepper`, `Skeleton`, `ErrorState`, `EmptyState`, `TransactionRow`, `Sheet`,
  `Mascot`, the `Illustration` tone classes, `cleanQuestion`, `useI18n`, and the cookie writer pattern of
  `amount-visibility.ts`.
- **Worker.** App Worker only. No `workers/jobs` or `workers/inbound` change, no Queue, no AI call, no R2.
- **Migration.** None by default: nothing is stored on the server (two display cookies; the calendar and story read existing
  tables). If the owner picks a per-account daily-greeting setting (Owner decision 3), the next free number on `main` is `0046`,
  but FN-52 and FN-53 on other branches may claim it: renumber at merge. A per-account setting would add a small
  account-scoped table and an export and delete entry; not built by default.
- **Merge caution.** `nav.ts`, `i18n-en.ts`, `Sidebar.svelte` and `src/routes/(app)/+page.svelte` are also touched by the
  FN-52 and FN-53 branches; expect conflicts and rebase before the final gates.
- **Docs.** `docs/design/DESIGN_SYSTEM.md`: next change-log entry (v3.3 unless another branch took it) listing the feature-chip
  exception, the greeting hero, the calendar badge and the story sheet; § Components gets `CalendarBadge`, `FeatureChip` and
  the hero card; § Illustrations notes `HeroScene`. `docs/design/APP_PARITY.md` § 3 Beranda order is updated (hero first,
  Struk and Suara in the desktop header, Fitur tiles). `docs/RUNBOOK.md` gains "Replacing the app icon". A release note in
  `src/lib/content/release-notes/` (both languages) at ship time.

## Prerequisites

None for Parts A–C. No credential, provider or `.dev.vars.example` entry. Struk and the hero ask field show their existing
"belum dikonfigurasi" reasons when the AI Gateway is not configured (`AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID`, see
`docs/RUNBOOK.md` › Secrets): this feature neither adds nor needs them. Part D's history card needs **owner-approved content**
(Owner decision 2), not a credential. A new home-screen icon needs the owner's logo file (`docs/TASKS.md:253`).

## Tracker impact

- `docs/TASKS.md`: no open item covers this. Add under the UI lines, ticked at completion:
  `- [ ] **Claude** — FN-54 greeting hero, calendar page, feature icons and daily greeting (no migration) — docs/features/fn-54-greeting-calendar/PRD.md`.
  Add `- [ ] **You** — FN-54 on-this-day content: approve how many days and who researches them; each entry needs two opened
  sources.` and `- [ ] **You** — FN-54 real-phone check of the hero, calendar and badge at 360 px.` The open owner item "New logo
  (owner request 2026-10-11, "Geometric Lion Emblem on Orange"): send the image file; decide whether it also replaces Koko as
  the app icon" (`docs/TASKS.md:253`) stays open and gates Part A6's icon work; do not tick it from this feature.
- `docs/ACCEPTANCE.md`: row 57 ("360 px layout, 44 px touch targets, reduced motion", Browser) extends its Check column with
  `e2e/beranda-hero.spec.ts`; add two rows under Money and dates: "Greeting period and Beranda/Kalender day buckets use the WIB
  date (23:59 / 00:00 WIB vectors) | Automated | `src/lib/shared/greeting.test.ts`, `test/integration/kalender.test.ts`" and
  "Calendar day figure = Riwayat day total for the same date | Automated | `test/integration/kalender.test.ts`". Row 49 (month
  buckets, Not run) moves only if a named check covers the whole app's month bucketing, which this feature does not. The
  manual real-phone checks stay pending.
- `docs/FEATURES.md`: FN-54 entry added after FN-51 with this PRD (FN-52 and FN-53 live on other branches).
- `docs/HISTORY.md`: one Completed-work bullet at the end of each shipped part, with real-device checks stated as run or not run.

## Owner decisions (defaults proposed; answer once before the build)

1. **What "greetings page" means.** Default: the greeting **hero on Beranda** (Part B, always) **plus** a once-a-day sheet of
   the user's own figures (Part D). Alternative: hero only (drops Part D). Not proposed: a separate `/sapaan` page.
2. **"On this day" history cards.** Default: the mechanism ships, the content ships **empty** until you approve entries; no
   card is ever shown without two opened sources. Say who researches (an agent with web access, with your review) and the
   launch coverage; target 366 days afterwards. Alternative: no history cards at all.
3. **Daily sheet state.** Default: shown once per WIB day per device, **on** for everyone who has data, remembered in a cookie,
   switch in Pengaturan › Tampilan and "Matikan sapaan harian" in the sheet, device-only (not synced). Alternative: a
   per-account setting (needs migration 0046 or the next free number, plus an export and delete entry).
4. **Greeting boundaries and English.** Default: pagi 04:00–10:59, siang 11:00–14:59, sore 15:00–17:59, malam 18:00–03:59 WIB;
   English: morning / afternoon / afternoon / evening. Say if your usage differs (for example malam from 19:00).
5. **Name in the greeting.** Default: none ("Selamat pagi."), keeping the line short at 360 px and in shared spaces.
6. **Hero ask field.** Default: a GET form that prefills Tanya and sends nothing; disabled with a visible reason when the AI
   Gateway is not configured. Alternative: send the question straight from Beranda (reuses Tanya's ask action and its
   duplicate guard; costs the user's own key on press).
7. **Chips.** Default: chip 1 = existing last-month comparison; chip 2 = budget left (or the spent/over/"Atur anggaran"
   variants). Alternative: also a streak chip (already in the header).
8. **Calendar form.** Default: a page at `/kalender` with spending shades, closed days, bills and recurring items, a 26-month
   window (23 back, this month, 2 ahead). Alternative: a sheet over Beranda (shallow routing; more JavaScript, no deep link
   without extra work).
9. **Struk and Suara placement.** Default: in the desktop header next to the badge, unchanged on phone (bottom of the main
   column). Alternative: also move the pair up under the hero on phone.
10. **Badge look.** Default: ink band with the month in `--bg`, the day number below, no accent colour (ink and white,
    mono-safe).
11. **Coloured feature chips.** Default: yes, tinted with existing category hues, grey in the mono theme, recorded as a
    design-system exception. Alternative: neutral grey chips (keeps "colour only for meaning" strictly).
12. **Fitur tiles.** Default: static hints, no live figures, at the end of Beranda's side column. Alternatives: live figures
    (new queries per feature), or tiles directly under "Hari ini" (needs a reading-order decision on phone).
13. **Kalender in the sidebar.** Default: no (the badge is the entry; `/beruntun` stays as is). Alternative: add it under Uang.
14. **Home-screen icon.** Default: nothing visual ships until you send the logo file; Part A6 only prepares the swap. Say if
    the logo replaces Koko as the icon, and whether the Pro and Agen icon variants (FN-46) keep a crown on the new mark.
15. **Koko on the hero.** Default: a still `idle` Koko, 48 px, resting at the right end of the illustration strip, no speech.
16. **Plan gating, credits, retention.** None: every user gets all of it; no AI credit is spent; no server-side data is stored
    (two display cookies, one year); no new retention rule. Say if you want any part Pro-only.
17. **Illustration.** Default: one new wide scene with a sun or moon that follows the time of day, drawn in the existing
    isometric style. Alternative: the existing 4:3 scenes only (smaller, less tailored).
18. **Visible H1 on desktop.** Default: yes ("Beranda", with the streak chip under it), matching the other desktop pages.

## Owner decisions — answered 2026-10-13

- Greeting: the Beranda hero and the optional once-a-day sheet built from the user's own figures (Part D), with an
  off switch in Pengaturan › Tampilan.
- "On this day": ship the cited JSON file, its validator and the review log empty; entries are drafted with sources
  for the owner's review and only approved ones ever show.
- Feature icons: coloured chips from the existing category hues (documented design-system exception).
- Every other default accepted: greeting boundaries pagi 04:00, siang 11:00, sore 15:00, malam 18:00 WIB; `/kalender`
  from the date badge with figures equal to Riwayat; Struk and Suara beside the badge on desktop, unchanged on phone;
  the ask field only prefills Tanya; daily-sheet state per device (cookies); no migration; the home-screen icon waits
  for the owner's logo file.
