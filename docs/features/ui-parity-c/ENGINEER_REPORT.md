# Parity wave C — engineer report (cycle 1)

Branch `ui-parity-c` (from `main` d0de5dd). Spec: `docs/design/APP_PARITY.md` § 3 (Anggaran, Dompet, Fitur sheet,
Impor) and § 3a. Screenshots: `shots/` (360 and 1440 px, light and dark, Anggaran and Dompet, fictional data).

## Per spec item

**Anggaran `/anggaran` (new).** Header: subtitle "1 Okt – 31 Okt 2026 · 23 hari lagi", "Awal periode anggaran"
(grey, disabled with its reason), "Ubah anggaran" (ink; sheet with JS, `?ubah=bulanan` inline without). Main column:
HeroAmount "Sisa untuk dibelanjakan" (or "Melebihi anggaran"), "Rp… sehari sampai 31 Okt" (FN-07 safe-to-spend),
progress bar with a pace marker, "Rp… terpakai dari Rp… · diperkirakan Rp… di akhir periode" (amber when ahead of
pace). "Per kategori" GroupedList: tile, name, "Rp… tersisa"/"Rp… melebihi", bar with pace marker, grey
"Rp 836.000 / Rp 1.200.000", amber `--warn` bar + `--warn-text` "Lebih cepat dari jadwal", red when over. Right
column: "Belum ada anggaran" (expense categories without a budget, this month's spend, "Atur" → category sheet or
`?kategori=<id>` inline) and the pace note. No-budget state, empty states, error state with retry, loading
skeleton, saving labels, success only after the server confirms. Sidebar "Anggaran" link added to Uang.
Server: `budgets/anggaran.ts` (figures from the FN-05 aggregates Beranda uses: the total reconciles with Beranda,
integration-tested), pace math in `budgets/math.ts` (`pacePercent`, `budgetProgress`, BigInt, WIB month).

**Dompet `/dompet` (replaces the redirect).** Wallet loader and actions (create/update/archive/restore/favourite,
createGoal) moved from `/kekayaan` unchanged. HeroAmount "Total saldo" (favourite wallet's currency; other
currencies listed beside it, never summed), "{n} dompet · Rp… disisihkan untuk tujuan" (live goals' savings).
"Dompet kamu" GroupedList: initials tile, name with ★ for the favourite, type line, balance, chevron (≥ 480 px),
star button to make another favourite. Right column "Tujuan" (FN-10 GoalsSection: progress rows, "%" right,
"Rp4,5 jt dari Rp30 jt"). Actions: Transfer (→ `/riwayat/baru?type=transfer`; disabled with its reason without two
same-currency wallets), "+ Tambah dompet". `/kekayaan` is now the "Kekayaan bersih" page (net worth, Barang and
Koleksi values); the Dompet tab no longer claims `/kekayaan` (it still claims `/kekayaan/tabungan/*`).

**Fitur sheet.** "Jelajahi fitur" (sidebar; also Beranda's link) opens one layout-level sheet: intro line, ToggleRows
Kekayaan bersih, Barang, Langganan, Koleksi bound to FN-12 flags (posts the existing `/pengaturan/fitur?/setFlag`;
switch shows the stored state, "Perubahan disimpan." only after the server answered; sidebar reloads), then "Buka
fitur" links to the enabled feature pages (the phone's path to them now that `/kekayaan` lost those rows). Without
JS the link goes to `/pengaturan/fitur`.

**Impor.** Subtitle; "Impor mutasi" panel card with two PickerSheets (Dompet for rows without a wallet; template:
Deteksi otomatis / Template Montra / Money Manager), dashed drop zone (upload icon, title, grey explanation, CSV
badge, "Pilih file", drag-and-drop into the same file input), "Baca dengan AI" disabled with its reason; Ekspor and
"Riwayat impor" cards; right column "Cara lain memasukkan data" (Impor/ekspor CSV, Pindai struk "Segera hadir",
Gmail → Kotak masuk, Pintasan → Aplikasi terhubung) and "Pekerjaan membaca terbaru" (empty state). Without JS the
native select and format radios post as before.

## Deviations (decide or accept)

1. **Migration `0020_category_budgets.sql` (new table `category_budgets`).** Unavoidable for § 3's "Per kategori"
   rows and the "Belum ada anggaran" list: FN-07 stores one total per space, so per-category amounts had nowhere to
   live. This reverses FN-07 owner decision B ("defer per-category budgets") for the parity request of 2026-10-08 —
   owner should confirm. Separate table (FN-07's `budgets` untouched), same lifecycle (guarded writes in `db.batch`,
   revive-on-set tombstones, unique (space, category)); added to `SPACE_SCOPED_TABLES` (purge/account deletion) and
   the FN-31 export decisions. Parallel waves adding a migration will need renumbering at merge.
2. "Awal periode anggaran" is disabled with "Periode anggaran mengikuti bulan kalender, mulai tanggal 1." FN-07 has
   no period start; a picker would need storage and a change to Beranda's safe-to-spend.
3. Dompet hero shows "{n} dompet · Rp… disisihkan untuk tujuan", not "Rp… tersedia": goal savings are not tied to
   wallets, so "total minus set aside" would be an invented figure. No "Lihat semua" on Tujuan (no goals page).
4. Impor template picker lists only formats that work (no bank list or coloured dots: no bank templates exist);
   label "Template berkas". The reading-jobs card is an empty state (FN-16/17 not built).
5. `/kekayaan` keeps the Barang and Koleksi value rows (net-worth context, FN-27/28 reconcile there); only the
   Langganan row left. Not restyled (wave D).
6. Kit touches: HeroAmount figure `min(56px, 12.5vw)` (a 9-digit figure wrapped at 360 px, Beranda too);
   ProgressBar `marker` + `warn` tone; Button `describedby`; icons `upload`, `arrow-left`, `transfer`, `gauge`.
   Beranda's budget form moved into `ui/budgets/BudgetForm.svelte` and its actions into `budgets/actions.ts`
   (shared with Anggaran); Beranda's markup otherwise unchanged.
7. Fitur sheet uses the shared Sheet header (close button, no back arrow).

## Files

New: `migrations/0020_category_budgets.sql` (+ meta snapshot/journal), `src/lib/server/budgets/{category-repo,
anggaran,actions}.ts`, `src/routes/(app)/anggaran/+page.{server.ts,svelte}`, `src/routes/(app)/dompet/+page.svelte`,
`src/lib/ui/budgets/BudgetForm.svelte`, `src/lib/ui/shell/{FiturSheet.svelte,fitur.svelte.ts}`; tests
`src/lib/server/budgets/anggaran.test.ts`, `src/lib/server/wallets/balance.test.ts`,
`src/lib/server/goals/progress.test.ts`, `test/integration/anggaran.test.ts`.
Changed: dompet/kekayaan/impor/Beranda routes, schema, spaces purge list, export decisions, budgets math/messages,
wallets balance, goals progress, GoalsSection, nav + Sidebar + layout, kit (above), i18n-en (66 entries), link
targets `/kekayaan?tambah=1` → `/dompet?tambah=1`, goal-notification fallback → `/dompet`.
Tests changed: `kekayaan-routes.test.ts` → `dompet-routes.test.ts` (+ totals/set-aside/two-space cases),
tabungan/riwayat/feature-flags/net-worth route tests, nav/ProgressBar/notifications units; e2e fitur (Fitur sheet
test), impor (picker sheets), kekayaan, tabungan, shell, langganan, notifikasi, riwayat, kotak-masuk, ledger.

## Gates (each step run separately under the heavy lock)

- `npm run check` exit 0 — `COMPLETED 1456 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`
- `npm run lint` exit 0 — `All matched files use Prettier code style!`, eslint clean
- `npx vitest run --maxWorkers=2` exit 0 — `Test Files 157 passed (157)`, `Tests 2237 passed (2237)`
- `npm run build` exit 0 — `✔ done`
- Playwright `--workers=1` (fitur, impor, shell, kekayaan, tabungan, langganan, notifikasi, riwayat, kotak-masuk,
  beranda, kekayaan-bersih, koleksi, laporan, kit, barang): `158 passed`, `7 skipped` (project-only tests), exit 0.

## Pre-handoff probes

- Concurrency: 20 concurrent first saves of one category budget → 1 `ok`, 19 `stale`, one row.
- Two tabs: a stale `updated_at` on set/remove category budget → 409 "changed meanwhile", nothing written.
- Cross-space: removed member (stale `locals.space`) → 404 on `/anggaran` load and all four actions, repo answers
  `gone`, row unchanged; another space's / income / unknown / over-long category id → same 404 body; shared-space
  category budgets and Dompet totals never appear in a member's personal space.
- Money vectors: no new parsing (amounts through `parseBudgetForm` / `wholeAmountMinor`).
- Two devices: n/a (no sync client yet).
- Month boundaries: pace/projection vectors 31 Jan vs 1 Feb, last day of the month, February.
- 360 px: no horizontal scroll on Anggaran, Dompet, Impor at 360 light+dark with seeded data; header actions 44 px.
- No-JS: Dompet (kekayaan.spec), Impor (impor.spec); Anggaran total + category forms verified with a temporary
  probe spec (passed both projects, not committed — e2e for Anggaran was out of scope).
- User copy: no paths or internal ids.

## Not verified / open

- No phone entry to `/anggaran` (sidebar only; Beranda's budget link still opens its own sheet).
- Usage statistics: `/dompet` is not a named screen (`kekayaan` still maps `/kekayaan`).
- English "{n} wallets" reads "1 wallets" for one wallet.
- Goal rows keep the GroupedList hairline inset (68 px) although they have no icon.
- Emoji tiles render as boxes in the headless screenshots only (no emoji font in the test browser).
- Laporan (wave B) e2e ran green against this branch's HeroAmount change, but wave B's own changes were not merged.

## Cycle 2 — gaps

1. **Phones reach `/anggaran`:** Beranda's budget block (§ 3: the progress line "from budgets") gets a "Lihat
   anggaran" link next to "Ubah/Atur anggaran". Chosen over a Dompet row or the Fitur sheet: the reference has no
   Anggaran row on Dompet, and the Fitur sheet holds hideable modules, while Anggaran belongs to Uang.
2. **Usage statistics:** `dompet` and `anggaran` added to the closed `STAT_SCREENS` vocabulary and
   `statScreenForPath` (`src/lib/shared/privacy.ts`); new `privacy.test.ts` plus the FN-31 integration loop.
3. **English plurals:** no plural helper exists, so the singular is its own phrase: "1 dompet" → "1 wallet",
   "1 hari lagi" → "1 day left"; the composed lines take the count as `{dompet}`.
4. **Anggaran no-JS test committed:** `e2e/anggaran.spec.ts` (JavaScript disabled: refused 0, saved total, saved
   category budget, kept on reload) plus the Beranda → Anggaran link.

Gates (each step separately under the heavy lock):

- `npm run check` exit 0 — `COMPLETED 1458 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`
- `npm run lint` exit 0 — `All matched files use Prettier code style!`, eslint clean
- `npx vitest run --maxWorkers=2` exit 0 — `Test Files 158 passed (158)`, `Tests 2239 passed (2239)`
- `npm run build` exit 0 — `✔ done`
- Playwright `--workers=1` (anggaran, beranda, kekayaan, shell): `57 passed`, `4 skipped`, exit 0.

Still open: goal rows' hairline inset; emoji boxes in headless screenshots only.

## Cycle 3 — red team lows

- **L1 (budget outlives its category):** the app has no category-delete path (owner decision C: hide only), so
  the rule lives in the database: trigger `category_budgets_follow_category` (migration 0020) runs on any
  `categories.deleted_at` null → set and, in the same statement and therefore the same batch, tombstones that
  category's live budget (`amount_minor` 0, `deleted_at`, `updated_at` = max(deleted_at, old + 1), `seq` = the
  space's current counter, which the delete batch bumped first). Integration test: budget set → category
  tombstoned in a seq-bumped batch → budget row content-free with the batch's seq, the other category's budget
  untouched, Anggaran hides it, the FN-31 export reader (`tablePages`) lists only the live budget, a later
  category update never touches the tombstone again.
- **L2 (FK not bound to the space):** `category_budgets (space_id, category_id)` → `categories (space_id, id)`
  composite foreign key, plus `categories_space_id_uq` created in the same migration (before the table). 0020 and
  its snapshot/journal regenerated with drizzle-kit, then the index moved first and the trigger appended (drizzle
  does not model triggers, same as 0018/0019). Integration test: a raw insert of a budget pointing at another
  space's category fails with a FOREIGN KEY error; the same insert with the space's own category succeeds.

Gates (each step separately under the heavy lock; no UI change, so no Playwright run):

- `FIN_PERSIST_TO=<fresh dir> npm run db:migrate:local` exit 0 — 0000–0020 applied (`0020_category_budgets.sql ✅`)
- `npm run check` exit 0 — `COMPLETED 1476 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`
- `npm run lint` exit 0 — `All matched files use Prettier code style!`, eslint clean
- `npx vitest run --maxWorkers=2` exit 0 — `Test Files 160 passed (160)`, `Tests 2277 passed (2277)`
- `npm run build` exit 0 — `✔ done`
