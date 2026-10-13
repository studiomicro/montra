# Security re-check: fix-lows-services (2026-10-13)

Scope: `git diff 5a486bc..41f0cb1` (14 commits, migration 0045), plus the "Resolution (2026-10-13)" notes in the
feature reports. Worktree `montra-worktrees/lows-services-rt`, detached at 41f0cb1. Red team: Opus.

## Verdict: PASS

No high or medium finding. Each fix holds against the original attack. Variants of the original attacks still get
through in three places (the masking, the answer guard and the narrative lure filter), and the masking has one
small regression. All of these are low. Two doc and info items are listed so they can be tracked.

## Commands run (one file at a time)

| Command | Result |
| --- | --- |
| `npx vitest run test/integration/gmail.test.ts` | 50 passed |
| `npx vitest run test/integration/merchants-redteam.test.ts` | 9 passed |
| `npx vitest run test/integration/kotak-masuk-routes.test.ts` | 14 passed |
| `npx vitest run test/integration/agen.test.ts` | 49 passed |
| `npx vitest run test/integration/agen.qa.test.ts` | 9 passed |
| `npx vitest run test/integration/billing-hardening.test.ts` | 18 passed |
| `npx vitest run test/integration/streak-plus.test.ts` | 25 passed |
| `npx vitest run src/lib/server/tanya/answer-guard.test.ts` | 160 passed |
| `npx vitest run src/lib/shared/text.test.ts` | 12 passed |
| `npx vitest run src/lib/server/billing/claims.test.ts` | 12 passed |
| `npx vitest run src/lib/ui/kit/HeroAmount.test.ts` | 3 passed |
| `npx vitest run src/lib/ui/net-worth/wealth-ui.test.ts` | 8 passed |
| `npx vitest run src/lib/server/agent/render.test.ts` | 9 passed |
| `npx vitest run src/lib/server/agent/narrate.test.ts` | 12 passed |
| `npx vitest run src/lib/ui/photos/picker-mode.test.ts` | 10 passed |
| PoC `src/lib/server/tanya/zz-poc.test.ts` (guard and lure vectors) | ran; results below; deleted |
| PoC `src/lib/shared/zz-poc.test.ts` (masking and claim-address vectors) | ran; results below; deleted |
| PoC `src/lib/ui/kit/ZzProbe.svelte` + `zz-probe.test.ts` (SSR mask order) | ran; results below; deleted |

`npm run gates` was not run here. QA runs it in the other worktree.

## Re-break attempts on each fix

- **FN-19 Gmail L6 (AI-read cap). Holds.** `claimAiRead` (`src/lib/server/gmail/repo.ts:468`) is one guarded
  UPDATE … RETURNING, and the 20-way concurrency test passes. The cap counts per connection. A reconnect does not
  reset it: the `onConflictDoUpdate` set clause in `oauth.ts` leaves `ai_window_start`/`ai_reads` alone. Disconnect
  deletes the row, so disconnect and connect again starts at 0. Only the owner can do that, on their own key. An
  outside sender cannot. The claim sits after the deterministic parsers and after the key lookup, so only real AI
  reads count. An `ai_limit` mail re-queued through "Baca ulang" goes through the same claim again. Info: the
  24-hour window is fixed, not sliding, so up to 2 × 200 reads can land close together across a window boundary.
  The cost is bounded, and the same pattern is accepted elsewhere.
- **FN-19 Gmail L7 (re-seal on rotation). Holds for refreshed connections.** The re-seal is bound to the same
  (connectionId, userId) AAD. It is guarded on the nonce that was read, so a concurrent reconnect wins. It is best
  effort, and a failure is retried on the next refresh. See finding N4 for the connections that are never refreshed.
- **FN-19 Gmail L5. Holds.** `read.ts` hard-codes `trust = 'unverified'`. A grep finds no other Gmail path that
  writes `verified`. `inbound/draft.ts:133` therefore always sets `needs_review` for Gmail. `GMAIL_AUTHSERV_ID` is
  removed from the env, the RUNBOOK and the examples.
- **FN-19 forwarding L3 (masking). Holds for the listed joiners.** There is a regression and some other joiners
  still get through: see N1.
- **FN-20 L2 ("Pakai nama"). Holds.** `useName` (`kotak-masuk/+page.server.ts`) reads only `id` and `updatedAt`. A
  forged `title`/`name` field is ignored. The draft is loaded with `getDrafts(scope.spaceId, …)`, so another space's
  draft id returns 404. The name is re-resolved by `draftHints`, and the merchant cache is keyed by `spaceId`
  (`cacheForKeys(db, spaceId, …)`), so another space's AI name cannot be offered or applied. `renameDraft` is guarded
  on pending, `updated_at` and live membership. `resolveMerchants.merchant` is never the AI name now. The only writer
  of a suggested name is this tap. The `/riwayat/saran` chip is tap-to-apply in the client. The name renders as
  escaped text.
- **FN-22 S11/S12 and FN-47 L4. Every listed vector is refused.** New variants still pass: see N2.
- **FN-23 S1 (lure filter). Holds for the reported PoC.** Simple variants pass: see N3.
- **FN-23 S2. Holds.** A tombstone keeps `created_at`, so the per-user and per-space 24 h counts include it. The
  live cap, the list and the download skip it (`deleted_at is null`). A step for it sees `failed` and stops, and step
  writes are guarded on `status in ('queued','running')`. The keys go to the outbox in the same batch. Hapus on a
  tombstone again is idempotent.
- **FN-23 S3. Holds.** `releaseResend` binds the ids once (`json_each`) and touches only `attempts = 1` unfinished
  runs. The worst case is a retry on every tick until the 7-day expiry.
- **FN-23 S4. Holds.** `/agen/status`: signed out gets 404, and off the plan gets 403. It uses `listRuns`, which
  checks user = caller, the current space, live membership and `deleted_at is null` in one statement. The response
  is `private, no-store`. The loader now only checks whether a key row exists and never decrypts it.
- **FN-23 S5. Holds.** The meta CSP is `default-src 'none'` plus the hash of the one style block, with no
  `'unsafe-inline'`. It comes before the style element. The test recomputes the hash.
- **FN-30 L1/L5. Hold.** Fullwidth letters, a trailing dot (also `..`) and `googlemail.com.` all fold to the same
  address. `。` (U+3002), soft hyphen and ZWSP stay distinct, as do cross-script lookalikes. That acceptance is
  reasonable for now, but only because no address is verified yet: anyone can sign up with a fresh made-up address
  anyway, so the markers stop casual re-claims only. That stays true until e-mail verification ships (owner
  decision recorded). L5: the guarded UPDATE runs before the INSERT OR IGNORE in the same deletion steps, and the
  test passes. L3 and L6 copy: verified by the content tests.
- **FN-34b L1/L2. Hold.** `usersDueCloseReminder` is bounded (`limit`, cursor) and parameterised. `deliverPush`
  re-checks `day_closures` before sending.
- **FN-45 drop handling. Holds.** It is a UX check on the client only. The server still sniffs the bytes, and the
  shared `sniffImageType` is unchanged in behaviour (moved, not altered). Only the first file is assigned.
- **FN-47 copy and echo. Holds.** `typed` is capped at 64 characters and rendered as an input value (escaped).
- **FN-25b L1/L2. Holds as a display preference.** The cookie is host-only, `SameSite=Lax` and `Secure` on https.
  It is not HttpOnly by design, because it holds only `1`. Setting it only masks: it cannot unmask anything or reach
  another user. The SSR state is reset by the root layout on every render. Svelte SSR here is synchronous (no
  `experimental.async`), so requests cannot interleave. The figures stay in `__data.json` and the page data, which is
  documented and accepted ("display-only"). While hidden, the trend chart draws no line, area, dots, cursor or
  direction colour. `aria-valuetext` goes through `shown()`. The allocation bar draws one segment, and the shares and
  the bar's `aria-label` are masked. The change line ("Naik … ") masks the amount but keeps the direction word, which
  is acceptable. See N5 for the order dependency.
- **Migration 0045. No data loss.** The 0044 and 0045 snapshots match for `gmail_mail` columns, indexes and FKs. The
  only CHECK difference is the added `ai_limit`. The INSERT…SELECT copies all 15 columns by name, and no table
  references `gmail_mail`. The new `gmail_connections` columns come last, matching the positional insert-select in
  `oauth.ts`. `agent_runs.deleted_at` is nullable. The RUNBOOK records the row counts and the Time Travel bookmark.

## Findings

### N1 (low): masking regression: an account number of up to 10 digits glued to `,NN` is kept in full

- Where: `src/lib/shared/text.ts:53` `AMOUNT_SHAPE` gains `\p{Nd}{1,10},\p{Nd}{2}`, and `,` is now a run joiner
  (`:39`).
- Reproduction: `maskAccountNumbers('Rek 1234567890,12')` → `Rek 1234567890,12`. Before 9456de8 it gave
  `Rek ••••7890,12`. Also `'4111 1111 1111 1111,00'` → `••••1111 1111,00`, which shows 8 digits. Common Indonesian
  accounts (BCA) are 10 digits.
- Joiners that still get through (they predate this batch and are not in the listed set): U+2012 figure dash, U+2015,
  `·` (U+00B7), `・`, `~`, `+`, `|`, `:`, `" _ "`, and a double space (`4111  1111  1111  1111`). A double space is
  common in mail converted from HTML to text.
- Fix: limit the bare comma-decimal shape to amounts with a currency word or `Rp` before them, or to fewer than 8
  digits. Treat `\s{1,2}` and `[‒―·]` as joiners.

### N2 (low): the answer guard still passes some re-signed or spelled-out amount variants (S11/S12 family)

- Where: `src/lib/server/tanya/answer-guard.ts:57` (MONEY_WORD), `:82` (RESHAPED_FIGURE), `:93`
  (LOOKALIKE_AMOUNT).
- Reproduction (PoC, all returned `prose`): `Kamu habis R–p 500.` (an en dash, not caught by `r[ .\-]?p`),
  `Saldo I.D.R 500.`, `Saldo U.S.D. 50.`, `Saldo 50 r b.`, `Saldo 50 j t.`, `Saldo 50 r.b.`, `Saldo l OOO OOO.`,
  `Saldo SOO OOO.`, `Saldo lOOOOOO.`, `Saldo (-) [[f:B]].`, `Gajimu min [[f:B]]`, `Saldo defisit [[f:B]].`,
  `Gajimu [[f:B]] dikali 12.`
- Impact: the same as S11/S12. Prose can imply an invented amount or flip a sign. Every figure shown is still the
  server's own.
- Fix: allow every ALLOWED dash in `r…p`. Fold dotted or spaced letter sequences before the MONEY_WORD test (strip
  `.`/space between single letters). Add `min`, `defisit`, `dikali`, and `(-)`/`(+)` before a figure. Treat a word
  made only of lookalikes, 6 or more long, as a loose number.

### N3 (low): the narrative lure filter (FN-23 S1) is bypassed by simple spellings

- Where: `src/lib/server/agent/narrate.ts:45`.
- Reproduction (PoC; each passed `guardAnswer` and `narrativeHasLure` returned false):
  `Verifikasi di montra-bantuan .com segera.`, `montra-bantuan(.)com`, `montra-bantuan.cöm`,
  `montra-bantuan titik com`, `Masuk ke akunmu dan isi kata-sandi.`, `katasandi`, `sandi`, `passcode`.
- Impact: social-engineering text in a Montra-branded report. The text is escaped plain text and is never a link.
- Fix: also refuse `\.\s*[a-z]` after a word, `(.)`, `titik com|dot com`, `kata[\s-]?sandi|\bsandi\b|passcode`,
  and `masuk ke (akun|aplikasi)`. Run the domain test on the mark-folded (NFD, marks stripped) text.

### N4 (low, ops/doc): the L7 re-seal only covers connections that refresh; the RUNBOOK note is stale

- Where: `src/lib/server/gmail/token.ts:65,78`. RUNBOOK lines 208–212 still say "A re-seal job does not exist yet",
  and no note mentions the connections that never refresh. The L7 resolution cites a "RUNBOOK rotation note" that
  is not in the diff.
- Scenario: a connection that is `paused`, `needs_reconnect` or has automatic checks off never refreshes, so it is
  never re-sealed. If `_PREVIOUS` is removed, disconnect and account deletion can no longer revoke that grant at
  Google, because `revokeGmailToken` returns false.
- Fix: update the rotation note. Remove `_PREVIOUS` only when
  `select count(*) from gmail_connections where token_key_id <> '<new id>'` is 0. Optionally add a jobs sweep that
  re-seals every row, without needing Google.

### N5 (info): the server-side mask depends on render order

- Where: `src/lib/ui/kit/HeroAmount.svelte:88` sets `amounts.hidden` when the hero renders.
- Probe (with the cookie set to hidden): `BEFORE:Rp 9.999` (markup before the hero) and `PLAIN:Rp 6.666` (a plain
  `const` in the script) render unmasked. `$derived` values and markup after the hero render `••••`. No current
  page puts a `shown()` figure before its hero, apart from the no-JS inline edit forms, which show input values
  anyway. A future page could still flash.
- Fix (optional): apply `amountsHiddenAtLoad()` in the route layout or page before any figure, not inside
  HeroAmount.

## ACCEPTED / OWNER items: judgement for a public repo

- FN-19 forwarding daily cap: reasonable. The address is a 128-bit bearer secret that can be rotated, reads use the
  user's own key, and there is a 60-per-hour cap.
- FN-20 throttle window (2× burst on the user's own key): reasonable.
- FN-22 brackets and the hyphen range, `pre-line` lines, the small-number allowance: reasonable. The figures stay
  the server's own.
- FN-23 S6 (a removed member's reports kept for up to 30 days, with access ended at once): reasonable under PRD
  decision 6. S7 (owner): allowing `hapus` off the plan is the better privacy default, so I recommend the owner
  accept it.
- FN-30 L1 cross-script, L2 oracle: acceptable only as a stopgap. Without e-mail verification the starter-grant
  markers stop casual re-claims only. Keep e-mail verification tracked as a prerequisite before real payments. L4
  fail-open without `CLAIM_HASH_KEY`: acceptable with the admin "Belum dikonfigurasi" signal. Self-hosters should
  see it in SELF_HOSTING.md too.
- FN-13b, FN-51: reasonable.

## Checklist (docs/ENGINEERING_CHECKLIST.md)

Bound lists use `json_each` (`releaseResend`, REREAD_REASONS). Caps are single guarded statements (`claimAiRead`,
`createRun`). The cron query is bounded and parameterised. Tombstones carry no content. The CSP has no
`'unsafe-inline'`. Every new route checks scope and membership server-side. The `updated_at` stale guard is present
on `useName`. Masking has the regression in N1. The fail-before proofs are cited in the resolution notes. They were
not re-run on unfixed code here.

## Resolution (cycle 2, 2026-10-13)

All in `fix(lows): cycle 2: masking, guard and lure normalisation, Gmail re-seal sweep, sliding AI cap, page-level amount mask`, each with a test that failed on the cycle-1 code.

- **N1 FIXED.** A bare comma decimal (`1234567890,12`) is an amount only when it starts its run and either `Rp`/`IDR`
  comes right before it or it holds fewer than 8 digits, so accounts glued to `,NN` and cards ending in `,00` keep at
  most 4 digits. One or two spaces, `·`, U+2010–U+2015, U+2212, `・`, `~`, `+`, `|`, `_`, `*`, `•` (bare or between
  spaces) join digit groups. Tests: `src/lib/shared/text.test.ts` › "maskAccountNumbers cycle 2 (red team N1)".
  Times (`18:05`) stay: `:` is not a joiner.
- **N2 FIXED.** The money-word test reads a folded copy (marks stripped, lower case, single letters joined across
  spaces, dots and dashes: `R–p`, `I.D.R`, `U.S.D.`, `r b`, `j t`, `r.b.`); words made only of lookalikes with two or
  more zero-like letters are read as digits before the number checks (`l OOO OOO`, `SOO OOO`, `lOOOOOO`); `min`,
  `defisit`, `(-)`/`(+)` before a figure and `dikali` after one drop the prose. QA observation 1: "kurang [[f]] lagi"
  (a shortfall, still the positive server figure) now stays prose; "kurang [[f]]" without "lagi" and "minus [[f]]"
  still fall back to figures only. Tests: `answer-guard.test.ts` › "guardAnswer cycle 2 (red team N2)" and QA's
  `answer-guard.lows-qa.test.ts` (its "kurang … lagi" expectation updated to prose).
- **N3 FIXED.** `narrativeHasLure` tests a folded copy (NFKC, marks stripped, lower case) for a space before the dot
  (`montra-bantuan .com`), a bracketed dot (`(.)`, `[.]`), `titik com`/`dot com`, `kata-sandi`, `katasandi`, `sandi`,
  `passcode` and "masuk ke akun/aplikasi"; `.cöm` folds to `.com`. Test: `narrate.test.ts` › "narrativeHasLure cycle 2
  (red team N3)".
- **N4 FIXED.** The jobs Worker's hourly tick runs `resealGmailTokens`: up to 100 connections still sealed under
  another key are opened (current or `_PREVIOUS`) and sealed again with the current key, guarded on the nonce, without
  calling Google, so paused, needs-reconnect and checks-off connections are covered. RUNBOOK › Connected apps ›
  Rotation now says to remove `_PREVIOUS` only when no row has the old `token_key_id` and 7 days after the rotation;
  the L7 note in `fn-19-gmail/SECURITY_REPORT.md` cites it. Test: `gmail.test.ts` › "N4 (cycle 2): the hourly sweep
  re-seals connections that never refresh (paused, needs reconnect, checks off)".
- **N5 FIXED (render order).** Every route page with a HeroAmount or NetWorthSection calls
  `applyAmountsHiddenAtLoad()` at the top of its script, so figures before the hero (plain consts included) are masked
  on the server too; HeroAmount still applies it and the device's stored choice wins on mount. Masking in the loader
  data instead would touch every figure of six pages; the figures stay in the page data as before (display
  preference). Tests: `HeroAmount.test.ts` › "a page that applies the cookie choice first masks figures before any
  hero …" and "every route page with a HeroAmount or NetWorthSection applies the choice in its script".
- **Accepted fixed window (L6 info):** unchanged; the 24-hour AI-read window per Gmail connection stays fixed (worst
  case 2 × 200 reads on the owner's own key across a boundary).


## Cycle 2 (re-check of `ec73820`, rebased on main 22191cd)

### Verdict: PASS

N1–N5 are fixed for every reported vector. The FN-20 L4 sliding counter is sound. What remains is low only: more
variants of the same deny-list families (the guard, the lure filter and the masking separators), one starvation
case in the new re-seal sweep, and some false positives in the guard to track.

### Commands run (one file at a time)

| Command | Result |
| --- | --- |
| `npx vitest run src/lib/shared/text.test.ts` | 25 passed |
| `npx vitest run src/lib/server/tanya/answer-guard.test.ts` | 180 passed |
| `npx vitest run src/lib/server/tanya/answer-guard.lows-qa.test.ts` | 12 passed |
| `npx vitest run src/lib/server/tanya/answer-guard.qa.test.ts` | 33 passed |
| `npx vitest run src/lib/server/agent/narrate.test.ts` | 26 passed |
| `npx vitest run src/lib/ui/kit/HeroAmount.test.ts` | 5 passed |
| `npx vitest run test/integration/gmail.test.ts` | 51 passed |
| `npx vitest run test/integration/merchants-redteam.test.ts` | 10 passed |
| `npx vitest run test/integration/fix-lows-imports.qa.test.ts` | 3 passed |
| `npx vitest run test/integration/sign-in.test.ts` | 13 passed |
| `npx vitest run test/integration/impor-statements.test.ts` | 43 passed |
| PoC `src/lib/server/tanya/zz-poc.test.ts` (32 masking, 50 guard, 20 false-positive and 32 lure vectors) | ran; deleted |

`npm run gates` was not run here.

### Re-check of N1–N5

- **N1 (masking): FIXED.** `Rek 1234567890,12` → `Rek ••••9012`. `4111 1111 1111 1111,00` → `••••1100`. A double
  space, `·`, U+2012, a tab and a newline now join groups, and all mask. Amounts, dates and instalments stay as
  printed (`Rp 1.250.000,00`, `IDR 1,250,000.00`, `Rp150.000*12`, `Rp 1.250.000~1.500.000`, `08-10-2026`).
  - The `Rp`/`IDR` exception keeps `Rp1234567890,12`, `rp.1234567890,12` and `IDR 1234567890,12` (up to 13 digits).
    With a currency marker right before it, that is an amount by its form, so I accept it. A prefix that only
    contains `rp` does not count (`Grp 1234567890,12` → masked), and neither does a marker after the number
    (`1234567890,12 Rp` → masked).
  - Residual (low): three or more spaces (`4111   1111   1111   1111`), `:` and a spaced dot (` . `) still split
    the groups.
- **N2 (answer guard): FIXED** for all 13 reported vectors and for dashed, spaced and dotted variants (`R _ p`,
  `R·p`, `I-D-R`, `I  D  R`, `r‒p`, `( - )`, `[-]`, `minus{B}`, `IOOOOOO`, `ZOO.OOO`, `s e j u t a`,
  `r i b u`).
  - Residual (low; every figure shown is still the server's own):
    - Codes split by an unlisted separator: `R/p 500`, `R  -  p 500`.
    - Multiplier and sign words not on the list: `{B} dikalikan 12`, `berlipat`, `ganda`, `rugi {B}`, `nombok {B}`.
    - Two figures joined as arithmetic: `{B}; {A}`, `{B} / {A}`.
    - Slang units: `2 jeti`, `2 jti`.

    A deny-list cannot be complete. I recommend closing this family as ACCEPTED, with the server-figure guarantee
    as the real control.
- **N3 (lure filter): FIXED** for every reported vector (`.com` with a space, `(.)com`, `.cöm`, `titik com`,
  `kata-sandi`, `katasandi`, `sandi`, `passcode`, `masuk ke akun`).
  - Residual (low; escaped plain text, never a link):
    - Obfuscated dots: `[dot] com`, `(titik) com`, `dot c o m`.
    - A spaced dot before a TLD not in the list: `. shop`, `. store`.
    - Other separators: `montra-bantuan,com` / `·com` / `/com`.
    - Credential phrases not covered: `kode verifikasi`, `kode rahasia`, `kata kunci`, `masuk akun`.

    I recommend accepting the same way as N2.
- **N4 (Gmail re-seal): FIXED.**
  - `resealGmailTokens` never calls Google.
  - Each re-seal keeps the AAD (connectionId, userId) and is guarded on the nonce it read. A concurrent refresh
    re-seal or a reconnect wins, and the loser's UPDATE matches 0 rows. Both outcomes are valid seals.
  - Failures are caught per tick, and only `errorLabel(e)` and a count are logged, never a token.
  - Paused, needs-reconnect and checks-off rows are covered.
  - The RUNBOOK rotation note now gives the `token_key_id` count query and the 7-day revocation-queue wait.
  - New low (C2-1) below.
- **N5 (SSR mask order): FIXED.** `applyAmountsHiddenAtLoad()` runs at the top of the script of Beranda, Dompet,
  Laporan, Anggaran and Kekayaan, before any markup or plain `const`. The `FigureBeforeHero` test covers a figure
  placed before the hero.
- **FN-20 L4 (sliding hourly AI cap): sound. The 10-minute statement throttle is not affected.**
  - The cleanup threshold rose from 60 to 61 minutes, so both cleanups (`countAttempt`: `< min(windowStart, now −
    61 min)`; the sliding counter: `< now − 61 min`) delete less than before, never more.
  - The oldest bucket the hourly read uses starts at `current − 60 min`, which is at or after `now − 61 min`, so it
    is never swept.
  - The 10-minute buckets and windows are far inside that limit.
  - Bucket hashes are bound once through `json_each`, so there is no 100-parameter issue.
  - The guarded increment counts concurrent calls exactly.
  - `sign-in`, `impor-statements` and `fix-lows-imports.qa` all pass.

### New findings

#### C2-1 (low): the re-seal sweep can stall on rows that no key opens

- Where: `src/lib/server/gmail/token.ts` `resealGmailTokens`. The select has
  `where token_key_id <> ${current} order by id limit 100`. A row that opens with neither key is skipped with
  `continue` and selected again on every tick.
- Scenario: `_PREVIOUS` was removed once while some rows were left (they are now `needs_reconnect/key`), and then a
  second rotation starts. If 100 or more such dead rows sort before the live ones, the sweep processes only dead
  rows and never re-seals the rest. The RUNBOOK condition (count of old `token_key_id` = 0) also never becomes true
  while dead rows exist.
- Fix: select only rows that can still be re-sealed, e.g. exclude `status = 'needs_reconnect' and
  reconnect_reason = 'key'`, or mark an unopenable row `needs_reconnect/key` in the sweep. Make the RUNBOOK query
  exclude those rows too.

#### C2-2 (info, QA): false positives from the stricter guard

- `Tiga terbesar: {A}, {B} dan {C}.` → `figures_only`. The new `${MARK}[.,]? *${MARK}` catches a plain comma
  list of figures. Before cycle 2 this was prose.
- `Kurang {A} dari anggaran.` → `figures_only` (cycle 1 `kurang`).
- `Kategori GOOD naik.` → `figures_only` (the lookalike run).

These fail safe (the figures still show), but they degrade ordinary answers. Consider allowing `MARK, MARK` when
the line ends in `dan/atau MARK`, or dropping the comma alternative and keeping only `.` and nothing between.

### Checklist

Bound lists use `json_each`. The re-seal is a guarded single-row UPDATE per connection, bounded at 100 per tick. No
secrets or tokens are logged. The masking rule is restored (N1). No new routes and no new `'unsafe-inline'`.
