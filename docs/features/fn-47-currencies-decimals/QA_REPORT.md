# FN-47 QA Report — more currencies and decimal amounts

**Verdict: PASS** (with 3 non-blocking findings for the owner/engineer to judge before ship)

## Commands run

- `npm ci --no-audit --no-fund` — installed, 277 packages added, exit 0 — real npm registry.
- `npm run gates` (check + lint + test + build) — exit 0; `Test Files 318 passed (318)`, `Tests 5056 passed (5056)`; build (client+server+service worker) succeeded — all local, no mocks beyond the project's own stubbed fetch/AI in unit tests.
- `git diff d4a7933..d4f8444 --stat` / `git diff d4a7933..d4f8444` — reviewed full diff (72 files) — local, no provider.
- `E2E_PORT=8881 npx playwright test e2e/mata-uang-sen.spec.ts --project=phone` — 5 passed (13.9s) — real Chromium browser against local `wrangler dev`, no mocked provider.
- `E2E_PORT=8881 npx playwright test e2e/riwayat.spec.ts e2e/pro-look.spec.ts --project=phone` — 10 passed (17.1s), IDR regression + FN-46 Pro look regression post-rebase — real browser, local server.
- No migration diff present (`git diff d4a7933..d4f8444 -- migrations/` empty) — `db:migrate:local` not needed, confirmed per PRD "no migration".
- Manual `npx tsx` probes of `formatMoney`/`typedAmountMinor`/`minorToAmountText` (read-only verification scripts, deleted after use, no file left in repo) — local, no provider.

## Checked acceptance criteria

1. PASS — `WALLET_CURRENCIES` order confirmed (`src/lib/shared/wallets.ts:20-32`); `wallets.test.ts` locks the exact order and `walletCurrencyLabel` output; e2e `mata-uang-sen.spec.ts:78-90` asserts the rendered `<option>` text on the real wallet form.
2. PASS — `WalletForm`, `SubscriptionForm`, `NetWorthItemForm` all call the shared `walletCurrencyLabel()` (verified in diff); same list/order, no per-form divergence.
3. PASS — `test/integration/dompet-routes.test.ts` "TWD, HKD and CNY wallets keep their currency and balance across a reload" creates all three, re-reads via `walletsOf`, exact minor units.
4. **PARTIAL / FINDING** — budget persists exactly (`anggaran.test.ts` FN-47 case: CNY 1.234,56 → `amountMinor 123_456`, retrieved unchanged) but the literal display string in AC4 (`HKD 1.234,00`) is not what `formatMoney` produces when cents are exactly zero — see Finding 1.
5. PASS — `langganan.test.ts` (TWD subscription 149,50 → 14_950, bare "TWD") and `net-worth-routes.test.ts` (TWD manual item 1.234,56 → 123_456) both round-trip exactly with the bare code.
6. PASS — `beranda.test.ts` "a CNY spend is its own chip, never summed into rupiah": IDR hero total unaffected, CNY appears only in `otherCurrencies`.
7. PASS — `answer-guard.test.ts` "FN-47: TWD and HKD figures" — both a formatted record figure and the bare word `hkd`/`TWD`/`CNY` in prose are handled correctly (figure shown, prose-naming-currency dropped); `answer-guard.ts:51` word list now includes `twd`/`hkd`.
8. PASS — `prices.test.ts` "HKD and CNY take ECB's daily rate with the 14-day window" and `refreshPrices` FN-47 case: both fetch, validate and write `fx:idr` like USD.
9. PASS — `prices.test.ts` "TWD (a monthly dataset) is accepted up to 40 days old" — 15 and 40 days old accepted, a same-age USD answer is refused, confirming the per-currency override (`FX_RATE_MAX_AGE_DAYS`) is scoped to TWD only.
10. PASS — same test: 41 days old and a future date both throw `bounds`; `FX_DEFAULT_BOUNDS` sanity check also tested with an implausible TWD rate.
11. PASS — `net-worth-routes.test.ts` TWD item: no cached rate yet, item still created/listed, `nw.error` is null (no thrown exception reaching the page).
12–17. PASS — `amount-input.test.ts` FN-47 describe blocks cover every vector (grouping/decimal split, right-pad short fraction, 3rd-digit cut+flag, last-separator-wins) in both locales; e2e `mata-uang-sen.spec.ts` reproduces 12, 13, 14, 17 in a real input with real keystrokes/paste and caret assertions.
18. PASS by inspection — `locale` is read once per render from `useLocale()`/layout data; the UI language changes only via a cookie set on a full navigation (unchanged, pre-existing design), so no live mid-field reformat path exists; not a new code path FN-47 introduces.
19. PASS — `amount-input.test.ts` "IDR and JPY stay whole units, byte-identical to before"; e2e currency-switch test types `25000,5`/`25000.5` into an IDR field and gets `250.005` (comma dropped as a non-digit, never read as decimal).
20. PASS — `balance-adjustment.test.ts` "the edit form pre-fills 20,75 (not 20) and saving it unchanged keeps 2075"; e2e en-locale test re-opens the edit form and asserts `1,250.50`.
21–22. PASS — e2e "currency switch in an open form" exercises both directions (USD→EUR keeps text, →IDR clears, IDR→USD keeps whole number) in both locales.
23. PASS — e2e no-JS test: USD opening balance `12,50` saved as the real `USD 12,50` row, page rendered server-side with `javaScriptEnabled: false`.
24. PASS — same e2e test and `dompet-routes.test.ts`/`balance-adjustment.test.ts`: a 3rd fraction digit is refused server-side with the existing field error; wallet/row not created.
25. PASS — `dompet-routes.test.ts` "refuses a third fraction digit (USD) and any fraction for IDR": IDR/JPY with a decimal separator refused, matching the pre-FN-47 contract exactly.
26. PASS — `anggaran.test.ts` FN-47 case: CNY `1.234,56` (id) → `amountMinor 123_456`, retrievable unchanged; `1.234,567` (3 fraction digits) refused.
27. PASS — `subscriptions/validation.test.ts`, `net-worth/validation.test.ts`, `langganan.test.ts`, `net-worth-routes.test.ts` all exercise the identical rule via the one shared `amountMinorFromText`.
28. PASS — `balance-adjustment.test.ts` "a stated balance of 100,25 records the exact cent difference in the wallet's own currency" — confirms the `transactions/validation.ts:370`-area shape check now uses the wallet's real currency, not hard-coded IDR (IDR wallet in the same test still refuses a fraction).
29. PASS — `public-api.test.ts` new FN-47 case: `amount_minor: 1250` against a USD wallet created verbatim, confirming no regression from the text-reading changes.
30. PASS — access/space-scoping tests untouched in shape and still green: `dompet-routes.test.ts` "/dompet: one access rule", `balance-adjustment.test.ts` criterion 11 (member/stranger/removed-member on a shared space, including the guarded-insert write path), `sync-push.test.ts` locale threading didn't change scope checks. No new route was added by this PRD, confirmed by the diff (only existing route handlers gained a `locale` parameter).
31. PASS — new hint string pair present in `i18n-en.ts:1214`; `npm run test` (which includes the project's i18n-coverage test) is green inside the 5056-test run.
32. PASS — e2e specs exercise loading (form opens), saving (submit → "Dompet ditambahkan."/redirect), error (field error shown, no-JS refusal message shown) and reload/success states on the real amount field; no regression to busy/disabled button text (unrelated code untouched).

## Findings (non-blocking; recommend addressing before ship)

1. **AC4's literal display string is not produced.** `formatMoney` keeps its pre-existing, unchanged "sen only when non-zero" rule (`src/lib/shared/money-format.ts:71-72` — untouched by this diff except exporting `SEPARATORS`). A HKD budget of exactly 1,234.00 therefore renders as `HKD 1.234`, not the `HKD 1.234,00` AC4 asks for literally. This is consistent with the PRD's own item 6 ("mirrors `formatMoney`'s own 'sen only when non-zero' rule ... so the field's starting text and the read-only display never disagree") and is locked in by the engineer's own test (`wallets.test.ts`: `formatMoney(100, 'TWD')` → `'TWD 1'`, no `.00`). Verified directly: `formatMoney(123400, 'HKD', 'auto', 'id')` → `"HKD 1.234"`. Judgment: this is a pre-existing, deliberate, documented display convention, not a new defect — but AC4's wording should be corrected (or the owner should decide cents must always show for non-IDR 2-decimal currencies, which would be a separate, larger change to `formatMoney` touching every existing currency's display, not scoped here).

2. **Misleading refusal copy for 2-decimal currencies.** Every existing `BALANCE_INVALID`/`AMOUNT_INVALID`/`BUDGET_AMOUNT_INVALID`/`NW_VALUE_INVALID` string literally says "...dengan angka bulat, tanpa sen" ("...with a whole number, no cents") — e.g. `src/lib/server/wallets/messages.ts:8`. This text is now shown for a USD/HKD/etc. amount refused only because it had a *third* fraction digit, even though the field explicitly supports two. A user who typed `12,345` for a USD wallet is told cents aren't allowed at all, contradicting the field's own hint ("Pakai koma untuk sen: 12,50") shown one line above it. Confirmed live via the no-JS e2e test (`e2e/mata-uang-sen.spec.ts:209`), which asserts this exact string is shown for that case. Recommend a currency-aware reword (e.g. "...at most two digits after the comma") for the 2-decimal path.

3. **A refused amount re-renders as a different, truncated value rather than echoing the user's input.** On a server-refused no-JS submission with too many fraction digits (e.g. `12,345` for USD), the wallet is correctly *not* created (AC24 holds), but the redisplayed field does not show `12,345`: `AmountInput` recomputes `valueMinor` from the posted text via `typedAmountMinor` (which lenient-truncates) and redisplays `minorToAmountText(1234, …)` = `12,34` — a different, plausible-looking number the user never typed and that was never saved. Confirmed directly: `typedAmountMinor('12,345', 'USD', 'id')` → `1234` → re-rendered as `"12,34"`. No money is fabricated server-side (nothing is stored), but the on-page echo after a refusal is silently reinterpreted instead of showing exactly what was typed, which could read as "it understood me correctly" when it did not. Recommend echoing the raw posted text verbatim on a refused submission instead of round-tripping it through the minor-unit conversion.

Item (d) from the brief — the answer-guard now matching `twd`/`hkd` — is **not** a finding: it is exactly PRD item 5/AC7's required change, is tested (`answer-guard.test.ts`), and behaves correctly (both the figure-substitution and the "drop prose naming the code" paths were exercised).

## Engineering checklist

- Money/dates: integers only end-to-end (no `parseFloat`, confirmed in `amount-input.ts`/`forms.ts` by code read), one currency per sum (`beranda.test.ts` CNY-chip case), WIB dates untouched by this PRD.
- Access: no new route; existing space-access helper calls unchanged; shared/removed-member tests green.
- i18n: new hint string has an English entry; i18n coverage test green.
- Currency display: only the shared `formatMoney`/`moneyParts` used, never hand-formatted — see Finding 1 for the one display nuance.
- No other checklist item (D1 bound params, LIKE patterns, CSV export, CSP, upload persistence) is touched by this diff.

## Scope not independently re-tested

Given the size of the already-provided test suite (72 files touched, all green, plus 4 new e2e specs run live), I did not write additional tests of my own — every acceptance criterion had direct, specific coverage already in place (listed above) and the gates/e2e runs confirm them passing against real code paths, not fixtures standing in for the behaviour under test.

---

## Cycle 2 (re-run)

**Verdict: PASS**

Scope: `git diff d4f8444..c2d6bee` (worktree `montra-worktrees/fn-47-qa2`, detached at `c2d6bee`), re-read against the
cycle-1 findings, the red-team-pentester's `SECURITY_REPORT.md` (cycle 1, PASS with 3 lows: L1 offline-queue
locale, L2 `.`-as-grouping inflation in whole-unit currencies, L3 answer-guard vocabulary), and the PRD's own
cycle-2 correction to AC4.

### Commands run

- `npm ci --no-audit --no-fund` — 277 packages, exit 0 — real npm registry.
- `npm run gates` (check + lint + test + build) — exit 0 throughout; `check`: `COMPLETED 2172 FILES 0 ERRORS 0
  WARNINGS`; `lint`: prettier + eslint clean; `test`: `Test Files 318 passed (318)`, `Tests 5089 passed (5089)`
  (+33 vs cycle 1, all FN-47-cycle-2-labelled); `build`: client+server+service-worker succeeded — all local, no
  mocks beyond the project's own stubbed fetch/AI in unit tests.
- `npx playwright test e2e/mata-uang-sen.spec.ts e2e/offline-queue.spec.ts e2e/qa-fn02-offline-reload.spec.ts e2e/suara.spec.ts e2e/riwayat.spec.ts --project=phone` (`E2E_PORT=8921`) — 30 passed (37.4s) — real Chromium against local `wrangler dev`, no mocked provider.
- `git diff d4f8444..c2d6bee --stat` / full diff — read in full (49 files) — local, no provider.
- No migration diff (`git diff d4f8444..c2d6bee -- migrations/` not in the changed-file list) — `db:migrate:local` not needed.

### Cycle-1 findings re-verified

1. **AC4 display string — FIXED (by PRD correction, not code).** PRD's acceptance criterion 4 was reworded in
   this cycle to state the real, unchanged `formatMoney` rule explicitly (`HKD 1.234,56` when cents are non-zero,
   `HKD 1.234` not `HKD 1.234,00` when they are exactly zero) and credits "fix cycle 2 after QA finding 1". No
   code change was needed or made; the owner-visible display convention is now correctly documented. Confirmed:
   `budgets/validation.test.ts`/`anggaran` tests unchanged and still green.

2. **Misleading refusal copy — FIXED.** New `amountRefusal(currency, whole, cents)` helper
   (`src/lib/server/forms.ts:152-154`) and a matching `*_INVALID_CENTS` message added for every one of the six
   touched form paths (transactions/recurring `AMOUNT_INVALID_CENTS`, wallets `BALANCE_INVALID_CENTS`, budgets
   `BUDGET_AMOUNT_INVALID_CENTS`, subscriptions `AMOUNT_INVALID_CENTS`, net-worth `NW_VALUE_INVALID_CENTS`) —
   "Isi jumlah lebih dari 0, maksimal 2 angka di belakang koma." instead of "...tanpa sen" for any 2-decimal
   currency. Verified: `transactions/validation.test.ts` "QA FN-47 #2: a refused amount is told the rule of its
   currency" (USD/HKD → cents copy, IDR/JPY → whole copy); same pattern in `recurring/validation.test.ts`,
   `subscriptions/validation.test.ts`, `net-worth/validation.test.ts`, `wallets/validation.test.ts`. Live e2e
   confirmation: `mata-uang-sen.spec.ts` "no JavaScript..." asserts the exact text "Isi saldo awal dengan
   maksimal 2 angka di belakang koma." is shown for a USD wallet refused on a third fraction digit — passed.
   Every new string has an English entry in `i18n-en.ts` (6 new pairs, confirmed by diff and by the green
   i18n-coverage test inside the 5089-test run).

3. **Refused input echoed as a truncated value — FIXED.** `AmountInput` gained a `typed` prop (QA FN-47 #3
   comment in the source) that, when set, is shown verbatim instead of being recomputed from `valueMinor`; every
   amount-bearing form (`WalletForm`, `TransactionForm`, `AdjustmentForm`, `RecurringForm`, `SubscriptionForm`,
   `NetWorthItemForm`) now passes `typed={errors.X ? values.amountField : undefined}`. Verified: `AmountInput.test.ts`
   "QA FN-47 #3: a refused submit echoes what was typed" — shows `12,345`/`12.345` verbatim in both locales, and
   that the echoed text is HTML-escaped (XSS check: `"><b>1` renders safely inside the `value="..."` attribute,
   never breaks out). Live e2e: the same `mata-uang-sen.spec.ts` no-JS test posts `12,345` for a USD wallet and
   asserts `input[name="openingBalance"]` still has the value `12,345` (not `12,34`) after the refused submit —
   passed.

### Watch items from this task, checked specifically

- **`composeAmountMinor` unification (transactions, recurring, voice) and the stricter whole-unit rule.** This is
  the red-team's own L2 fix: `WHOLE_AMOUNT_TEXT` for a 0-decimal currency (IDR, JPY) now requires plain digits or
  exact groups of three (`\d{1,3}(\.\d{3})+`) with no stray spaces and no `.` used as anything but grouping —
  same contract wallets/budgets/subscriptions/net-worth already had. `0001.234` (4-digit first group) and
  `25 000` (space) are indeed now refused, exactly as the brief flagged. I confirmed this is **not** a regression
  against any real input path:
  - The client `AmountInput` oninput filter (`src/lib/ui/kit/AmountInput.svelte`) never produces a space or a
    malformed grouping in the posted text for IDR/JPY — it only ever emits plain digits or exact-3 dot-grouping.
    Voice review rows are pre-filled the same way (`minorToAmountText`), and the voice form
    (`src/lib/server/transactions/voice.ts`) reads each row through the identical `resolveTransactionInput` as
    the compose form — one schema, confirmed by the PRD and by code (no separate, looser voice parser for the
    *typed/edited* amount field; free-text/speech-to-digits parsing itself is out of scope, unchanged, per PRD
    "Out of scope"). So a real voice draft, a real Tambah-sheet entry, a real recurring create/edit, and the
    offline-queued form of any of these all still produce text the stricter reader accepts.
  - `25 000` and `0001.234` could previously only reach the server from a no-JS/tampered/scripted POST, never
    from the real widget — this is exactly the class of input the red-team's L2 finding was about (an `en`
    `12.50` landing on an IDR/JPY wallet via the same lenient path, silently inflating ×100). Direct tests:
    `transactions/validation.test.ts` "FN-47 red team L2" and `recurring/validation.test.ts`'s updated case both
    assert the new refusal; `composeAmountMinor('12.50','IDR','en')` → `null` (previously → `125000`, a real
    money-amount bug). This is a correctness fix, not a regression — the "previously accepted" inputs it closes
    off were never reachable through normal use and the loophole they documented was a genuine ×100 inflation
    risk.
  - e2e `suara.spec.ts` (7 tests, including the typed-sentence, fake-recogniser, offline, zero/hostile-text and
    no-JS cases) and `offline-queue.spec.ts`'s voice-offline case all passed against the real route with this
    stricter reader in place, so the real IDR capture paths (voice, Tambah sheet, edit, recurring, offline queue)
    are confirmed still working end-to-end, not just by unit test.

- **Offline queue `locale` field and old queued items failing closed.** New optional `locale` on `PushRequest`/
  `QueueItem` (`src/lib/shared/offline-queue.ts`); the drain now sends the language the item was typed in, and
  the server (`pushQueuedWrite`, `src/lib/server/sync/push.ts:244-245`) uses `item.locale ?? locale` (falls back
  to the session's current language when the item predates this field). I judged whether this strands a real
  user's pre-existing queue after deploy:
  - **Not a silent loss.** A 400/`invalid` answer is handled by the existing (pre-FN-47) failed-item path
    (`src/lib/ui/offline-queue/sync.ts`): the item is marked `failed` with a message
    (`QUEUE_INVALID` = "Perubahan ini tidak bisa disimpan. Buka lagi lalu periksa isinya."), stays visible in the
    queue UI, and the user can retry or discard it — the same mechanism already used for every other refusal
    (stale, no-access, limit, etc.), not a new failure mode FN-47 invented.
  - **The only items actually at risk** are ones queued *before* this cycle's client code ships, for a 2-decimal
    currency, whose typed text would read differently under the two locales (e.g. an `en` `12.50` typed while the
    session was `en`). If the user never switches UI language between queuing and draining (the overwhelmingly
    common case — nothing in the product switches language automatically), the fallback-to-session-locale read
    is correct and the item drains normally; `sync-push.test.ts`'s own new case "an item queued before FN-47
    cycle 2 (no locale) is read with the session language" proves exactly this: it succeeds when the session
    locale still matches what was typed, and fails closed (never silently inflated) only when it does not.
  - **Verdict on this judgment call: acceptable, not a stranding regression.** The failure mode this replaces was
    strictly worse (the red-team's own L1: a value could previously be read under the wrong locale with no error
    at all, for a hypothetical future exponent-3 currency, or at minimum with the misleading "typed in" code
    comment). Today, for every currency actually shipped (exponent 0 or 2), misreading always refuses rather than
    inflating, and refusal is always visible and actionable, never silently dropped. No currently-queued item is
    at risk unless the user also changes their UI language while offline with an item still pending — a narrow,
    already-rare combination, and even then the result is a visible, recoverable "failed" state, not data loss
    or a wrong amount. I would not block ship on this; it is a reasonable, documented trade-off, consistent with
    "money is never invented."

- **Answer-guard vocabulary (red-team L3).** `MONEY_WORD`/`AMOUNT_AFTER_NUMBER` now also catch `rmb`, `renminbi`,
  `ntd`, `nt` (only before a number/figure), `hk`, `sen`, `cents?` — confirmed by `answer-guard.test.ts`'s new
  "FN-47 red team L3" describe block (14 positive cases dropped as `figures_only`, 5 negative cases — ordinary
  Indonesian prose containing "sen" inside a word like "sensitif"/"sendiri"/"seni" — correctly still `prose`).

### Full PRD acceptance-criteria re-check

All 32 acceptance criteria from cycle 1 were re-verified against this cycle's diff: criteria 1, 2, 3, 5, 6, 7,
8–11, 12–22, 23, 25, 27, 29–32 are untouched by this diff's code paths and remain covered by the same tests cited
in the cycle-1 report (all still green in this run's `npm run test`). Criteria 4, 24, 26, 28 (the ones involving a
refusal message or `composeAmountMinor`) were re-verified directly above. No criterion regressed.

### Engineering checklist

- Money/dates: integers only end-to-end, no `parseFloat`-style reads (confirmed by code read of
  `amountMinorFromText`/`wholeAmountMinor`); one currency per sum, untouched; WIB dates untouched.
- Access: no new route; `pushQueuedWrite`'s scope check runs before `item.locale` is even read; shared
  space-access helper calls unchanged (confirmed by diff — only validation/messages/UI files touched, no route
  or loader added).
- i18n: 6 new Indonesian phrases, 6 new English entries, i18n-coverage test green.
- Shared code: the strict `amountMinorFromText` is still server-only (`src/lib/server/forms.ts`); the client's
  `typedAmountMinor` stays lenient for the live-typing UX and is not meant to match 1:1 (pre-existing, flagged as
  a note not a finding by the red-team in cycle 1: client and server can disagree, and that disagreement always
  fails closed server-side, never stores a different value than what the server itself computed).

No new findings from this cycle. The verdict is PASS.

## Follow-ups (SUMMARY "Not done") — Resolution (2026-10-13)

All FIXED in `fix(amounts): currency-aware queue and net-worth copy, echo refused budget text, steady 16 MB bound`
(82985af):

- `QUEUE_AMOUNT_MISSING`: `queueAmountMissing(currency)` gives the cents wording for a currency with cents. Test:
  `src/lib/ui/offline-queue/view.test.ts` › "says whole numbers for IDR and JPY, at most two decimals for a currency
  with cents".
- Net-worth value hint: "Perkiraanmu sendiri, boleh dengan sen." for a currency with cents. Test:
  `src/lib/ui/net-worth/NetWorthItemForm.test.ts` › "allows cents for a currency that has them" (failed before).
- No-JS budget form: a refused `setBudget`/`setCategoryBudget` returns the typed text and `BudgetForm` shows it
  instead of the stored budget. Tests: `src/lib/ui/budgets/BudgetForm.test.ts` › "shows the refused text exactly as
  typed" and `test/integration/beranda.test.ts` › "refuses a %s amount with a field error and writes nothing" (now
  expects `typed`).
- `xlsx-cpu.test.ts` flake: the 16 MB linear-time read gets a 10 s bound (about 0.3 s alone; a quadratic scan would
  take minutes) and a 30 s test timeout. A flake has no fail-before run; the bound still tells linear from quadratic.
