# FN-51 More motion on phone PWA and desktop — SUMMARY

Status: **complete** (2026-10-12).

Goal (PRD): make the app feel alive on phone and desktop with subtle, purposeful motion, without an animation
library, layout shift or battery cost.

- Files: `src/lib/ui/motion.ts`, `src/lib/ui/shell/PullToRefresh.svelte`, `src/lib/ui/shell/pull-to-refresh.ts`,
  `src/lib/ui/shell/Sheet.svelte`, `src/lib/ui/shell/TabBar.svelte`, kit (`GroupRow`, `DayHeader`, `HeroAmount`,
  `ProgressBar`, `Skeleton`, `CategoryBar`), charts (`Donut`, `CumulativeChart`, `StackedBars`), net worth
  (`TrendChart`, `AllocationBar`, `CreditCardCard`), PWA banners, `src/routes/+layout.svelte`, Beranda, Riwayat,
  Dompet, Kotak masuk, Impor (`+page.server.ts` returns the batch id on import, undo and move), `/dev/ui`,
  `docs/design/DESIGN_SYSTEM.md`, `docs/design/tokens.css`, `docs/FEATURES.md`.
- Owner decisions: subtle intensity; desktop-only and phone-only extras; Koko welcome-back wave once per WIB day in
  the installed app; pull-to-refresh in the installed app on Beranda and Riwayat; skeleton shimmer; hover lift without
  shadow; Kotak masuk row exit.
- Migration: none.
- Tests: `test/motion-css.test.ts` (keyframes use transform/opacity/stroke-dashoffset only),
  `src/lib/ui/motion.test.ts`, `src/lib/ui/shell/pull-to-refresh.test.ts`, `e2e/motion.spec.ts`.
- QA: PASS, 30 criteria and 7 owner decisions (`QA_REPORT.md`). Red team: PASS with 2 lows (`SECURITY_REPORT.md`),
  logged in `docs/TASKS.md`.
- Not verified: AC 6 (CLS and 60 fps on a real Android phone); a clean single `npm run gates` run (host overloaded,
  failures were untouched integration files that pass alone).
