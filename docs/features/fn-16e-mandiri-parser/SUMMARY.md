# FN-16e Mandiri parser — Summary

**Status: complete** (2026-10-09).

Goal: read Mandiri consolidated e-statement PDFs, which can hold several accounts, into statement rows with
running-balance self-checks; the user picks which account section to import, and only that section imports.

Files: `src/lib/shared/statements/mandiri.ts` (+ tests), registration in `parsers.ts`, letterhead claims in
`detect.ts`, `institution_conflict` / `institution_mismatch` refusals in `src/lib/server/statements/read.ts`, the
account picker on `/impor`, messages and English entries, fixture `test/fixtures/statements/mandiri.ts`,
integration and e2e tests.

Migrations: none.

Refused as a whole file: a block label inside a started row, a table ended by a label while its section does not
check out, a row amount line outside a table, two sections with one account number, and two banks' letterheads
in one file. A hand-picked bank that differs from the one letterhead present is a mismatch.

QA: PASS (`QA_REPORT.md`; real Mandiri sample 29 rows, Rp0 gap). Red team: cycle 1 FAIL (M1), cycle 2 PASS with
L3, fixed in cycle 3. Coverage note: no dedicated no-JS browser test for the multi-account picker (shared
mechanism covered).
