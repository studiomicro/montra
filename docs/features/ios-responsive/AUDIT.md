# ios-responsive — audit and fixes (2026-10-10)

Owner request 2026-10-10: "adjust to iPhone responsive", plus the same day's scope addition "phone layout v3" (simple
layout, pattern from one reference screenshot). Slug `ios-responsive`, tier Medium (CSS and layout only; no data,
access or copy change; one new i18n phrase, "Saldo"). Branch `fix/ios-responsive`, not merged.

## How it was audited

- **Engine:** Playwright WebKit 26.6 (closest to iOS Safari that runs here), iPhone user agent, touch, `pointer: coarse`.
  It is not Safari: no software keyboard, no dynamic toolbars, no `env()` insets, a macOS native `<select>`.
- **Viewports (full screen, as the installed app):** iPhone SE 375×667, iPhone 15 393×852, iPhone 15 Pro Max 430×932,
  iPhone 15 landscape 852×393. Light and dark. Portrait insets emulated through the `--sai-*` variables (top 47,
  bottom 34 on notch phones, none on SE); landscape left/right 59, bottom 21.
- **Data:** a fresh local account with three wallets (one named "BCA Tabungan Utama Keluarga Besar Jakarta Selatan"
  at Rp 1.264.000.000), seven transactions (a −Rp 1.264.000.000 expense with a 120-character merchant name), budgets,
  a goal, net-worth items, the demo seed (`Data demo` rows, subscriptions, collectibles) and demo drafts in the inbox.
- **49 screens × 4 viewports × 2 themes = 392 page states**, each measured at the top and scrolled to the end:
  horizontal overflow and the elements causing it, interactive targets under 44 px, clipped or ellipsised text (rupiah
  amounts in particular), content and primary buttons under the floating bars, sticky title against the top inset,
  sheet height. Screens: Beranda; Riwayat, edit, baru, Suara, Struk, Berulang (+ baru); Laporan; Dompet; Anggaran; Alur
  uang; Kekayaan (+ goal); Langganan; Barang; Koleksi; Kotak masuk (+ periksa, Notifikasi); Tanya; Impor (all
  sections); Ruang (+ baru); Pengaturan and its 19 subpages; Tambah, Fitur and filter sheets; Masuk and Daftar.
- The measuring scripts are throw-away (not committed); the guard that stays is `e2e/ios-responsive.spec.ts`.

## Findings

"Before" is the first run on the unchanged code; "After" is the last run on the final build.

| # | Screen(s) | Check | Finding before | Fix | After |
| --- | --- | --- | --- | --- | --- |
| 1 | Riwayat baru, Ubah transaksi, Berulang baru | horizontal scroll | the wallet `<select>` took the width of its longest option: page 124 px (SE), 106 px (15), 69 px (Pro Max) too wide | `app.css`: `select` may shrink (`max-width`, `min-width: 0`, `overflow: hidden`); `.field`, `.stack`, `.picker` grids get `minmax(0, 1fr)` | 0 px |
| 2 | Impor (wallet and statement pickers) | horizontal scroll | the picker button's single-line text widened its implicit grid column: 130 / 112 / 75 px | same `.picker` / `.stack` rule | 0 px |
| 3 | Beranda | long rupiah amount | hero "Rp 1.265.429.500" broke before its last digit onto a second line | `HeroAmount`: length class + container query unit shrinks the figure to its line; 56 px stays for normal amounts | one line, SE to Pro Max |
| 4 | Koleksi | clipped money | purchase price cut by an ellipsis ("Dibeli 12 Jun 2026 · Rp 3.20…") | meta line wraps | full amount |
| 5 | Beranda | 44 px targets | space avatar 40×44, hide-amounts eye 40×40, chart link "Lihat transaksi" 99×21 | avatar `min-width: 44`; `HeroAmount` eye 44 px on coarse pointers; `BarChart` link 44 px high | ≥ 44 |
| 6 | Laporan, Dompet, Anggaran | 44 px targets | the same eye button, 40×40 | as above | ≥ 44 |
| 7 | Riwayat baru, Ubah transaksi, Struk, Berulang baru | 44 px targets | "Batal" link 41×44 | `a.cancel` min-width 44 on coarse pointers (`app.css`) | ≥ 44 |
| 8 | Anggaran (SE) | horizontal scroll | found on the re-run: my header-actions row (phone layout v3) could not wrap, 10 px over | actions wrap | 0 px |
| 9 | Riwayat, Dompet, Langganan, Kotak masuk, Beranda (Terbaru) | list rows | 40 px tile, 60 px rows, amount alone on the right | phone layout v3 (below) | per owner pattern |
| 10 | Tab bar | covered content | full-width bar with 5 labelled cells | phone layout v3 (below); content keeps `--tabbar-h + 40 px + inset` bottom padding | last row clear on all 4 viewports |

Checked and clean (no finding): no horizontal scroll on any other screen, in any viewport, light or dark, including the
three long-text cases (wallet name, 120-character merchant, −Rp 1.264.000.000 in Riwayat day totals, rows and hero);
sticky titles never sit above the top inset (47 px); the Tambah sheet is 524/852 px (393), 490/667 (SE) and 369/393
(landscape) high, the Fitur sheet 781/852, 643/667 and 369/393 — none taller than the viewport, none scrolls the
page sideways; Pengaturan and its subpages, Tanya, Ruang, Masuk/Daftar, Kekayaan, Barang, Langganan, Laporan, charts:
no finding. Landscape 852×393: no horizontal scroll, last rows reachable, both bars clear of the 59 px side insets.

False positives of the measuring script (not defects): "Ya, hapus" and the category options on Periksa sit inside closed
`<details>`; decorative illustration shapes (`g.strip`) extend past an `overflow: hidden` frame on Impor, Aplikasi
terhubung, Integrasi and API.

## Remaining, not fixed

- **`<select>` height:** macOS WebKit draws the native menulist about 23 px high whatever `min-height` says, so the
  measuring script still reports it. The component CSS sets `min-height: 48px` (iOS honours it); only a real iPhone confirms.
- **Alur uang:** the node labels in the diagram are 32 px-high links inside SVG (decorative diagram, names also appear
  in the lists); left as is.
- **Landscape phones (601–932 px wide):** the phone layout v3 pieces that are scoped to 600 px (outlined chips, record
  rows, header links, toolbar "+") do not apply there; the pill and round "+" do (≤ 1023 px). Deliberate, per "≤ 600 px".
- **Not testable here:** software keyboard (is the focused field kept visible, does a sheet shrink), Dynamic Island,
  home-indicator swipe zone, rubber-band scroll, real Safari toolbars, the iOS select popup, VoiceOver.

## Phone layout v3 (owner request 2026-10-10)

Rules in `docs/design/APP_PARITY.md` § 3b. Implemented in the shared pieces, then per page:
`TabBar` (icon-only glass pill bottom-left, round ink "+" bottom-right, safe-area aware), `ScreenTitle` (title, text
link right, subtitle under, square outlined "+" for an icon-bearing primary action), `Chip` (outlined, active filled
ink), `GroupList records` + `TransactionRow` / `DraftSummary` / Dompet rows (48 px rounded tile, bold title, grey meta,
small grey label over the bold amount, hairline after the tile, ≥ 72 px), Riwayat toolbar (search + square "+").
No new colour or token; the glass blur budget is unchanged (the round button is solid ink, so one blurred layer fewer).

## Screenshots (393 px, DPR 1, emulated notch 47 px / home indicator 34 px)

| Screen | Light | Dark |
| --- | --- | --- |
| Beranda | [beranda-393-light.png](beranda-393-light.png) | [beranda-393-dark.png](beranda-393-dark.png) |
| Riwayat | [riwayat-393-light.png](riwayat-393-light.png) | [riwayat-393-dark.png](riwayat-393-dark.png) |
| Dompet | [dompet-393-light.png](dompet-393-light.png) | [dompet-393-dark.png](dompet-393-dark.png) |
| Kotak masuk | [kotak-masuk-393-light.png](kotak-masuk-393-light.png) | [kotak-masuk-393-dark.png](kotak-masuk-393-dark.png) |

Also: [beranda-375-light.png](beranda-375-light.png) (iPhone SE, long figure on one line),
[anggaran-393-light.png](anggaran-393-light.png), [sheet-tambah-393-light.png](sheet-tambah-393-light.png),
[riwayat-852-landscape-light.png](riwayat-852-landscape-light.png). The "Pasang Montra di layar utama" card is the
one-time iOS Safari install hint (it appears because the audit used an iPhone user agent).

## Guard

`e2e/ios-responsive.spec.ts`, WebKit projects `ios-se` (375×667) and `ios-pro-max` (430×932) in `playwright.config.ts`
(those two projects run only this file; `phone` and `desktop` ignore it). It signs up a user with the long-text data
above and, on 11 screens, asserts no horizontal scroll, four ≥ 44 px tabs plus the round Tambah button, the bars above
the home indicator, the last list item and every primary button clear of the bars, the sticky title below the notch,
and the Tambah sheet within the screen. Fail-before proof: with the `select` / `.field` rule removed the spec fails
with "Received: 124" (SE) and "69" (Pro Max) on `/riwayat/baru`.
