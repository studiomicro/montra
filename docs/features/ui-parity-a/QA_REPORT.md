# QA report — ui-parity-a (wave A: shell, kit, Beranda, Transaksi)

## Verdict: PASS

## Commands run
- `flock /tmp/montra-heavy.lock npm run check` → `COMPLETED 1441 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, exit 0 (real svelte-check/tsc, no mocks).
- `flock /tmp/montra-heavy.lock npm run lint` → `All matched files use Prettier code style!` + eslint clean, exit 0.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2` → `Test Files 153 passed (153)`, `Tests 2199 passed (2199)`, exit 0 (local in-memory D1 fixtures, no real providers; AI stubbed where relevant).
- `flock /tmp/montra-heavy.lock npm run build` → `✔ done` (adapter-cloudflare, site-adapter bundled), exit 0.
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=8821 flock /tmp/montra-heavy.lock npx playwright test e2e/shell.spec.ts e2e/kit.spec.ts e2e/beranda.spec.ts e2e/riwayat.spec.ts --workers=1` → `61 passed, 2 skipped` (phone-only tests correctly skipped on the desktop project), exit 0 (local wrangler dev Workers + local D1, real browser, no real external providers).
- No migrations in the diff, so `db:migrate:local` was not required (confirmed via `git diff main --stat -- migrations/` → empty).
- `npm run gates` and bare `npm test` were deliberately **not** run (RAM limit instruction); the four gate steps above were run individually under the heavy-task lock instead, covering the same checks.

## Checked criteria (APP_PARITY.md §1, §2, §3 Beranda/Transaksi, §3a)

**§3a tokens/design system** — PASS. `tokens.css` has `--accent`, `--heat-1..4`, `--warn`, `--warn-text` light+dark; `test/contrast.test.ts` (in the 2199 passing) gates AA 4.5:1 text pairs and 3:1 graphic pairs in both themes, including `--warn-text` and `--accent` on `--bg`/`--panel`/`--chart-bar`. DESIGN_SYSTEM.md v2 present with changelog.

**§2 kit components** — PASS. HeroAmount, ComparePill, PeriodStepper, PickerSheet, SearchField, IconButton, ToggleRow all present under `src/lib/ui/kit`, exercised on `/dev/ui` (e2e `kit.spec.ts`: light/dark render without overflow/CSP violations, 40 px minimum targets, `AmountInput` integer minor units — all pass).

**§1 shell** — PASS. Sidebar sectioned (Uang/Fitur/Catat), space card, plan card, `+Tambah transaksi` with `N` hint; `N` shortcut verified by `shortcut.test.ts` (unit) and `shell.spec.ts` e2e ("N opens the Tambah sheet outside text fields, never while typing" — pass). Phone tab bar Beranda/Riwayat/Laporan/Dompet/Tambah, equal cells ≥44 px at 360 px (e2e pass). Exactly one `aria-current` verified by `nav.test.ts` (rewritten, in the 2199).

**§3 Beranda** — PASS. Hero, ComparePill, 14-day bars, budget progress line, Struk/Suara buttons, Hari ini / Terbaru / Akan datang all present and screenshot-verified (`shots/beranda-{360,1440}-{light,dark}.png`, viewed). WIB month-boundary vectors (23:30 WIB 31 Oct vs 00:30 WIB 1 Nov, same UTC date, correctly bucketed into different months) covered in `test/integration/beranda.test.ts:292-341`, passing. Cross-space scoping for the new `berandaLists`/Terbaru/Akan datang covered at `beranda.test.ts:781` (owner's personal space sees nothing of the shared space; a stranger naming the shared space by cookie falls back to their own personal space; the actual member sees the shared rows) — passing.

**§3 Transaksi** — PASS. Header counts/totals, search, period chips, type chips with counts, Kategori/Dompet picker chips, day groups, transfer rendering all present and screenshot-verified. Transfer-filter totals (never counted as in/out) covered by `test/integration/transactions.test.ts` and `riwayat-routes.test.ts` (`?pilih=` fallback, transfer chip). Pre-existing access-control suite (`riwayat-routes.test.ts:451-527`) re-verified: a member works on shared-space transactions, a non-member gets the same 404 as a missing id (no existence oracle) on load, update and delete, and **a removed member loses every route and action at once** — all pass, and this is the same code path the new Beranda/Transaksi loaders reuse.

**Money/dates** — PASS. `amount_minor` integers throughout; overflow-past-2^53 handling (exact TEXT+BigInt sums, "too large" shown as null, never thrown or rounded) re-verified in `beranda.test.ts:641-699` and `riwayat-routes.test.ts:620-663`. `−` is literal U+2212 in `money-format.ts` (confirmed in source, not a hyphen).

**i18n** — PASS. `test/i18n-coverage.test.ts` (part of the 2199) fails the suite if any Indonesian phrase passed to `tr`/`trf`/`msg` lacks an English entry; it passed, so the diff's ~40 new/changed `i18n-en.ts` lines are complete.

**360 px / light+dark / AA** — PASS. `shell.spec.ts` ("at 360 px the tab bar holds Beranda, Riwayat, Laporan, Dompet and Tambah in equal cells", "phone shows the tab bar with 44 px targets") and `beranda.spec.ts` ("at 360 px: no horizontal scroll, 44 px bar and picker targets, focus returns to the opener") pass. Dark-theme block equality (`prefers-color-scheme` vs `data-theme='dark'`) asserted by `contrast.test.ts`. Screenshots at 360/1440 × light/dark viewed directly for both pages — layouts match the reference screenshots' structure (sidebar sections, HeroAmount, bar chart, day-grouped transaction list with transfer `A → B` rendering) without copying the reference's name, mascot or copy.

**No fabricated figures / source+review state** — N/A to wave A's scope (no new capture paths); not applicable here since this wave touches only display/shell, not capture pipelines.

## Judged deviations (engineer-reported, each reviewed against spec and reasoning)

1. **Period chip "1 tahun terakhir" instead of "Semua"** — ACCEPTED. Every list scan is bounded to 366 days per the engineering checklist's "Bounded work" rule; labelling a 366-day window "Semua" (All Time) would misstate what the user sees. Truthful labelling over spec-literal wording is the right call and is explicitly flagged, not hidden.
2. **Search placeholder "Cari judul atau catatan" instead of the spec's "...kategori, wallet atau nominal"** — ACCEPTED. The implementation genuinely only searches title/note; claiming broader search would be a fabricated capability. Narrower truthful copy over a wider false claim is correct, and widening search is legitimate follow-up work, not a hidden regression.
3. **Hide-amounts toggle on Beranda only** — ACCEPTED. The spec's wave-A scope (§3) only gives HeroAmount — and therefore the eye toggle — to Beranda; Laporan/Anggaran come in later waves. Server-rendered amounts on other pages are never masked, so there is no page where a user could get stuck unable to reveal amounts, satisfying the CLAUDE.md UI-state rule.
4. **Bulk select ("Pilih") and sort select not built; "Penyesuaian saldo" chip not built** — ACCEPTED with a note. "Pilih" needs a new bulk-delete server action, which is new write-surface area beyond wave A's "restyle + reuse existing loaders" scope per `docs/TASKS.md`'s wave-A description (shell, kit, Beranda, Transaksi display); "Penyesuaian saldo" is explicitly listed in APP_PARITY §4 "Not in this pass". These gaps are visible (no dead buttons were added, the controls are simply absent) and tracked, not silently dropped. Recommend wave B/C PRD explicitly list "Pilih" and sort as follow-up so they aren't forgotten, since APP_PARITY §3 does describe them as part of the Transaksi header.

## Findings
None blocking. One non-blocking note: a source code comment in `src/lib/server/spaces/access.ts` named another product (since reworded) — this is an internal, non-user-facing comment explaining engineering rationale, not shipped brand copy, so it does not violate the "never brand" rule, but engineering may want to reword it to avoid the name appearing in `git blame`/grep of the shipped repo for appearance's sake.

## Engineering checklist spot-checks
- One access rule / no existence oracle: confirmed (404 for both missing and foreign ids, same body).
- Bounded work: confirmed (366-day cap, acknowledged in the period-chip deviation).
- i18n: confirmed via `i18n-coverage.test.ts`.
- Money integers / one currency per sum / WIB buckets: confirmed via existing + wave-A test additions.
- No real providers in tests: confirmed (local D1, no network calls in the vitest run).
No other checklist items are implicated by this diff (no new D1 writes beyond existing patterns, no CSV/export changes, no new capture paths, no sync/account-key changes).

## Not independently re-verified (carried from engineer report, informational only)
- Real devices (iOS Safari, Android Chrome), screen readers, 200% zoom.
- Full e2e suite end-to-end in one run (only shell/kit/beranda/riwayat run here, per task scope and RAM limit); engineer separately reported other specs passing across the cycle.
