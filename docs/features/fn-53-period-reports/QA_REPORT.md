# FN-53 period reports — QA report (cycle 1)

**Verdict: PASS** (HEAD 2c0f074 on feat/fn-53-period-reports, rebased on main 73694d2). No blocking finding; four low-severity notes below.

## Commands run

All local (local D1 via miniflare, local wrangler dev); no real provider was called, no AI, no remote DB.

- `npm run check` — 0 errors, 0 warnings (2319 files), exit 0, local.
- `npm run lint` — prettier "All matched files use Prettier code style!" + eslint clean, exit 0, local (re-run after adding the two QA files).
- `npm run build` — "done", exit 0, local.
- Touched Vitest, one file at a time, all pass, local D1: report-period.test.ts 17/17; net-worth/period.test.ts 17/17; reports/money-flow.test.ts 14/14; shared/money-flow.test.ts 5/5; integration/alur-uang.test.ts 16/16; migration-0046.test.ts 3/3; patungan-aggregates.test.ts 12/12; period-reports.test.ts 26/26.
- `npm run test` (full, once) — Test Files 367 passed (367), Tests 6056 passed (6056), exit 0, local D1 (before my QA test file was added).
- `npx vitest run test/integration/period-reports-qa.test.ts` (my added file) — 5 passed, local D1.
- `FIN_PERSIST_TO=<scratch> npm run db:migrate:local` on a fresh DB — 0000–0046 all applied (0046 "✅"); second run "No migrations to apply!"; exit 0.
- Upgrade path: DB migrated to 0045 with a temporary wrangler config (migrations dir without 0046), inserted a live snapshot row and a tombstone row, applied 0046 with `wrangler d1 migrations apply`: rows intact, `classes` null, `PRAGMA foreign_key_check` empty. CHECK enforced: `classes='[1]'` rejected, `classes='{"cash":5}'` on a tombstone rejected, on a live row accepted.
- `npx drizzle-kit check` — "Everything's fine".
- `npx playwright test e2e/period-reports.spec.ts --workers=1` (E2E_PORT=5427) — 17 passed (local wrangler dev, mock-free, no provider).
- `npx playwright test e2e/alur-uang e2e/kekayaan e2e/laporan.spec.ts e2e/hidden-amounts.qa.spec.ts --workers=1` — 46 passed, 7 skipped (project-conditional skips), local.
- `npx playwright test e2e/period-reports-qa.spec.ts --workers=1` (my added spec, real snapshot rows written to the local e2e D1) — 4 passed, 1 skipped (desktop dark by design), local.
- Shots from e2e runs restored (`git checkout` of fn-35 and fn-53 shots); my 5 screenshots live in the scratchpad only.

## Checked criteria

Periods and URL
- 1 parse (k > y > p, clamp, junk): PASS, report-period.test.ts "parseReportPeriod (AC 1)".
- 2 quarter dates, leap year no throw: PASS, "periodDates (AC 2, 3)"; my QA test runs the 366-day year 2024 end to end.
- 3 current quarter/year run to today, month whole: PASS (same test).
- 4 previous period same offset, clamp for the 31st, leap alignment: PASS, "previousPeriodDates (AC 4)".
- 5 stepper null at current/2000, href round trip: PASS.
- 6 `?m=` conversion, JS off: PASS, unit "switching kinds" + e2e "without JavaScript" (GET form, "Tampilkan", stepper links).
- 7 Back button twice returns each period; reload keeps it: PASS, e2e "Bulan → Kuartal → Tahun are navigations".

Money flow
- 8 quarter totals = periodTotals = Riwayat range per node/wallet/link: PASS, integration "a quarter: totals equal periodTotals…". My probe: quarter = sum of its three Bulan views (in, out, per month rows), year = quarter data = Laporan stat line.
- 9 Per bulan rows = year totals = Laporan Tahun stats[0]: PASS (integration + Laporan current-year test).
- 10 WIB vectors: PASS. 31 Dec 23:30 vs 1 Jan 00:30 (stored 17:30 UTC asserted), each quarter edge, month and year, in `period-reports.test.ts`; my leap-day probe (29 Feb 23:30 / 1 Mar 00:30, 2024) passes for month, quarter, year.
- 11 fold: PASS. 9 expense categories give 7 + "Lainnya" with exact rest, month shows 9; no fold at 8 categories or 7 wallets (never one node). My 100 categories / 30 wallets probe: at most 8 income, 8 expense, 7 wallet nodes, node sums and link sums equal totals, every link end exists, list 12 + exact rest.
- 12 average floor(total/elapsed), "dibagi 1 bulan" for Q4 now, too-large null: PASS (integration + e2e "Dibagi" + screenshot "Dibagi 1 bulan berjalan").
- 13 comparison words, rupiah, no percent, "Belum ada data …", cut note: PASS (integration; screenshots show "Belum ada data Q3 2026" for a previous period cut at the same offset).
- 14 one currency, other named and counted, comparison same currency: PASS (integration).
- 15 transfers, adjustments, merged pair, deleted, demo excluded: PASS (integration).
- 16 future-dated row only in its month view: PASS.
- 17 empty and error states: PASS (integration "empty quarter", "failing query" fixed copy; e2e empty state of the report page).
- 18 truncated warning generalised: PASS.

Net-worth report
- 19 Q3 snapshots: PASS (opening exact, +Rp 30.000.000, 4 points).
- 20 carry 4 days = `earlier`, 15 days = `since_start` "sejak", none = unavailable: PASS. My boundary probe: exactly 7 days back is used (`earlier`), 8 days back is not (falls to the first snapshot inside, July shown as a gap).
- 21 pre-period-only snapshot never a closing; one snapshot gives no change: PASS (unit).
- 22 partial 30 Sep never closes (28 Sep does), Sep point hollow with note: PASS, unit + browser (one `circle.dot[data-partial]`, "Sebagian harga belum tersedia hari itu").
- 23 gap month: PASS, unit; browser (Jul slot "Belum ada catatan", 3 dots, no line across the gap).
- 24 live closing = Kekayaan hero, KV outage still renders, past period 2 statements and no KV/wallet read: PASS (integration, statement counting).
- 25 groups: PASS. Sorted by absolute change, sum exact, unknown key -> "Lainnya", debt wording. Browser with real rows: Q3 Emas +Rp 30.000.000, Utang bertambah Rp 10.000.000 (red), Dompet +Rp 5.000.000 sum to +Rp 25.000.000; Q4 live: "Utang berkurang Rp 20.000.000" (green) and sum matches -124.900.000.
- 26 `classes` null at either end: note "tersedia mulai {tanggal}", total change still shown: PASS (unit and integration).
- 27 jobs tick stores `classes`; partial later run never overwrites; statement budget test unchanged: PASS.
- 28 31 Dec / 1 Jan snapshots: PASS (unit; QA probe year 2025 closing 31 Dec, Q1 2026 opening 31 Dec exact, 1 Jan 2026 snapshot not in 2025).
- 29 foreign caption only with live foreign holdings: PASS (engineer deviation judged acceptable, see below).
- 30 demo-only space: empty state with badge, no figure: PASS.

Access, privacy, states
- 31 non-member / removed member 404 same as every route, signed out to /masuk, no space id from URL: PASS (integration "removed member").
- 32 two users, two spaces, member of shared space sees owner's figures: PASS.
- 33 hidden amounts: PASS. Both pages mask on first server HTML (integration + e2e). Browser with real snapshots: after pressing the eye, SSR HTML of the Q3 report has no figure, reload shows no polyline and no dots, read-out pill has no figure.
- 34 360/1280 px light/dark, no horizontal scroll, switcher on its own row on phone, inline in the title row on desktop: PASS (e2e `expectNoHorizontalScroll` on every state; screenshots Q3 360 light, Q4 360 dark, Tahun 1280 light, plus engineer's 12 shots reviewed in part).
- 35 keyboard (radio arrows, slider arrows, stepper links): PASS in e2e.
- 36 i18n: PASS (full suite includes the English-entry test; titles read "Quarter 3 · Jul–Sep 2026").
- 37 no path/SQL/id in copy: PASS.
- 38 hidden Kekayaan module still answers: PASS.

Performance
- 39 20,000 rows: 4 statements, aggregates only; past year net-worth report 2 statements: PASS (asserted).
- 40 100 categories / 30 wallets bounds: PASS (my probe, pure fold) plus engineer's page tests.

Owner decisions: 1 (three kinds only), 2 (own route /kekayaan/laporan), 3 (migration 0046, no backfill), 4 (live closing), 5 (7-day carry with date, gaps not bridged), 6 (months so far), 7 (7/6 fold, Kuartal and Tahun only), 8 (comparison on Bulan), 9 (month vs quarter default), 10 (labels `Q3 '26`), 11 (no gating), 13 (Laporan unchanged, Kuartal links to Tahun): all as built.

Migration checklist item: PASS (fresh apply, no-op rerun, upgrade with rows, FK check, drizzle-kit check, 0046 snapshot meta present, RUNBOOK note with Time Travel bookmark and redeploy order for the jobs Worker).

## Engineer deviations judged

- Removed `parseFlowMonth` / `stepFlowMonth`: acceptable; no dangling import (check, build and full test green).
- `?p=` before 2000 falls back to the default month rather than 2000-01: acceptable, harmless, a stricter reading of "unparsable"; stepper floor still works. Note only.
- Foreign-rate caption only for a running period: acceptable and consistent with the PRD (a past period converts nothing; stored IDR figures only).
- Nothing tombstones snapshots: confirmed by grep (only hard purge with the space); CHECK on `classes` still enforced and tested.

## Findings (none blocking)

1. Low: the hero on /kekayaan/laporan shows the change twice (big `HeroAmount` and a green/red `+Rp 25.000.000` line below). Redundant but not wrong.
2. Low: for a negative change the big hero reads `Rp-124.900.000` (prefix then minus), unlike the `−Rp` convention used everywhere else on the page (the line below is correct). Comes from `HeroAmount`'s own rendering; check against DESIGN_SYSTEM if the owner cares.
3. Low: while amounts are hidden the words "Naik/Turun", "Utang berkurang/bertambah", the comparison words and arrows ("lebih banyak", up/down glyph) still show the direction. No amount leaks and the PRD asks only that figures and colour be masked; flag as a product choice.
4. Info: the e2e suite only sees snapshots through a helper, so my added `e2e/period-reports-qa.spec.ts` seeds the local e2e D1 with wrangler; it is fine to keep or delete.

## Files added by QA (uncommitted)

- `<repo>-worktrees/fn-53-period-reports/test/integration/period-reports-qa.test.ts` (5 tests: quarter = sum of months, leap day, 7/8-day carry, past-year snapshot edges, 100 categories / 30 wallets fold).
- `<repo>-worktrees/fn-53-period-reports/e2e/period-reports-qa.spec.ts` (report with real snapshot rows, gap, partial month, groups, hidden eye, Tahun).

No source under `src/`, `workers/` or `migrations/` was edited.

## Cycle 2 (HEAD cd3822f, diff 2c0f074..cd3822f)

**Verdict: PASS.** The three cycle-1 low notes and the red team 2000-floor finding (L1) are fixed; no new finding.

Commands run (all local; no provider, no AI, no remote DB):
- `npm run check` — 0 errors, 0 warnings (2319 files), exit 0.
- `npm run lint` — prettier clean + eslint clean, exit 0 (re-run after my spec edit).
- Touched Vitest one file at a time, all pass: report-period.test.ts 19/19; HeroAmount.test.ts 7/7; shared/money-flow.test.ts 5/5; reports/money-flow.test.ts 14/14; period-reports.test.ts 27/27; period-reports-qa.test.ts 5/5; alur-uang.test.ts 16/16.
- Fail-before proof: `src/` files of the cycle-2 change put back to 2c0f074 (then restored to cd3822f, tree clean): report-period.test.ts "a period at the floor has no previous period" fails; HeroAmount.test.ts "puts the sign before the symbol" fails; period-reports.test.ts "every kind at the floor loads, with no previous period instead of the error state" fails. All pass at cd3822f.
- `npm run test` (full, once) — Test Files 368 passed (368), Tests 6066 passed (6066).
- E2E (shim PATH, E2E_PORT=5427, --workers=1) period-reports, period-reports-qa, alur-uang, kekayaan, hidden-amounts.qa — 63 passed, 8 skipped (project-conditional), local wrangler dev. Shots written by the run restored with `git checkout`.
- `npx playwright test e2e/period-reports-qa.spec.ts --workers=1` after my edit — 5 passed (phone and desktop, light and dark).

Checked:
- 2000 floor: `previousPeriodDates` returns null at the floor, `moneyFlowReport` returns `comparison: null` (no periodTotals call for 1999), the page says "Tidak ada periode sebelumnya"; every kind at the floor loads (integration); stepper stops at 2000 and 2099. All other comparison criteria (AC 13) unchanged and passing.
- Hidden mode shows no direction: comparison reads "•••• dibanding {periode}" with a neutral dot, hero label stays "Perubahan kekayaan bersih", groups show only the masked amount (no Naik/Turun, no "Utang berkurang/bertambah", no sign, no up/down class). Server HTML test (engineer) and my browser test after hydration with seeded snapshots, 360 px light/dark and 1280 px light/dark: main text has no `Naik|Turun|Tetap|Utang …|±Rp|↑↓` and no `.up/.down` classes, trend line and dots absent. Screenshot reviewed (1280 dark hidden): `Rp ●●●●`, masked rows, flat dashed placeholder.
- Hero: single change figure, `−Rp 124.900.000` / `+Rp 25.000.000` with U+2212 via HeroAmount `signed` (default false, so other heroes unchanged; Beranda/Kekayaan/e2e suites pass). Screenshot reviewed (Q4 360 dark): sign leads the symbol, red by sign, duplicate line gone.
- i18n: new strings have English entries (full suite i18n test passes).
- All ACs 1–40 still hold (cycle-1 evidence stands for untouched code; the affected ones — AC 13, 17, 33, 34, 36 — re-run green).
- QA files: `e2e/period-reports-qa.spec.ts` gained the hidden-direction assertions and the 1280 dark run (edit uncommitted).
