# FN-16i — Impor layout adjustment

Owner request 2026-10-11 ("adjust the import features"), with a screenshot of the reference app's Imports page.
Mirror behaviour and layout only — never its name, mascot, copy or product names. This pass is a UI
reorganisation of the existing `/impor` page: no new capture path, no schema change.

## Goal

`/impor` already does the capture work (FN-16a/g/h statements, FN-17 spreadsheets, FN-18 CSV) but its layout
grew panel by panel and now undersells what Montra can read and oversells what it can't: the "Pindai struk" row
still says "Segera hadir" after FN-15 shipped, the bank-statement institution picker only lists the four banks
with a real parser with no path for the rest, and the wallet picker shows a plain icon instead of the brand
badges FN-43 already draws everywhere else. Tightening the layout to the reference's wallet-then-file flow,
making the institution list name every bank honestly (supported, screenshot-only, or not yet, each with its own
working alternative), and fixing the stale "coming soon" row gets Montra closer to "every primary action works
or shows why it is unavailable" for the single busiest capture screen outside Tambah.

## Scope

1. **Page chrome** (`src/routes/(app)/impor/+page.svelte:482-489`): new subtitle on `ScreenTitle` stating, in our
   own words, that a statement is read then every row is reviewed before it is saved (not the reference's wording).
2. **Shared wallet picker, lifted once** (`+page.svelte:468-480`, `496-887`): the `walletPick` snippet is currently
   rendered inside each of the four panels (CSV, Spreadsheet, PDF/CSV mutasi, Foto). Move it above the `Segmented`
   source control so one `PickerField` picks the destination wallet for whichever panel is active; the four hidden
   `defaultWalletId` inputs keep reading the same `walletId` state (no server contract change).
3. **Wallet picker brand badge**: `walletOptions` (`+page.svelte:182-188`) gains `brand: matchBrand(w.name)?.id`
   (`#lib/shared/brands.ts:171` `matchBrand`) so `PickerSheet` draws the FN-43 `BrandBadgeById` in front of each
   wallet row, the way `/dompet` already draws `BrandBadge` per wallet (`src/routes/(app)/dompet/+page.svelte:350`).
   A wallet whose name matches nothing (e.g. "Tunai") keeps today's plain row.
4. **Honest institution picker for the PDF/CSV mutasi panel** (`+page.svelte:362-368`, `institutionOptions`):
   expand the list beyond `data.statementInstitutions` (today only `STATEMENT_PARSERS` — BCA, BNI, Mandiri, OCBC,
   `src/lib/shared/statements/parsers.ts:12`) to the full CLAUDE.md FN-04 institution list — BCA, Mandiri, BRI,
   BNI, OCBC, Bank Jago, BSI, CIMB Niaga, Permata, Jenius, SeaBank, GoPay, OVO, DANA, ShopeePay, "Lainnya" — each
   row carrying its FN-43 brand badge (`institutionOption()`, `#lib/shared/brands.ts:194`). A row with a real PDF
   or CSV parser is selectable as today; every other row is shown **disabled** with a one-line hint naming its
   real alternative (see Acceptance 4). This list is server-trusted data (`load`, `+page.server.ts:183-214`) built
   from a new static catalogue, not a client guess.
5. **`PickerOption.disabled`** (`src/lib/ui/kit/picker.ts:4-14`, `src/lib/ui/kit/PickerSheet.svelte:37-71`): add an
   optional `disabled?: boolean` to the shared option type; a disabled row renders its hint, is not focusable as a
   radio target (`aria-disabled`, `tabindex="-1"`, no `onclick`), and is skipped in `role="radiogroup"` keyboard
   navigation. Used nowhere else yet, so no other picker's behaviour changes.
6. **"Pindai struk" row fixed** (`+page.svelte:1003-1009`): replace the stale `tr('Segera hadir')` placeholder with
   a real `href="/riwayat/struk"` (FN-15, shipped — `src/routes/(app)/riwayat/struk/+page.svelte`) and a one-line
   description of what it does (own wording, not the reference's copy).
7. **"Pintasan" row removed** (`+page.svelte:1018-1025`): see Owner decisions — the row names a capability Montra
   does not have (no Shortcuts/Tasker-style phone integration); it is dropped rather than left pointing at
   `/pengaturan/aplikasi`, which is Settings, not another way to bring data into this import.
8. **Card order** (`+page.svelte` `.o-*` CSS rules, `1085-1099`): reorder so the left column reads Impor berkas →
   Riwayat impor → Ekspor CSV (the export card is additional Montra functionality the reference screenshot does
   not show, kept last rather than removed) and the right column reads Cara lain memasukkan data → Pekerjaan
   membaca terbaru, matching the reference's left-then-right grouping; the same order holds in the single-column
   phone layout.
9. **Card titles/subtitles**: rename the `h2` at `+page.svelte:497` from "Impor mutasi" to "Impor berkas" (it
   already holds all four formats, not only bank mutations) and add a one-line card subtitle under it: pick the
   wallet, then the file (own wording).
10. **i18n**: every new or changed Indonesian string gets an `en` entry in `src/lib/shared/i18n-en.ts`, following
    the existing `tr()`/`trf()` calls in the file.
11. **Tests**: update `e2e/impor*.spec.ts` (and any Vitest covering `institutionOptions`/`walletOptions`) for the
    new card order, the lifted wallet picker, the expanded institution list and disabled-row behaviour.

## Out of scope

- Any new capture path, parser, or OCR layout (FN-16a/g/h, FN-17, FN-18, FN-19 are unchanged).
- Merging the four format panels (CSV / Spreadsheet / PDF-CSV mutasi / Foto) into one upload flow or one form
  action — they stay four `Segmented`-switched panels as today; only the chrome around them moves.
- A BRI, Bank Jago, BSI, CIMB Niaga, Permata, Jenius or SeaBank PDF/CSV parser (still FN-16a's open backlog item,
  `docs/TASKS.md` line 244-245) — this pass only names them honestly, it does not add their support.
- A "Recent reading jobs" data source: the card stays the same honest placeholder it is today
  (`+page.svelte:1029-1044`); it is reordered, not rebuilt.
- Any FN-48 (categories for imported rows) server-side change; that work lives on its own branch and is not
  touched here.
- A phone-shortcuts integration of any kind (Owner decision 2, below).
- Any migration; no table changes.

## Acceptance criteria

1. Given a signed-in user on `/impor` at ≥ 1200 px, when the page loads, then the layout shows two columns: left
   "Impor berkas" (wallet picker, format segments, the active panel, its drop zone) then "Riwayat impor" then
   "Ekspor CSV"; right "Cara lain memasukkan data" then "Pekerjaan membaca terbaru" — in that order.
2. Given the same page at 360 px, when the page loads, then the five cards stack in the order: Impor berkas,
   Riwayat impor, Cara lain memasukkan data, Pekerjaan membaca terbaru, Ekspor CSV, with no horizontal scroll and
   every tap target ≥ 44 px.
3. Given the wallet picker is opened (with JavaScript) from any of the four panels, when a wallet whose name
   matches an FN-43 brand (e.g. "BCA", "GoPay") is listed, then its row shows that brand's badge; a wallet with no
   brand match (e.g. "Tunai") shows the existing plain row; choosing a wallet sets the same `defaultWalletId` the
   active panel's form already posts, and the choice survives switching between panels without a reload.
4. Given the PDF/CSV mutasi panel's "Pilih institusi" sheet is opened, when it renders, then it lists Deteksi
   otomatis, BCA, Mandiri, BNI, OCBC as selectable rows (today's real parsers, `STATEMENT_PARSERS`), and BRI, Bank
   Jago, BSI, CIMB Niaga, Permata, Jenius, SeaBank, GoPay, OVO, DANA, ShopeePay and Lainnya as disabled rows each
   with a one-line Indonesian hint naming a real alternative (BRI: "pakai Foto (tangkapan layar BRImo) atau
   CSV/Spreadsheet"; the e-wallets: "pakai Foto (tangkapan layar aplikasi)"; the rest: "belum didukung — pakai
   CSV atau Spreadsheet, atau nanti AI dengan kuncimu sendiri").
5. Given a disabled institution row, when the user taps, clicks or tab-reaches it (keyboard), then nothing is
   selected, focus does not land on it inside the `radiogroup`, and `aria-disabled="true"` is present; the row
   never submits the form as a chosen institution.
6. Given JavaScript is off, when `/impor` renders the PDF/CSV mutasi panel, then the native `<select name="institution">`
   fallback lists the same selectable options as criterion 4 and omits (not merely visually hides) the disabled
   ones, so a no-JS submit can never post an unsupported institution id.
7. Given the "Cara lain memasukkan data" card, when it renders, then "Pindai struk" is a working link to
   `/riwayat/struk` with a one-line description (never "Segera hadir"), and the former "Pintasan" row is absent;
   the card has exactly three rows: Impor/ekspor CSV, Pindai struk, Gmail.
8. Given a space with no transactions yet, when `/impor` loads, then "Riwayat impor" shows its existing empty
   state and "Pekerjaan membaca terbaru" shows its existing honest placeholder — both unchanged in content, only
   in position.
9. Given the server load fails (`loadError` set, `+page.server.ts:203-213`), when `/impor` renders, then the error
   state in "Riwayat impor" still appears in its reordered position with its existing retry button, and the rest
   of the page (wallet picker, panels, other-ways card) stays usable.
10. Given a user who is not a member of the space in the URL (or a removed member), when they request `/impor` or
    post any of its five actions (`preview`, `import`, `previewStatement`, `importStatement`, `undo`, plus the
    spreadsheet and OCR actions), then every one answers through the existing `currentSpaceScope()` check
    (`+page.server.ts:183-249`, unchanged by this PRD) with the same not-found/not-a-member response as today — no
    regression test is needed beyond confirming the existing guard still wraps every action after the reorder.
11. Given the page in English (`locale=en`), when every string touched by this PRD renders, then each has a
    matching `i18n-en.ts` entry; `npm run test` (or the i18n coverage test) fails if one is missing.
12. Given the FN-16h OCBC password hint field (`+page.svelte:748-758`), when this PRD's changes ship, then the
    field, its placement in the PDF/CSV mutasi panel and its copy are unchanged.
13. Given the money and date values already shown in this page (row amounts in `duplicateList`, balance-gap lines,
    import batch dates), when they render after the reorder, then they still use `formatMoney`/`formatDayLabel`/
    `formatDateTimeWib` unchanged — this PRD touches no formatting logic.
14. Given `npm run gates` (check, lint, test, build), when run after the change, then it is clean; given
    `e2e/impor*.spec.ts` (or whichever Playwright spec covers `/impor`), when run against `wrangler dev`, then it
    passes against the new card order and institution list.

## Architecture notes

- **Routes:** `src/routes/(app)/impor/+page.svelte` (layout, panels, pickers, CSS order rules) and
  `src/routes/(app)/impor/+page.server.ts` (`load`, line 183 — gains the expanded institution catalogue; no
  action signatures change).
- **Shared:** `src/lib/shared/brands.ts` (`matchBrand`, `brandById`, `institutionOption`) reused as-is for the new
  badge/hint rows; a new small exported list (e.g. `IMPOR_INSTITUTION_CATALOGUE` in `brands.ts` or a new
  `src/lib/shared/statements/catalogue.ts`) maps every FN-04 institution name to {brand id, supported: boolean,
  hint}. Keep `STATEMENT_PARSERS` (`src/lib/shared/statements/parsers.ts`) as the single source of truth for which
  rows are selectable — never hand-maintain a second "supported" list that can drift.
- **Kit:** `src/lib/ui/kit/picker.ts` (`PickerOption.disabled`), `src/lib/ui/kit/PickerSheet.svelte` (render and
  keyboard handling for a disabled row). Both are shared by every other `PickerSheet` call site in the app
  (Dompet, Langganan, Kategori, …); add a Vitest/e2e case confirming an *enabled* row elsewhere is unaffected.
- **i18n:** `src/lib/shared/i18n.ts` (`tr`/`trf`) and `src/lib/shared/i18n-en.ts`.
- **No migration.** No table in `migrations/` changes; `data.statementInstitutions`/`data.ocrInstitutions` keep
  their current shape, only `load`'s returned catalogue grows.
- **No Worker change.** This is the app Worker's SSR/UI only; `workers/jobs` and `workers/inbound` are untouched.
- **FN-48 avoidance:** FN-48 (categories for imported rows, building on another branch per `docs/TASKS.md` line
  160-161) touches `src/lib/server/imports/*` and `src/lib/server/statements/*`. This PRD does not edit those
  files or `+page.server.ts`'s action bodies — only `load`'s returned data and the `.svelte`/kit files above — to
  keep the merge conflict-free.

## Prerequisites

None. Every institution named in the expanded picker that is not yet readable says so honestly (Acceptance 4);
no new credential is needed to ship this PRD. (FN-16a's still-open BRI PDF parser and any future AI-read statement
path remain gated on the existing on-hold Anthropic key per `docs/TASKS.md`, unchanged by this pass.)

## Tracker impact

- Closes the implicit follow-up to **"Parity wave C … Impor layout"** (`docs/TASKS.md` line 169-171, done
  2026-10-08) by adjusting that layout per the 2026-10-11 owner request, and fixes the stale FN-15 "Segera hadir"
  row left over from before FN-15 shipped (`docs/TASKS.md` line 305, FN-15 done 2026-10-09).
- No `docs/ACCEPTANCE.md` row names `/impor`'s layout directly; the closest is "Statement PDF (password) →
  balance check → duplicates excluded → import → undo" (`docs/ACCEPTANCE.md:17`, status Not run) — this PRD does
  not change that row's status (no new verification of the capture path itself), but its Browser-level e2e check,
  once run, should also cover the reordered layout and the new institution list on the same screen.
- Add this PRD's entry to `docs/FEATURES.md` under FN-16 (done alongside this file, see below).

## Owner decisions

1. **Unsupported institutions shown disabled vs. hidden.** Default: show every FN-04-listed bank as a row, the
   ones without a parser disabled with a real alternative named, rather than hiding them — this tells the user
   what is coming and what to do today instead of silently omitting a bank they expected to see.
2. **"Pintasan" row.** Montra has no phone-shortcuts integration (no Apple Shortcuts/Tasker action). Default:
   remove the row rather than keep it pointing at Settings › Aplikasi terhubung, which is not "another way to
   bring data into this import." If the owner later wants a real quick-capture shortcut row (e.g. linking to
   voice capture), that is a separate, small follow-up.
3. **"Lainnya" (other bank) row's behaviour when chosen.** Default: selecting it posts no `institution` value
   (same as Deteksi otomatis) — the server's existing auto-detect/`institution_unknown` refusal path
   (`STATEMENT_UNSUPPORTED`, `src/lib/server/imports/messages.ts:58`) already answers honestly; no server change
   needed. Alternative (not built here): a dedicated "we don't recognise this bank yet" message distinct from the
   generic detection failure — a later, small follow-up if the two are found confusing in testing.
4. **Export card's position.** Default: kept as a full card at the end of the left column (Owner decisions above),
   not reduced to a single row under "Cara lain" — the date-range picker it needs does not fit a one-line row.

## Risk tier

**Medium.** Touches one route's template and server `load`, two shared kit files (`picker.ts`, `PickerSheet.svelte`)
used by other pickers app-wide, and the shared brand catalogue — but no migration, no new action, no change to
money, date or space-authorization logic. The main regression risk is the `PickerOption.disabled` addition
affecting an unrelated picker elsewhere (Dompet, Langganan, Kategori); mitigated by keeping the default `disabled`
falsy and adding a regression test on an existing enabled-only picker (Acceptance 14's gates run plus a targeted
Vitest/e2e case).

## Owner decisions — answered 2026-10-11

(1) Unsupported banks are shown as disabled rows with the real alternative named. (2) The phone-shortcuts row is
shown as a disabled "Segera hadir" row (no link, no action) until a real integration exists — the owner chose this
over removing it. (3) and (4) take the proposed defaults.
