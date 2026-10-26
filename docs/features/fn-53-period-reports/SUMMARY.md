# FN-53 Quarterly and yearly money flow and net worth report — SUMMARY

Status: **complete** (2026-10-13), two cycles.

Goal (PRD): let the user see money flow and net worth over a quarter or a year, computed from stored rows and
snapshots only, without inventing values.

- Alur uang (`/alur-uang`): Bulan | Kuartal | Tahun switcher with link-based stepping (`?p=`, `?k=`, `?y=`, works
  without JavaScript), quarter/year aggregation in four bounded statements, more than 7 categories or 6 wallets folded
  into "Lainnya" on Kuartal and Tahun, a rupiah comparison with the previous period ("Tidak ada periode sebelumnya" at
  the 2000 floor), average per month and a per-month list; hidden amounts now apply on first render.
- Net worth report (`/kekayaan/laporan`): opening and closing from stored daily snapshots (opening carried back at most
  7 days with its date, gaps never bridged, the current period closes on the live total), monthly trend, change by
  asset group where snapshots carry `classes`; the hero shows the change once as `−Rp`/`+Rp`.
- With amounts hidden, no figure, sign, arrow, direction word or colour reveals movement.
- Migration: `0046_net_worth_snapshot_classes.sql` (nullable `classes` JSON with a CHECK). The jobs Worker writes it;
  deploy jobs after the migration.
- Tests: `report-period.test.ts`, `net-worth/period.test.ts`, `period-reports.test.ts`, `period-reports-qa.test.ts`,
  `migration-0046.test.ts`, `e2e/period-reports.spec.ts`, `e2e/period-reports-qa.spec.ts`.
- QA: PASS (cycles 1 and 2). Red team: PASS cycle 1 with L1–L2, PASS cycle 2.
- Not verified: staging (not deployed); older periods show only the total change until snapshots carry `classes`.
