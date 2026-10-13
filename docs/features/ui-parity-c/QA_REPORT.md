# QA report — ui-parity-c

**Verdict: FAIL**

One blocking defect: `npm run check` fails with a duplicate-object-key TypeScript error introduced by this
branch's diff, which makes `npm run gates` fail at its first step. Everything else checked (vitest, build,
migration, Playwright journeys, security/money/date logic) is clean; see findings below for the one fix needed
and the re-run scope.

## Commands run

- `flock … npm run check` — exit 1 — `ERROR "src/lib/shared/i18n-en.ts" 1545:2 "An object literal cannot have
  multiple properties with the same name."`, `COMPLETED 1471 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS` — no
  provider, local svelte-check/tsc.
- `flock … npm run lint` — exit 0 — `All matched files use Prettier code style!`, eslint silent/clean — no provider, local prettier+eslint.
- `flock … npx vitest run --maxWorkers=2` — exit 0 — `Test Files 159 passed (159)`, `Tests 2273 passed (2273)` — no provider, local Vitest (D1 in-memory, AI stubbed).
- `flock … npm run build` — exit 0 — `✔ done` (vite + adapter-cloudflare, 18 prerendered files) — no provider, local build.
- `FIN_PERSIST_TO=<fresh dir> flock … npm run db:migrate:local` — exit 0 — all 20 migrations `✅`, including `0020_category_budgets.sql` on top of `0019_privacy.sql` — local D1 (wrangler --local), no remote/provider.
- `LD_LIBRARY_PATH=… E2E_PORT=8831 flock … npx playwright test --workers=1 e2e/anggaran.spec.ts e2e/kekayaan.spec.ts e2e/kekayaan-bersih.spec.ts e2e/fitur.spec.ts e2e/impor.spec.ts e2e/beranda.spec.ts e2e/laporan.spec.ts e2e/shell.spec.ts` — exit 0 — `85 passed (2.9m)`, `4 skipped` (project-only tests) — local Workers (wrangler dev, three bindings), fictional seed data, no provider.

Note: `npm run gates` itself was not run as one command (RAM limit instructs running each step separately under
the heavy lock); its first component (`check`) already fails, so a combined run would fail too.

## Checked criteria (APP_PARITY § 3 / § 3a, FN-07 reversal)

1. **Anggaran page and figures** — PASS. `anggaranFigures`/`budgetProgress`/`safeToSpend`/`pacePercent` in
   `src/lib/server/budgets/math.ts` and `anggaran.ts` use BigInt throughout, read the same `periodTotals`/
   `categoryTotals` aggregates as Beranda, and are proven to reconcile (`test/integration/anggaran.test.ts`
   "the total reconciles with Beranda: same spending, same safe-to-spend"). WIB month-boundary vectors exist
   in `src/lib/server/budgets/math.test.ts` ("23:30 WIB on the last day is still that day", "00:30 WIB on the
   1st is the new month", "31 Jan vs 1 Feb"). Pace marker + amber "Lebih cepat dari jadwal" render through
   `ProgressBar.svelte` (`tone`, `marker` props) with its own unit test.
2. **Per-category budget writes** — PASS. `src/lib/server/budgets/category-repo.ts`: every statement re-checks
   `isLiveMember` and `liveExpenseCategory` inside the same guarded `db.batch`; `setCategoryBudgetAction`/
   `deleteCategoryBudgetAction` (`actions.ts`) route `gone`→404, `missing`→404 with `CATEGORY_NOT_FOUND`,
   `stale`→409. Integration-tested: 20 concurrent first-saves → one `ok` + 19 `stale` (one row); stale
   `updated_at` → 409 "changed meanwhile"; removed member → 404 on load and all four actions; another space's /
   income / unknown / over-long category id → same 404; a tombstoned category's budget stops showing; shared
   category budgets never leak to another space or a personal space. Money is an integer (`amount_minor`),
   `CHECK` constraint in the migration forbids a non-positive live amount and forces a tombstone's amount to 0.
3. **Wallet total in one currency only** — PASS. `balanceTotals` (`src/lib/server/wallets/balance.ts`) sums
   per currency with BigInt and never crosses currencies; `balance.test.ts` covers mixed-currency wallets, a
   too-large balance (null, not rounded) and the favourite's currency leading. Dompet's hero line
   ("{n} dompet · {jumlah} disisihkan untuk tujuan") deliberately avoids inventing a cross-currency "available"
   figure (documented deviation 3, reasonable).
4. **Goals right column** — PASS. `GoalsSection.svelte` shows "%" right, "{tersimpan} dari {target}" compact
   figures, a thin `ProgressBar`, "Diarsipkan"/"Tercapai" state, empty/loading/error states and a sheet-based
   add with `createGoal`. No "Lihat semua" (documented deviation 3: no goals index page exists).
5. **`/kekayaan` is now the net-worth page** — PASS by inspection and `net-worth-routes.test.ts` (updated for
   this branch); `MODULE_NAV.kekayaan = '/kekayaan'` and `nav.ts`'s `SIDEBAR_SECTIONS` still link Langganan,
   Barang, Koleksi; no route in the diff was removed without a replacement link.
6. **Fitur sheet toggles persist FN-12 flags** — PASS. `FiturSheet.svelte` posts the existing
   `/pengaturan/fitur?/setFlag` action per row, shows "Perubahan disimpan." only after `result.type === 'success'`,
   and calls `invalidateAll()` so the sidebar reloads. Confirmed live: `e2e/fitur.spec.ts` "the Fitur sheet
   (Jelajahi fitur) switches a module, the nav follows, and it persists" (passed, phone + desktop).
7. **Impor pickers and the disabled AI button with its reason** — PASS. `PickerSheet` for Dompet/template;
   dashed drop zone with drag-and-drop into the same file input; "Baca dengan AI" is `<Button disabled
   describedby=…>` pointing at a visible reason paragraph. Confirmed live: `e2e/impor.spec.ts` "the Dompet
   picker sheet chooses the wallet for rows without one; AI reading says why it is off" (passed).
8. **Phone path to `/anggaran`** — PASS. Beranda gained a "Lihat anggaran" link (cycle 2 gap fix); confirmed by
   `e2e/anggaran.spec.ts` "Beranda links to Anggaran (the phone path; the sidebar links it on desktop)" (passed,
   phone + desktop projects).
9. **Usage statistics screens** — PASS. `dompet` and `anggaran` added to `STAT_SCREENS` and
   `statScreenForPath` in `src/lib/shared/privacy.ts`, with `privacy.test.ts` coverage; vitest run confirms it
   passes.
10. **Migration applies, fresh DB and on top of 0019** — PASS. `0020_category_budgets.sql` applied cleanly on
    a brand-new persist directory, in order after `0019_privacy.sql`, with the unique `(space_id, category_id)`
    index and the amount `CHECK` constraint present.
11. **i18n English entries** — PASS for coverage (the i18n-coverage test is part of the 2273 passing vitest
    tests, so no Indonesian phrase is missing an English entry), but see Finding 1: one phrase is *duplicated*
    across two object literals, which is a `check`-breaking defect even though both copies agree.
12. **360 px / light + dark AA** — PASS. `e2e/kekayaan.spec.ts` "/dompet fits 360 px in light/dark with 44 px
    targets" (desktop-project duplicates correctly skipped; phone-project instances passed), `e2e/beranda.spec.ts`
    "at 360 px: no horizontal scroll, 44 px bar and picker targets" passed; no new tokens were introduced by
    this diff (`--warn`/`--warn-text`/`--accent` already shipped in wave A, confirmed present in
    `docs/design/tokens.css` for both themes).
13. **No reference brand/copy** — PASS by inspection: labels throughout (Anggaran, Dompet, Fitur sheet, Impor)
    use MONTRA's own Indonesian wording; no other product's names found in the diff.
14. **Wave A kit changes didn't break Beranda/Transaksi/Laporan** — PASS. `e2e/beranda.spec.ts` (8 tests) and
    `e2e/laporan.spec.ts` (3 tests) all green on this branch; `e2e/shell.spec.ts`'s per-page overflow checks for
    Beranda/Transaksi/Laporan/Dompet all green.

## Findings

1. **FAIL — `npm run check` breaks: duplicate object-literal key in `src/lib/shared/i18n-en.ts`.**
   `'{jumlah} tersisa': '{jumlah} left'` is defined twice: once already on `main` (wave B, Laporan, line 712)
   and once added by this branch's diff at line 1545 (Anggaran section, same key, same value). `svelte-check
   --fail-on-warnings` turns this into a hard error (`COMPLETED … 1 ERRORS`), so `npm run check` exits 1 and
   `npm run gates` cannot be clean. The same duplicate also surfaces as an esbuild `[duplicate-object-key]`
   warning when `wrangler dev` bundles the Worker (seen at the top of the Playwright run's web-server log),
   confirming it is live in the diff, not a stale artifact. Scenario: run `npm run check` on this branch at
   HEAD (`1332c81`) → expected exit 0 per the engineer's own cycle-2 gate log ("COMPLETED 1458 FILES 0 ERRORS")
   → actual exit 1, because the rebase onto `main` (which already had wave B's Laporan key) landed this
   branch's own identical key again instead of reusing it. Fix: delete one of the two identical entries (keep
   either; both have the same English text) in `src/lib/shared/i18n-en.ts`.

No other findings. Given finding 1 is a single-line, mechanical duplicate (not a logic, security or money
defect — the duplicated value is identical) with every other acceptance criterion otherwise verified and
passing, a fix cycle should only need to re-run `npm run check` and, for safety, the i18n-coverage vitest test
before resubmitting.
