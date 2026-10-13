# QA report — FN-16i Impor layout adjustment

## Verdict: PASS

## Commands run

- `npm ci --no-audit --no-fund` — clean install, exit 0, no provider.
- `npm run gates` (run 1, serial) — check 0 errors, lint clean, build not reached; test: 1 test file failed
  (`net-worth.test.ts`, one 30s timeout under ambient load), 320/321 files passed, exit 1 — mock/fixture D1 only.
- `npx vitest run test/integration/net-worth.test.ts -t "105 more spaces"` — passed alone (29.7s), confirms the
  above was a timing flake, not a regression — mock/fixture D1.
- `npm run gates` (run 2, concurrent with the e2e run below) — 23 test files failed (ECONNRESET/"poisoned stub"
  to the local D1 proxy, CPU-timing assertions), exit 1; none of the failing files touch this diff — mock/fixture
  D1, discarded as contention noise (see Findings).
- `npm run gates` (run 3, serial, after the e2e run finished; ambient host load average 37–47) — check 0
  errors/warnings, lint clean; test: 3 files failed (`net-worth.test.ts` x2, `recurring.test.ts`,
  `xlsx-cpu.test.ts`), 318/321 passed, exit 1 — mock/fixture D1.
- `npx vitest run test/integration/net-worth.test.ts src/lib/server/spreadsheet/xlsx-cpu.test.ts test/integration/recurring.test.ts`
  — all 70 tests passed alone (35.6s) — confirms run 3's failures were host-load flakes, not a regression; none of
  the three files is touched by this diff.
- `npm run build` (standalone) — `BUILD_EXIT:0`, Worker and service worker built, 18 prerendered files bundled.
- `npx vitest run src/lib/shared/statements/catalogue.test.ts src/lib/ui/kit/PickerSheet.test.ts` — 6/6 passed,
  every run (incl. inside runs 1–3 above) — mock/fixture D1-free, pure unit tests.
- `npx vitest run src/lib/server/statements/validation.test.ts` (incl. 2 QA-added cases) — 4/4 passed — mock
  FormData, no provider.
- `npx playwright test e2e/impor.spec.ts e2e/impor-ocr.spec.ts e2e/impor-spreadsheet.spec.ts e2e/riwayat.spec.ts --project=setup --project=phone --project=desktop` (`E2E_PORT=9011`, `wrangler dev` + miniflare D1, local) —
  55 passed, 4 skipped (desktop OCR camera cases, pre-existing skip), exit 0 — local Worker, no real provider.
- `npx playwright test e2e/_qa-fn16i-themes.spec.ts --project=desktop` (QA scratch, deleted after run, not in the
  diff) — 3/3 passed, screenshots written — local Worker.
- No migration in this diff (`git diff --stat -- migrations` empty); `db:migrate:local` not re-run.

## Findings — environment, not the diff

The host is shared with many other concurrent sessions (load average 37–47 on this run). `npm run gates` run 1
and run 3 each failed 1–3 unrelated, pre-existing test files (`net-worth.test.ts`, `recurring.test.ts`,
`xlsx-cpu.test.ts`) on 30s timeouts or a <1000ms CPU-timing assertion; run 2 (while my own e2e suite ran
concurrently) failed 23 files with `ECONNRESET`/"poisoned stub" errors talking to the local D1 proxy. None of the
failing files is in this diff's file list (`catalogue.ts`, `catalogue.test.ts`, `picker.ts`, `PickerSheet.svelte`,
`PickerSheet.test.ts`, `+page.svelte`, `+page.server.ts`, `OcrImport.svelte`, `SpreadsheetImport.svelte`,
`i18n-en.ts`). Every flaky file passed cleanly when re-run alone (evidence above). Check, lint and build are clean
on every run. Treated as environment noise per the task's own warning ("load is high"), not a gate failure
attributable to this change.

## Checked criteria (PRD `docs/features/fn-16i-impor-layout/PRD.md`)

1. **Desktop ≥1200 px column order** — PASS. `e2e/impor.spec.ts:615` ("Impor layout at 1280 px…") asserts
   `column('left') == ['Impor berkas','Riwayat impor','Ekspor CSV']`,
   `column('right') == ['Cara lain memasukkan data','Pekerjaan membaca terbaru']`. Ran green under **both**
   `--project=phone` and `--project=desktop` (the engineer's flagged gap: the test builds its own 1280×900
   context via `browser.newContext`, so it never inherits a project's device profile — it is the same literal
   check either way; confirmed by running it explicitly under `--project=desktop`, where it passed, test #51).
   CSS verified by read: `.o-main` order 1, `.o-history` 2, `.o-other` 3, `.o-jobs` 4, `.o-export` 5; at
   `main-col`/`side-col` the two columns keep each other's internal order.
2. **360 px stack order, no h-scroll, ≥44 px targets** — PASS. `e2e/impor.spec.ts:520` (light + dark) asserts the
   exact 5-heading order, `expectNoHorizontalScroll`, and ≥44 px on the wallet button and the "Pindai struk" link.
   Also eyeballed at 360 px in `mono` and `gold` (Pro) themes via a QA scratch spec — both render the same order,
   full-width cards, legible disabled-row text, no overflow (screenshots below).
3. **Shared wallet picker, brand badges, survives panel switch** — PASS. Same test: BCA row shows `.b-bca` badge,
   Tunai shows no `.tile`/badge; choosing Tunai from the CSV panel, then switching to "Mutasi bank", shows the
   same `defaultWalletId` already posted by the CSV panel's hidden input, with the `PickerField` label correctly
   switching from "Dompet untuk baris tanpa dompet" (CSV) to "Dompet tujuan" (others).
4. **Honest institution picker: BCA/Mandiri/BNI/OCBC selectable, 12 others disabled with their named
   alternative** — PASS. `catalogue.test.ts` (4 cases) proves `statementCatalogue(STATEMENT_PARSERS)` derives
   selectable strictly from `STATEMENT_PARSERS` (`['bca','mandiri','bni','ocbc']`, can't drift) and gives the
   exact disabled set/order/hints from the PRD (BRI → BRImo+CSV/Spreadsheet, the 4 e-wallets → app screenshot, the
   rest incl. Lainnya → CSV/Spreadsheet/later AI). `impor.spec.ts:520` asserts the same live in the sheet: 5
   enabled rows, 12 disabled rows, BRI/GoPay/Lainnya hints verbatim, BRI's `.b-bri` badge present.
5. **Disabled row: tap/click/keyboard-reach do nothing, `aria-disabled="true"`, never submitted** — PASS.
   `PickerSheet.test.ts` (SSR) asserts `disabled`, `aria-disabled="true"`, `tabindex="-1"`, `aria-checked="false"`
   even when `value` names the disabled row, no `.radio` mark. `impor.spec.ts:520` forces a click on BRI (sheet
   stays open, `aria-checked` stays false) and Tabs from OCBC three times, asserting `aria-disabled` is never on
   the newly focused element (native `disabled` removes the row from the tab order, no custom roving-tabindex
   needed since `PickerSheet.svelte` renders a real `<button disabled>`).
6. **No-JS `<select>` omits (not hides) disabled rows** — PASS. `impor.spec.ts:483` asserts
   `#mutasi select[name="institution"] option` text is exactly `['Deteksi otomatis','BCA','Mandiri','BNI','OCBC']`
   — the 12 disabled rows are absent from the DOM, not CSS-hidden (`selectableInstitutions` filters them out
   before the `{#each}`). Server backstop independently verified (see QA-added test below): `parseStatementFields`
   refuses any institution id the 4-parser list doesn't know, so even a hand-crafted POST of `institution=bri` (or
   any of the other 11 disabled ids) is answered `STATEMENT_FIELDS_INVALID` ("Pilih institusi dari daftar."),
   unchanged by this PRD (`src/lib/server/statements/validation.ts:64-65`, not touched in the diff).
7. **"Cara lain memasukkan data": Pindai struk links to `/riwayat/struk`, Pintasan handling** — PASS as amended by
   the 2026-10-11 owner decision at the end of the PRD, which supersedes the body text's "exactly three rows."
   The card has **4** rows: Impor/ekspor CSV, Pindai struk (now a real link, "Segera hadir" gone), Gmail, and
   Pintasan kept as a disabled "Segera hadir" row (no `href`, no click). `impor.spec.ts:520` asserts
   `listitem` count 4, `link` count 3, the struk link's `href` and ≥44 px height, and that the Pintasan row has
   no link and still reads "Segera hadir".
8. **Empty-space states unchanged, only repositioned** — PASS by inspection: the diff moves the `<section
   class="card o-history">` and `<section class="card o-export">` blocks in the markup/CSS order rules only; their
   internal `{#if loading}/{#if loadError}/{:else}` branches and copy are untouched (confirmed by `git diff`).
9. **`loadError` state still appears, in its new position, rest of page usable** — PASS by inspection (same
   block, unchanged logic, only reordered); not independently re-tested this cycle (no code path change), low
   risk given (8)'s diff confirmation.
10. **Space authorization unchanged on every action** — PASS. `+page.server.ts`'s diff only adds
    `statementCatalogue`/`STATEMENT_CATALOGUE` to `load`'s two return branches (both already inside
    `currentSpaceScope(locals)`); no action signature or body changed. `e2e/impor.spec.ts`'s existing no-JS and
    JS journeys (all passing, see Commands) exercise `preview`, `import`, `previewStatement`, `importStatement`,
    `undo`, spreadsheet and OCR actions unchanged.
11. **i18n coverage** — PASS. `i18n-en.ts` diff adds an English entry for every new/changed Indonesian string
    (subtitle, card copy, wallet-picker label, struk description, Pintasan copy, all three alternative hints) and
    removes the entries for strings this PRD deleted (stale "Impor mutasi"/"Segera hadir"/old wallet-picker
    labels) — a stale orphan entry would itself be harmless, but none was left stale either way. `npm run test`
    (part of `npm run gates`, run 3) includes the i18n coverage check and it passed.
12. **FN-16h OCBC password hint unchanged** — PASS. `impor.spec.ts:520` asserts `#mutasi`'s "Sandi PDF (jika ada)"
    field is still visible after the reorder; diff shows no edit to that block.
13. **Money/date formatting untouched** — PASS by inspection: no diff hunk touches `money-format.ts`, `dates.ts`,
    or any `formatMoney`/`formatDayLabel`/`formatDateTimeWib` call site; only surrounding markup moved.
14. **`npm run gates` clean, e2e green** — PASS modulo the host-load noise documented above (check/lint/build
    clean every run; every test failure traced to an unrelated, pre-existing, host-load-sensitive test and shown
    to pass alone). `e2e/impor*.spec.ts` and `e2e/riwayat.spec.ts`: 55 passed, 4 pre-existing desktop-OCR skips,
    0 failed.

## PickerSheet/picker.ts regression (shared kit files, app-wide)

`grep` for every `PickerSheet` consumer app-wide: `src/routes/(app)/riwayat/+page.svelte`,
`src/routes/(app)/impor/+page.svelte`, `src/routes/(app)/dev/ui/+page.svelte` (demo), plus the two panel
components `PickerField.svelte`/`SpreadsheetImport.svelte`/`OcrImport.svelte` that render it indirectly through
`/impor`. (Dompet/Kategori/Ruang/Tema/Bahasa do not use `PickerSheet` — they use other controls — so they could
not regress through `picker.ts`.) Both real consumers' e2e suites ran green (`riwayat.spec.ts`: category filter
picker, incl. "manage categories" test; `impor.spec.ts`: wallet and institution pickers). `PickerSheet.test.ts`
(new, SSR-rendered) directly proves an enabled-only picker (the Dompet/Kategori shape: no `disabled` key on any
option) is byte-for-byte unaffected — every row clickable, focusable, radio-marked, `role="radiogroup"` present —
matching the risk tier's required regression case.

## ENGINEERING_CHECKLIST

No violation found. UI-only change; no D1/money/date/capture/sync logic touched. `{#each}` lists keyed by
catalogue/option `value` (static ids), never merchant text. Touch targets and i18n checked above.

## Screenshots (360 px, `/private<scratchpad>`)

`impor-360-mono.png`, `impor-360-gold.png` (theme forced client-side via `data-theme`, purely visual — no paid
plan needed for a CSS check): card order, spacing and disabled-row contrast look correct in both; light/dark are
covered by the committed e2e spec's own screenshots (`impor-layout-360-light.png` /
`impor-layout-360-dark.png` in Playwright's own `test-results/`). No defect seen in any of the four themes.

## QA-added test

`src/lib/server/statements/validation.test.ts`: two new cases under
`parseStatementFields: an institution without a parser is refused (FN-16i disabled rows)` — proves every
`STATEMENT_PARSERS` id (and `''`) is accepted and every one of the 12 catalogue-only ids (BRI, Bank Jago, BSI,
CIMB Niaga, Permata, Jenius, SeaBank, GoPay, OVO, DANA, ShopeePay, Lainnya) is refused with
`STATEMENT_FIELDS_INVALID`. Not committed (QA worktree, per instructions), but left in the tree with the rest of
this report's evidence.
