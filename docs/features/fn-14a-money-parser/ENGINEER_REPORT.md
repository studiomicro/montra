# FN-14a Shared money and date parser — engineer report (cycle 1)

Branch `fn-14a-money-parser`, based on `581e700`. Pure TypeScript in `src/lib/shared`; no migration, route,
i18n string, D1, Worker, `$app`, `cloudflare:*`, svelte or DOM import.

## Files

- `src/lib/shared/money-parse.ts` (new): `parseMoneyAmount`, `findMoneyMentions`, `cleanMoneyText`,
  `IDR_SLANG`, `MONEY_TEXT_MAX`, types `ParsedAmount` / `MoneyMention`. One internal tokenizer (`TOKEN` regex
  plus `readToken`) backs both exports. Reuses `currencyExponent('IDR')` from `money-format.ts` and `cleanText`
  from `text.ts` (strip Cc/Cf/Zl/Zp, cap before `normalize()`). Values computed in BigInt, returned only if
  `<= Number.MAX_SAFE_INTEGER`; no `parseFloat`, `Number()` only on the final safe integer.
- `src/lib/shared/dates.ts` (additive; the file already existed on `main` with `formatDateTimeWib`):
  `wibDateString(epochMs)`, `wibDateParts(date)`, `addWibDays(date, days)`, `parseRelativeIndonesianDate(text,
  todayWib)`. Names follow FN-05/FN-07's planned API (`wibDateString`, `wibDateParts`) so those features extend
  this module. `wibTodayString` is not added (no caller yet; FN-05 adds it).
- Tests: `src/lib/shared/money-parse.test.ts` (new, 124 cases), `src/lib/shared/dates.test.ts` (extended,
  65 cases in total). Every vector is its own `it.each` case.

## Decisions taken beyond the PRD's Owner decisions (A–E accepted as written)

1. **Separator rule (C) edge cases:** a separator used both as grouping and decimal (`1.250.00`), two grouping
   characters (`1.250,000`), a group not of 3 (`1.2500`, `12.50.000`) or a head group over 3 digits
   (`1234.567`) → `null`. `1.250` and `1,250` both → Rp 1.250 (grouping). `2,75 jt` → Rp 2.750.000.
2. **Mentions need a marker.** In free text a number is a mention only with `Rp`/`IDR`, a unit
   (`rb`/`ribu`/`k`/`jt`/`juta`), slang, a number word + unit, a DB/CR suffix, or a valid thousands grouping
   (`25.000`). Bare `2026`, `081234567890`, `14.30`, `1,5` are not mentions. `parseMoneyAmount` (a whole cell)
   still accepts bare digits (`28000`).
3. **Compound or glued numbers are dropped, never read partially.** A token directly preceded or followed (only
   whitespace between) by a number word (`puluh`, `ratus`, `lima`, …) or, for digit-ending tokens without DB/CR,
   by another digit is discarded: `dua puluh lima ribu`, `2 juta 500 ribu`, `Rp 1 250 000` → `null`/`[]`
   (never `lima ribu`, `2 juta`, `Rp 1`). Cost: `kopi 25rb lima` loses its mention; the caller's manual fallback
   applies.
4. **Brackets:** `(25.000)` is an accounting negative only when it is the whole input (`parseMoneyAmount`); in
   free text (`kopi (25rb)`) brackets are punctuation and the amount stays positive.
5. **Contradictory signs → `null`:** sign plus brackets, two signs, or a sign/brackets plus DB/CR. `-0` → `0`.
   `+Rp 25.000` accepted (the formatter's own income output).
6. **Extras accepted:** `Rp.` prefix, `Rp 25.000,-`, glued `50.000CR`, U+2212 minus, NBSP (formatter output
   round-trips), number-word slang multiplier (`dua ceban`). Slang multiplier is 1–99 or a small word; `0 ceban`
   and `100 ceban` → `null`.
7. **Number words (B):** `satu`–`sebelas` and `seratus`, followed by `ribu`/`rb`/`juta`/`jt`. Not `seribu`,
   `sejuta`, `miliar` or multi-word compounds.
8. **Spans** index `cleanMoneyText(input)` (equal to the input when it is already clean; cleaning is idempotent).
   Input is capped to 2000 code points (`MONEY_TEXT_MAX`).
9. **Relative dates:** whole phrase only (`beli kopi kemarin` → `null`); `jum'at` accepted; `[hari] <weekday>
   lalu`; `N hari lalu` bounded to 1–366; a malformed `todayWib` throws `RangeError` (caller bug, never a guess).

## Checklist items applied

- Integers only / one shared parser: BigInt arithmetic, safe-integer guard (vector at exactly
  `MAX_SAFE_INTEGER` and one sen above), no `parseFloat`.
- Untrusted text: `cleanText` strips control/zero-width/bidi characters and caps length before `normalize()`;
  vectors with `​`, `\u0007`, `‮`, `﻿`, and a 1,000,000-character input.
- WIB dates: `wibDateString` vectors at 23:30 WIB on 31 Oct / 31 Dec / 29 Feb 2024 and 00:30 WIB on the next
  1st, plus 00:00:00.000 and 23:59:59.999; `kemarin` across month, year and leap-day boundaries.
- Shared code: no imports beyond `./money-format`, `./text` (asserted by a test) and `./i18n` (type-only, existing).
- Gates and fail-before proof: below. Not applicable: D1, access, AI, sync, web output, UI items.

## Pre-handoff probes

- **Money vectors:** `Rp 1.250.000` → 125000000 · `1.250.000,50` → 125000050 · `Rp 28.000,00` → 2800000 ·
  `IDR 1,250,000.00` → 125000000 · `25rb` → 2500000 · `25k` → 2500000 · `1,5 jt` → 150000000 · `2 ceban` →
  2000000 · `goceng` → 500000 · `gopek` → 50000 · `cepek` → 10000 · `goban` → 5000000 · `-25.000` / `(25.000)`
  → -2500000 · `50.000 DB` → 5000000 debit · `50.000 CR` → 5000000 credit — all pass as separate cases.
- **Month boundaries:** 23:30 WIB last day / 00:30 WIB first day vectors pass (8 `wibDateString` cases).
- Concurrency, two tabs, cross-space, two devices, 360 px, no-JS, user copy: not applicable (no route, no D1,
  no UI, no user-facing string).

## Fail-before proof (mutation runs against the two test files, 189 cases)

| Mutation | Result |
| --- | --- |
| Stub (`parseMoneyAmount` → null, `findMoneyMentions` → []) | 74 failed / 115 passed* |
| Decimal rule `≤ 3` trailing digits | 27 failed |
| Accept any thousands-group length | 3 failed |
| `goceng` = 500 | 6 failed |
| Ambiguity guard removed | 3 failed |
| Marker filter removed from mentions | 8 failed |
| Brackets not negative | 2 failed |
| Safe-integer guard removed | 2 failed |
| No text cleaning | 4 failed |
| WIB offset 0 (UTC date) | 4 failed |
| `<weekday> lalu` may return today | 1 failed |
| `kemarin` = today | 12 failed |

*The stub passes the `null`/`[]` vectors and the untouched date tests by construction; every positive money
vector fails on it, and the `null` vectors are covered by the targeted mutations above.

## Gates

`npm run gates` exit 0: svelte-check clean (`--fail-on-warnings`), both worker `tsc` clean, prettier + eslint
clean, `Test Files 37 passed (37)`, `Tests 470 passed (470)`, both builds `✓ built`.

## Concerns / follow-ups

- `kopi 25rb lima` style sentences lose a mention (decision 3) — deliberate, revisit with real voice data.
- FN-14 must map spans against `cleanMoneyText(transcript)`, not the raw transcript.
- `docs/ACCEPTANCE.md` row moves are for QA to record, not done here.

## Cycle 2 (QA 564ae3e PASS, red team 1d5c343 FAIL; both cherry-picked)

The tests were written first. Before any source change, that run gave `Tests 46 failed | 321 passed (367)`.

- **M1:** the tokenizer now runs without the `i` flag, on text lower-cased for ASCII letters only, so offsets
  do not change. Every dictionary lookup uses `Object.hasOwn` and returns null for an unknown key, and
  `IDR_SLANG` is frozen. A fuzz test covers every code point up to U+1FFFF whose case mapping changes, plus
  3000 seeded random strings. Putting the `i` flag back on its own still passes, because the `hasOwn` guard is
  a second layer.
- **L1:** when the cap cuts the text, the partial trailing word is dropped, and so is any amount that touches
  the cut. `parseMoneyAmount` returns null for input that was cut.
- **L2:** a head group starting with `0` is rejected when the figure is grouped. Bidi controls are stripped by
  `cleanText` (tested).
- **L3:** a sign counts only when it touches the figure or the currency.
- **L4:** `addWibDays` accepts only a safe integer and years 1970–9999.
- **Owner decision B changed (PRD updated):** spoken-number grammar `parseNumberWords`, one linear pass, at
  most 18 words. It needs `ribu`/`juta`; ambiguous mixes of words and digits are still refused.
- **DB/CR before the amount** is accepted. The QA vectors that this cycle changed were updated.
- **Worst-case timing**, one parse plus mention scan, worst of 10 runs:
  - spoken number words: 1.63 ms
  - `'1 '`×1000: 2.57 ms (the overall worst)
- **Cycle 3 (red-team re-check 6429d75):**
  - L1 residual fixed: raw input longer than `(MONEY_TEXT_MAX + 2) * 4` UTF-16 units now counts as truncated,
    so zero-width padding can no longer hide the cut.
  - N1 fixed: in free text, a leading DB/CR counts only when the figure has a currency, a unit or thousands
    grouping, so `Kode DB 123456` is not a mention. A whole amount cell still reads `DB 123456`.
  - Both had failing tests first: `3 failed | 202 passed`.
- **Mutations:** each new mutation fails tests (leading zero 5, spaced dash 2, DB-before 6, scale
  requirement 6, `puluh` ones 5, truncation 2 and 1, date range 3).

## Rebase on main (FN-05/06, 01cc53d)

`src/lib/shared/dates.ts` now keeps FN-05's module as the base. My duplicate `wibDateString`, offset and
day constants are removed, and FN-05's names are used where the helpers overlap.

- `addWibDays` is merged into FN-05's `addDays`. It now has the cycle-2 bounds: a real calendar date, a
  safe-integer `days`, and years 1970–9999, otherwise RangeError. FN-05's callers pass dates in 2000–2099.
- `wibDateParts` reuses FN-05's `DATE`, `utcMidnight` and `dateOfUtcFields`.
- `parseRelativeIndonesianDate` uses `addDays`.
- Earlier report text and the QA/security reports still say `addWibDays`; that is now `addDays`.
