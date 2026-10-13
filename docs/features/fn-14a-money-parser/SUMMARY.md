# Shared money and date parser (FN-14a) — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (Owner decision B changed 2026-10-08, auto-accepted: spoken number
words supported).

- **Built:** `src/lib/shared/money-parse.ts` (`parseMoneyAmount`, `findMoneyMentions`, `cleanMoneyText`) and WIB date
  helpers in `src/lib/shared/dates.ts` (`parseRelativeIndonesianDate`, `wibDateParts`, bounded `addDays`). Pure
  TypeScript for device and Worker; integer minor units via BigInt with safe-integer guards; statement and locale
  formats, DB/CR before or after, slang (rb, k, jt, ceban, goceng, gopek, cepek, goban), bounded Indonesian number
  words up to 999.999.999, relative dates up to 366 days; untrusted-text cleaning and length cap before normalise.
- **Tests:** ~220 vectors incl. QA's bank/e-wallet formats; fuzz test never throws; worst-case ≈ 3.6 ms (no ReDoS).
- **QA:** PASS. **Red team:** FAIL (M1 `ſ` throw) → fixed; re-check PASS; residual Lows fixed in cycle 3.
