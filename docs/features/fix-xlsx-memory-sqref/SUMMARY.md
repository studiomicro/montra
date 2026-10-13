# fix-xlsx-memory-sqref — SUMMARY

Status: **complete** (2026-10-11). FN-17 lows L1 and L5 from `docs/features/fn-17-spreadsheet/SECURITY_REPORT.md`.

- Goal: a real workbook with a long `sqref` imports (L5); each inflated part is held once, not twice (L1).
- Files: `src/lib/server/spreadsheet/xml.ts`, `xlsx-read.ts`, their tests (`xml.test.ts` new, `xlsx-cpu.test.ts`,
  `xlsx-read.test.ts`, `qa-ac-extra.test.ts` new), `test/helpers/xlsx.ts` (`after` option).
- Migrations: none.
- QA: PASS (`QA_REPORT.md`). Red team: PASS, one low and one informational (`SECURITY_REPORT.md`).
- Not changed: `SHEET_READ_LANE_MAX` and the inflate caps (live peak ~57.5 MB is the UTF-8 decode).
