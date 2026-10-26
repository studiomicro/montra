# FN-55 Credit cards (FN-55a + FN-55b): security report

Reviewed: `git diff main...HEAD` at 53defaf (feat/fn-55-credit-cards on main 9414412), red-team worktree
`montra-worktrees/fn-55-rt`. Date 2026-10-13. Checked against the PRD (B3-B7) and `docs/ENGINEERING_CHECKLIST.md`.

## Verdict: PASS

No medium or high findings. Three low findings are listed below so they are tracked. L1 must be fixed before the
first real card parser lands (FN-55c), because it is reachable only through a card parser.

## Findings

### L1 (low, latent): a card row dated outside the printed period is accepted and moved back up to a year

`src/lib/shared/statements/card-rows.ts:244` (with `card-dates.ts:15-24`). A row's day-month takes the latest year
not after the statement date. The period printed on the statement (`card-rows.ts:210`) is checked against the
statement date only, never against the rows. A row printed `30/10` on a statement dated 25/10/2026 with period
26/09–25/10/2026 is stored as **2025-10-30**. The statement is still accepted: the balance identity, the class totals
and `balanceCheck` all hold, because the row's amount is real and only its date is wrong.

A shifted date column, or a row from the next cycle, therefore lands silently in last year's month totals, budgets
and reports.

PoC (deleted): integration import of `fictionalCardPdf` with rows `['30/10 30/10 TOKO PALSU 100.000,00']`, previous
2.000.000,00 and new 2.100.000,00 gave `ok: true` and a stored row with `occurred_on = 2025-10-30`.

Not reachable in production today: `STATEMENT_PARSERS` registers no `kind: 'card'` parser, and `FICTIONAL_CARD` is
imported only by tests and the harness test. Fix before FN-55c:
- When a period is printed, refuse a statement whose posting date (or its transaction date, when no posting date is
  printed) is outside `[periodFrom, periodTo]`.
- Bound a transaction date to a window before `periodFrom`, for example one cycle.

### L2 (low): the wallet-kind gate can be bypassed after import by moving a bank batch or changing the wallet type

There are two ways around the gate:
- `src/lib/server/imports/repo.ts:350`. Move restricts only card batches (a batch with a `card_statements` row) to
  card wallets. A bank statement batch, with its printed opening and closing balances and period, moves into a
  `kartu_kredit` wallet with no refusal.
- `src/lib/server/wallets/repo.ts:311`. Only the card→other type change is locked. A bank wallet that holds bank
  statement batches can be retyped to `kartu_kredit`.

Either way, bank rows and bank statement figures end up in a card wallet. That is exactly what `needs_bank_wallet`
refuses at import, "the sign would flip". The card's continuity then runs in card mode (`planContinuity(..., card)`),
and the card summary's owed, available credit and gap figures read bank-convention rows.

This affects only the user's own data in their own space. There is no cross-space access and no amount is invented.

PoC (deleted): `importStatement(FICTIONAL_BANK pdf → bank wallet)` gave `ok`, then
`moveImportBatch(batch → card wallet)` gave `{"ok":true,"moved":4}`. A direct import of the same file into the card
gave `needs_bank_wallet`.

Fix:
- Refuse a move of a batch that has a statement span (`period_from` set) and no card statement into a
  `kartu_kredit` wallet.
- Optionally, refuse other→`kartu_kredit` while the wallet holds live bank-statement batches.

### L3 (low): the card preview on /impor ignores "Sembunyikan nominal"

`src/routes/(app)/impor/+page.svelte:972-990`. The new card preview prints the payments, purchases, fees, minimum,
limit and wallet balance through `formatMoney` without `shown()`. With "hide amounts" on, these figures stay visible.
The bank preview on the same page has the same pre-existing behaviour.

In the same block, `c.totals.fees + c.totals.interest` is a Number addition. It is safe in practice, because each
term is at most `MAX_SAFE_INTEGER` and the statement already passed the BigInt identity. Still, compute it on the
server or use BigInt.

## Attacked and holding

- **Balance identity and forged rows.** The builder fails closed on all of these (unit PoC):
  - a shifted or extra amount cell (`amountCells !== 1`);
  - a description claiming a payment on a debit row (class follows direction only);
  - a planted letterhead or summary line (`structureBroken`, plus the `institution_conflict` test);
  - a second card number (`card_unsupported`);
  - a minimum above the amount owed;
  - a due date before the statement date or more than 60 days after it;
  - a period ending after the statement date;
  - a total mismatch;
  - more rows than `CSV_MAX_ROWS`.

  A cancelling +Y/−Y pair is accepted. This is the documented known limit (PRD B4, parser header).
- **Sen, grammar and overflow.** `id` and `en` grammars are fixed and need exactly two decimals:
  - `1.250`, `1.25,00`, a trailing `-`, full-width digits and `en`-on-`id` are all refused;
  - `0,01` gives 1 minor unit; `0,00 CR` gives 0;
  - zero-amount rows are refused;
  - amounts above `MAX_AMOUNT_MINOR` are refused;
  - 2000 rows of 99.999.999.999,99 (sum beyond 2^53) are refused (BigInt sums, then a safe-range check);
  - the D1 CHECKs bound the stored figures.
- **Mixed currency.** Only IDR card wallets accept a card statement (`card_currency`). A foreign original amount is
  kept in the note only and never parsed as an amount.
- **Wallet-kind gate at import.**
  - Card parser with a bank wallet or no wallet: `needs_card_wallet`. Bank parser with a card wallet:
    `needs_bank_wallet`.
  - The kind is derived from the server-side wallet (`getWallet(spaceId, id)`), never from the client.
  - `insertCardStatement` re-asserts `type = 'kartu_kredit'`, live wallet, live member and the 60-row cap inside the
    batch. `batchAssert` refuses the whole import if the row was not written.
  - The fictional issuer is not in `STATEMENT_PARSERS` and is imported only by tests and the harness test.
- **Dedupe and concurrency.**
  - The partial unique index `(space, wallet, statement_date) where deleted_at is null` refuses a second copy with
    other bytes.
  - After "Urungkan" the statement is tombstoned with its rows, so re-import is allowed. Same bytes keep the old
    dedupe keys, so the rows are not recreated.
  - 20 concurrent imports write one batch (existing test).
  - The card duplicate rule only flags; it never deletes.
- **KARTU KREDIT/PL pairing.**
  - `pairsOf` requires `c.space_id = d.space_id = spaceId`, a non-card debit wallet, a card credit wallet, tiles
    checked by kind, and the window `[d−1, d+3]` on WIB `occurred_on`.
  - Confirm re-checks the pair inside the insert, together with live membership and "no live link".
  - Re-pairing after undo goes through the same guarded path.
- **Card page `/dompet/kartu/[id]`.**
  - It calls `requireSpaceAccess`. A removed member gets 403/404.
  - The lookup is by `id + space_id + deleted_at is null + type`: another space's id, an archived card, a non-card
    wallet and an over-long id all return the same 404.
  - It is read-only. `__data.json` holds only the card's own figures and ids, with no secret or full number.
  - Amounts go through `shown()`.
- **Wallet form.**
  - The day fields accept `^\d{1,2}$` with 1–31 only.
  - A limit of 0 or less, above the cap, or with sen beyond the exponent is refused.
  - Card fields sent for a non-card type are refused with `CARD_FIELD_ONLY`, not ignored.
  - The DB CHECKs repeat the rules, including the type coupling.
  - The type lock holds card→other while statements are live, in the action and in the update guard.
- **`card_statements` and migration 0047.**
  - Space-scoped reads; content-free tombstone CHECK; ISO-date CHECKs.
  - The migration is a plain CREATE plus three `ALTER … ADD`: no rebuild and no data loss (migration-0047 test).
  - Space deletion deletes it before `import_batches` and `wallets`, so the FKs are satisfied. Export includes it as
    JSON.
- **Net worth.** A card with a negative balance is classed `debt`. A card at zero or in credit stays with the wallets.
  An owed card is never shown as an asset.
- **Secrets and PII.**
  - PDF passwords are used for the read only (AC 30 test).
  - `passwordHint` comes only from the parser registry, never from the request.
  - The card number is reduced to its last 4 before it is compared; it is never stored on `card_statements`.

## Commands run

- `npx vitest run src/lib/shared/statements/card-rows.test.ts`: 24 passed
- `npx vitest run src/lib/shared/cards.test.ts`: 9 passed
- `npx vitest run test/integration/migration-0047.test.ts`: 4 passed
- `npx vitest run test/integration/card-statements.test.ts`: 27 passed
- `npx vitest run test/integration/credit-cards.test.ts`: 24 passed
- PoCs `src/lib/shared/statements/poc-rt.test.ts` (5 cases) and `test/integration/poc-rt.test.ts` (2 cases) ran and
  were deleted. Results are quoted under L1 and L2 above.

## Resolution (2026-10-13)

- **L1 (card row outside the printed period):** `buildCardStatement` (`src/lib/shared/statements/card-rows.ts`) now
  refuses the whole statement when a row's posting date (or, with none printed, its only date) lies outside the
  printed period; the posting date must still be on or after the transaction date. A purchase dated in the previous
  cycle but posted in this one stays readable. The PRD defines no posting lag, so none is allowed past the period.
  Residual (documented): a statement that prints no period keeps the 400-day year rule. Regression tests:
  `card-rows.test.ts` › "red team L1" (fails on the cycle-1 code).
- **L2 (bank batch moved into a card):** `moveImportBatch` (`src/lib/server/imports/repo.ts`) refuses a `statement`
  batch without a card statement into a `kartu_kredit` wallet (`bank_statement_to_card`, 400, "Impor ini mutasi
  rekening. Pindahkan hanya ke dompet bukan kartu kredit.", English entry added), checked before the write and again
  in the guarded update; a card batch out of a card was already refused (`card_wallet_required`). CSV and spreadsheet
  batches may still move into a card (they carry no statement sign convention). Regression test:
  `card-statements.test.ts` › "red team L2" (fails on the cycle-1 code).
- **L3 (preview ignores hidden amounts; plain-number sum):** the card preview moved to
  `src/lib/ui/impor/CardStatementSummary.svelte`, every figure through `shown()`; fees + interest is summed on the
  server as BigInt (`feesAndInterestMinor`, null → "terlalu besar"). The Impor page now applies the eye's cookie at load
  and masks the statement block's other figures too (balance gap, duplicates, continuity gaps). Regression test:
  `CardStatementSummary.test.ts` (the masking test fails without `shown()`).

## Cycle 2 (re-check of `git diff 5d21cfd..550be5d`, 2026-10-13)

### Verdict: PASS

L3 is fixed. L1 and L2 are fixed for the paths reported in cycle 1. The residual gaps below are low. L1-R is latent:
the shipped `STATEMENT_PARSERS` is still `[BCA, BNI, MANDIRI, OCBC]`, with no `kind: 'card'` parser. Track L1-R as a
gate for FN-55c.

### L1: fixed for the reported case; residual L1-R (low, latent)

`card-rows.ts:255-264` now refuses a statement when a row's posting date (else its only date) lies outside the
printed period. PoC results:

| Rows (transaction date, posting date) | Result |
| --- | --- |
| `30/10 30/10` | `inconsistent`, nothing written (the cycle 1 case) |
| `25/09 25/09` (day before the period) | `inconsistent` |
| `20/09 27/09` (purchase in the earlier cycle, posted in this one) | `ok`, stored as 2026-09-20 (legitimate) |
| `30/10 01/10` | `ok`, stored as **2025-10-30** |
| `01/11 01/10` | `ok`, stored as **2025-11-01** |

The last two show what is left: only the posting date is bounded. The transaction date, which becomes `occurred_on`,
may still lie up to 400 days before the statement date. A transaction date read from a shifted or wrong column, with a
real posting date, still puts a correctly summed row almost a year early. Fix in FN-55c: bound the transaction date
too, for example `date >= periodFrom − 60 days` (or the previous statement date minus a cycle). `posted >= date`
already bounds it from above.

Without a printed period, the 400-day rule alone applies: `30/10` on a 25/10/2026 statement becomes 2025-10-30 and is
accepted. This is judged acceptable as a latent low *only* if each FN-55c parser for an issuer that prints no period
bounds rows another way. Options are the previous stored statement date, or the earliest posting date minus a cycle.
Record this in the FN-55c PRD.

### L2: fixed for statement batches; two judged residuals

- **Move.** `moveImportBatch` refuses `bank_statement_to_card` before the write (`imports/repo.ts:357`). The guarded
  update repeats the check as `bankGuard`, so a wallet retyped between the read and the write is still refused. PoC:
  move of a FICTIONAL_BANK batch into a card gave `{"ok":false,"reason":"bank_statement_to_card"}`. OCR screenshot
  batches also carry `source = 'statement'` (`ocr-import.ts:147`), so they are refused too, which errs safe.
- **CSV and spreadsheet batches into a card (judged acceptable).** Their rows state their own `type` per row, and they
  carry no printed opening, closing or period figures. Moving them into a card is equivalent to typing the same rows
  into it by hand. No sign is inferred, and the card's statement-to-statement continuity never reads them, because it
  only uses batches with a span.
- **Retype, still open (low).** A bank wallet holding bank-statement batches can still be retyped to `kartu_kredit`.
  PoC: `updateWallet(bank → kartu_kredit)` returned `ok` and the type is now `kartu_kredit`. Cycle 1 called this
  optional. The effect is the same as the old move: bank-convention statement figures inside a card, and card-mode
  continuity. Only the user's own data is affected. Keep it as a tracked low. A fix would be a guard
  `not exists (live statement batch without card_statements in this wallet)` on other→`kartu_kredit`.

### L3: fixed

`CardStatementSummary.svelte` sends every figure through `shown()`, including the wallet balance line.
`feesAndInterestMinor` is summed on the server as BigInt and goes through `safeMinor`, which gives null and "terlalu
besar" past the safe range. `CardStatementSummary.test.ts` covers the masking.

### Commands run (cycle 2)

- `npx vitest run src/lib/shared/statements/card-rows.test.ts`: 26 passed
- `npx vitest run src/lib/ui/impor/CardStatementSummary.test.ts`: 3 passed
- `npx vitest run test/integration/card-statements.test.ts`: 28 passed
- `npx vitest run test/integration/fn55-qa.test.ts`: 3 passed
- PoC `test/integration/poc-rt2.test.ts` (L1: 5 variants plus no period; L2: move and retype) ran and was deleted.
  Results are quoted above.

## Resolution (cycle 3)

- **L1-R (shifted transaction-date column):** `buildCardStatement` now also requires a row's transaction date to be
  on or after the printed period's first day minus `CARD_ROW_LAG_DAYS` (60) and on or before its posting date; the
  posting (or only) date stays inside the period. `30/10 01/10` and `01/11 01/10` on the 25/10/2026 statement are
  refused whole; `20/09 27/09` still imports (2026-09-20). A statement that prints no period is bounded from 60 days
  before its statement date (the residual noted in cycle 2 is closed). Regression tests: `card-rows.test.ts` ›
  "red team L1-R" (fail on the cycle-2 code).
- **L2 retype:** `updateWallet` refuses turning a non-card wallet into `kartu_kredit` while it holds a live account-statement
  batch (`bank_statements_locked`, 409, "Dompet ini punya mutasi rekening yang diimpor. Urungkan atau pindahkan impor
  itu dulu untuk menjadikannya kartu kredit.", English entry added), inside the guarded update itself, so a race cannot
  slip past. Regression test: `card-statements.test.ts` › "red team L2 retype" (fails on the cycle-2 code).
- **No printed period (FN-55c contract):** the PRD's FN-55c paragraph now states that every issuer parser's rows are
  bounded by the printed period or from 60 days before the statement date, and that a result with neither a period
  nor a statement date is refused; `card-rows.test.ts` › "FN-55c contract" asserts the refusal.

## Cycle 3 (re-check of `git diff 550be5d..59a5b9e`, 2026-10-13)

### Verdict: PASS

L1-R and the no-period gap are fixed. The L2 retype is fixed. One new low residual (L2-R, below) is tracked. Every
other open item from cycles 1 and 2 is closed.

### L1-R and the no-period gap: fixed

`card-rows.ts:261-269` checks two things for every row:
- the posting date (else the only date) must lie in `[periodFrom, periodTo]`, or in `[statement − 60, statement]`
  when no period is printed;
- the transaction date must be on or after that window's start minus 60 days. `posted >= date` already bounds it
  from above.

A result with neither a period nor a statement date is refused by the existing statement-date requirement.

PoC on the fictional parser (deleted). Base case: statement 25/10/2026, period 26/09–25/10.

| Variant | Result |
| --- | --- |
| cycle 1 `30/10 30/10` | refused |
| cycle 2 `30/10 01/10` and `01/11 01/10` | refused |
| transaction date at the edge, period start − 60 (`28/07`, posted `27/09`) | ok, 2026-07-28 |
| transaction date at period start − 61 (`27/07`) | refused |
| row on the last period day (`25/10`) | ok |
| year wrap, statement 05/01/2027, period 06/12–05/01 | `28/12` gives 2026-12-28 ok; `03/01`/`04/01` gives 2027-01-03 ok; `07/10` posted `06/12` (−60) ok; `06/10` (−61) refused; `10/01` (after the statement) refused |
| leap day, statement 05/03/2028 | `29/02` gives 2028-02-29 ok |
| leap day, statement 05/03/2027 | `29/02` refused |
| no period | `30/10` refused; posted `26/08` (−60) ok; posted `25/08` (−61) refused; transaction `27/06` posted `26/08` (−120) ok; transaction `26/06` refused; `30/10` posted `01/10` refused |

### L2 retype: fixed

`updateWallet` (`wallets/repo.ts:333-335`) guards other→`kartu_kredit` in the update itself: no live statement batch
without a card statement. It answers `bank_statements_locked`, which the action maps to a 409.

PoC results:
- retype of a bank wallet holding a bank statement: `bank_statements_locked`;
- a normal edit that stays bank: `ok`;
- after "Urungkan": retype `ok`;
- a card wallet holding a card statement, edited and staying a card: `ok`.

### L2-R (low, new residual): a retype racing a bank-statement import

The import's batch has no wallet-type guard for account statements. `insertCardStatement` guards the card side; the
bank side is unguarded. A retype to `kartu_kredit` that commits between the import's wallet read (`prepare`) and its
`db.batch` therefore still writes the bank rows into a card. The retype itself passes its guard, because no statement
batch exists yet at that moment.

PoC (deleted): a parser wrapper fired the retype during `parse`. The import returned `ok`, the wallet type was
`kartu_kredit`, and 4 rows were written.

This needs two concurrent requests in the same space, by the user or a co-member, within milliseconds. It affects
only that space's own data; nothing crosses spaces and no amount is invented. Fix when convenient: add the batch
assertion `exists (wallet live and type <> 'kartu_kredit')` for non-card statement imports, mirroring
`insertCardStatement`.

### Commands run (cycle 3)

- `npx vitest run src/lib/shared/statements/card-rows.test.ts`: 31 passed
- `npx vitest run test/integration/card-statements.test.ts`: 29 passed
- `npx vitest run test/integration/fn55-calendar-qa.test.ts`: 1 passed
- `npx vitest run test/integration/credit-cards.test.ts`: 24 passed
- PoCs `src/lib/shared/statements/poc-rt3.test.ts` (19 date variants) and `test/integration/poc-rt3.test.ts` (retype
  lock and race) ran and were deleted. Results are quoted above.
