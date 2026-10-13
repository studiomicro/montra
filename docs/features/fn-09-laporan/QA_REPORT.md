# FN-09 Laporan — QA Report (cycle 1)

## Verdict: PASS

Reviewed at commit `9172505` (worktree detached from `c97640f`, FN-07/08 cycle-2 head). No migration in this
diff (confirmed by `git diff --stat`). `npm run gates` is clean; the full e2e suite's four failures on the first
run were reproduced as pure resource-contention flakiness (workerd `disconnected: write()` crashes under full
parallel load) — all four pass cleanly in isolated re-runs, including the Laporan spec itself and the two Beranda
tests that prove the `budgets/math.ts` refactor caused no behaviour change.

## Commands run

- `npm ci` — installed 245 packages, exit 0 (local npm registry, no provider).
- `npx svelte-kit sync` — regenerated `.svelte-kit` types, exit 0.
- `npm run db:reset:local` — applied all migrations to a fresh local D1 (Miniflare sqlite, no remote), exit 0.
- `npm run gates` — check/lint/test/build, exit 0: svelte-check 1093 files/0 errors/0 warnings; prettier+eslint
  clean; Vitest 65 files/975 tests passed; `vite build` done (local toolchain, no provider calls).
- `npx playwright test` (`E2E_PORT=8837`, chromium via `LD_LIBRARY_PATH`, local wrangler/workerd dev server) —
  136 passed, 4 failed, 15 skipped (local, mocked AI/D1, no real provider).
- `npx playwright test e2e/laporan.spec.ts --project=phone --project=desktop` — 9 passed, 0 failed (same env;
  isolated re-run of the one FN-09 spec, confirms the first run's single Laporan failure was flaky).
- `npx playwright test e2e/beranda.spec.ts e2e/kekayaan.spec.ts --project=phone` — 15 passed, 0 failed (same
  env; isolated re-run of the other three failures from the first run, confirms they are pre-existing
  environmental flakiness, not caused by this diff's `budgets/math.ts` refactor).
- `npx vitest run src/lib/shared/i18n.test.ts` — 1 file/12 tests passed (local, confirms the EN-coverage gate).

## Checked criteria (PRD `docs/features/fn-09-laporan/PRD.md`)

1. PASS — defaults `bulan-ini`/`keluar`, WIB current-month range. `test/integration/laporan.test.ts`
   "defaults to this WIB month and money out…".
2. PASS — `bulan-lalu` recomputes every figure server-side via `periodRange`/`laporanReport`; no client
   re-derivation (SSR `load` re-runs on navigation). `laporan.test.ts` "bulan-lalu: equals Riwayat's list".
3. PASS — `tahun-ini` uses `yearToDateRange`/`monthlyTotals`/`BarChart`. `laporan.test.ts` "tahun-ini…";
   e2e `laporan.spec.ts` year-to-date assertion.
4. PASS — chip switches category/merchant source, stat lines unchanged. `laporan.test.ts` "Pemasukan: the
   direction switches the lists, never the stat lines".
5. PASS — stat lines are `periodTotals` output verbatim; integration test cross-checks against Riwayat's own
   load and Beranda's `berandaSummary` for the same fixture rows (exact `9_800_000`/`900_000_000` figures),
   proving Beranda = Riwayat = Laporan.
6. PASS — `--money-up` for `netMinor < 0`, `--money-in` for `>= 0` (`+page.svelte` `class:up`/`class:in`);
   e2e checks the `+` sign and class via visible text.
7. PASS — empty-space test: three stats are honest zeros, lists show `'Belum ada transaksi di periode ini.'`.
8. PASS — `categorySlices` sums to `periodTotals.outMinor`; `floorPercent` is exact BigInt floor, unit-tested
   against `2/3→66`, `(MAX−1)/MAX→99` (never rounds up).
9. PASS — same shape under Masuk, verified in the direction-switch test (Gaji 900_000_000, 100%).
10. PASS — `categorySlices`/`categoryTotals` filter zero-amount categories (`.filter((c) => c.minor !== 0)`).
11. PASS — top-10, descending, `≤ periodTotals.outMinor`; "a 60+ character title…at most 10 merchants" test.
12. PASS — blank/whitespace titles collapse to one `null`-title (`'Tanpa judul'`) row with summed count.
13. PASS — "Kopi Kenangan" vs `"  kopi kenangan \t"` collapse to one row, `count: 2` — exact regression test.
14. PASS — 72-character title grouped by equality, no D1 error; SQL uses `lower()/trim()` equality grouping
    (no `LIKE`/`GLOB`), confirmed by reading `merchantTotals`'s SQL in `aggregate.ts`.
15. PASS — `monthLines` builds `thisMonth`/`lastMonth` from `dailyTotals` over the selected and prior month,
    aligned by day, carrying the prior month's last value when shorter; unit-tested in `laporan.test.ts`.
16. PASS — `yearBars` returns ≤ 12 bars, Jan through the current WIB month, zero-filled for an empty month.
17. PASS — 23:30 WIB 31 Dec / 00:30 WIB 1 Jan split correctly across `tahun-ini`, `bulan-lalu` and
    `monthlyTotals` in the dedicated WIB-boundary integration test.
18. PASS — `+page.server.ts` calls only `currentSpaceScope(locals)` (`requireSpaceAccess` under the hood); no
    space id read from `url.searchParams` anywhere in the route or `laporanReport`.
19. PASS — cross-space probe (non-member via cookie/`?space=`/`?spaceId=`) sees only their own personal-space
    zeros; removed member sees zeros; stale `locals.space` is a 404 — all in
    `describe('one access rule across spaces (pre-handoff cross-space probe)')`.
20. PASS — `{#each}` lists key by `stat.currency`, or by array index over a server-deduplicated,
    already-grouped array (categories/merchants/bars); never by merchant display text.
21. PASS — `i18n.test.ts` (12/12) passed; every new phrase in `i18n-en.ts` has an English entry, including the
    reused `'Pemasukan'`/`'Pengeluaran'` keys and the new `trf()` templates.
22. PASS — every figure goes through `formatMoney`/the `money()` wrapper; every date range through
    `dates.ts` (`yearToDateRange`, `monthRange`, `shiftMonth`); no hand-built `Rp` string found.
23. PASS — `Segmented`/`Chip` are 44 px (`min-height: 44px` in both kit components, grepped directly); AA
    tokens reused (`--money-up`/`--money-in`), no new colours.
24. PASS — load-failure test injects `'D1_ERROR: boom at /src/lib/server/x.ts'` and asserts only the fixed
    `'Laporan tidak bisa dimuat...'` string reaches the page; the path never appears.
25. PASS — no-JS e2e test: `/laporan` returns 200 with real server-computed figures, the GET form's radio +
    `'Tampilkan'` button and the plain-link direction chips both work with JavaScript disabled — the PRD's
    "inert" fallback floor is exceeded.
26. PASS — `npm run gates` clean (0 errors/warnings, 975/975 tests, build ✔); engineer report's fail-before
    log (yearBars `?? 0` mutation, missing `lower()`, missing `trim()`, `Math.round` mutation, base-commit
    import failure) is a credible fail-before set; re-verified gates myself, matching result.

## Findings (non-blocking)

- **PRD/code naming drift (informational, not a defect).** The PRD names functions (`wibMonthRange`,
  `sumExpenseByCategoryMinor`, `sumExpenseByDayMinor`, `sumIncomeByCategoryMinor`, `wibYearToDateRange`,
  `sumByMerchantMinor`, `sumByMonthMinor`) that do not exist; the real FN-07/08 codebase already shipped
  equivalents under different names (`monthRange`, `categoryTotals({type})`, `dailyTotals`, `yearToDateRange`,
  `merchantTotals`, `monthlyTotals`). The engineer reused the real, already-tested functions with equivalent
  contracts rather than inventing a second layer — correct call, but the PRD should be corrected before the
  next feature cites these names.
- **Chip labels ("Pengeluaran"/"Pemasukan" instead of PRD's "Keluar"/"Masuk").** Verified the stated reason:
  `i18n-en.ts:13` already maps `Masuk: 'Sign in'`, so reusing that key for the direction chip would mistranslate
  in English. The URL parameter contract (`arah=keluar|masuk`) is unchanged from the PRD; only the visible
  label differs. Acceptable, matches `'Pemasukan'`/`'Pengeluaran'` already seeded at `i18n-en.ts:77-78`.
- **BarChart touch targets (per the task brief's note).** `src/lib/ui/kit/BarChart.svelte` bars are `width="22"`
  (`W = 22`), below the 44 px target; this is the same pre-existing component slated for widening in FN-07
  cycle 3, reused unchanged per this PRD's own "no new UI kit primitive" rule. **Laporan does not depend on
  BarChart taps for any acceptance criterion**: the year-view bars default `selected = days.length - 1` (the
  current month, already visible in the readout on render), and every number the bars represent is already
  shown elsewhere on the page (stat lines, category list, merchant list) without any tap. This is a reused
  component defect to track under FN-07 cycle 3, not a Laporan-specific gap.
- **First full e2e run's 4 failures were environmental, not regressions.** `beranda.spec.ts:54`,
  `kekayaan.spec.ts:124`, `kekayaan.spec.ts:157` and `laporan.spec.ts:33` failed only in the full 150-test
  parallel run (`workerd` connection-reset/broken-pipe errors visible in the server log around each failure);
  all four pass cleanly when re-run in isolation. Recorded as evidence, not as a Laporan defect.

## Engineering checklist

No violations found against `docs/ENGINEERING_CHECKLIST.md`: bounded SQL aggregates with `LIMIT`/period caps,
no `LIKE`/`GLOB`, no `inArray` growth, one access rule (`currentSpaceScope`/`requireSpaceAccess`), exact
`CAST(SUM() AS TEXT)` → BigInt → `safeMinor` (never `?? 0` on an overflow path — explicitly regression-tested),
money never mixed across currencies, WIB dates throughout, totals reconcile (criterion 5), keyed lists, i18n
coverage, shared `formatMoney`, truthful states (loading/empty/error; no save/success state claimed since the
route is read-only), 44 px `Segmented`/`Chip` targets, user-facing error text has no path/identifier, gates
clean, fail-before proof shown.
