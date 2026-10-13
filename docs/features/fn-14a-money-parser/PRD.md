# FN-14a Shared money and date parser (`src/lib/shared`) — PRD

Catalog anchor: no dedicated FN id exists in `docs/FEATURES.md` for this module; it is the parser half of FN-14's
own mirror entry (`docs/FEATURES.md:128-132`, "amounts `25rb`... slang cepek 100, gopek 500...") plus the
statement-format vectors FN-16/18/19 will need, minted here as **FN-14a** per the tracker line it closes:
`docs/TASKS.md` › Phase 2 › "Shared money and date parser (`src/lib/shared`) with the voice slang, statement and
CSV vectors (prerequisite for FN-14, FN-16 – FN-19)" (`docs/TASKS.md:65-66`). Phase: 2 — Capture. Risk tier:
**Large** (money-calculation logic per `/build-feature`'s own risk table — no migration, no auth, but every later
capture feature's figures are only as correct as this module, and "money is never invented" gives it the same
scrutiny as a schema change).

Owner decisions already fixed before this pass: server-first in D1, signed-in only for anything that *saves* a
parsed amount (FN-14/18/19) — this module itself has no session, no space, no D1 dependency at all; it is pure
`src/lib/shared` code importable unchanged by the browser bundle and the app/jobs Workers, per `CLAUDE.md` ›
Data and runtime conventions ("shared domain code... so the client and Worker run the same logic") and the
checklist's own "Shared code" item (`docs/ENGINEERING_CHECKLIST.md:56`). No migration, no routes, no i18n
strings, no UI states — see Out of scope.

## Goal

Every capture path after this one — voice (FN-14), statement import (FN-16), CSV (FN-18), Gmail (FN-19) — turns
human-written or human-spoken amounts and dates into the one thing FN-05 is allowed to store: an integer
`amount_minor` and a WIB `occurred_on` date string. `src/lib/shared/amount-input.ts` already says explicitly it is
"not a general money parser (Phase 2 owns that)" (`src/lib/shared/amount-input.ts:5`). Without this module, every
later Phase 2 feature would either reinvent its own regular expressions for "25rb"/"Rp 1.250.000"/"goceng" (risking
five subtly different bugs instead of one well-tested one) or fall back to `parseFloat` on money, which
`CLAUDE.md` forbids outright. FN-14a is that one parser: deterministic, dependency-free, exhaustively vector-
tested against every format `docs/ENGINEERING_CHECKLIST.md`'s "Money vectors" probe and `docs/FEATURES.md`'s FN-14
mirror name, plus the small set of relative Indonesian date phrases voice capture needs to resolve to a WIB
calendar date.

## Scope

- **`src/lib/shared/money-parse.ts`** (new, pure, no D1/Workers/DOM dependency):
  - `parseMoneyAmount(text: string): ParsedAmount | null` — parses **one** amount expression occupying the whole
    (trimmed) input string. Handles: digit grouping with `.` and locale decimal `,` (`Rp 1.250.000`,
    `1.250.000,50`, `Rp 28.000,00`); US-style grouping with `,`/`.` (`IDR 1,250,000.00`); bare digits (`28000`);
    `Rp`/`IDR` prefix, with or without a space, case-insensitive; voice slang multipliers and units (`25rb`,
    `25 ribu`, `25k`, `1,5 jt`, `1,5 juta`, and the seven fixed slang words `cepek` 100, `gopek` 500, `seceng`
    1.000, `noceng` 2.000, `goceng` 5.000, `ceban` 10.000, `goban` 50.000, each optionally preceded by a small
    integer multiplier, e.g. `2 ceban` = 20.000); the bounded Indonesian number-word case `seratus ribu` = 100.000
    (see Owner decision B for the exact bound); `DB`/`CR` suffixes (`50.000 DB`, `50.000 CR`) returning an
    additional `direction: 'debit' | 'credit'` field alongside the positive magnitude; leading-minus and
    parenthesised negative notation (`-25.000`, `(25.000)`) returning a **negative** `minor` (a signed refund/
    reversal amount — see Owner decision D for why this module never decides a transaction `type`).
  - `findMoneyMentions(text: string): MoneyMention[]` — scans free text for **every** amount mention (built on the
    same internal tokenizer as `parseMoneyAmount`, never a second number parser), returning `{ minor, start, end,
    raw, direction? }[]` in reading order. This is the primitive FN-14's sentence segmentation ("kopi 25rb dan
    parkir goceng" → two mentions) and FN-16/19's row/line scanning build on; this module stops at "where is every
    amount and what is it," never splitting a sentence into items itself (see Out of scope).
  - `type ParsedAmount = { minor: number; direction?: 'debit' | 'credit' }`, `type MoneyMention = ParsedAmount & {
    start: number; end: number; raw: string }`. Every `minor` returned is IDR (exponent 2, per
    `src/lib/shared/money-format.ts:5` `currencyExponent('IDR') === 2`) and a safe integer
    (`Number.isSafeInteger`) — this module is IDR-only this pass (see Out of scope).
- **`src/lib/shared/dates.ts`** (touched, additive only — owned by whichever of FN-05/FN-07 lands the WIB
  calendar-date module first, `docs/features/fn-05-transactions/PRD.md:42-46`, `docs/features/fn-07-budgets-
  beranda/PRD.md:44-49`; this feature adds one export, it forks no second date module, same precedent FN-09
  already followed, `docs/features/fn-09-laporan/PRD.md:39-42`): `parseRelativeIndonesianDate(text: string,
  todayWib: string): string | null` — resolves a relative Indonesian date phrase against an explicit
  caller-supplied "today" (a WIB `YYYY-MM-DD` string, e.g. from `wibTodayString()`), never reading the clock
  itself (see criterion 24). Recognises: `hari ini` → `todayWib`; `kemarin` (and `kemarin pagi`/`kemarin siang`/
  `kemarin sore`/`kemarin malam`) → `todayWib` minus one calendar day; `tadi pagi`/`tadi siang`/`tadi sore`/`tadi
  malam` → `todayWib` (same day, the phrase only names a time of day); `<hari> lalu` for the seven Indonesian
  weekday names (`senin`, `selasa`, `rabu`, `kamis`, `jumat`, `sabtu`, `minggu`) → the most recent occurrence of
  that weekday **strictly before** `todayWib` (never today, even if `todayWib` itself falls on that weekday);
  `N hari (yang) lalu` → `todayWib` minus `N` calendar days. Anything else returns `null` (the caller keeps
  whatever default date its own UI already shows).
- **Test files:** `src/lib/shared/money-parse.test.ts` (new) and the dates-module's own test file extended with
  `parseRelativeIndonesianDate` vectors (whichever file FN-05/FN-07 created, e.g. `src/lib/shared/dates.test.ts`)
  — every vector named in Acceptance criteria below, run as the checklist's own "Money vectors" pre-handoff probe
  (`docs/ENGINEERING_CHECKLIST.md:92-93`) quoted verbatim in the hand-off.

## Out of scope

- **Sentence segmentation** — turning "kopi 25rb dan parkir goceng" into two separate draft *items* (title,
  wallet hint, category hint, income/expense type per item) is FN-14's job, built on top of this module's
  `findMoneyMentions`; this module only locates and values amount mentions, it never groups surrounding words into
  an "item."
- **Wallet-word and income-word detection** ("pakai gopay", "gaji", "refund") — FN-14.
- **CSV/statement column mapping and absolute date-format parsing** (`2026-10-01`, `01/10/2026`) — FN-18 owns its
  own small, separate absolute-date parser for its two fixed formats; this module's date function is for *relative
  phrases* only (`kemarin`, `senin lalu`), a different problem with a different input shape. FN-18 does reuse
  `parseMoneyAmount` for its amount columns (see that PRD's Architecture notes).
- **Foreign currency / FX conversion** — `original_amount_minor`/`original_currency` and day's-rate conversion
  are FN-05's territory; this module returns only IDR minor units and never attempts a currency other than IDR.
  A string that *looks* foreign-currency-formatted but has no `Rp`/`IDR` marker and no slang unit (e.g. a bare
  `"1,250,000.00"` with no prefix at all) is still parsed as IDR by the grouping/decimal heuristic — callers that
  need to reject non-IDR amounts do so themselves from context (e.g. a CSV `currency` column), not this module.
- **Unbounded Indonesian cardinal-number word parsing** — only the bounded grammar in Owner decision B (as
  changed 2026-10-08) is in scope; `miliar`, decimals in words (`satu koma lima juta`, `setengah juta`), digits
  mixed with words (`2 juta lima ratus ribu`) and non-standard forms (`satu ratus`) return `null`/no mention.
- **AI-assisted parsing of any kind** — this module is the deterministic local parser `docs/FEATURES.md:137`
  explicitly requires to "work without an account"; no network call, no model, ever.
- **Any UI, route, i18n string, or D1 access.** This is a library. A caller that cannot parse an amount shows its
  own fallback copy (e.g. FN-14's "Tidak bisa membaca jumlahnya. Ketik manual.") — this module returns `null`,
  nothing more.

## Acceptance criteria

**Determinism and shape**

1. Given the identical input string, when `parseMoneyAmount`/`findMoneyMentions` run any number of times, then
   they return byte-identical results every time — no `Date.now()`, no `Math.random()`, no locale/`Intl` state
   inside either function (`docs/FEATURES.md:127`: "typing the same sentence gives the same result").
2. Every `minor` value returned by either function is a safe integer (`Number.isSafeInteger`) — never a float,
   never `NaN`, even for inputs carrying a fractional `,50` sen component.
3. An input with no recognisable amount returns `null` (`parseMoneyAmount`) or an empty array
   (`findMoneyMentions`) — never a thrown exception, never a guessed value (checklist › Money and dates ›
   "Integers only"; `CLAUDE.md` › Data model › "Money is never invented").

**Locale and statement formats (checklist › pre-handoff "Money vectors")**

4. `"Rp 1.250.000"` → `{ minor: 125_000_000 }` (1.250.000 rupiah, no sen).
5. `"1.250.000,50"` → `{ minor: 125_000_050 }` (sen `50` kept, never truncated).
6. `"Rp 28.000,00"` → `{ minor: 2_800_000 }` (an explicit `,00` is zero sen, not dropped silently from the result
   shape — the stored integer is exact either way).
7. `"IDR 1,250,000.00"` → `{ minor: 125_000_000 }` (US-style grouping/decimal, correctly distinguished from the
   dot-grouped Indonesian style in criterion 4 by the separator-disambiguation rule in criterion 17).
8. `"Rp28.000"` (no space after the symbol) and `"28000"` (bare digits, no separators at all — a raw CSV/
   statement cell) both → `{ minor: 2_800_000 }`.
9. `"50.000 DB"` → `{ minor: 5_000_000, direction: 'debit' }`; `"50.000 CR"` → `{ minor: 5_000_000, direction:
   'credit' }` — magnitude is always positive; `direction` is additional information, never folded into the sign
   of `minor` (checklist › Money and dates › "Sign convention" stays FN-05's call, not this module's).
10. `"-25.000"` → `{ minor: -2_500_000 }`; `"(25.000)"` → `{ minor: -2_500_000 }` — both negative-refund notations
    produce the same signed value.

**Voice slang (`docs/FEATURES.md:128-130`)**

11. `"25rb"`, `"25 ribu"`, `"25k"` each → `{ minor: 2_500_000 }`.
12. `"1,5 jt"`, `"1,5 juta"` each → `{ minor: 150_000_000 }`.
13. `"cepek"` → `10_000`; `"gopek"` → `50_000`; `"seceng"` → `100_000`; `"noceng"` → `200_000`; `"goceng"` →
    `500_000`; `"ceban"` → `1_000_000`; `"goban"` → `5_000_000` (all `minor`, i.e. 100/500/1.000/2.000/5.000/
    10.000/50.000 rupiah respectively).
14. `"2 ceban"` → `{ minor: 2_000_000 }` (20.000 rupiah — the multiplier applies only when a small integer
    immediately precedes one of the seven slang words; see criterion 16 for the negative case).
15. `"seratus ribu"` → `{ minor: 10_000_000 }` (100.000 rupiah) — the one bounded number-word vector named in the
    brief (Owner decision B).
16. `"beli 2 kopi 50rb"` is **not** a `parseMoneyAmount` vector (it is not a bare amount string) but is a
    `findMoneyMentions` vector: exactly one mention, `{ minor: 5_000_000, raw: '50rb' }`, with `"2"` left outside
    any mention's span — proving the quantity word is not mistaken for a slang multiplier merely because a digit
    precedes *some* later amount in the string (the multiplier rule only fires immediately before one of the
    seven fixed slang words, per criterion 14).

**Case, whitespace and robustness**

17. `"25RB"`, `"25 RB"`, `" 25rb "` (leading/trailing whitespace) all → `{ minor: 2_500_000 }` — case-insensitive,
    whitespace-tolerant.
18. The separator-disambiguation rule (last separator followed by exactly 1–2 trailing digits at the string's end
    ⇒ decimal; any other pattern with the same separator character repeated ⇒ grouping) is proven by one test
    pair sharing the same dot-grouped prefix: `"1.250.000"` (no decimal, grouping only) → `{ minor: 125_000_000 }`
    vs. `"1.250.000,50"` (criterion 5) → `{ minor: 125_000_050 }` — the rule, not a coincidence of two separate
    heuristics, is what tells them apart.
19. A string containing control characters or zero-width characters around an otherwise-valid amount (checklist ›
    Access and privacy › "Untrusted text") is stripped before parsing and still resolves correctly; a string that
    is entirely unparseable after stripping returns `null`/`[]`, never throws.
20. `findMoneyMentions` on the required acceptance journey's own fixture, `"kopi 25rb dan parkir goceng"`
    (`docs/ACCEPTANCE.md:11`), returns exactly two mentions: `{ minor: 2_500_000 }` and `{ minor: 500_000 }`, in
    that order, with non-overlapping `[start, end)` spans — proven at this module's layer so FN-14's own
    "→ 2 drafts" criterion only has to prove it *uses* this result, not re-derive it.
21. `findMoneyMentions` on a string containing a single amount returns an array of length 1; on a string with no
    amount, length 0 — never a spurious extra mention from, e.g., a bare year or a phone-number-looking substring
    with no currency/slang marker attached.

**Relative dates**

22. Given `todayWib = '2026-10-08'` (a Thursday): `"hari ini"` → `'2026-10-08'`; `"kemarin"` → `'2026-10-07'`;
    `"tadi pagi"`, `"tadi siang"`, `"tadi sore"`, `"tadi malam"` → `'2026-10-08'` (all same calendar day);
    `"kemarin malam"` → `'2026-10-07'`; `"senin lalu"` → `'2026-10-05'` (the most recent *past* Monday, not the
    coming one); `"3 hari yang lalu"` → `'2026-10-05'`; `"2 hari lalu"` → `'2026-10-06'`; an unrecognised phrase
    (e.g. `"besok"`, "tomorrow" — not a capture-time phrase) → `null`.
23. Given `todayWib` on the 1st of a month (e.g. `'2026-11-01'`), `"kemarin"` resolves to the last day of the
    *previous* month (`'2026-10-31'`), including the February/leap-year boundary (`todayWib = '2025-03-01'` →
    `"kemarin"` → `'2025-02-28'`; `todayWib = '2024-03-01'` → `'2024-02-29'`) — checklist › Money and dates ›
    "WIB dates" month-boundary vectors, reusing whatever calendar-day arithmetic `src/lib/shared/dates.ts` already
    proved for `wibDayRangeUtcMs`/equivalent, never a second day-arithmetic implementation.
24. `parseRelativeIndonesianDate` never calls `Date.now()`, `new Date()` with no argument, or any other
    wall-clock read internally — a Vitest test asserts this by calling it with a fixed, arbitrary `todayWib` far
    from the real current date and checking the result is still correct, with no time mocking required to make
    the test pass.

**Cross-cutting**

25. `src/lib/shared/money-parse.ts` and the `parseRelativeIndonesianDate` addition to `dates.ts` import nothing
    from `src/lib/server` or any Cloudflare binding — a lint/import-boundary check (or a plain `grep` in the
    hand-off) proves this, since the same file must run unchanged in the browser bundle and both Workers.
26. `npm run gates` (check, lint, test, build) is clean on the branch before hand-off; every vector above is its
    own assertion (not one giant table test with a single pass/fail), and the full set is shown failing on the
    unfixed/stub code first (checklist › Tests › "Fail-before proof").

## Architecture notes

**Modules touched / added**

- `src/lib/shared/money-parse.ts` (new) — `parseMoneyAmount`, `findMoneyMentions`, the internal shared tokenizer,
  the `IDR_SLANG` constant table (the seven slang words → rupiah value, exported so FN-14's segmentation and this
  module's own tests share one source of truth rather than two copies of the same seven numbers).
- `src/lib/shared/dates.ts` (touched, additive) — `parseRelativeIndonesianDate`, reusing whatever WIB
  calendar-date primitives (`wibDateString`/`wibTodayString`-equivalent) FN-05/FN-07 already exported; **build-
  order dependency**: if neither has merged yet when this feature is implemented, this module's date function
  cannot land until one of them creates `dates.ts` — implement `money-parse.ts` first and add the date function
  as soon as `dates.ts` exists, never forking a parallel date module to avoid waiting (same rule FN-09 already
  followed, `docs/features/fn-09-laporan/PRD.md:14`).
- No `migrations/`, no `src/routes/`, no `src/lib/server/`, no `i18n.ts`/`i18n-en.ts` entries — this feature adds
  none of them.
- **Reused by (not built here):** FN-14 (`findMoneyMentions` for voice/typed-sentence segmentation,
  `parseRelativeIndonesianDate` is available to FN-14 too if a future pass lets a user say "kemarin" instead of
  picking a date, though FN-14's own PRD this pass defaults to today and does not expose that control yet), FN-18
  (`parseMoneyAmount` for CSV amount columns), FN-16/FN-17/FN-19 (statement/spreadsheet/Gmail amount columns,
  later passes, not built now).

**Reuse / do not duplicate**

- Exactly one money tokenizer (`money-parse.ts`'s internal one) backs both exported functions — no second regex
  pass for "the CSV version" vs. "the voice version."
- Exactly one calendar-day arithmetic implementation (`dates.ts`), reused by `parseRelativeIndonesianDate` rather
  than a second `Date`-math routine.

## Prerequisites

- No new external credentials. Pure TypeScript, no network, no D1, no WebCrypto, no provider. No "Belum
  dikonfigurasi" degraded state applies — there is no provider toggle here.
- **Build-order note (not a credential):** the `dates.ts` half depends on FN-05 or FN-07 having created that
  module first (see Architecture notes). The `money-parse.ts` half has no such dependency and can be built first
  or in parallel.

## Tracker impact

- Closes `docs/TASKS.md` › Phase 2: "`- [ ] **Claude** — Shared money and date parser (`src/lib/shared`) with the
  voice slang, statement and CSV vectors (prerequisite for FN-14, FN-16 – FN-19).`" (`docs/TASKS.md:65-66`).
- Moves `docs/ACCEPTANCE.md` rows:
  - "Integer minor units; slang and locale vectors parse exactly" → from **Not run** to **Automated** for the
    vectors in this PRD (criteria 4–21) once they pass — `docs/features/fn-05-transactions/PRD.md:406-409` already
    flagged that this half of the row "stays Not run until FN-14/FN-16's parsers exist"; this is that parser.
    Each *caller* (FN-14, later FN-16/18/19) still needs its own criterion proving it actually calls this module
    rather than a hand-rolled one — this PRD only proves the module itself is correct.
  - "Month/day buckets use the WIB date (23:30 WIB on the last day)" → the relative-date half (criteria 22–24)
    adds to whatever FN-05/FN-07 already automated for the underlying calendar module; note in the qa-tester's
    evidence which vectors came from which PRD rather than re-claiming the whole row.

## Owner decisions

**Every decision below is auto-accepted per owner instruction 2026-10-08 ("just auto accept your recomm"). No
open questions remain.**

- **A. Unparseable input returns `null`/`[]`, never a best-effort guess.** *Trade-off:* every caller needs its own
  "couldn't read that" fallback path (FN-14 already has one by design); the alternative — guessing the closest
  plausible number — is exactly what `CLAUDE.md`'s "money is never invented" forbids, so there is no real
  alternative to weigh here.
- **B. Indonesian number-word coverage — changed 2026-10-08 (auto-accepted): number words supported.** Originally
  bounded to the slang table plus one small-number-word + `ribu`/`juta` pattern; changed after QA flagged that
  voice entry (the core journey) commonly says compounds. Now a bounded, linear-time grammar: `satu`…`sembilan`,
  `sepuluh`, `sebelas`, `N belas`, `N puluh [N]`, `seratus`/`N ratus`, `seribu`/`N ribu`, `sejuta`/`N juta`,
  combined in descending order (`dua puluh lima ribu` = 25.000, `satu juta lima ratus ribu` = 1.500.000,
  `seribu lima ratus` = 1.500), at most 18 words, and only when a `ribu`/`juta` scale is present (a lone
  `dua puluh lima` is a quantity, not money). *Trade-off:* `miliar`, word decimals and digit/word mixtures still
  return `null` and use the caller's manual fallback; a malformed or glued sequence is refused, never read
  partially.
- **C. Separator disambiguation is a fixed heuristic (last separator + ≤2 trailing digits ⇒ decimal), not a
  caller-supplied locale flag.** *Trade-off:* a genuinely ambiguous two-digit grouped number at the very end of a
  string could misparse in theory; in practice IDR groups in threes and this never occurs in real bank-statement
  or voice input, so the simpler fixed rule is preferred over a configuration option nothing currently needs.
- **D. Negative/directional amounts are returned as data (`minor` sign, `direction` field), never mapped to a
  `transactions.type` by this module.** *Trade-off:* every caller must do that one small mapping itself; the
  alternative (this module deciding `type`) would require it to import FN-05's schema knowledge, breaking the
  "shared code has no server/D1 dependency" rule the checklist states explicitly.
- **E. IDR-only this pass; no currency parameter, no FX.** *Trade-off:* a foreign-currency-formatted string with
  no `Rp`/`IDR` marker is still parsed as if it were IDR by the grouping heuristic; callers that read a currency
  from elsewhere (e.g. a CSV `currency` column) are responsible for rejecting non-IDR rows themselves (FN-18 does
  exactly this, see that PRD's Owner decision D).
