# FN-16h OCBC "REKENING KORAN" single-account e-statement — PRD

Catalog entry: `docs/FEATURES.md` › FN-16 (adds a one-line FN-16h note after the FN-16g bullet). Risk tier:
**Large** (new structural parsing of an uploaded, real-world bank PDF, per `.claude/commands/build-feature.md`'s
"new external input" bar — the same tier FN-16a/e/f/g were given).

## Why this exists (bug report)

The owner's sample e-statement is refused end to end:

- **Deteksi otomatis** → `institution_unknown` (shown as `STATEMENT_UNSUPPORTED`,
  `src/routes/(app)/impor/+page.server.ts:100`), because `OCBC.detect()` requires both the bank footer line and a
  `LAPORAN MUTASI REKENING /` or `LAPORAN KONSOLIDASI /` title (`src/lib/shared/statements/ocbc.ts:379-384`);
  this statement's title is `REKENING KORAN` and its footer line is printed as `PT. Bank OCBC NISP Tbk` (a period
  after `PT`), which the current `FOOTER` regex `^PT Bank OCBC (?:NISP|Indonesia),? Tbk` (`ocbc.ts:65`) does not
  match — neither anchor fires, so no parser claims the file.
- **OCBC picked manually** → `STATEMENT_INCONSISTENT` (`src/routes/(app)/impor/+page.server.ts:104`), because
  `segment()` (`ocbc.ts:171-261`) never finds a `TRANSACTIONS_TITLE` (`LAPORAN MUTASI REKENING /`) line on any
  page, so `transactionsPage` is false for every page, no section ever opens, and `parsePdf()`
  (`ocbc.ts:353-371`) returns `inconsistent: true` from its own `sections.length === 0` check (`ocbc.ts:368`).

`src/lib/shared/statements/ocbc.ts` (FN-16f) was written from — and only reads — the "Laporan Konsolidasi /
Consolidated Statement" multi-account layout (portfolio list pages + one `LAPORAN MUTASI REKENING` table per
account, module comment `ocbc.ts:13-48`). OCBC NISP's other personal e-statement product, "REKENING KORAN"
(printed for a single current/savings account, e.g. a **Tanda360Plus Digital** account; confirmed from the
owner's real, redacted sample, never committed:
`.superpowers/ref/samples/statements/ocbc-rekening-koran-2026-04.txt`, git-ignored in the main checkout, outside
this worktree), is a different page layout the existing parser cannot read. This PRD scopes a second code path
for it inside the same user-facing "OCBC" institution.

**No value from the sample (name, address, account number, product number, amount, merchant, bank reference) is
reproduced anywhere below, in fixtures, or in code/tests** — only its structure, using the bank's own standard,
repeated form labels (`REKENING KORAN`, `CABANG / BRANCH`, `NOMOR REKENING / ACCOUNT NUMBER`, `Currency Code`,
`Beginning Balance`, `Berita`, …), which are printed boilerplate on every OCBC NISP Rekening Koran statement, not
the owner's personal data. Every fixture, regex example and test value in the implementation must be invented and
obviously fictional, mirroring only the sample's *shape*.

## Goal

A real OCBC NISP customer whose bank issues the single-account "REKENING KORAN" e-statement (not the
multi-account consolidated one) can import it through `/impor` exactly like every other supported bank: pick or
auto-detect OCBC, see the balance check and preview, and get real transaction rows — instead of the statement
being silently refused as unsupported or inconsistent. This closes a real end-to-end failure the owner hit on
their own account, and keeps MONTRA's "money is never invented" and fail-closed self-check guarantees (FN-16b/e/f)
for a second, materially different page layout from the same bank.

## Scope

### One `ocbc` parser, two layouts (owner decision A — see Owner decisions)

- `src/lib/shared/statements/ocbc.ts` keeps its single exported `id: 'ocbc'`, `label: 'OCBC'` entry in
  `STATEMENT_PARSERS` (`parsers.ts:12`) — the picker shows "OCBC" once, not "OCBC (Konsolidasi)" and "OCBC
  (Rekening Koran)". Internally, `detect()` and `parse()` each recognise which of the two layouts a `pdf_text`
  document is (by its own stable anchors, below) and dispatch to that layout's own segmenting/reading logic;
  the Laporan Konsolidasi path (`segment()`, `readRow()`, `readSection()`, `consistent()` as they exist today) is
  **unchanged** — every current test in `ocbc.test.ts` keeps passing unmodified.
- A new internal module (e.g. `src/lib/shared/statements/ocbc-rekening-koran.ts`, imported only by `ocbc.ts`, not
  added to `parsers.ts`) holds the Rekening Koran layout's own segmenting and row-reading functions, so neither
  layout's regexes/logic leak into the other and `ocbc.ts` stays a thin dispatcher plus the existing Konsolidasi
  code. Keep the two layouts' detect scores mutually exclusive (a document only ever matches one), so `detect()`
  still returns a single 0..1 number as the `StatementParser` interface requires (`types.ts:65`).

### Detection (both layouts stay at `LETTERHEAD_CONFIDENCE`, FN-16e red team L3 unaffected)

- Widen or add a footer anchor to accept the Rekening Koran print's `PT. Bank OCBC NISP Tbk` (period after `PT`)
  alongside the existing Konsolidasi `PT Bank OCBC NISP Tbk` / `PT Bank OCBC Indonesia Tbk` forms (`ocbc.ts:65`) —
  verify against the sample whether OCBC Indonesia's own Rekening Koran print uses the same period variant or
  not; do not assume.
  **Letter-spaced-text caution:** the sample's legal paragraph is printed with single spaces inserted between
  every letter on some lines (e.g. `S E H U B U N G A N D E N G A N …`); `linesOf()`'s whitespace collapse
  (`ocbc.ts:109-113`) does **not** undo that, so the plain footer line and the per-page legal block are separate,
  differently-spaced lines — only the plain, non-letter-spaced footer line is a usable anchor; never match
  letter-spaced text as the footer (it would also match the English translation paragraph, which is not a
  detection anchor for either layout).
- Add a Rekening Koran report-title anchor alongside the existing `TRANSACTIONS_TITLE` /
  `LAPORAN KONSOLIDASI` check (`ocbc.ts:382-383`): a line ending `REKENING KORAN` (the sample's header line
  carries a document-code prefix before it, e.g. `<code> REKENING KORAN` — anchor on the suffix, never require
  an exact full-line match on the prefix, which is a per-print document id, not stable boilerplate) together
  with the `CABANG / BRANCH :` and `NOMOR REKENING / ACCOUNT NUMBER` labels appearing on the same page, so a
  single stray "REKENING KORAN" phrase inside a forged remark cannot alone claim the file (mirrors the existing
  two-anchor requirement for the Konsolidasi layout: title *and* footer).
- `detect()` still returns `0` for a CSV document and for any file carrying neither layout's anchors (existing
  `ocbc.test.ts` "claims nothing without the bank footer or a report title" case extends to the new layout: a
  Rekening Koran sample missing its footer, or missing `REKENING KORAN`/`NOMOR REKENING`, claims nothing).
- `letterheadClaims()`/the two-claims-conflict refusal (`detect.ts:97-104`, `read.ts:164-165`) is exercised
  unchanged — it operates on `parsers.detect()` scores, not on which OCBC layout fired internally.

### Rekening Koran layout structure (from the real sample; described generically, no sample value reused)

Per-page repeated header block (every page): a customer address block bracketed by the branch code (not a
detection anchor — the branch code is the owner's own data, printed twice as a page artifact); then, each as
their own short line(s):

- `CABANG / BRANCH : <code> - <branch name>`
- `PERIODE / PERIOD : <DD Month YYYY> - <DD Month YYYY>` (**one line**, unlike the Konsolidasi layout's
  multi-line `Tanggal … : … - …`, `ocbc.ts:57-58`) — this is the statement period every row's date must fall
  inside, same role as the existing `PERIOD`/`dateOf` check, new regex needed for this line shape.
- `TANGGAL PERCETAKAN` / `/ PRINTING DATE` / `: <DD Month YYYY>` (label split across lines, value on its own
  `: …` line — not used for parsing, printing date only).
- `MATA UANG /` / `CURRENCY` / `: IDR` (same split-label pattern; this file's one declared currency per page,
  **not** the per-row currency anchor — see below).
- `HALAMAN / PAGE : <n> of <m>` (one line; useful for a page-count sanity check, not required for correctness).
- `NOMOR REKENING /` / `ACCOUNT NUMBER` / `: <account number> - <product name>` (split-label pattern; this is
  the one account the whole file is about — every currency block below belongs to this same account number).

Table header (every page, many short lines): a sequence ending in the two lines `SALDO /` then `BALANCE`
(**upper-case**, unlike the Konsolidasi layout's title-case `Saldo /` / `Balance` the existing header-line check
matches literally, `isHeaderLine()` → `line === 'Saldo /' && next === 'Balance'`, `ocbc.ts:158`) — the new layout
needs its own header-end anchor (case-sensitive, matching only this layout's exact printed case; do not loosen
the existing check to be case-insensitive, which would let a forged lower/mixed-case table header appear
mid-row in the *other* layout and defeat its own fail-closed `isHeaderLine()` guard).

Per-currency block, **not** per account/page as in the Konsolidasi layout:

- `Currency Code : <ISO 4217>` then `Beginning Balance <amount>` — this pair opens one currency's row table. The
  sample has one `IDR` block (the account's own currency, always present) and, later, one `SGD` block (a foreign
  sub-ledger of the **same** account number) — treat each currency block as its own `StatementSection` the same
  way `StatementSection`/`StatementParse.sections` already models one account's table in the Konsolidasi layout
  (`types.ts:38-51`), except here the *account* is the same across sections and the *currency* varies, so
  `accountLast4` is the same for every section of one file and `label` should name the currency (and/or the
  printed product name from `NOMOR REKENING`) rather than a second account number.
- Rows: `DD/MM/YYYY DD/MM/YYYY <description…> <debet> <kredit> <saldo>` — dates are **slash-separated**
  (`dateOf()`'s `[- ]` separator class, `ocbc.ts:119`, needs a `/` variant added, or a second date parser for
  this layout; never silently reuse the Konsolidasi `DD-Mon-YYYY` parser on slash dates, which would misread
  month/day). Amounts are the same `1,234,567.89` shape the shared `AMOUNT`/`ROW_AMOUNT` regexes already parse
  (`ocbc.ts:50-52`) — reuse those constants, do not re-invent the amount grammar.
- **Row grouping differs from the Konsolidasi layout and must be implemented, not assumed:** in the Konsolidasi
  layout the amount line is always the row's *last* line (module comment `ocbc.ts:26-28`, enforced by
  `readRow()`'s "last text must be the amount line" check, `ocbc.ts:287-289`). In the Rekening Koran sample the
  amount line can be:
  - the row's own start line (date, date, description and all three amounts on one line), **or**
  - the first continuation line (the description wraps once before the amounts appear), **or**
  - followed by one or more further lines that are *not* part of this row at all: a `Berita : <reference text>`
    line (the counterpart/reference note a bank prints after the amount) and/or a further plain continuation
    line with no `Berita :` prefix (the reference text wrapping again) — these trail the row's own amount line
    and must still be read as that row's **description**, never discarded, because the counterpart's bank code
    and account number inside them (e.g. a 3-digit SKN/BI-FAST bank code before an account number) is exactly
    what a later feature (FN-48, on another branch) needs intact to match the user's own transfers between
    their accounts — this feature only needs to preserve that text, never parse or match it.
  - A row's own line group therefore runs from its `DD/MM/YYYY DD/MM/YYYY …` start line up to (but not including)
    the next row's start line, the next `Currency Code :`/`Beginning Balance` pair, the table-header anchor, or
    the per-page legal footer — whichever comes first. **Exactly one** line inside that group must match the
    amount-line pattern (debet, kredit, saldo at the line's end); zero or more than one makes the row
    unreadable (reuse the existing "more than one amount-shaped line is third-party text, reject"
    posture, `ocbc.ts:284-289`, generalised to "anywhere in the group" instead of "only the last line"). Every
    other line in the group — before *or* after the amount line, in original order — joins the row's
    `description` with the amount line's own leading text (if any), exactly as `readRow()` already assembles
    `description` from `texts.slice(0, -1)` plus the amount line's text group (`ocbc.ts:300`), generalised to
    "every non-amount line in the group, in order."
  - **Page-break mid-block:** the sample shows a row's trailing `Berita :`/plain continuation line printed as
    the *first* content line of the next page (after that page's repeated header-and-table-header block), before
    the next row's start line. The per-currency section must stay open across the page break (same account,
    same currency, no new `Beginning Balance` seen yet) exactly as the Konsolidasi layout's existing
    "continues" check already does across pages (`ocbc.ts:236-241`); the carried-over trailing line still
    belongs to the *previous* page's last row, not to whatever row follows it.

Last page: a **summary table**, not more transaction rows. There is **no `Ending Balance` line in the row
table** for this layout (unlike the Konsolidasi layout's `Saldo Akhir` line, `ocbc.ts:56`) — the closing balance
per currency comes only from this summary table: a row per currency, `<ISO> <exchange rate> <balance in that
currency> <balance in IDR>` (the exchange rate is printed to **three** decimals, a different precision than the
two-decimal `AMOUNT` grammar used everywhere else — it needs its own regex and is **never** treated as a
transaction amount or fed into the balance check), followed by a `Total Saldo Dalam IDR / Balance Total in IDR
<amount>` line. For each currency section:

- `openingBalanceMinor` = that currency's `Beginning Balance` value.
- `closingBalanceMinor` = that currency's **own-currency** balance column in the summary table (never the
  IDR-converted column, which depends on a market exchange rate this feature must not treat as a stored
  transaction fact — CLAUDE.md "money is never invented").
- The running-balance chain (`Beginning Balance` plus every row's signed amount, in printed order, including
  across the page break) must land exactly on that `closingBalanceMinor` — any gap refuses the whole file
  (`inconsistent`), the same fail-closed rule `consistent()` already enforces for the Konsolidasi layout
  (`ocbc.ts:313-322`), generalised to read from the summary table's value instead of a `Saldo Akhir` line.
- If a currency block opened in the row pages has no matching summary-table row (or vice versa), or the summary
  table's own `Total Saldo Dalam IDR` does not equal the sum of its own per-currency IDR-converted column, the
  whole file is `inconsistent` — these are additional self-checks this layout needs that the Konsolidasi layout
  does not (it has no summary page).

### Sections, importability and dedupe (reuse, no new types)

- Reuse `StatementSection`/`StatementParse.sections` unchanged (`types.ts:38-51`): one section per currency
  block. The `IDR` section is importable (`refusal: null`, subject to the self-checks above); any other
  currency section (the sample's `SGD` block) is `refusal: 'unsupported_currency'`, listed in the picker
  (`choiceOf()`, `sections.ts:23-30`) but never produces importable rows — identical behaviour to how the
  Konsolidasi layout already lists a foreign sub-account (`ocbc.test.ts` "a foreign sub-account is listed, never
  importable"). `refusal: 'not_transaction_account'` does **not** apply to this layout (there is no separate
  portfolio-list page to check an account against — the one account on the `NOMOR REKENING` line is always the
  statement's subject).
- `accountLast4` is the same for every section of one Rekening Koran file (one account, several currencies) —
  unlike the Konsolidasi layout where it can differ per section (different accounts).
- Row `index` values stay unique across the whole file (every currency section's rows numbered in one running
  sequence), exactly as the existing `readSection(..., nextIndex)` threading already guarantees
  (`ocbc.ts:324-330,358-361`) — dedupe keys (`statement:<sha256>:<row index>`, FN-16a) never collide across
  sections of one file.
- `readStatement()`'s picked-section flow (`read.ts:176-206`), the `/impor` section picker UI, refusal messages
  (`STATEMENT_SECTION_REQUIRED`/`_UNKNOWN`/`_UNSUPPORTED`, `+page.server.ts:106-108`) and the balance-check
  display are **all already generic over any `StatementParser` that returns `sections`** — no route, action or
  UI change is needed; this feature is scoped entirely to `src/lib/shared/statements/ocbc*.ts` and its tests.
- `openingBalanceMinor`/`closingBalanceMinor` on the picked section's `parse` (what `readStatement()` returns as
  `reading.parse`, `read.ts:199`) must be the real integers described above — a later feature (FN-48, on another
  branch, not built here) reads these two fields for a month-to-month continuity check; this PRD's only
  obligation to it is that the fields are populated correctly, never that any continuity logic is added here.

### Tests (`src/lib/shared/statements/ocbc-rekening-koran.test.ts` or appended to `ocbc.test.ts`)

Every fixture is invented and obviously fictional (fictional names, round amounts, a made-up account number),
built with the same small page-building helper pattern `test/fixtures/statements/ocbc.ts` already uses for the
Konsolidasi layout, extended (or a sibling helper added) for this layout's page shape. Fixtures must exercise, at
minimum, every quirk named in Scope and Acceptance below: description wrapped before the amount line, a
`Berita :` line and a plain continuation line after a row, a row's trailing annotation carried onto the next
page, the per-page repeated header/table-header noise, the `SGD`-style foreign currency block, the last-page
summary table as the sole source of the closing balance, and the planted-third-party-text attacks already
proven for the Konsolidasi layout (a forged amount-shaped `Berita` line, a forged `Beginning Balance`/section
header/footer/table-header line inside a row's trailing annotation) re-proven against this layout's own row
grouping (since the amount line is no longer always last, the forged-line attack surface is different and needs
its own tests, not an assumption that the Konsolidasi tests cover it).

## Out of scope

- Any OCBC layout other than Laporan Konsolidasi (existing, FN-16f) and Rekening Koran (this PRD) — a third OCBC
  statement shape, if one surfaces later, gets its own follow-up once a real sample exists (same "never guess a
  layout" rule as FN-16a's owner decision A).
- Matching a `Berita`/reference line's counterpart bank code and account number to the user's own other wallets
  or transactions (FN-48) — this feature only keeps that text intact inside `description`; no matching logic,
  schema, or UI is added here.
- Any change to `/impor`'s routes, actions, Svelte UI, or `src/lib/server/imports/messages.ts` — the existing
  generic statement-refusal/section-picker plumbing already covers this parser; if implementation discovers a
  genuinely new refusal reason this layout needs that `StatementRefusal` (`read.ts:33-64`) does not already have,
  that is a scope change to flag back, not something to silently add.
- CSV or XLS(X) Rekening Koran exports — the real sample is a password-protected text-layer PDF; this parser's
  `formats` stays `['pdf_text']` like every other OCBC/BCA/BNI/Mandiri parser.
- Raising or changing the existing PDF size/page/decompression bounds, password handling, or rate limiting
  (`src/lib/server/statements/pdf-text.ts`, `validation.ts`) — this feature reads pages the same bounded way
  every other statement parser already does; the owner's file already opens today with the existing password
  flow (per the task brief), so no change there.
- `npm run compat:statements` script changes beyond what already works — it already reads any PDF under
  `.superpowers/ref/samples/statements/` with a password from `.pdf-password`/`FIN_SAMPLE_PDF_PASSWORD`
  (`scripts/compat-statements.ts:62-90,264-267`) and already prints per-section lines for a multi-section parser
  (`statementLines()`, `scripts/compat-statements.ts:174-190`); running it against the owner's real sample after
  this parser ships is a verification step (Tracker impact), not new script scope.

## Acceptance criteria

**Detection**

1. Given the Rekening Koran layout's own letterhead anchors (title suffix `REKENING KORAN` plus
   `CABANG / BRANCH :` and `NOMOR REKENING / ACCOUNT NUMBER` on the same page, and the bank footer line including
   its `PT.`-with-period variant), when a `pdf_text` document is detected, then `OCBC.detect()` returns
   `LETTERHEAD_CONFIDENCE` and `detectInstitution()` (`detect.ts:63-83`) picks `ocbc` automatically — closing the
   `institution_unknown` failure from the bug report.
2. Given the same document with no footer line, or with the title/account-number anchors missing, `OCBC.detect()`
   returns `0` — unchanged "claims nothing without its anchors" guarantee, now proven for both layouts.
3. Given a document carrying only the Konsolidasi layout's anchors, `OCBC.detect()` still returns
   `LETTERHEAD_CONFIDENCE` and the existing Konsolidasi parsing path runs unchanged (every existing `ocbc.test.ts`
   case still passes, unmodified).
4. Given a document carrying one bank's Rekening Koran anchors and a different bank's full letterhead planted in
   remark text, `letterheadClaims()` returns both and the file is refused `institution_conflict`, never offered
   for a manual pick (FN-16e red team L3, unchanged behaviour, now also proven for this layout).

**Parsing correctness (fictional fixtures mirroring the real sample's structure)**

5. Given a fixture whose IDR currency block's rows, in printed order, have a `Beginning Balance`, and whose
   per-row amount line sits on the row's own start line, when picked (manually or auto-detected), then every
   row's date (slash-separated, resolved via this layout's own date parsing), direction, amount and description
   are read correctly and the running balance chain matches every row's printed `saldo`.
6. Given a fixture row whose description wraps onto a second line before the amount line appears (amount line is
   the row's second line, not its first), the row is read with the full two-line description and the correct
   amount — proving the "amount line need not be the group's first line" case.
7. Given a fixture row followed by a `Berita : <reference>` line and then a further plain continuation line (no
   `Berita :` prefix) before the next row starts, both trailing lines are appended to that row's `description` in
   order, and the next row is read as a separate, correctly-amounted row — proving trailing annotation is kept,
   not discarded, and never mistaken for a new row or a second amount.
8. Given a fixture where a row's trailing `Berita`/continuation line is split across a page break (the
   continuation is the first content line of the next page, after that page's repeated header and table-header
   block), the section stays open across the break, the carried-over line joins the correct (previous) row's
   description, and the next page's first *row* is read as a new row — proving cross-page continuation for this
   layout's per-currency sections, independent of the Konsolidasi layout's own cross-page logic.
9. Given a fixture with an `IDR` currency block followed by a second currency block (e.g. a fictional foreign
   code) for the same account, both become their own `StatementSection`; the IDR section is importable
   (`refusal: null`) when it checks out, the other section is `refusal: 'unsupported_currency'` and contributes
   no rows to any import, and both share the same `accountLast4` — proving the "same account, several
   currencies" section model (distinct from the Konsolidasi layout's "several accounts" model).
10. Given a fixture's last-page summary table stating a currency's own-currency closing balance and a separate
    IDR-converted balance that differ (a plausible real case for a foreign currency), the section's
    `closingBalanceMinor` is the **own-currency** figure, never the IDR-converted one, and the 3-decimal exchange
    rate on that line is never parsed as a transaction amount or fed into the balance check.
11. Given a fixture whose summary table's `Total Saldo Dalam IDR` does not equal the sum of its own rows'
    IDR-converted column, the whole file is `inconsistent` — a self-check the Konsolidasi layout does not need
    (it has no summary page) but this layout does.

**Self-checks and fail-closed refusal (FN-16b/16f posture, re-proven for this layout's different row grouping)**

12. Given a fixture where a row's running balance does not match its printed `saldo` by even one unit, the
    account's section is `refusal: 'inconsistent'` — never silently accepted or corrected.
13. Given a fixture where a currency section's own-currency closing balance (from the summary table) does not
    equal `Beginning Balance` plus the signed sum of every row, the section is `refusal: 'inconsistent'`.
14. Given a fixture where a `Berita`/plain continuation line (anywhere in a row's trailing annotation) is shaped
    like a second valid amount line, the row becomes unreadable (`unparseable_amount`) and its section is
    `inconsistent` — proving third-party description/reference text can never decide an amount, generalised to
    "appears after the real amount line" (the Konsolidasi layout's existing tests only cover "before").
15. Given a fixture where a forged `Beginning Balance`, `Currency Code :`, table-header line, or per-page legal
    footer line is planted inside a row's trailing annotation (attempting to close or reopen a section mid-table
    the way the Konsolidasi layout's existing "forged structure in description text" tests probe,
    `ocbc.test.ts:205-264`), the whole file is refused `inconsistent` — the same fail-closed posture, re-proven
    against this layout's own segmenting logic (which is new code, not a shared code path with the Konsolidasi
    segmenter, so this is not already covered).
16. Given a fixture where a row is cut exactly at a page boundary such that no page's content ever supplies a
    valid amount line for it (a genuinely broken/truncated print, as distinct from criterion 8's valid
    continuation), the file is refused `inconsistent`, never partially imported.
17. Given a fixture whose printed period (the one-line `PERIODE / PERIOD :` form) disagrees between pages, or is
    missing from a page, the whole file is refused `inconsistent` — mirroring the Konsolidasi layout's existing
    period-consistency check, re-implemented for this layout's own single-line period format.

**Dedupe, picker and cross-cutting**

18. Given a Rekening Koran fixture with two currency sections, every row across both sections has a unique
    `index`, so the FN-16a dedupe key (`statement:<sha256>:<row index>`) never collides between sections of the
    same file.
19. Given the same fixture file uploaded and imported twice, the second import reports every IDR row as already
    imported and creates zero new rows — reusing FN-18/FN-16a's existing dedupe query unchanged (no new code path
    in `statement-import.ts`, which this feature does not touch).
20. The real-sample verification (Owner decision / Tracker impact below) is run through `npm run compat:statements`
    with the sample's password supplied via `.pdf-password` or `FIN_SAMPLE_PDF_PASSWORD` (never a command-line
    argument, never committed) and its printed matrix shows the IDR section's rows parsed with a passing balance
    check and zero unexplained rejections — never a file path, name, account number or row description printed
    (existing harness guarantee, `compat-statements.ts` Scope, unchanged).
21. `npm run gates` (check, lint, test, build) is clean; every new regression test in criteria 5-17 is shown
    failing against the unfixed/pre-existing `ocbc.ts` first (checklist › "Fail-before proof") — in particular,
    a test reproducing the exact bug report (auto-detect → `institution_unknown`; OCBC picked →
    `STATEMENT_INCONSISTENT`) against a Rekening Koran-shaped fixture must fail before this feature's code
    lands and pass after.
22. Every server-side `/impor` load and action this parser's output flows through continues to resolve the space
    via `requireSpaceAccess`/`currentSpaceScope` from `event.locals.user` — unaffected by this change (no route
    touched), confirmed by the existing FN-16a/e cross-space tests still passing unmodified.
23. No new Indonesian or English UI string is needed (no route/UI change) — if implementation discovers one is
    needed after all (e.g. a new `StatementRefusal` variant), it is added to both `src/lib/shared/i18n.ts` and
    `i18n-en.ts` together, per the existing `i18n.test.ts` guard.
24. Money through this parser stays integer `amountMinor` via `parseMoneyAmount` only (no second tokenizer); every
    row's WIB date is read from the statement's own printed `DD/MM/YYYY`, never "this year" or the upload date.

## Architecture notes

- `src/lib/shared/statements/ocbc.ts` — add the Rekening Koran detection anchors to `detect()`, and dispatch
  `parse()` to the new layout's reader when those anchors (not the Konsolidasi ones) match. Existing exports
  (`OCBC`, `OCBC_MAX_SECTIONS`) and the Konsolidasi code path (`segment`, `readRow`, `readSection`, `consistent`,
  all current regexes) are unchanged.
- New file `src/lib/shared/statements/ocbc-rekening-koran.ts` (shared, pure, like every other statement module):
  the layout's own line-shape regexes (period, per-page split labels, table-header-end anchor, `Currency Code`/
  `Beginning Balance`, row start, row grouping/amount-line search, summary-table rows and total), its own
  `segment`-equivalent and `consistent`-equivalent functions. Reuses `parseMoneyAmount` (FN-14a),
  `isDateString`/WIB date helpers (`src/lib/shared/dates.ts`), and `statementRow()` (`rows.ts:52-81`) for building
  the final `MappedRow` — no second row-builder or amount tokenizer.
- `src/lib/shared/statements/ocbc-rekening-koran.test.ts` (new) plus fixtures, likely
  `test/fixtures/statements/ocbc-rekening-koran.ts` (new, sibling to the existing `ocbc.ts` fixture helper) —
  entirely fictional, per Scope.
- No change to `src/lib/shared/statements/{types,detect,sections,rows,parsers}.ts`, `src/lib/server/statements/
  {read,pdf-text,statement-import,validation}.ts`, or any `/impor` route/UI file — every one of those is already
  generic over "a `StatementParser` that may return `sections`" and needs no new case for this parser.
- No migration. No new npm dependency. No Worker other than the existing app Worker (this is synchronous,
  in-request PDF text parsing, same as every FN-16a/e/f parser).
- `npm run compat:statements` (`scripts/compat-statements.ts`) needs no code change — it already reads any
  `pdf_text` file under `.superpowers/ref/samples/statements/` with a sidecar/env password and already prints
  one line per section for a multi-section parser (`statementLines()`); running it against the owner's real
  sample (file type: a password-protected text-layer PDF, 4 pages, extracted by the app's own `pdf-text.ts`
  wrapping `unpdf`) is the real-sample verification step, not a script change.

## Prerequisites

- **No new credential.** The sample is password-protected with the owner's date of birth
  (format like `13Des1998`); the existing PDF password flow (`extractPdfText(bytes, { password })`,
  `read.ts:128`, and the harness's `.pdf-password`/`FIN_SAMPLE_PDF_PASSWORD` env path,
  `compat-statements.ts:62-90,264-267`) already opens it — confirmed by the task brief, no change needed here.
  Never commit the password or the sample; both stay under the git-ignored
  `.superpowers/ref/samples/statements/` folder in the main checkout.
- No AI Gateway/Anthropic key, no new npm dependency, no Worker secret.

## Owner decisions

- **A. One `ocbc` parser id handles both layouts internally, rather than a second parser id (e.g. `ocbc-rk`).**
  *Trade-off:* the module grows two distinct code paths behind one dispatcher instead of two small, fully
  separate files; in exchange the `/impor` institution picker keeps exactly one "OCBC" entry (never asking a
  user which of two technical layouts their own statement is), matching how every other bank in
  `STATEMENT_PARSERS` is one user-facing institution regardless of how many statement products it issues.
  Proposed default: ship it this way; only split into two parser ids later if a third OCBC layout makes the
  dispatcher unwieldy.
- **B. The Rekening Koran layout's `not_transaction_account` refusal case is dropped (never produced), since this
  layout has no portfolio-list page to check an account against.** *Trade-off:* a future Rekening Koran sample
  for an account type OCBC itself would refuse to issue this statement for (if any exists) has no specific
  refusal reason to fall back on other than the generic self-check `inconsistent`. Proposed default: accept it —
  no evidence any such case exists for this product; revisit only if a real sample proves otherwise.
- **C. The foreign-currency summary line's exchange rate and IDR-converted balance are read only to validate the
  `Total Saldo Dalam IDR` self-check (criterion 11); they are never stored anywhere.** *Trade-off:* a user with a
  real foreign-currency sub-ledger on this account gets no imported record of its IDR-equivalent value from this
  feature (consistent with "listed, never imported as IDR" already decided for the Konsolidasi layout's foreign
  sub-accounts). Proposed default: accept it; FN-25 (Kekayaan/net worth) is the right place for a foreign balance
  to ever surface, not statement import.

## Tracker impact

- Closes the gap in `docs/TASKS.md`'s FN-16f line — "**Claude** — FN-16f OCBC e-statement parser (2026-10-09, no
  migration)" (`docs/TASKS.md:270`) only covered the Laporan Konsolidasi layout; add a new tracker line under
  Phase 2 for this PRD once built: "FN-16h OCBC Rekening Koran single-account e-statement parser" with its
  branch/migration-none note.
- Does **not** close `docs/TASKS.md:271`'s open FN-16f red-team lows (L1 positioned-text closure, L2 remark text
  can fail-close a user's own statement) — those stay open against the Konsolidasi layout; this PRD's own
  self-checks (criteria 12-17) are this layout's equivalent, tracked fresh, not a fix for FN-16f's.
- `docs/ACCEPTANCE.md`'s "Statement PDF (password) → balance check → duplicates excluded → import → undo" row
  (Required journey table) stays **Not run** for a real-provider/real-bank-file proof until the owner runs
  `npm run compat:statements` against their own sample (criterion 20) and, separately, imports it once through
  `/impor` in a browser — this PRD only gets it to **Automated** (fictional fixtures) on its own.
- Add to `docs/FEATURES.md` under FN-16 (after the existing FN-16g bullet): "**Ours — FN-16h, a second OCBC
  layout** (`docs/features/fn-16h-ocbc-rekening-koran/PRD.md`): OCBC NISP's single-account 'REKENING KORAN'
  e-statement (e.g. a Tanda360Plus Digital account), read by the same user-facing 'OCBC' parser that already
  reads OCBC's multi-account Laporan Konsolidasi layout (FN-16f)."

## Owner decisions — answered 2026-10-11

Defaults taken by the orchestrator (internal, no owner-visible change beyond "OCBC" appearing once in the picker):
(A) one `ocbc` parser id for both layouts; (B) no `not_transaction_account` refusal for this layout; (C) the
foreign-currency summary row is validated only, never stored. The real-sample compat run is done by the
orchestrator with the password from the owner; the password is never written to a file in the repository.
