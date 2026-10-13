# Parity wave D — engineer report (cycle 1)

Source: `docs/design/APP_PARITY.md` § 3a (wave D) and the two wave A polish items in `docs/TASKS.md`.
Branch `ui-parity-d` from `main` e47e343. Styling and markup only: no migrations, no server, access-control or
money-calculation change. Every form action, `use:enhance` handler, no-JavaScript path and loading / empty /
error / saving / success state is kept as it was.

## Shared pieces (outside `src/lib/ui/kit`, which wave C owns)

- `src/lib/ui/shell/IconRow.svelte` — GroupedList row: 40 px round tile with an icon, 15 px / 600 title, 13 px
  grey second line, optional trailing slot, chevron only when the row is a link. Kit gap: GroupRow has no
  icon-row layout; candidate to move into the kit after wave C.
- `src/lib/ui/shell/PageAction.svelte` — the page's primary action: ink pill in the header row on desktop
  (`at="header"`), full-width large ink pill at the bottom of the page on a phone (`at="bottom"`). Both are
  rendered; each is `display: none` at the other width, so assistive tech and tests see one.
- `src/app.css` — one rule: a secondary/destructive Button inside a panel GroupedList (`.group`) takes the page
  colour, so a panel pill on a panel row stays visible.
- `src/lib/ui/auth/Field.svelte` — § 3a input: 48 px, radius 12, panel fill, no border; invalid = red inner ring.
  Native `select`/date inputs in TransactionForm, WalletForm, SubscriptionForm, PayForm, Aplikasi and Suara got
  the same fill (on a panel row they take the page colour instead).
- `Sheet` title 20 px / 700; AddSheet (Tambah sheet) rows 15 px / 600 with the hairline inset after the tile,
  disabled paths dimmed.

## Per screen

- **Pengaturan** — subtitle = the account e-mail; three grouped sections (Akun, Aplikasi, Privasi) of IconRows
  with a grey second line and chevrons (was one flat list with bare icons).
- **Akun** — section titles 20 px / 700 (also in AccountKeySection and ChangePasswordSection); panel inputs.
- **Privasi** — section titles 20 / 700; body text grey; the policy, terms, Akun and public delete links became
  GroupedList rows with chevrons (no brand-blue standalone links).
- **Notifikasi (settings)** — section titles 20 / 700; the install-guide link is bold ink.
- **Paket** — credit balance stands on the page as the one big number (56 / 52 px), no card; plan cards are
  panel fills in an auto-fit grid (2–3 across on desktop); the current plan is an ink "Paketmu sekarang" tag,
  not an ink ring; credit history hairlines inset; pager links bold ink. Mode-uji page: title weights, bold links.
- **Aplikasi terhubung** — rows get an initials tile and chevron; 13 px second line; inline (no-JS) detail and
  dev select on the new fills.
- **Kategori** — the intro line is the header subtitle; section titles 20 / 700; "+ Tambah kategori" row has a
  tile; the no-JS form sits on the page colour (its panel inputs stay visible).
- **Instal, Fitur** — already on the pattern; unchanged apart from inherited kit/Field styles.
- **Kotak masuk** — header subtitle; "Periksa draf" is the PageAction (header on desktop, full-width bottom on a
  phone); Notifikasi is an IconRow with the unread count as its second line; "Draf" section title with
  "{n} draf menunggu"; dev tools unframed. Draft tags no longer overflow at 360 px (22 px nowrap pills), "Abaikan"
  14 px.
- **Notifikasi (inbox)** — header subtitle; "Kembali ke Kotak masuk" and "Atur notifikasi" are secondary header
  pills (were brand-blue links); unread dot ink.
- **Periksa draf** — header subtitle and a secondary "Kembali" pill; selection count as a 20 px section title;
  option hairlines inset.
- **Ruang** — subtitle; spaces and members get round initials avatars; "Buat ruang bersama" is the PageAction;
  space detail moves role line and "Pakai ruang ini"/"Sedang dipakai" into the header row; invite link field on
  the panel fill. Buat ruang / undangan: subtitle, 560 px form column.
- **Tanya** — subtitle under the H1; still "Segera hadir".
- **Langganan / Barang / Koleksi** — subtitle "{n} langganan/barang/koleksi" (the lists hold every row of the
  space, so the count is exact); "+ Tambah …" is the PageAction (header on desktop when the list is non-empty,
  full-width bottom on a phone; the empty state keeps its own button); the in-list "+ Tambah …" row is gone; the
  total is left-aligned at the HeroAmount scale (44 px phone, 52 px desktop) instead of a centred 34–40 px figure;
  rows 15 / 600 titles, 13 px second lines, 15 / 700 amounts; no-JS forms on the page colour.
- **Tambah sheet forms** — Transaksi baru / Ubah: 560 px column, centred "Batal"; Suara review rows are panel
  fills without the inset frame, fields inside them on the page colour, titles 20 / 700.
- **/masuk, /daftar, /akun-dihapus** — H1 28 / 34 px, 800, with a 15 px grey subtitle; desktop column sits lower;
  the "Daftar"/"Masuk" link in the sentence stays brand blue (inline text link, allowed by § 3a).
- **Polish (wave A)** — Sidebar: compact rows from 940 px window height down (fits at 900 px), second lines of the
  plan card and the assistant note visually hidden below 820 px, a 24 px fade above the sticky bottom block and
  room after the last link (at 768 px the last Catat link fades under the block and scrolls into view).
  "Lihat semua" (Beranda) and "Lihat semua di Riwayat" (Laporan) are bold ink, no underline until hover.

## Deviations

- Pengaturan subtitle is the account e-mail (no count is meaningful there).
- Notifikasi inbox subtitle is a fixed line, not a count: the list is capped by `NOTIFICATION_LIST_LIMIT`, so a
  count could understate.
- Header primary actions on Langganan/Barang/Koleksi appear only when the list is non-empty, to avoid two CTAs
  next to the empty state.
- Kekayaan bersih, Dompet, Anggaran, Impor, the Fitur sheet and the kit were not touched (wave C). WalletForm and
  GoalForm (used on `/kekayaan`) only had their `select` restyled.

## Files

New: `src/lib/ui/shell/IconRow.svelte`, `src/lib/ui/shell/PageAction.svelte`,
`src/lib/ui/shell/page-pieces.test.ts`, `e2e/parity-d.spec.ts`. Changed: `src/app.css`,
`src/lib/shared/i18n-en.ts` (20 keys), Sidebar, AddSheet, Sheet, Field, DraftSummary, AccountKeySection,
ChangePasswordSection, TransactionForm, WalletForm, SubscriptionForm, PayForm, and the pages under `(app)/`
pengaturan/*, kotak-masuk/*, ruang/*, langganan, barang, koleksi, [stub], riwayat/baru, riwayat/[id]/edit,
riwayat/suara, `(app)/+page.svelte` and laporan (link style only), `(auth)/*`. E2E updated: `e2e/privasi.spec.ts`
(the Privasi link is located inside `main`: on desktop the test user "Pemilik Privasi" also names the sidebar
account link).

## Gates (each under `flock /tmp/montra-heavy.lock`)

- `npm run check` — svelte-check 1459 files, 0 errors, 0 warnings; tsc for service worker and both Workers clean.
- `npm run lint` — "All matched files use Prettier code style!", eslint exit 0.
- `npx vitest run --maxWorkers=2` — Test Files 155 passed (155), Tests 2236 passed (2236).
- `npm run build` — "✔ done".
- Playwright `--workers=1` (E2E_PORT=8834, LD_LIBRARY_PATH workaround): full suite 284 passed, 16 skipped,
  1 failed (privasi desktop, ambiguous locator — fixed); rerun of `privasi.spec.ts` + `parity-d.spec.ts`:
  6 passed, 1 skipped (parity-d is phone-only).

## Pre-handoff probes

- 360 px: `e2e/parity-d.spec.ts` — 20 signed-in routes plus /masuk and /daftar, H1 visible, no horizontal scroll:
  passed. Screenshot script also reported no overflow on Pengaturan, Kotak masuk, Langganan and /masuk at 360 and
  1440 px, light and dark.
- No-JS forms: unchanged paths; covered by the existing no-JS specs in the suite run (privasi, langganan, koleksi,
  ruang, suara, tabungan) — passed.
- Concurrency, two tabs, cross-space, money vectors, two devices, month boundaries: not applicable (no server,
  data or money change).
- User copy: new strings contain no paths or identifiers.

## Screenshots

`docs/features/ui-parity-d/shots/`: pengaturan, kotak-masuk, langganan, masuk at 360 and 1440 px, light and
dark; `sidebar-1440x900-light.png` and `sidebar-1440x768-light.png` for the sidebar fix. Taken from a local
`wrangler dev` with one fictional user (a wallet, two catalogue subscriptions, four demo drafts). Emoji tiles show
as boxes because the headless browser has no emoji font.

## Not verified

- Real devices and screen readers (VoiceOver/TalkBack) — only Chromium headless.
- AA contrast was not re-measured by tooling for the new combinations; the colours used are existing tokens on
  their usual surfaces (muted on bg/panel, ink on panel, money-up on panel), which `test/contrast.test.ts` covers.
- Merge with wave C: both waves may touch `src/app.css` and `i18n-en.ts` (wave D keys sit after
  "Pasang aplikasi", not at the end of the file).
