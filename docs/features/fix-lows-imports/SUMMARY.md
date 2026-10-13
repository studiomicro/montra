# Fix: open import lows before going public — SUMMARY

Status: **complete** (2026-10-13), two fix cycles.

Owner decision 2026-10-13: fix the open low findings before the repository is published, so the published reports
describe fixed issues. Every import low (FN-16a, 16b, 16c, 16d, 16f, 16g, 16h, 16j, FN-17, FN-48 Parts A and C) is
now FIXED with a regression test that failed first, or ACCEPTED with the rationale its report already gave; each
report carries a "Resolution (2026-10-13)" note.

- Main changes: statement uploads charge body bytes instead of holding a slot and throttle on a sliding window that
  counts only accepted uploads; BCA PDF refuses a forged table header; BCA CSV reads lone quotes, many commas and bare
  `=` remarks; OCBC rows start only in the date column, measured per page width, from PDF and OCR positions; the OCR
  asset check refuses extra files; HEIC size comes from the walked meta box; FN-16j refuses an archived source wallet
  (`source_archived`) and answers a removed member with 404; statement categories come only from the bank's own
  leading words; FN-48C keeps a deleted merge deleted on import undo, pages older links (`?sebelum`) and leaves no
  straddle gap; CI caches `.ocr-cache` on pushes to main only.
- Migration: none.
- QA: PASS (cycle 1 and 2). Red team: PASS cycle 1 with three new lows, PASS cycle 2.
- Not verified: the owner's sample PDF (password-protected), `npm run test:pdf-workerd` (Linux-only workerd
  package), the CI cache step on GitHub.
