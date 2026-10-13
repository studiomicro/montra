# FN-47 Security report: currencies and decimals

- Scope: `git diff d4a7933..d4f8444` (worktree `montra-worktrees/fn-47-rt`, detached at d4f8444), PRD and QA_REPORT read.
- Reviewer: red-team-pentester, 2026-10-11, cycle 1.

## Verdict: PASS

There are no medium or high findings. Three low findings are listed below so they are tracked.

## What was attacked, and what held

- **Locale confusion (×1000 or ×100 inflation).** `event.locals.locale` comes from the `lang` cookie or the
  `Accept-Language` header (`src/hooks.server.ts:68-70`). Only the requester controls it. The cross-site form
  check (`hooks.server.ts:66`) stops another site from posting under a chosen locale. A PoC ran 34 vectors through
  `amountMinorFromText`, `composeAmountMinor` and `typedAmountMinor` for USD, JPY and IDR, under `id` and `en`. For
  every currency with exponent 2, an amount valid in one locale is refused (null) in the other. This holds because
  grouping needs exactly 3 digits after a separator, and a fraction allows at most 2. Examples:
  `1.234`: id=123400, en=null. `12,345`: id=null, en=1234500. `1.234,56` and `1,234.56` are each refused in the
  other locale. No input read silently as a different amount.
- **Offline queue replay after a language switch (FN-02).** `/api/v1/sync/push` reads the queued text with the
  current session locale. A switched locale fails closed: the server answers `invalid`, and the item stays for the
  user to retry or discard. It is never stored inflated. See L1 for the remaining availability and design risk.
- **Unicode and number syntax.** The server rejects fullwidth and Arabic-Indic digits, NBSP and thin-space
  grouping, U+2212, `1e5`, `0x10`, `1..234`, `1,2,3`, a bare `,` or `.`, and 3+ fraction digits. JS `\d` without
  the `u` flag is ASCII only. Leading zeros are stripped before the 13-digit cap. The largest value,
  `9999999999999,99` = 999999999999999, is below `Number.MAX_SAFE_INTEGER`. `MAX_AMOUNT_MINOR` (1e13) still bounds
  transactions, subscriptions and budgets. Net worth keeps `MAX_VALUE_MINOR`. The wallet schema bounds the
  opening balance. No `parseFloat` on money.
- **Currency tampering.** A transaction's currency always comes from the wallet row in the space
  (`resolveTransactionInput`), never from the form. A transfer between wallets with different currencies is still
  refused (`TRANSFER_CURRENCY`, `transactions/validation.ts:217`). The budget currency must be one the space holds
  (`isBudgetCurrency`). Subscription and wallet currencies are allow-listed. A tampered currency changes only the
  attacker's own row.
- **Public API v1.** `createViaApi` and `updateViaApi` pass `exactAmountMinor` with `amountText` forced to `''`.
  The locale `'en'` reads nothing, so behaviour is unchanged.
- **Space access.** Every touched action still goes through its existing helper: `walletScope`, `pageScope`,
  `guarded`, `currentSpaceScope`, or the push scope in `pushQueuedWrite`. Only the locale argument was added.
  The diff adds no new loader or route.
- **FX.** The 40-day window applies only to TWD (`FX_RATE_MAX_AGE_DAYS`). Other currencies keep 14 days, and a
  future date is still refused. TWD, HKD and CNY use `FX_DEFAULT_BOUNDS`, as the PRD and owner accepted (see L3).
  KV is written only after `fetchIdrRate` validation and is re-parsed with a zod schema on read. The fetch host is
  fixed (`api.frankfurter.dev`) and the currency is allow-listed, so the change opens no SSRF or KV poisoning path.
- **Sinks.** The diff adds no `{@html}`, raw SQL, `console.*` of amounts, or new `fetch`.

## Findings

### L1 (low): a queued write is read with the replay-time locale, not the locale it was typed in

- Location: `src/routes/api/v1/sync/push/+server.ts:50-51`, `src/lib/server/sync/push.ts:143-185`. The queue item
  in `src/lib/ui/offline-queue/form-item.ts` does not record its locale.
- Scenario: the user goes offline in `en` and types USD `12.50`. They switch to Bahasa Indonesia, then reconnect.
  The push answers `invalid` (AMOUNT_INVALID). The item stays failed until the user switches language back or
  discards it. The code comment ("the one the queued form was typed in") is wrong.
- Why low: this fails closed for every allowed currency, which all have exponent 0 or 2. The PoC found no vector
  that changes value. Adding a currency with exponent 3 (KWD, BHD, …) would make `1.234` read as 1234 in id and
  1.234 in en. That would be a silent ×1000 change.
- Fix: store the locale with the queued item and send it with the push. Or normalise the amount to canonical
  minor-unit text before queueing.

### L2 (low): in whole-unit currencies, `.` is still read as grouping anywhere, so en-locale decimal text inflates ×100

- Location: `src/lib/server/transactions/validation.ts` `composeAmountMinor` (`WHOLE_AMOUNT_TEXT = /^[\d. ]*$/`,
  then all non-digits stripped). The recurring and voice paths use the same function.
- Scenario: in the `en` locale, a USD amount of `12.50` reaches the server against an IDR or JPY wallet. The
  server stores it as Rp 1.250 (125000 minor) or ¥1,250. There are two ways this happens:
  1. A no-JS edit or compose POST where the user changes the wallet select from a USD wallet to an IDR wallet.
     `switchAmountText` clears the text only with JS.
  2. A queued create whose wallet changed from USD to IDR before the drain. A wallet's currency may change only
     while it has no transactions, and the queued create may be its first.
- Repro: `composeAmountMinor('12.50','IDR','en')` returns 125000, and `composeAmountMinor('12.5','JPY','en')`
  returns 125. Both were checked in a temporary PoC.
- Why low: it needs no-JS or a narrow race, and it affects only the user's own row. This lenient rule predates
  FN-47, but FN-47 now teaches en users that `.` is a decimal mark.
- Fix: for exponent 0, accept only plain digits or correctly grouped `\d{1,3}(\.\d{3})+`, as
  `amountMinorFromText` → `wholeAmountMinor` already does.

### L3 (low): the answer guard misses the new currency vocabulary (`RMB`, `NTD`, `HK`, `renminbi`, `sen`, `cents`)

- Location: `src/lib/server/tanya/answer-guard.ts:48-56` (`MONEY_WORD`) and `AMOUNT_AFTER_NUMBER`.
- Repro (temporary PoC, now deleted): `guardAnswer('Kamu habis RMB 500 bulan ini.', book)` returns `prose`.
  The same happens for `500 RMB`, `NTD 900`, `HK 900`, `renminbi 500`, `500 sen` and `900 cents`.
  `TWD 900` and `900 HKD` are correctly `figures_only`.
- Impact: a model answer can show a made-up amount of at most 3 digits next to a unit word that FN-47 just made a
  product term ("CNY (RMB)", sen and cents). Prompt-injected text, such as an e-mail-derived title, could steer
  this. It breaks the "money never invented" guarantee only within the user's own space.
- Fix: add `rmb|renminbi|ntd|nt|hk|sen|cents?` to `MONEY_WORD`, or to `AMOUNT_AFTER_NUMBER` for the after-number
  forms. Add `renminbi`, `ntd` and `hk` as standalone tokens.

### Notes (no finding)

- **FX bounds.** TWD, HKD and CNY take `FX_DEFAULT_BOUNDS` (0,0001 – 1.000.000 IDR). A wrong provider answer up
  to about 2000× off would pass. The PRD and owner accepted this. It affects net-worth display only, never stored
  transactions.
- **Checklist "Shared code" (ENGINEERING_CHECKLIST.md:56).** The client summary uses lenient
  `typedAmountMinor` (shared). The server uses strict `amountMinorFromText` (`src/lib/server/forms.ts`). They can
  disagree: id `12,345` gives a client summary of 12.34, but the server refuses it. This fails closed. Consider
  moving the strict reader into `src/lib/shared` so device and Worker match.

## Commands

- `npm ci --no-audit --no-fund`: installed.
- `npx vitest run src/lib/server/forms.test.ts src/lib/shared/amount-input.test.ts src/lib/server/tanya/answer-guard.test.ts src/lib/server/net-worth/prices.test.ts src/lib/server/transactions src/lib/ui/offline-queue`:
  Tests 282 passed (282).
- `npx vitest run test/integration/sync-push.test.ts test/integration/public-api.test.ts test/integration/balance-adjustment.test.ts`:
  Test Files 3 passed (3), Tests 102 passed (102).
- Temporary PoCs `src/lib/server/zz-poc/{poc,guard}.test.ts` ran (1 passed each) and were deleted. `git status`
  was clean apart from this report.

## Cycle 2 (re-check of `git diff d4f8444..c2d6bee`)

**Verdict: PASS.** L1 and L2 are fixed. L3 is fixed for every listed vector. One low residual remains (L4).

### L1 (fixed): the locale stored on a queued item

- `src/lib/shared/offline-queue.ts:70`: `locale: z.enum(['id', 'en']).optional()`. Temporary PoC through
  `parsePushRequest`: `en` and `id` are accepted. `fr`, `EN`, `' id'`, `__proto__`, `123` and `null` are refused.
  No locale is accepted and falls back to the session language (`src/lib/server/sync/push.ts:246`).
- Can a client choose the locale to make the server misread an amount? It can choose. But this is no new
  capability. The client already writes the payload's amount text, so it can type any number it wants. The
  choice only changes the user's own row in a space it already passed `no-access` and role checks for.
  Membership, the rate limit and the account check all run before `dispatch` and do not use the locale.
  Vectors: `1.234` USD reads as 123400 in `id` and is refused in `en`; `1,234` USD reads as 123400 in `en`.
  IDR `1.234` reads as 123400 in both. No reading under either language gives an amount the text cannot mean.
- The locale only selects the separators in `readTransactionForm` and `checkVoiceRows`. It never reaches SQL, a
  key or a response header.

### L2 (fixed): one shared reader for IDR and JPY in `composeAmountMinor`

- `src/lib/server/transactions/validation.ts:55` now calls `amountMinorFromText` for every currency. Re-run
  vectors (temporary PoC): `12.50` IDR en gives null, `12.5` JPY en gives null, `12.50` JPY id gives null,
  `1.25.000`, `1 250`, `.500`, `500.` and `0` give null. `1.250.000` IDR en gives 125000000, `1.500` JPY en
  gives 1500, `00012` IDR gives 1200, and `9999999999999` (13 digits) gives 999999999999900. 14 digits give null.
  The cycle-1 ×100 case is closed.

### L3 (fixed): answer-guard currency vocabulary

- Temporary PoC on `guardAnswer` gives `figures_only` for: `RMB 500`, `500 RMB`, `RMB500`, `500RMB`,
  `NT 900`, `900 NT`, `NT$ 900`, `HK$ 900`, `HKD$ 900`, `CN¥ 500`, `¥500`, `500 元`, `五百 元`, `renminbi 500`,
  `500 sen`, `900 cents`, `9 NTD`, `US$ 9` and `$9`.
- No false positives: `Saya sendiri senin 5 kali.` and `NT staff 3 orang.` stay `prose`.
- Linearity: the new patterns are bounded alternations and one lookahead `(?= *[0-9])` with no nested
  quantifier. Inputs of 300,000 characters (`nt ` repeated, `nt` + spaces, `se…ribu…`, `R` + spaces, `1 `
  repeated) each finished in at most 0.4 ms.

### L4 (low, new residual): currency codes spelled with spaces bypass the guard

- Location: `src/lib/server/tanya/answer-guard.ts:52-56` (`MONEY_WORD`). Only `R p` has a spaced form.
- Repro: `guardAnswer('Kamu habis R M B 500.', book)` and `guardAnswer('Kamu habis C N Y 500.', book)` return
  `prose`.
- Why low: this needs a model answer that spells a code letter by letter. The amount has at most 3 digits, and
  the impact stays in the user's own space. The same gap applies to `U S D` and predates FN-47.
- Fix (optional): add `\b[a-z](?: [a-z]){2}\b(?= *[0-9])` for spaced three-letter codes, or collapse
  single-letter runs before matching.

- **Resolution (2026-10-13):** FIXED in `fix(tanya): refuse lookalike digits, re-signed figures and spelled-out codes in answers`
  (2b72d0f): a three-letter code spelled with spaces before a number or a figure (`R M B 500`, `C N Y 500`,
  `U S D 50`) drops the prose. Test: `src/lib/server/tanya/answer-guard.test.ts` › "drops prose with FN-47 L4 R M B"
  (and C N Y, U S D; failed before).

### `typed` echo prop in AmountInput (no finding)

- Each echoed field is capped at 64 characters on the server (`.slice(0, 64)` in transactions `:101`/`:346`,
  wallets `:55`, net-worth `:109`, subscriptions `:81` and recurring `:97`). Only the poster sees the value, on
  a SvelteKit form action that has origin/CSRF checks.
- SSR PoC: `"><script>alert(1)</script>` renders as `value="&quot;><script>…"`, so the attribute stays closed.
  `<img onerror>` renders as `&lt;img…`, and `&quot;x` renders as `&amp;quot;x`.
  `' onfocus=alert(1) x='` stays inside the double-quoted value. No `{@html}` was added.

### New refusal copy (no finding)

- `AMOUNT_INVALID_CENTS`, `BALANCE_INVALID_CENTS` and the budget, subscription, wallet and net-worth variants are
  fixed strings with English entries. They hold no currency internals, limits beyond "2 digits", ids or stack
  detail. `amountRefusal` picks the string only from the wallet currency, which the server already holds.

### Checklist

- The cycle-1 note on shared code is partly addressed: the server now uses one reader for every currency. That
  strict reader still lives in `src/lib/server/forms.ts`, while the client summary uses the lenient shared
  `typedAmountMinor`. This fails closed, so it is not a finding.

### Commands (cycle 2)

- `npm ci --no-audit --no-fund`: exit 0.
- `npx vitest run src/lib/server/tanya/answer-guard.test.ts src/lib/server/transactions src/lib/server/forms.test.ts src/lib/shared/offline-queue.test.ts src/lib/ui/kit/AmountInput.test.ts src/lib/ui/offline-queue src/lib/ui/wallets`:
  Test Files 13 passed (13), Tests 293 passed (293).
- `npx vitest run test/integration/sync-push.test.ts test/integration/balance-adjustment.test.ts test/integration/dompet-routes.test.ts test/integration/offline-drain.test.ts`:
  Test Files 4 passed (4), Tests 105 passed (105).
- Temporary PoC `src/lib/server/zz-poc/poc.test.ts` ran (1 passed) and was deleted. `git status` shows only
  this report as modified.
