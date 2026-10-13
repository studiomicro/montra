# FN-14a Shared money and date parser — QA report

**Verdict: PASS**

Branch `fn-14a-money-parser`, commit `a518c6c` (on `581e700`), reviewed in a detached worktree checkout.

## Commands run

- `npm ci` — installed 245 packages, exit 0 (local dependency install, no network provider call).
- `npx svelte-kit sync` — exit 0, no output (local codegen, no provider).
- `npm run gates` (before adding QA vectors) — exit 0: `svelte-check` clean, both Worker `tsc` clean,
  prettier+eslint clean, `Test Files 37 passed (37)`, `Tests 470 passed (470)`, both builds `✓ built` (all
  local Vitest/Vite/Wrangler toolchain, no real provider, no mock standing in for a provider — this module has
  none).
- `npx vitest run src/lib/shared/money-parse.qa.test.ts` (new QA vector file, iterating once on a
  misconstructed vector) — final run exit 0: `Test Files 1 passed (1)`, `Tests 31 passed (31)` (local Vitest,
  no provider).
- `npm run gates` (after adding QA vectors) — exit 0: `svelte-check` clean, both Worker `tsc` clean,
  prettier+eslint clean, `Test Files 38 passed (38)`, `Tests 501 passed (501)`, both builds `✓ built` (local
  toolchain, no provider).
- No migration in this diff; `npm run db:migrate:local` not applicable and not run.

## Checked criteria (PRD `docs/features/fn-14a-money-parser/PRD.md`)

All 26 acceptance criteria verified against `src/lib/shared/money-parse.ts`/`.test.ts` and
`src/lib/shared/dates.ts`/`.test.ts`, independently exercised with the new vectors in
`src/lib/shared/money-parse.qa.test.ts` (31 tests, all passing).

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Deterministic, no clock/random/Intl | PASS | `money-parse.test.ts` "is deterministic across repeated calls"; `money-parse.ts` module-boundary test asserts no `Date.now`/`Math.random`/`new Date`/`Intl.` in source |
| 2 | Always safe integer, never float/NaN | PASS | QA "safe-integer limits" block; engineer's MAX_SAFE_INTEGER vector; BigInt arithmetic throughout |
| 3 | Unparseable → `null`/`[]`, never throw | PASS | engineer's `%j → null, never a throw` block (18 cases incl. `Infinity`, `NaN`, `25e3`, full-width digits) |
| 4–8 | Locale/statement formats | PASS | engineer vectors + QA bank-format block (`Rp25.000,00`, `IDR 25.000`, `Rp 1.000.000,-`, `25.000 CR/DB`, `Rp. 25.000`, bare `25.000,00`) |
| 9 | DB/CR direction, magnitude always positive | PASS | engineer vectors; QA mutasi-line `findMoneyMentions` test |
| 10 | `-25.000`/`(25.000)` both negative | PASS | engineer vectors incl. bracket edge cases |
| 11–15 | Voice slang + `seratus ribu` | PASS | engineer vectors; QA word-form block (`tiga ribu`, `sepuluh ribu`, `dua juta`) |
| 16 | Quantity word not mistaken for multiplier | PASS | `findMoneyMentions('beli 2 kopi 50rb')` test |
| 17 | Case/whitespace tolerance | PASS | engineer's case/whitespace block |
| 18 | Separator disambiguation rule | PASS | engineer's ambiguity block (`1.250.000` vs `1.250.000,50`, plus 8 reject cases) |
| 19 | Control/zero-width chars stripped, never throws | PASS | engineer's invisible-character vectors; `cleanText` reused from `text.ts` |
| 20 | Acceptance-journey fixture, 2 ordered non-overlapping mentions | PASS | `findMoneyMentions('kopi 25rb dan parkir goceng')` exact-match test |
| 21 | Mention count: 1 / 0, no spurious mentions | PASS | engineer's "no mention" vectors (year, phone number, time, bare decimal, compound words) |
| 22 | Relative-date vectors at `todayWib='2026-10-08'` | PASS | `dates.test.ts` full table, incl. `besok`→`null` |
| 23 | Month/leap-year boundary for `kemarin` | PASS | `dates.test.ts` + QA WIB-boundary block (23:30/23:59/00:00 WIB vectors, leap-day) |
| 24 | No internal wall-clock read | PASS | `dates.test.ts` "never reads the wall clock" source-grep test + "uses only the passed-in today" vector at `1999-01-01`/`2101-03-01` |
| 25 | No `src/lib/server`/Cloudflare import | PASS | module-boundary test asserts `imports === ['./money-format', './text']`; manual `git diff` review confirms `text.ts`/`money-format.ts` pre-existing and untouched |
| 26 | `npm run gates` clean, one assertion per vector, fail-before proof shown | PASS | gates run above; every vector is its own `it.each` row/`it`; engineer report's mutation table (12 mutations, each failing a distinct subset) |

## Independent QA vectors added (`src/lib/shared/money-parse.qa.test.ts`, 31 tests, all passing)

- **Bank/e-wallet statement formats** (BCA `Rp25.000,00`, Mandiri `IDR 25.000`, BRI `Rp 1.000.000,-`, BNI
  mutasi `25.000 CR`/`25.000 DB`, GoPay/OVO/DANA/ShopeePay-style signed/glued `-Rp25.000`/`+Rp25.000`/`Rp25.000`,
  `Rp. 25.000`, compact design-system `Rp5,24 jt`, bare mutasi cell `25.000,00`) — all parse to the exact
  integer minor amount the PRD requires. One real-world nuance found and documented as its own passing test:
  when a DB/CR marker sits **before** the figure in a mutasi line (`"...DB 25.000 08/10"`, vs. the PRD's own
  `amount` + `DB/CR` order), the digit-ambiguity guard (criterion 16/21's own "no spurious mention from a
  phone-number-looking substring" rule) drops the mention rather than guess, because a date-like token
  (`08/10`) immediately follows a bare grouped number with no trailing marker. This is in scope — the PRD only
  requires `"50.000 DB"` order (criterion 9) — but any FN-16/18 statement importer must anchor on column
  position for rows where the direction marker precedes the amount, not rely on this module to disambiguate
  free-text order.
- **Chrome `id-ID` voice-transcript number-word styles**: in-scope single-word forms (`tiga ribu`,
  `sepuluh ribu`, `dua juta`, `seratus ribu`) all parse correctly. Out-of-scope compounds
  (`dua puluh lima ribu`, `lima belas ribu`, `dua ratus ribu`, `tiga ratus lima puluh ribu`, bare `seribu`,
  bare `sejuta`) all correctly return `null` per Owner decision B — each is asserted as its own passing test,
  not treated as a parser defect, but flagged below as a product risk for FN-14 since several of these are
  extremely common spoken amounts.
- **Safe-integer limits**: `MAX_SAFE_INTEGER` boundary (accept/reject at the sen), a realistic large
  statement/net-worth figure (`Rp 999.999.999.999` → exact integer minor, well under the bound), and a
  never-float/never-NaN sweep across several sen-bearing inputs.
- **WIB boundaries**: 23:30 WIB / 23:59 WIB / 00:00 WIB on 31 October, chained with a `"kemarin"` voice-capture
  resolution against the exact `occurred_on` the capture would store (not just the raw epoch), plus the
  2024-02-29 leap-day boundary reusing `addWibDays`/`wibDateString`.

## Product risks for FN-14 (voice capture) — not FN-14a defects

The parser does exactly what its PRD specifies (Owner decision B: bounded word list, not full cardinal-number
parsing). These are forward risks for whoever builds FN-14's segmentation/fallback UX:

1. **Multi-word compound amounts are common in natural speech and all return `null`.** `"dua puluh lima ribu"`
   (25.000), `"lima belas ribu"` (15.000), `"dua ratus ribu"` (200.000) and `"tiga ratus lima puluh ribu"`
   (350.000) are everyday ways to say round amounts aloud; all fall through to FN-14's manual-entry fallback.
   If early usage shows these are frequent, Owner decision B's "safe, additive follow-up" (PRD, Owner decision
   B trade-off) should be prioritised rather than left for "once real usage shows which phrases people actually
   say."
2. **Bare `"seribu"`/`"sejuta"` (1.000/1.000.000) are not recognised standalone**, even though they are among
   the simplest Indonesian number words; a user saying just "seribu" for a 1.000 rupiah item gets no mention.
3. **Whether Chrome's `id-ID` recogniser normalises spoken numbers to digits before this module ever sees them
   is unverified here** (out of this QA's reach — no browser/Web Speech API in this test run); if it does not
   normalise, risk 1–2 above are the real-world failure rate for voice capture, not a rare edge case. FN-14's
   own QA pass should capture a real microphone sample against the live recogniser to measure this, since a
   scripted Vitest string is not a substitute for a working recogniser.
4. **DB/CR-before-amount mutasi line layouts** (see vector finding above) silently drop the mention; FN-16/18
   must parse by column position for such statement exports, not re-scan free text.

## Checklist review

`docs/ENGINEERING_CHECKLIST.md` items relevant to this module (Integers only, WIB dates, Untrusted text,
Shared code, Fail-before proof, Money vectors) are all satisfied — no violations found. Items not applicable
(auth/space scoping, D1, sync, UI states, i18n strings) correctly do not apply: this module has no route, no
D1 access, no UI, and adds no user-facing string (confirmed by `git diff 581e700..a518c6c --stat`, which
touches only `src/lib/shared/{money-parse.ts,money-parse.test.ts,dates.ts,dates.test.ts}` plus the engineer
report).

## Tracker note (for the caller, not edited here)

`docs/ACCEPTANCE.md`'s "Integer minor units; slang and locale vectors parse exactly" row may move from
**Not run** to **Automated** for criteria 4–21 (this parser). The "Month/day buckets use the WIB date" row's
relative-date half (criteria 22–24) is covered here; the underlying `wibDateString`/`occurred_on` bucket half
stays whatever FN-05/FN-07 already proved — this PRD only added to it, per the PRD's own Tracker impact note.
