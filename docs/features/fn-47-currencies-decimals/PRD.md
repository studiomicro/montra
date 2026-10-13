# FN-47 More currencies and decimal amounts

Owner request 2026-10-11. Risk tier: **Large** (money arithmetic touched in nine form/validation pairs plus the
shared client widget; a mistake misreads a stored amount by a factor of 10–100, the exact class of bug
`currencyExponent()`'s own doc comment warns about — `src/lib/shared/money-format.ts:35-39`).

## Goal

A wallet, budget, subscription or net-worth item held in Taiwan dollars, Hong Kong dollars or yuan is as real as
one held in US dollars today — the user picks it from the same list and sees it priced in rupiah like every other
foreign holding. And for every foreign currency already supported (USD, SGD, MYR, EUR, AUD, GBP, plus the three new
ones), the amount typed is the amount meant: today a $12.50 opening balance is silently saved and re-shown as
$12.00 (`minorToDigits` truncates the cents, `src/lib/shared/amount-input.ts:14-18`) and a $20.75 transaction can
only be typed as $20 or $2,075 depending on how the digits are read. This closes both gaps without touching the
database: `amount_minor` already carries ISO 4217 minor units for every currency (`currencyExponent`,
`src/lib/shared/money-format.ts:11-39`); only the picker list and the typed/stored text conversion were IDR-shaped.

## Scope

**A. Three more currencies**

1. `WALLET_CURRENCIES` (`src/lib/shared/wallets.ts:20`) gains `TWD`, `HKD`, `CNY` at the end. No exponent change
   needed: `money-format.ts`'s ISO table already lists all three at exponent 2 (`src/lib/shared/money-format.ts:17-22`),
   proven by the existing test that iterates `WALLET_CURRENCIES` and asserts every code's exponent
   (`src/lib/shared/wallets.test.ts:19-25` — extend its assertion, since it currently hard-codes "2 unless JPY").
2. Every `z.enum(WALLET_CURRENCIES, …)` picks the three up automatically: wallets
   (`src/lib/server/wallets/validation.ts:21`), budgets (`src/lib/server/budgets/validation.ts:17`), subscriptions
   (`src/lib/server/subscriptions/validation.ts:120`), net-worth manual items
   (`src/lib/server/net-worth/validation.ts:150`). No migration: none of these columns has a DB `CHECK` on the
   currency text (confirmed by grep of `migrations/*.sql`), so the allow-list is the only gate.
3. `fetchIdrRate` (`src/lib/server/net-worth/prices.ts:244-263`) already fetches any `WALLET_CURRENCIES` member
   through Frankfurter v2 generically — no code change needed to *call* it for the new three. What does need a
   change:
   - **Provider coverage, verified against `frankfurter.dev` 2026-10-11:** HKD and CNY are ECB daily-reference
     currencies (both in the ~31-currency ECB list Frankfurter's v2 `/v2/currencies` serves) — same daily cadence
     as the eight currencies already live. **TWD is different**: Frankfurter v2 does list and serve `TWD/IDR`
     (confirmed via `frankfurter.dev/currencies/twd/`), but its own page states a **monthly dataset**, not ECB's
     daily one. `fetchIdrRate`'s existing staleness check — `body.data.date` must be no more than 14 days before
     `today` (`src/lib/server/net-worth/prices.ts:256`) — will intermittently and predictably throw
     `PriceFetchError('bounds')` for TWD whenever more than 14 days have passed since that month's publication,
     i.e. for roughly half of every month, even though the answer is perfectly valid. **Decision needed** (below):
     widen the bound for currencies on a non-daily dataset.
   - `FX_BOUNDS` (`src/lib/server/net-worth/prices.ts:62-65`): no new entry needed. TWD, HKD and CNY fall through
     to `FX_DEFAULT_BOUNDS` (0,0001 – 1.000.000 IDR per unit, `prices.ts:65`), the same generic rail six of the
     eight currencies already live with today (SGD, MYR, EUR, JPY, AUD, GBP never got a tightened `FX_BOUNDS`
     entry either). This satisfies "sane bounds" without writing a guessed exchange-rate figure into the code
     (CLAUDE.md: never hard-code guessed pricing).
4. Picker label: every `<select>` that lists `WALLET_CURRENCIES` currently renders `<option value={code}>{code}</option>`
   verbatim — `src/lib/ui/wallets/WalletForm.svelte:118-120`, `src/lib/ui/subscriptions/SubscriptionForm.svelte:118-120`,
   `src/lib/ui/net-worth/NetWorthItemForm.svelte:157-159`. Add one shared helper, e.g. `walletCurrencyLabel(code)` in
   `src/lib/shared/wallets.ts` (not translated — these are proper currency codes, like `WALLET_QUICK_PICKS` names
   already are, `src/lib/shared/wallets.test.ts:46-49`), returning `"CNY (RMB)"` for `CNY` and the bare code for
   every other entry (owner decision). All three forms call it instead of printing `{code}` directly.
5. Every other place a currency list is shown or matched, so none is missed:
   - Beranda and Laporan's `otherCurrencies` chips (`src/routes/(app)/+page.svelte:275-278`,
     `src/routes/(app)/laporan/+page.svelte:203`, `src/lib/server/reports/laporan.ts:148,487`,
     `src/lib/server/reports/money-flow.ts:58,168`) and Alur uang's export
     (`src/routes/(app)/alur-uang/+page.svelte:207`) already read whatever currency a stored transaction carries —
     no code change, just confirm (acceptance criterion) a TWD/HKD/CNY transaction shows there correctly.
   - The public API's currency serialisation (`src/lib/server/api/serialize.ts:133`) — same, generic, verify only.
   - `src/lib/server/tanya/answer-guard.ts:51` (the assistant's own-figures guard word list) already includes
     `cny`; add `twd` and `hkd` so the assistant may say a TWD/HKD amount back without being flagged as inventing a
     figure.
   - `src/lib/shared/spreadsheet/amounts.ts:37` (FN-17 foreign-currency mark in spreadsheet import) already
     matches `cny` and `hkd`; add `twd`.
   - `src/lib/shared/statements/mandiri.ts:62` already matches `CNY` and `HKD` in its currency-suffix regex; add
     `TWD`. (This only changes which statement rows Mandiri's parser accepts as foreign-currency rows; it does not
     change how their amount text is read — see Out of scope, money-parse.ts.)

**B. Decimal (cents) amount entry for every 2-decimal currency**

Applies to USD, SGD, MYR, EUR, AUD, GBP and the three new codes (TWD, HKD, CNY) — every `WALLET_CURRENCIES` member
except IDR and JPY, which keep today's whole-unit-only entry exactly as is (owner decision, restated below).

6. `src/lib/shared/amount-input.ts` gains locale- and currency-aware parsing, replacing the whole-unit-only
   `amountDigits`/`digitsToMinor`/`minorToDigits` pipeline (kept working unchanged for exponent-0 currencies):
   - A typed/pasted string is read against the **active UI locale's** separators from `money-format.ts`'s existing
     `SEPARATORS` table (`src/lib/shared/money-format.ts:46-49`): Indonesian group `.` / decimal `,`, English group
     `,` / decimal `.`. No auto-detection of the other locale's format (decision 3 below).
   - For a currency whose `currencyExponent()` is 0 (IDR, JPY): behaviour is **unchanged** — every non-digit
     character, including a decimal separator, is stripped while typing, exactly as `amountDigits` does today
     (`src/lib/shared/amount-input.ts:6-8`).
   - For a currency with `currencyExponent()` 2: the **last** occurrence of the locale's decimal separator in the
     typed/pasted text marks the start of the fractional part; every other occurrence of either separator (group or
     decimal) before it is a grouping character and is discarded, mirroring the "last separator with ≤2 trailing
     digits is the decimal mark" rule `src/lib/shared/money-parse.ts:114-135`'s `readFigure` already uses, and the
     `frac.padEnd(scale, '0')` right-padding `src/lib/server/net-worth/validation.ts:62`'s `parseQuantity` already
     uses for quantities — both reused as precedent, not reinvented.
   - **Live typing** never lets a third fraction digit appear: once two digits follow the decimal separator, a
     further digit keystroke is dropped, caret held in place (same "filter the keystroke" shape the existing
     `oninput` handler already uses for grouping, `src/lib/ui/kit/AmountInput.svelte:40-51`) — "refused, not
     rounded" (owner wording) applies at the character level, so a 3rd fraction digit is simply never entered.
   - **Paste** of a longer fractional run (e.g. pasting "12,345" into a 2-decimal field) is truncated to the first
     two fraction digits by the same live filter — the paste still lands, with the extra digit dropped, never
     rounded.
   - A fraction shorter than the exponent (`0,5`, `,50`) is accepted as typed and zero-padded on the right only at
     conversion to minor units (`0,5` → 50 cents, i.e. Rp-style "fifty", not "five") — never left-padded, never
     reinterpreted while the field still has focus.
   - `minorToDigits`'s equivalent must show cents when non-zero on edit-open (ending the "cents silently vanish on
     edit" bug this PRD exists to fix) — mirrors `formatMoney`'s own "sen only when non-zero" rule
     (`src/lib/shared/money-format.ts:71-72`) so the field's starting text and the read-only display never disagree.
7. `src/lib/ui/kit/AmountInput.svelte` reads the active locale from `useI18n()` (`src/lib/ui/i18n-context.ts:10,21`,
   already used by every form that embeds `AmountInput` for `tr()`; it safely defaults to `'id'` with no provider,
   confirmed by the existing server-render test using no context,
   `src/lib/ui/kit/AmountInput.test.ts:7-30`) instead of hard-coding `.` grouping; `inputmode` stays `"numeric"` for
   IDR/JPY and becomes `"decimal"` for every other currency so mobile keyboards show the decimal key. A hint line
   below the field, shown only for a 2-decimal currency, e.g. "Pakai koma untuk sen: 12,50" (id) / "Use a dot for
   cents: 12.50" (en) — new `tr()`/`i18n-en.ts` entry pair, same shape as the existing net-worth quantity hint
   (`src/lib/shared/i18n-en.ts:1212`).
8. `src/lib/server/forms.ts#wholeAmountMinor` (`src/lib/server/forms.ts:136-143`) is replaced/extended by a
   locale-aware `amountMinorFromText(text, currency, locale)`: accepts the same whole-unit grouped text it does
   today for a 0-decimal currency (unchanged contract, unchanged tests —
   `src/lib/server/forms.test.ts`'s amount-related cases keep passing), and for a 2-decimal currency accepts an
   optional fractional part of **exactly** 0–2 digits after the locale's decimal separator; **more than 2 fraction
   digits in the posted text is refused outright** (field error, same as today's "not a whole amount" refusal,
   never silently truncated or rounded) — this is the no-JS/tampered-payload backstop behind the client's
   can't-type-a-third-digit filter. `transactionFormValues`'s own `AMOUNT_TEXT` shape check
   (`src/lib/server/transactions/validation.ts:44`, currently `/^[\d. ]*$/`) gets the matching locale-aware update.
   Every caller passes the request's locale (`event.locals.locale`, already set for every request in
   `src/hooks.server.ts:49-51` and already read this way by several actions, e.g.
   `src/routes/(app)/riwayat/struk/+page.server.ts:259`): wallets (`openingBalanceMinor`,
   `src/lib/server/wallets/validation.ts:37-40`), transactions (`resolveTransactionInput`,
   `src/lib/server/transactions/validation.ts:286-287`), transfers (same form/function, currency is the shared
   wallet currency so no new path), balance adjustments (FN-37, `statedBalanceMinor`,
   `src/lib/server/transactions/validation.ts:393-399`; the wallet's own currency decides decimal eligibility, not
   always IDR as the shape check at `transactions/validation.ts:370` currently assumes), recurring transactions
   (`src/lib/server/recurring/validation.ts`, same wallet-currency pattern as `TransactionForm`), budgets
   (`parseBudgetForm`, `src/lib/server/budgets/validation.ts:30-44`), subscriptions (`parseSubscriptionForm`,
   `src/lib/server/subscriptions/validation.ts:101-167`), net-worth manual value (`parseNetWorthForm`,
   `src/lib/server/net-worth/validation.ts:123-202`).
9. The public API (FN-38) needs **no change**: `POST /api/v1/transactions` already takes `amount_minor` as an
   exact integer in the wallet's minor units (`src/lib/server/api/transactions.ts:123,170-171`, validated by
   `exactAmountError`, `src/lib/server/transactions/validation.ts:154-158`) — it was never text, so it already
   carries cents correctly for every currency; this PRD only confirms that with a test using a non-IDR wallet.
10. Receipts (FN-15) stay untouched and out of this PRD's currency-count scope: `ReceiptReviewForm.svelte` has its
    own whole-rupiah-only digit grouping (`src/lib/ui/receipts/ReceiptReviewForm.svelte:108`) and
    `src/lib/server/receipts/save.ts:310` hard-codes `currency: 'IDR'` — receipts are IDR-only by design (FN-15),
    so no decimal path applies there.

**i18n:** the new hint string pair (item 7); no new error-message text is needed — the existing
`AMOUNT_INVALID`/`BUDGET_AMOUNT_INVALID`/etc. phrases already say "not a valid amount" generically and keep
covering "too many fraction digits" without rewording (verify at review time; reword only if a tester finds the
existing phrase misleading for this new refusal path).

## Out of scope

- Any D1 migration or schema change (confirmed unnecessary above).
- `src/lib/shared/money-parse.ts` (the voice/free-text/statement-row parser) and the per-bank statement parsers
  under `src/lib/shared/statements/*` keep converting every recognised figure to **IDR** minor units regardless of
  a detected currency suffix (`toMinor`'s hard-coded `IDR_SCALE`, `src/lib/shared/money-parse.ts:61,138-142`) — this
  is a pre-existing limitation of Phase 2 capture, not something this pass changes. A TWD/HKD/CNY wallet still
  gets its transactions typed through the ordinary `AmountInput`-based compose/edit form (covered above), voice
  dictation into such a wallet, and any statement row whose amount column is actually foreign-denominated, are not
  fixed here.
- Receipt scanning (FN-15): IDR-only, unchanged (item 10 above explains why).
- Any new net-worth priced source (crypto/gold) for the three new currencies — `priceSource` stays `manual` for a
  TWD/HKD/CNY item exactly as it is today for SGD/MYR/etc.; only the FX conversion to IDR is in scope.
- Changing `currencyExponent()`'s table or the DB column types (`amount_minor` stays the single integer column it
  is for every currency).
- A general money-text parser upgrade (e.g. scientific notation, multiple currencies pasted at once) beyond the
  grouping/decimal rule in scope item 6.
- Historical backfill: existing stored transactions/budgets/etc. are untouched; this only changes how new typing
  and edits are read.

## Owner decisions

1. **TWD's rate freshness window.** Frankfurter serves TWD/IDR but only republishes it monthly (confirmed
   2026-10-11, `frankfurter.dev/currencies/twd/`); the existing 14-day "is this rate too stale to use" bound
   (`src/lib/server/net-worth/prices.ts:256`) will reject a true, current TWD answer for roughly half of each
   month. **Proposed default:** add a per-currency override (same shape as `FX_BOUNDS`) raising TWD's bound to 40
   days (covers a month's publication cycle plus a safety margin); HKD, CNY and the existing six keep 14 days. Net
   effect for the user: a TWD-denominated item's rate-of-the-day may legitimately be up to ~40 days old before
   falling back to the item's manual value, versus ~14 days for every other currency; this is disclosed nowhere in
   the UI today (no currency shows "how fresh is this rate" text) and this PRD does not add one. Alternative: drop
   TWD entirely rather than ship a currency whose FX quietly works ~half the time without this override — rejected,
   since the override is a two-line fix.
2. **CNY picker label.** Already decided by the owner: "CNY (RMB)" in the picker, bare `CNY` everywhere money is
   displayed with that code (formatMoney always prints the ISO code, unchanged). No other code gets a parenthetical
   (not "HKD (Hong Kong Dollar)", not "TWD (NT$)") — keeps the three additions visually consistent with the five
   already live.
3. **Pasting the other locale's formatted number.** Typing/pasting is read strictly under the active UI locale's
   separators (Indonesian "," decimal; English "." decimal) — there is no attempt to detect and reinterpret a
   pasted string written in the other convention (e.g. pasting the English-formatted "1,234.56" into an
   Indonesian-locale field reads "," as the decimal mark, "." as a second, discarded, grouping character — likely
   not the 1 234,56 the user meant). **Proposed default:** accept this as a known, documented limitation — the
   field already shows the chosen currency's symbol and the hint string names the expected separator, and
   auto-detecting formats reliably (telling "1.234" IDR-style group from "1.234" English-decimal) is not possible
   without more context than the pasted text carries. Alternative: detect and special-case a small set of common
   foreign formats — rejected as added complexity for a rare path (nobody switches UI language mid-paste).
4. **Currency switch inside an open add/edit form.** `WalletForm`, `SubscriptionForm` and `NetWorthItemForm` let
   the user change the currency `<select>` before saving; IDR/JPY (exponent 0) and the eight 2-decimal codes are
   not equivalent once decimal entry exists. **Proposed default:** switching between any two 2-decimal currencies
   (e.g. USD → EUR) keeps the typed text as is (the number means the same thing under either). Switching **to**
   IDR or JPY from a 2-decimal currency **clears the field** (there is no non-inventive way to collapse "12,50"
   into a whole-unit figure — money is never invented, so this PRD refuses to guess whether that means 12 or 13).
   Switching **from** IDR/JPY to a 2-decimal currency keeps the typed whole number unchanged (implicitly ",00").
   Alternative: always clear on any currency change — rejected as needless re-typing for the by-far-most-common
   case (choosing a 2-decimal currency before typing anything, or changing between two of them).

## Acceptance criteria

**Currency list**

1. Given the add/edit wallet form, when the currency `<select>` is opened, then it lists `IDR, USD, SGD, MYR, EUR,
   JPY, AUD, GBP, TWD, HKD, CNY` in that order, with `CNY` shown as "CNY (RMB)" and every other option as its bare
   code.
2. Given the same list, then it renders identically (including the `CNY (RMB)` label) on the subscription form and
   the net-worth manual-item form.
3. Given a wallet created with currency `TWD` (or `HKD`, or `CNY`), when its opening balance is saved and the page
   reloads, then the wallet shows that currency and balance unchanged, and a transaction can be recorded against it
   exactly as for any other foreign-currency wallet.
4. Given a budget set in `HKD` (its space has an `HKD` wallet), when the budgets list and Beranda's safe-to-spend
   card are reloaded, then the amount and currency persist and format via the shared `formatMoney` — never
   floats. `formatMoney` shows sen only when they are not zero (unchanged rule, owner-visible): a budget of
   123456 minor units shows `HKD 1.234,56` (id) / `HKD 1,234.56` (en); one of exactly 123400 shows `HKD 1.234`
   (id) / `HKD 1,234` (en), not `HKD 1.234,00`. (Corrected in fix cycle 2 after QA finding 1; showing `,00`
   always would be a separate owner decision touching every currency's display.)
5. Given a subscription and a net-worth item each created in `TWD`, then both persist their currency and amount
   across reload and appear in their respective lists with the "TWD" code (no parenthetical).
6. Given a space with transactions in `IDR` and `CNY` in the same month, when Beranda or Laporan is loaded, then
   the `CNY` total appears as a separate "other currencies" chip, never summed into the `IDR` total (one currency
   per sum, `ENGINEERING_CHECKLIST.md` § Money and dates).
7. Given the Tanya (assistant) answer guard, when an answer mentions a `TWD` or `HKD` figure the user's own records
   support, then it is not flagged as an invented figure (the guard's own word list, `answer-guard.ts:51`, must
   include both codes alongside the existing `cny`).

**FX for the new currencies**

8. Given the jobs Worker's hourly price-refresh cron with a live `HKD` or `CNY` net-worth item, when it runs within
   06–23 WIB, then `fetchIdrRate` succeeds against Frankfurter and the cached `fx:idr` entry's `at` is updated,
   exactly as for `USD` today.
9. Given the same cron with a live `TWD` item, when Frankfurter's TWD answer carries a `date` more than 14 but no
   more than 40 days before today (owner decision 1's window), then the fetch still succeeds and the item shows a
   current rate, not a fallback to its manual value.
10. Given a Frankfurter answer for any wallet currency (new or existing) whose `date` is more than 40 days before
    today, or more than 1 day after today, then `fetchIdrRate` still throws `PriceFetchError('bounds')` and the
    item falls back to its last good cached rate or its manual value — never a stale or future date silently
    accepted.
11. Given KV has no cached `fx:idr` entry for `TWD`/`HKD`/`CNY` yet (cold cache or a fetch failure), then a
    `TWD`/`HKD`/`CNY` net-worth item shows its manual value (or no value) exactly like any other currency in the
    same state — no error page, no thrown exception reaching the user.

**Decimal entry — client widget**

12. Given an Indonesian-locale session and a `USD` wallet's amount field, when the user types `12,50`, then the
    field shows `12,50` and the value submitted is `1250` minor units ($12.50) — not `125000` (today's bug: whole
    digits "1250" × 100).
13. Given the same field, when the user types a third digit after the decimal separator (`12,505`), then that
    keystroke is dropped: the field still reads `12,50` and the caret does not advance past the second fraction
    digit.
14. Given the same field, when the user pastes `12,345` in one action, then the field shows `12,34` (the third
    fraction digit truncated, never rounded to `12,35`).
15. Given the same field, when the user types `0,5`, then on submit the value is `50` minor units (fifty cents),
    not `5`.
16. Given the same field, when the user types `,50` (no leading digit), then on submit the value is `50` minor
    units, the same as typing `0,50`.
17. Given an English-locale session and the same `USD` wallet, when the user types `12.50`, then the field shows
    `12.50` and submits `1250` minor units; typing a grouping comma (`1,250.50`) still submits `125050` minor units
    ($1,250.50).
18. Given any session, when a `12,50`/`12.50` amount is on-screen and the user does nothing further, then switching
    the whole app's language preference does not change what has already been typed into an open form (languages
    switch on navigation, not live inside a focused field — confirm current i18n behaviour is unaffected).
19. Given an `IDR` or `JPY` wallet's amount field, when the user types a decimal separator (`,` in id, `.` in en),
    then it is silently ignored exactly as today — no cents are ever enterable for these two currencies.
20. Given a stored `USD` transaction of `1250` minor units ($12.50), when its edit form opens, then the amount field
    pre-fills `12,50` (id) / `12.50` (en) — not `12` (today's truncation bug, `minorToDigits`,
    `amount-input.ts:14-18`) — and saving without changing the amount keeps it at `1250` minor units (round-trip
    preserves cents).
21. Given the add-wallet form with currency `USD` selected and `12,50` typed into the opening-balance field, when
    the user changes the currency `<select>` to `EUR`, then the field still reads `12,50` (owner decision 4); when
    instead changed to `IDR`, then the field is cleared.
22. Given the same scenario reversed — `IDR` selected with `25000` typed, then switched to `USD` — the field still
    reads `25000` (owner decision 4, "from IDR/JPY keeps the whole number").

**Decimal entry — server (no-JS / direct POST)**

23. Given a no-JS POST to create a `USD` wallet with `openingBalance=12,50` (id-locale session) and no JavaScript
    run, then the wallet is created with an opening balance of `1250` minor units — the page renders correctly
    without a script tag (`ENGINEERING_CHECKLIST.md` § Web and output, no-JS forms probe).
24. Given a POST with `openingBalance=12,345` for a `USD` wallet (three fraction digits, bypassing the client
    filter — a tampered or scripted request), then the action refuses it with the existing amount-invalid field
    error; the wallet is not created and no value is silently rounded or truncated server-side.
25. Given a POST with a decimal separator in the `balance`/`amount` field for an `IDR` wallet (e.g.
    `openingBalance=25,50`), then the action refuses it (exponent 0: no fraction digits are ever accepted),
    matching today's whole-unit-only contract for IDR exactly.
26. Given the budget-setting action with `currency=CNY` and `amount=1.234,56` (id-locale session, two fraction
    digits after the last `,`), then the created budget's `amountMinor` is `123456` and it is retrievable unchanged
    after reload.
27. Given the subscription and net-worth-item actions with the same style of amount text in a 2-decimal currency,
    then both parse and store the amount identically to the budget case (one shared parsing rule, not three).
28. Given a balance-adjustment (FN-37) POST against a `USD` wallet with `balance=100,25`, then the recorded
    adjustment transaction's `amountMinor` reflects the exact cent difference from the wallet's current balance —
    the shape check at `transactions/validation.ts:370` (currently hard-coded to `wholeAmountMinor(…, 'IDR')`) must
    use the wallet's real currency, not always IDR.
29. Given the public API (`POST /api/v1/transactions`) with `amount_minor: 1250` against a `USD` wallet, then the
    created transaction carries exactly `1250` minor units ($12.50) — confirms no regression from the amount-text
    changes above, since this endpoint never took text.

**Access and i18n**

30. Given every load and form action touched above (wallets, budgets, subscriptions, net-worth, transactions,
    adjustments, recurring), then each one re-checks the acting user's access to the target space through the
    existing shared space-access helper before reading or writing — no new route bypasses it (unchanged from
    today, verified by test since this PRD does not add a new route).
31. Given the new hint string ("Pakai koma untuk sen…" / "Use a dot for cents…") and the extended `CURRENCY_INVALID`-style
    error paths, then every new Indonesian phrase has a English entry in `i18n-en.ts`, and the project's i18n test
    (which fails when a phrase lacks an English entry) stays green.
32. Given the amount field in a loading, empty, error, saving and success state (an add-wallet or set-budget form
    in flight), then each state still renders correctly with the new decimal logic — no regression to the existing
    busy/disabled button text or field error rendering.

## Architecture notes

- `src/lib/shared/wallets.ts` — `WALLET_CURRENCIES` array (+3 codes), new `walletCurrencyLabel()` helper.
- `src/lib/shared/wallets.test.ts:19-25` — update the hard-coded "exponent 2 unless JPY" assertion to also exclude
  `IDR`'s whole-unit *display* rule from the exponent check (the exponent itself stays 2 for IDR; only entry/edit
  skips decimals) — add cases for the three new codes' labels.
- `src/lib/shared/amount-input.ts` — the locale-and-currency-aware rewrite (item 6); `src/lib/shared/amount-input.test.ts`
  gets the new vectors from Acceptance criteria 12–22's non-UI half.
- `src/lib/ui/kit/AmountInput.svelte` + `AmountInput.test.ts` — locale from `useI18n()`, hint text, `inputmode`.
- `src/lib/server/forms.ts` — `wholeAmountMinor` → locale-aware `amountMinorFromText` (or kept name, extended
  signature); `src/lib/server/forms.test.ts` gets the decimal vectors.
- `src/lib/server/transactions/validation.ts` — `AMOUNT_TEXT` shape regex, `parseAdjustmentForm`'s hard-coded
  `'IDR'` at line 370, both call sites threading the wallet's real currency and the request locale.
- `src/lib/server/wallets/validation.ts`, `src/lib/server/budgets/validation.ts`,
  `src/lib/server/subscriptions/validation.ts`, `src/lib/server/net-worth/validation.ts`,
  `src/lib/server/recurring/validation.ts` — each call site passes `event.locals.locale` through to the action
  (check each route's `+page.server.ts` already has `event`/`locals` in scope; all of them do, being SvelteKit
  actions).
- `src/lib/server/net-worth/prices.ts` — new per-currency FX staleness-bound map (owner decision 1); no change to
  `FX_BOUNDS` (new codes use `FX_DEFAULT_BOUNDS`).
- `src/lib/ui/wallets/WalletForm.svelte`, `src/lib/ui/subscriptions/SubscriptionForm.svelte`,
  `src/lib/ui/net-worth/NetWorthItemForm.svelte` — use `walletCurrencyLabel()` instead of printing `{code}`.
- `src/lib/server/tanya/answer-guard.ts:51`, `src/lib/shared/spreadsheet/amounts.ts:37`,
  `src/lib/shared/statements/mandiri.ts:62` — add `twd`/`TWD` (and `hkd` to the answer guard) to each existing
  word/regex list.
- No migration. No new Worker. No new table. `workers/jobs`' existing hourly cron
  (`docs/features/fn-25-net-worth/` pattern) is the only runtime affected, by the widened TWD staleness bound.
- Reuses, never reinvents: `money-format.ts`'s `SEPARATORS`/`currencyExponent`, `net-worth/validation.ts`'s
  `parseQuantity` right-padding pattern, `money-parse.ts`'s "last separator wins" heuristic.

## Prerequisites

No new credential. Frankfurter v2 stays keyless (unchanged from FN-25); the existing `CACHE` KV binding and
`workers/jobs` cron secret-free setup already cover the three new currencies. Nothing here is gated on
`Belum dikonfigurasi` — every piece (currency list, decimal entry, FX fetch) works the moment the code ships, same
as the eight currencies already live.

## Tracker impact

No existing `docs/TASKS.md` line names this request (it was opened 2026-10-11, after the file's last update); the
engineer picking this PRD up adds a To-do line under a new dated entry, e.g. "FN-47 more currencies and decimal
amounts — code and tests", and on completion moves it to `docs/HISTORY.md` with the evidence (gates output, new
test vectors run). No `docs/ACCEPTANCE.md` row currently names FN-47 either; add one row ("FN-47 currencies and
decimals — decimal round-trip + TWD/HKD/CNY FX") the same way FN-45/FN-46 rows were added, moved from "Not run" to
a named check (Automated: `npm run gates`; Browser: the AmountInput typing/paste criteria 12–22, which need a real
input element and cannot be proven by a server-rendered Vitest alone).

## Owner decisions — answered 2026-10-11

All proposed defaults accepted by the owner: TWD rates accepted up to 40 days old (other currencies keep 14 days);
"CNY (RMB)" label for CNY only; pasted text is read with the UI language's separators only, never auto-detected;
currency switch keeps the typed amount between two 2-decimal currencies, clears it when switching to IDR or JPY, and
keeps the whole number when switching from IDR or JPY to a 2-decimal currency.
