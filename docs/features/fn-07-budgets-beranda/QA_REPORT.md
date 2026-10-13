# FN-07 Budgets + safe-to-spend / FN-08 Beranda — QA report

**Verdict (cycle 3, current): PASS** — see "Cycle 3 re-check" below.

**Verdict (cycle 1, superseded): FAIL** (one acceptance criterion unmet: criterion 28, `BarChart`'s tappable bars
were below the 44 px touch-target minimum; everything else checked below passes). Fixed in cycle 3.

Reviewed at `c97640f` (detached from `main` `bb1336f`), worktree
`<repo>`.

## Commands run

- `npm ci --no-audit --no-fund` — exit 0, local install, no network provider calls.
- `npx svelte-kit sync` — exit 0.
- `npm run db:reset:local` — exit 0; migrations 0000–0006 applied to local D1 (miniflare/workerd, no `--remote`).
- `npm run gates` (check, lint, test, build) — exit 0: svelte-check 1084 files/0 errors; prettier+eslint clean;
  Vitest 62 files / 939 tests passed; build succeeded. (First invocation hit 7 flaky `openLocalD1` hook timeouts
  from resource contention under full parallel load; a bare rerun of `npx vitest run` passed 62/62 files, 939/939
  tests, and a second full `npm run gates` ran clean end to end — recorded as an environment flake, not a defect.)
- `E2E_PORT=8827 LD_LIBRARY_PATH=<scratchpad> npx playwright test` — exit 0:
  132 passed, 15 skipped, 0 failed (local wrangler/workerd dev server, mocked nothing — real D1/local-wrangler
  runtime, no external providers).
- `E2E_PORT=8827 LD_LIBRARY_PATH=... npx playwright test e2e/beranda.spec.ts` — exit 0: 12 passed, 1 skipped
  (the 360 px test skips on the desktop project by design).

## Cycle-2 completion check

- `e2e/beranda.spec.ts` exists (218 lines) with all six journeys the controller asked for: budget-via-sheet
  survives reload; edit then "Hapus anggaran"; chart picker + tap-a-bar; 360 px + focus return; no-JS budget
  form; an expense from `/riwayat/baru` appearing on Beranda. All six pass (see above).
- `dailyTotals`/`categoryTotals` in `src/lib/server/transactions/aggregate.ts` use the same `cast(sum(...) as
  text)` → `foldTotals` (BigInt) path as `periodTotals`, with the "too large to show" (`null`) overflow state
  threaded through `src/lib/server/budgets/math.ts` (never `?? 0`, never rounded) and surfaced on the page as
  "Total terlalu besar untuk ditampilkan" (EN: "Total too large to show").

## Checked criteria (PRD `docs/features/fn-07-budgets-beranda/PRD.md`)

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Set budget via sheet, no reload | PASS | `e2e/beranda.spec.ts:35` (passed); `setBudget` repo guarded insert |
| 2 | Budget survives full reload | PASS | same test, `page.reload()` step passes |
| 3 | Edit = guarded UPDATE keyed on `updated_at` | PASS | `src/lib/server/budgets/repo.ts:72-92`; `test/integration/beranda.test.ts` stale-form tests |
| 4 | Two stale tabs → 409 "Berubah sejak terakhir dimuat" | PASS | `src/lib/server/budgets/messages.ts` `BUDGET_CHANGED`; integration test and ENGINEER_REPORT's live-HTTP probe |
| 5 | Zero/blank/negative/>13 digit amount rejected, no row | PASS | `src/lib/server/budgets/validation.ts` on `amountDigits`/`digitsToMinor`; `validation.test.ts`; e2e no-JS test asserts `0` → field error |
| 6 | "Hapus anggaran" tombstones, reversible | PASS | `repo.ts` `deleteBudget` (amount cleared, CHECK constraint); `e2e/beranda.spec.ts:54` |
| 7 | 20 concurrent creates → exactly one row | PASS | partial unique index `budgets_one_live_per_space_uq`; ENGINEER_REPORT concurrency probe (1 ok, 19×409) |
| 8 | No-JS form works as plain POST | PASS | `e2e/beranda.spec.ts:157` passed |
| 9 | Safe-to-spend = floor((B−S)/R), R inclusive of today | PASS | `src/lib/server/budgets/math.ts` `safeToSpend`/`daysRemainingInclusive`; WIB-boundary integration test |
| 10 | B−S ≤ 0 shows over-budget line, no negative per-day | PASS | `math.ts` `kind: 'over'`/`'spent'`; page renders `--money-up` |
| 11 | WIB 23:30 boundary: R=1, next-month row excluded | PASS | `test/integration/beranda.test.ts` "at 23:30 WIB on the 31st..." test |
| 12 | No budget → no "Sisa" line, hero/pill still render | PASS | `+page.svelte` conditional; `summaryOf` test with no budget |
| 13 | Hero = "Pengeluaran {bulan}" + month total via `moneyParts`/`formatMoney` | PASS | `+page.svelte`; no hand-built `Rp` strings found (`grep parseFloat` empty in app code) |
| 14 | Comparison pill diff via existing `ComparisonPill`/`comparisonKind`, no second threshold | PASS | `berandaFigures` passes raw `diffMinor`; no new threshold constant added |
| 15 | avg/day = floor(S/N) | PASS | `math.ts:197` `Math.floor(toDate / n)` |
| 16 | "Hari ke-N" uses WIB day-of-month | PASS | `dayOfMonth` from `wibTodayString`; boundary test covers 23:30/00:30 |
| 17 | Today section reconciles with Riwayat's totals/rows | PASS | `test/integration/beranda.test.ts` "Beranda totals equal Riwayat totals..." — month total, day total, row ids, and `DayHeader` sum all asserted equal |
| 18 | Zero transactions today → muted empty line | PASS | `+page.svelte:331` "Belum ada transaksi hari ini." |
| 19 | Chart picker switches without new request; tap-a-bar | PASS | `e2e/beranda.spec.ts:77`, asserts no `__data.json`/`/` request while switching |
| 20 | Loading skeleton, `ErrorState` with retry on load failure | PASS | `+page.svelte` skeleton + `ErrorState` branches (not exercised by an automated route test per ENGINEER_REPORT's own "Not verified" list — accepted as a known gap, not a criterion failure since the states exist and are wired) |
| 21 | Suara/Struk pills and "Segera hadir" kept verbatim | PASS | unchanged markup retained in rewrite |
| 22 | Space resolved via `locals.space.id` only | PASS | `+page.server.ts` → `currentSpaceScope` → `requireSpaceAccess`; no param/form space id |
| 23 | No budget id accepted from client | PASS | `repo.ts` functions take only `scope`/`spaceId`; forms carry only `updatedAt`, `amount`, `currency` |
| 24 | Form body size cap, 400/415 never 500 | PASS | `readFormBody` (FN-01 shared guard) reused in `guarded()` |
| 25 | `{#each}` keyed by id/category | PASS | `+page.svelte`, `BarChart`/`CategoryBar` all key by index/category id, not text |
| 26 | Every new Indonesian phrase has an English entry | PASS | `i18n-en.ts` diff adds ~30 entries incl. "Harian"/"Per kategori"/"Vs bulan lalu"/budget copy; `i18n.test.ts` passed in gates |
| 27 | Currency via shared formatter, no `parseFloat`/float math on minor units | PASS | grep confirms no `parseFloat`; `math.ts` uses BigInt throughout |
| 28 | Focus returns to opener; touch targets ≥44 px incl. `BarChart` bars; AA contrast | **FAIL** | Focus-return and `Segmented`/opener 44 px confirmed by `e2e/beranda.spec.ts:131` (360 px test, passed). **`BarChart`'s bars remain 22 px wide with a `minVisible = 2` px height floor** (`src/lib/ui/kit/chart-scale.ts` `barHeights`), well under the 44×44 px minimum the checklist and this criterion require on a coarse pointer. The engineer's own report flags this unresolved ("Meeting it needs a kit redesign... This is not done."). Not fixed in this diff. |
| 29 | No file path/stack/row id in user-facing errors | PASS | `BERANDA_LOAD_FAILED`/`BUDGET_CHANGED`/`BUDGET_GONE` messages are plain copy; `console.error` (server log only) carries the raw error, never returned to the client |
| 30 | `npm run gates` clean before hand-off; fail-before proof shown | PASS | gates clean (see Commands run); ENGINEER_REPORT's fail-before table (8 mutations, each reverted) |

Cross-cutting pre-handoff probes independently re-verified via `test/integration/beranda.test.ts`:
- Cross-space: a non-member reaches only their own personal space; a removed member loses the shared budget
  immediately; repo calls from a non-member scope return `'stale'` and write nothing (`describe('one access rule
  across spaces...')`).
- Totals equality: Beranda's month/day totals and row ids match Riwayat's for the same filters; transfers,
  income, USD and demo rows are excluded from every figure (`describe('Beranda totals equal Riwayat totals...')`).
- WIB boundaries: 23:30 WIB on 31 Oct gives day 31/R=1 and excludes the 00:30 WIB 1 Nov row (same UTC date);
  31st-vs-30-day-month and March-vs-February day-count capping both verified.
- Overflow: 1000×10^13-minor rows on one day, and 600×10^13 on two days, drive `spentMinor`/bars/categories/lines
  to `null` without throwing, and the page shows "Total terlalu besar untuk ditampilkan" instead of a figure.
- `budgets` is in `SPACE_SCOPED_TABLES` (`src/lib/server/spaces/spaces.ts:242`), confirmed by the space-deletion
  test purging it along with other space-scoped rows.

## Engineering checklist

Checked against `docs/ENGINEERING_CHECKLIST.md`:
- Data access: guarded `UPDATE…RETURNING`/`INSERT…WHERE NOT EXISTS` inside `db.batch`, no interactive transaction,
  bounded queries on `(space_id, occurred_on)` — compliant.
- Money and dates: integers/BigInt throughout, one currency per sum (other currencies listed, never summed),
  WIB dates tested at both boundaries, totals reconcile with Riwayat — compliant.
- Access and privacy: one access rule (`currentSpaceScope`/`requireSpaceAccess`), writes repeat `isLiveMember` —
  compliant.
- Web and output: `readFormBody` size guard reused, `{#each}` keyed, no inline styles in any SVG chart component
  (`grep style=` empty in `BarChart.svelte`, `CategoryBar.svelte`, `MonthLines.svelte`, `+page.svelte`) —
  compliant.
- UI quality / Accessibility: **violated** — "touch targets ≥ 44 px on coarse pointers" is not met by
  `BarChart`'s tappable rects (see criterion 28 above). This is the one checklist/criterion failure found.

## Findings

1. **Criterion 28 / checklist "Accessibility — touch targets ≥44 px" — FAIL.**
   - Scenario: on a phone (coarse pointer), open Beranda's "Harian" chart view and try to tap any bar whose
     value is small relative to the month's peak day.
   - Expected: every tappable bar has a touch target ≥44×44 px (PRD criterion 28 explicitly names "`BarChart`'s
     tappable bars"; `docs/ENGINEERING_CHECKLIST.md` › UI quality › Accessibility).
   - Actual: `src/lib/ui/kit/BarChart.svelte` renders each bar as an SVG `<rect>` of fixed `width={22}` and a
     height computed by `barHeights()` (`src/lib/ui/kit/chart-scale.ts`), which floors at `minVisible = 2` px for
     any non-zero value and can be far below 44 px for anything but the tallest bar(s) in the 14-day window. The
     clickable area is exactly the rect's bounding box (no padding/transparent hit-slop added), so most bars are
     reliably smaller than 44×44 px on a touchscreen.
   - `BarChart` is an existing FN-00 kit component reused unchanged by this feature (per the PRD's "UI kit reuse"
     note) rather than a new primitive this feature built, but the PRD still names it explicitly inside this
     feature's own criterion 28, and the engineer's own report lists it, unresolved, under "Not verified /
     concerns" ("Meeting it needs a kit redesign... This is not done."). Per the QA brief, an unmet acceptance
     criterion is reported as a FAIL regardless of which layer the fix belongs in; fixing it is a `src/lib/ui/kit`
     change outside what this QA pass may edit.

No other findings. All other criteria, the cross-cutting probes, and `npm run gates`/the full e2e suite are clean.

## Not independently re-verified (relied on engineer's report, lower risk)

- WCAG AA contrast of `--money-up` and other tokens was not measured with a contrast tool in this pass (the
  engineer's report also notes this); the page reuses only existing FN-00 tokens, so this is a low-risk gap, not
  scored as a separate failure.
- The `ErrorState`-on-load-failure path has no automated route-level test (no harness for `$app/*`-dependent
  page components exists yet, per ENGINEER_REPORT); the branch exists and is wired correctly by inspection of
  `+page.server.ts`'s try/catch and `+page.svelte`'s `data.loadError` branch.

## Cycle 3 re-check

**Verdict: PASS.** Reviewed `dd26de0` (detached from `main` `36eb361`), worktree
`<repo>`. The cycle-3 commit was reviewed directly
(engineer report was not delivered via hand-off; its content inside `docs/features/fn-07-budgets-beranda/ENGINEER_REPORT.md`
was read as part of the commit diff). All four scoped items pass; `npm run gates` and the full e2e suite are clean.

### Commands run

- `npm ci` — exit 0, local install, no network provider calls beyond the npm registry cache.
- `npx svelte-kit sync` — exit 0.
- `npm run db:reset:local` — exit 0; migrations 0000–0008 applied (all ✅) to local D1 (wrangler/workerd, no `--remote`), seed ran with no error.
- `npm run gates` — exit 0: svelte-check 1121 files/0 errors/0 warnings; prettier+eslint clean; Vitest 72 files/1038 tests passed; build ✔ done.
- `npx vitest run src/lib/ui/kit/BarChart.test.ts test/integration/beranda.test.ts src/lib/server/budgets/validation.test.ts` — exit 0, 3 files/44 tests passed (targeted re-run of this cycle's new/changed tests).
- `E2E_PORT=8836 LD_LIBRARY_PATH=<scratchpad> npm run test:e2e` — exit 0: 146 passed, 15 skipped, 0 failed (local wrangler/workerd dev server, real D1, no external providers; `beranda.spec.ts`'s phone-project 360 px test passed).
- Ad-hoc `npx wrangler dev --port 8816` (migrated local D1, started and stopped manually, no `--remote`) + `curl` against it for the L3 live probe (below) — stopped and its `.wrangler/manual-qa-8816` state removed after.

### Checked items

1. **Criterion 28 (BarChart touch targets) — PASS.**
   `src/lib/ui/kit/BarChart.svelte:17-73`: `COL = 44` is both the width and (via `height={H}`, `H = 120`) far more
   than the height of each day's hit `<rect class="hit" role="button">` (line 61-73); the visible 22 px `.bar`
   rect is drawn centered inside it with `aria-hidden="true"` and `pointer-events: none` (line 51-60, 100). The
   scroller (`.scroll`, line 94-97) scrolls horizontally inside itself (`overflow-x: auto`); an `$effect`
   (line 39-41) sets `scrollLeft = scrollWidth` so today (the last/rightmost day) is in view by default.
   `.hit:focus-visible` draws a 2 px outline (line 109-112). `select()` (line 31-35) handles both `Enter` and
   `' '` with `event.preventDefault()` before setting `selected`. `aria-pressed` is set per-rect
   (`i === selected ? 'true' : 'false'`, line 69). No `style=` attribute anywhere (confirmed by
   `src/lib/ui/kit/BarChart.test.ts`'s `expect(body).not.toMatch(/\sstyle=/)`, passing) — every visual property is
   an SVG attribute (`x`, `y`, `width`, `height`, `rx`) or a CSS class, never inline. The new
   `BarChart.test.ts` (4 tests) asserts ≥44×44 px hit columns including a zero-value day, the bar nested inside
   and narrower, `aria-pressed` only on the selected day, and currency formatting in `aria-label`; all 4 pass.
   `e2e/beranda.spec.ts:94-111` (the 360 px phone journey) measures all 14 bounding boxes live in a real browser
   (`box.width/height >= 44`), asserts the last bar is in viewport and pressed, focuses bar 12, presses Space, and
   re-checks `aria-pressed` and no horizontal page scroll — this passed (`e2e/beranda.spec.ts:131` phone project,
   confirmed in the e2e run above).

2. **Red-team Lows — PASS.**
   - **L1 (churn):** `src/lib/server/budgets/repo.ts:79-120`. A create (`expectedUpdatedAt === null`) first tries
     to revive the space's tombstone in place (`UPDATE … WHERE deleted_at IS NOT NULL AND space_id = … AND
     isLiveMember`, line 91-107) and only inserts a fresh row when `NOT EXISTS (select 1 from budgets b where
     b.space_id = …)` (line 108-117, no `deleted_at is null` filter — any row, live or dead, blocks the insert).
     Backed by `budgets_one_per_space_uq` on `space_id` with no `WHERE` clause (`migrations/0008_budgets.sql:14`,
     `src/lib/server/db/schema.ts:470-472`), so the table can hold at most one row per space ever. Test
     `test/integration/beranda.test.ts` "L1: set → delete churn keeps one row per space" (5× set/delete cycles,
     then one more set) passed, asserting `allBudgets(spaceId) === 1` throughout and that the revived row's
     `updated_at`/`seq` strictly increase.
   - **L2 (amount cap):** `src/lib/server/budgets/validation.ts` imports `wholeAmountMinor` from
     `src/lib/server/forms.ts:93` (the shared whole-amount parser) and caps with `MAX_AMOUNT_MINOR` from
     `src/lib/server/transactions/validation.ts:40`, confirmed `10_000_000_000_000` (10^13). `100.000.000.000` is
     accepted, `100.000.000.001` and `9999999999999` are refused with the new `BUDGET_TOO_LARGE` message
     ("Anggaran terlalu besar." / EN "That budget is too large." in `src/lib/shared/i18n-en.ts`).
     `validation.test.ts` covers both sides; passed.
   - **L3 (currency):** `isBudgetCurrency` (`repo.ts:42-56`) is one SQL check: the posted currency must be a live
     wallet's, or IDR when the space has no live wallet, or the live budget's own currency (so editing the amount
     stays possible after the wallet it was based on is archived). The action
     (`src/routes/(app)/+page.server.ts:52-56`) calls it server-side and never trusts the hidden form field.
     **Live probe:** started `npx wrangler dev` on port 8816 against a freshly migrated local D1, signed up a new
     user over HTTP (`POST /daftar`, got a session cookie), then `POST /?/setBudget` with
     `amount=100&currency=JPY` on that user's personal space (no wallets ⇒ IDR-only): got **HTTP 400** with
     `{"error":"Pilih mata uang dari daftar."}` (`BUDGET_CURRENCY_INVALID`), and a follow-up `IDR` post on the same
     session succeeded with **HTTP 200**, confirming the rejection was currency-specific and not a broken
     endpoint. Server stopped and `.wrangler/manual-qa-8816` removed afterward.
   - **L4 (removed member → 404):** the generic gate `currentSpaceScope` → `requireSpaceAccess`
     (`src/lib/server/spaces/current.ts:13`, `src/lib/server/spaces/access.ts:69`) already throws
     `error(404, 'Not found')` for a non-member or removed member before any budget code runs — this is the
     app-wide "one access rule" (e2e `ruang.spec.ts` "owner removes a member; the member's old URL is a plain
     404" passed in this run). Inside `setBudget`/`deleteBudget`, the new `whyNot()` helper
     (`repo.ts:58-64`) covers the narrower TOCTOU race (membership revoked between the gate check and the guarded
     write within the same request): when the guarded write matches 0 rows and the caller is no longer a live
     member, it returns `'gone'`, and `refused()` (`+page.server.ts:38-41`) answers it with the identical
     `error(404, 'Not found')` — the same answer as everywhere else, never the removed `BUDGET_GONE` fail(404,...)
     body. `BUDGET_GONE` was deleted from `messages.ts` with no remaining reference (confirmed by `gates`'
     clean typecheck). Repo-level probes (`test/integration/beranda.test.ts`, "a non-member naming the space…"
     and "a removed member loses the shared budget at once") assert `setBudget`/`deleteBudget` return `'gone'`
     for exactly this race; both pass.

3. **Migration renumbering — PASS.** `migrations/0008_budgets.sql` is unchanged in shape (only the index name/
   definition changed, see L1 above); `migrations/meta/0008_snapshot.json`'s `prevId`
   (`467fdf61-c3c2-4870-a938-d0a3aa378854`) equals `main`@`36eb361`'s `0007_snapshot.json` `id` exactly (verified
   by diffing the two), and `migrations/meta/_journal.json` has `idx: 8` for `0008_budgets`. `npm run
   db:reset:local` applied all nine migrations 0000–0008 (each showed ✅) and seeded with no error; `select name
   from sqlite_master` after reset lists `budgets` alongside every other expected table, and the live index on
   `budgets` is `budgets_one_per_space_uq` (no `WHERE` clause), matching the schema.

4. **vitest `hookTimeout` — PASS.** `vitest.config.ts` adds `hookTimeout: 60_000` next to the existing
   `testTimeout: 30_000`, with a one-line comment attributing it to `openLocalD1`'s `beforeAll` (workerd start +
   all nine migrations) occasionally exceeding the 10 s default under parallel load, observed by QA in cycle 2.
   A 6× increase on one lifecycle hook (not the per-test timeout) is a modest, narrowly-scoped change with a
   stated cause; accepted.

### Overall

**PASS.** All four scoped items hold under direct code inspection, the full test suite, and a live HTTP probe for
L3. `npm run gates` is clean (svelte-check 1121/0/0, prettier+eslint clean, Vitest 72 files/1038 tests, build ✔)
and the full e2e suite passed 146/146 (15 skipped, 0 failed) at `E2E_PORT=8836`. No findings.
