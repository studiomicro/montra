# FN-14a money parser — Security report

Reviewed: `git diff 581e700..a518c6c` (`src/lib/shared/money-parse.ts`, `src/lib/shared/dates.ts`, tests).
Scope: pure shared parser for untrusted text (voice, e-mail bodies, statement rows, CSV cells) on device and Worker.
No routes, D1, R2, auth or AI paths changed, so authorization/session/upload checks do not apply.

## Verdict: FAIL

One medium finding: crafted input makes the parser throw, which breaks PRD acceptance criterion 3 ("never a
thrown exception") and the checklist rule that untrusted input fails safe.

## Findings

### M1 (medium): U+017F "ſ" makes the parser throw a TypeError

- `src/lib/shared/money-parse.ts:70` (`'giu'` flag), `:120` (`SMALL_WORDS[word.toLowerCase()]`) and `:136`
  (`IDR_SLANG[g.slang.toLowerCase()]`).
- With the `i` + `u` flags, the regex uses Unicode simple case folding, so U+017F LATIN SMALL LETTER LONG S matches
  `s`. `"ſeceng".toLowerCase()` stays `"ſeceng"`, the lookup returns `undefined`, and `BigInt(undefined)` throws
  `TypeError: Cannot convert undefined to a BigInt`. NFC does not fold `ſ`, and `cleanText` does not strip it.
- Reproduced: `parseMoneyAmount('ſeceng')`, `parseMoneyAmount('ſatu ribu')`, `findMoneyMentions('bayar ſeceng tadi')`
  and `'ſeratus rb'` all throw.
- Exploit: a sender puts `ſeceng` in an e-mail body or receipt text. Every FN-19 Gmail/inbound job that runs
  `findMoneyMentions` on that body throws. Queue retries then send it to the dead-letter queue, so the real payment
  in that mail is never captured, and a malicious sender can do this to every mail on purpose. On the device, a
  pasted or spoken transcript can crash the voice sheet's handler. Any lookup that returns `undefined` hits the same
  path; U+212A KELVIN SIGN works only because its lowercase is ASCII `k`.
- Fix: look up with `Object.hasOwn(table, key)` and return `null` (no token) when the key is missing. The cleanest
  option also drops the `i` flag and lower-cases the cleaned text before tokenising. That keeps offsets the same,
  because NFC-clean text whose lower-case form changes length can be rejected or mapped first. Either way, add a test
  vector with `ſ` and `K` (U+212A).

### L1 (low): truncation at the 2000-code-point cap can shrink an amount silently

- `src/lib/shared/text.ts:21` with `money-parse.ts:14,226`. When the input is cut in the middle of a figure,
  `findMoneyMentions` still reports the shortened figure. Example: `'x '.repeat(996) + 'Rp 1.250.000'` becomes
  `Rp 1.250`, which gives `125000` minor (Rp 1.250) instead of Rp 1.250.000. `Rp 100.000` cut after `100` gives Rp 100.
- Impact: a wrong draft amount, smaller than the real one. An attacker cannot inflate an amount this way. FN-19 will
  pass e-mail bodies longer than 2000 characters, so this case will happen in real use.
- Fix: when `cleanText` cut the input, drop any token whose `end` equals the cleaned length. Better, have callers
  split bodies into lines or rows before parsing.

### L2 (low): leading-zero groups and bidi-reordered figures are accepted

- `src/lib/shared/money-parse.ts:103-105`. A head group such as `000` passes, so `Rp 000.001` gives Rp 1 and
  `Rp 000.999` gives Rp 999. `cleanText` strips U+202E, so `Rp ‮000.999‬` renders in the mail as
  "999.000" but parses as Rp 999. The reverse also works: the logical text `999.000` renders as "000.999" but parses
  as Rp 999.000.
- Impact: what the mail shows and what is parsed can differ by 1000x. The parsed `raw` text is clean, so the review
  screen shows what will be saved. Low.
- Fix: reject a head group that starts with `0` when there is more than one group (`0,50` stays valid).

### L3 (low): a dash used as punctuation in free text flips the sign

- `src/lib/shared/money-parse.ts:66,160`. `findMoneyMentions('Belanja - Rp 25.000')` gives `-2500000`. Common mail
  layouts such as "Item - Rp 25.000" and "Total - Rp ..." produce negative mentions.
- Impact: the direction is wrong; the magnitude is right. Low.
- Fix: in free text (`whole === false`), accept a sign only if it directly touches the currency or digits (no space
  after it), or ignore the sign and let callers use DB/CR or context.

### L4 (low): `addWibDays` does not validate `days`

- `src/lib/shared/dates.ts:56-58`. `addWibDays('9999-12-31', 1)` returns the malformed `+010000-01`.
  `addWibDays(d, 0.5)` silently floors. NaN or Infinity throws a RangeError from `toISOString`. Inside
  `parseRelativeIndonesianDate` the value is bounded to 1–366 and `todayWib` is validated (years 0001–0099 are
  rejected through the Date.UTC quirk, which is safe), so the only path is a future caller of the exported helper.
- Fix: require `Number.isSafeInteger(days)` and a result year from 1000 to 9999, otherwise throw a RangeError, and
  document this.

### Info

- `IDR_SLANG` (`money-parse.ts:17`) is exported and typed `Readonly`, but it is not frozen. Another module could
  change its values at runtime. Use `Object.freeze`.
- Checked and passed:
  - Prototype pollution: lookups only use keys that the regex captured, and `__proto__`, `constructor rb` and
    `__proto__ lalu` return `null`.
  - Safe-integer bound: the largest value, `Rp 90.071.992.547.409,91`, gives exactly `MAX_SAFE_INTEGER`. One more
    is `null`, and `99999999999999 jt` is `null`. BigInt math is exact (scale ≤ 100), and runs longer than 30
    characters are rejected before `BigInt()`.
  - Locale confusion: `\d` is ASCII-only even with `u`. Fullwidth `１２３` and Arabic-Indic `Rp ١٢٣` return `null`,
    and a mixed ASCII + `\p{N}` run fails the `END` lookahead. NBSP and thin-space grouping (`1 250 000`) is
    rejected as ambiguous. `1.250` and `1,250` both mean 1250 (IDR convention, consistent).
  - Length cap: `cleanText` slices to `max*4` UTF-16 units before `normalize()`, so the checklist rule is met.
    Control, zero-width and bidi characters are stripped.
  - Relative dates: N is limited to 1–366 (`367` and `999` give `null`). `todayWib` is passed in explicitly and
    validated as a real calendar date, and the module never reads the clock.

## ReDoS timing probes

A scratch Vitest file ran each input 5 times through both `findMoneyMentions` and `parseMoneyAmount` (Node, WSL2),
and the file was deleted afterwards. These are the worst times per run:

| Input | Length | Worst |
|---|---|---|
| `'1'` × 1,000,000 | 1,000,000 | 2.12 ms |
| `'1.'` × 500,000 / `'11,'` × 333,333 | 1,000,000 | 0.57 ms |
| `'1.'` × 999 + `x`, `'1.1,'` × 500 + `a` | ~2,000 | 0.58 ms |
| `'1rb '` × 500, `'1jt'` × 700 | ~2,100 | 2.44 ms |
| `'rp '` × 700, `'(- rp - '` × 300, `'1 ('` × 700 | ~2,400 | 1.70 ms |
| `'dua goban '`, `'satu ribu '` × 200 | 2,000 | 0.69 ms |
| `'1 '` × 1000 (ambiguity checks per token) | 2,000 | **3.42 ms** (worst) |
| Arabic-Indic digits × 2000 | 2,001 | 1.74 ms |
| ZWSP × 1,000,000 / spaces × 1,000,000 | 1,000,000 | 0.83 ms |
| `U+202E 1` × 4000, `1 + U+0301` × 4000 | 8,000 | 2.71 ms |
| `(` × 1000 + `1` + `)` × 1000 | 2,001 | 0.14 ms |

The regexes contain no nested ambiguous quantifiers, because every `(?:[.,]\d+)*` repetition needs a separator.
The `START` lookbehind limits where a match can begin, and the cap limits the work before any regex runs.
Catastrophic backtracking was not observed.

## Commands

- `npx vitest run src/lib/shared/money-parse.test.ts src/lib/shared/dates.test.ts src/lib/shared/text.test.ts`:
  3 files, 195 tests passed.
- Scratch probe `src/lib/shared/zz-sec-probe.test.ts`: 2 tests passed (timings and vectors above), then deleted.

## Cycle 2 re-check

Reviewed: `git diff 1d5c343..10c098b`, cycle-2 commit `10c098b` only (QA cherry-pick `fabdef1` excluded).

### Verdict: PASS

No critical, high or medium findings remain. Two low findings are open (L1 bypass, N1) and are tracked below.

### Earlier findings

| Id | Status | Evidence |
|---|---|---|
| M1 `ſ` throws | FIXED | The `i` flag is gone and `asciiLower` keeps offsets the same. Lookups go through `Object.hasOwn` (`money-parse.ts:59-61`). `ſeceng`, `ſatu ribu`, `ſeratus rb`, `ſejuta` and `bayar ſeceng tadi` give `null`/`[]` and no longer throw. U+212A becomes ASCII `K` through NFC, so it behaves like `25K`, which is harmless. |
| L1 truncation shrinks amount | NOT FIXED (bypass, still low) | The code-point cut is fixed: `'x '×996 + 'Rp 1.250.000'` gives `[]`. However, `prepare()` (`money-parse.ts:297-304`) only detects truncation by the cleaned length. `cleanText` first slices the raw input to `(MAX+2)*4` UTF-16 units (`text.ts:13`), and stripped invisible characters do not count toward the cleaned length. So `'​'.repeat(8000) + 'Rp 1.250.000'` gives `parseMoneyAmount` → `{minor:125000}` (Rp 1.250), and `'​'.repeat(7998) + 'Rp 25.000 CR'` loses its `credit` direction. The amount can only shrink or lose its direction, never grow. **Fix:** treat `text.length > (MONEY_TEXT_MAX + 2) * 4` as truncated, or have `cleanText` report the raw cut. |
| L2 leading-zero groups | FIXED | `money-parse.ts:124`: `Rp 000.001` and `Rp 0.500` give `null`, and `Rp 0,50` still gives 50. |
| L3 spaced dash flips sign | FIXED | `Belanja - Rp 25.000` gives +2500000. `-Rp 25.000` and `Rp -25.000` still give negatives. |
| L4 `addWibDays` unchecked | FIXED | Fractional days, MAX_SAFE_INTEGER, a year-10000 result and a pre-1970 result all throw RangeError (`dates.ts:61-69`). Note: `parseRelativeIndonesianDate('kemarin','1970-01-01')` now throws, which matches the documented RangeError contract. |
| Info `IDR_SLANG` mutable | FIXED | `Object.freeze` (`money-parse.ts:17`). |

### New attack surface

The number-word grammar (`parseNumberWords`, `money-parse.ts:144-209`, regex alternative `:82`):

- Magnitude-inflation attempts all give `null`: `seribu juta`, `sejuta sejuta`, `sejuta juta`, `dua juta dua juta`,
  `dua ribu tiga ribu`, `seratus ribu juta`, `sembilan ratus ribu ribu`, `dua puluh dua puluh ribu`,
  `satu ratus ribu`, `lima seribu`, `juta juta`. Mixed digits (`dua 500 ribu`, `dua juta 500`, `2 dua juta`,
  `dua juta2`) also give `null`.
- Words glued inside other words are not read: `sejutawan` and `dua​juta` (joined after stripping) give `null`.
- The largest value the grammar accepts is 999,999,999 rupiah (minor 99999999900), well within the safe-integer
  range.
- Each candidate is one left-to-right pass with an 18-word cap. A flood of grammar words matches as one regex run
  and is rejected in O(n). The only effect is that amounts inside such a flood are not reported.

### New findings

**N1 (low): a leading DB/CR turns any ungrouped number into a mention.**
- Where: `money-parse.ts:83`.
- Repro: `findMoneyMentions('Kode DB 123456')` gives a debit mention of Rp 123.456. A reference, account or
  sequence number after "DB"/"CR" in an e-mail body or statement narrative becomes a candidate amount with a
  direction.
- This is the same class as the existing suffix form (`123456 DB`), so the damage is limited to a wrong draft that
  the user reviews.
- Fix: in free text (`whole === false`), mark a prefix-DB/CR token only when it also carries a currency, a unit or
  thousands grouping. A bare amount cell can keep accepting `DB 50.000`.

### ReDoS timing (cycle 2)

Each input ran 5 times through both exports; the table shows the worst time.

| Input | Length | Worst |
|---|---|---|
| `'1 '` × 1000 | 2,000 | **3.60 ms** (worst) |
| `'1rb '` × 500 | 2,000 | 2.23 ms |
| `'1'` × 1,000,000 | 1,000,000 | 1.73 ms |
| `'dua 1 '` × 330 (word/digit alternation) | 1,980 | 1.41 ms |
| `'db1 '` × 500 | 2,000 | 1.19 ms |
| ZWSP × 1,000,000 + `Rp 1` | 1,000,004 | 1.05 ms |
| `'Rp 1.000 '` × 250 (truncated path) | 2,250 | 0.79 ms |
| 16 × max 18-word amount | 2,048 | 0.41 ms |
| `se*` near-miss prefixes, `satu`/`juta`/`sembilan ratus` floods | ~2,000 | ≤ 0.32 ms |
| `'db cr '` × 330, `'dua1juta'` × 250, `'(-rp-'` × 400 | ~2,000 | ≤ 0.23 ms |

Catastrophic backtracking was not observed.

### Commands (cycle 2)

- `npx vitest run src/lib/shared/`: 9 files, 367 tests passed.
- Scratch probe `src/lib/shared/zz-sec-probe.test.ts`: 2 tests passed (timings and vectors above), then deleted.
