# FN-16h OCBC Rekening Koran — SUMMARY

Status: **complete** (2026-10-11). Goal: import OCBC NISP single-account "Rekening Koran" e-statements (e.g.
Tanda360Plus Digital), which were refused (`institution_unknown`, or inconsistent when OCBC was picked).

- Built: `src/lib/shared/statements/ocbc-rekening-koran.ts` (detection, per-currency sections, slash dates, wrapped
  descriptions, Berita and continuation lines kept, closing balance from the last-page summary, refuse-whole
  self-checks) behind the one `ocbc` parser id; shared helpers moved to `ocbc-text.ts`. IDR importable, foreign
  sub-accounts listed only. No migration, route or i18n change.
- Real sample: the owner's encrypted April 2026 PDF through `npm run compat:statements`: `ocbc`, 21 rows parsed, 0
  rejected, balance check `pass (Rp0 gap)`; the SGD section listed, not imported.
- QA: PASS. Red team: PASS with L1 (a sender's note can plant a balanced fake pair if they know the balance to the
  cent; same known limit as FN-16f L1) and L2 (a sender's note can make the statement refuse, fail-closed).
