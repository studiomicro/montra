# FN-16d BNI parser — Summary

**Status: complete** (2026-10-09).

Goal: read BNI e-statement PDFs into statement rows with running-balance self-checks, the same contract as the
BCA parser (FN-16b), so a BNI statement imports through `/impor` without AI.

Files: `src/lib/shared/statements/bni.ts` (+ tests), registration in `parsers.ts`, fixture
`test/fixtures/statements/bni.ts`, integration test `test/integration/impor-statements.test.ts`, e2e in
`e2e/impor.spec.ts`, and `scripts/compat-statements.ts` (the `.pdf-password` lookup now refuses symlinks and
paths resolving outside the sample's folder, red team L1).

Migrations: none.

QA: PASS (`QA_REPORT.md`). Red team: PASS with two lows; L1 fixed in cycle 3, L2 (third-party remark text can
make a user's own statement refuse to import, fail-closed) accepted and tracked.
