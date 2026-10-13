# FN-16f OCBC parser — Summary

**Status: complete** (2026-10-09).

Goal: read OCBC NISP e-statement PDFs into statement rows checked against the running balance and the single
opening and closing balance, with the account picker when a statement holds several accounts, so an OCBC
statement imports through `/impor` without AI.

Files: `src/lib/shared/statements/ocbc.ts` (+ 26 unit tests), registration in `parsers.ts` (supported list now
BCA, BNI, Mandiri, OCBC), letterhead claim in `detect.ts`, fictional fixture `test/fixtures/statements/ocbc.ts`,
integration tests in `test/integration/impor-statements.test.ts`, e2e journey in `e2e/impor.spec.ts`.

Migrations: none. Real sample (owner's, not committed): 4 pages, 15 rows, 0 rejected, Rp0 gap.

QA: PASS. Red team: PASS with two lows:
- L1: OCBC prints no row numbers or in/out totals and the extracted text has no column positions, so a sender
  who knows the account's exact running balance could plant an equal fake income and expense pair in a transfer
  remark; balances and net worth never change, the batch can be undone. Fix: positioned text from `pdf-text.ts`
  (rows start only from the Trans Date column, amounts only from the Debet/Kredit/Saldo columns).
- L2: remark text can make the user's own statement refuse to import (fail closed), as FN-16d L2.
