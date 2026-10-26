# FN-55 Credit cards: a first-class card wallet and credit card e-statement import

Owner request 2026-10-13: "add Credit card also, and add creditcard e-statement import parser". Branch
`feat/fn-55-credit-cards` from main 73694d2. Catalog entry: `docs/FEATURES.md` › FN-55 (added with this PRD).

**Risk tier: Large** (`.claude/commands/build-feature.md`: migration, money calculation, new external input). The
work is delivered in three bounded passes so no single `/build-feature` cycle carries everything:

- **FN-55a, card wallet** (Part A): migration, wallet form, card page, net-worth liability, bill-payment matching.
  Buildable now, needs nothing from the owner.
- **FN-55b, card statement import infrastructure** (Part B, except per-issuer parsers): shared card-statement types,
  the strict self-check, card batch storage, preview, dedupe, continuity, undo, move. Buildable now, proven with a
  **test-only fictional issuer**. It registers **no real issuer**.
- **FN-55c-<issuer>, one parser per issuer**, each a small follow-up run **only after the owner supplies that
  issuer's sample** (see Owner decisions, "Samples the owner must provide"). Until a sample exists the issuer is
  "waiting for sample" and a parser is never written from memory or guesswork (FN-16a owner decision A,
  `src/lib/shared/statements/parsers.ts:7-11`).
  Each FN-55c parser must bound every row's dates: by the printed period when the statement prints one, else from
  60 days before the statement date (`CARD_ROW_LAG_DAYS`, enforced by `buildCardStatement`, red team L1-R); a parse
  result with neither a period nor a statement date is refused (`buildCardStatement` requires the statement date).

FN-55a and FN-55b may ship in one cycle (they share the migration). FN-55c runs are not part of this cycle.

## Goal

Montra tracks bank accounts, e-wallets and cash well, but a credit card is only a wallet whose opening balance can be
typed negative (`src/lib/shared/wallets.ts:4,74`; `src/lib/ui/wallets/WalletForm.svelte:139`). It has no limit, no
statement or due day, no "what is on my last bill", no "how much is still unbilled", no way to read the bank's
monthly e-statement, and paying the card from a bank account shows up as an ordinary expense (the imported bank
debit "KARTU KREDIT/PL …", `src/lib/shared/merchants/bank-narratives.ts:83,158`) next to the card's own purchases,
so the same money is counted twice. Many Indonesians pay most of their month through a credit card, so this is the
biggest hole left in the "one clear monthly number". This feature makes the card a first-class wallet: spending is
counted on the **purchase date**, paying the bill is a **transfer** from a bank wallet (never an expense), the card's
balance is a **liability** in net worth, and the monthly **e-statement can be imported** through the same fail-closed
statement pipeline as bank statements (FN-16), so a month of card spending appears from one PDF. Montra stays an
information tool: every figure is computed from stored rows or printed on the statement, the minimum payment is shown
exactly as printed and never computed, and nothing advises the user what to pay.

## Current behaviour (so the engineer does not rediscover it)

- A card is a wallet with `type = 'kartu_kredit'` (`WALLET_TYPES`, `src/lib/shared/wallets.ts:4`; DB CHECK
  `migrations/0003_wallets.sql:21`; `src/lib/server/db/schema.ts:497-526`). There are no limit, statement-day or
  due-day columns. `last_four` exists and is already limited to 4 digits (`0003_wallets.sql:22`).
- Owed money is a **negative balance**: the form's "negative" box makes the opening balance negative
  (`src/lib/server/wallets/validation.ts:39-47`, owner decision D). Balance = opening + signed rows
  (`src/lib/server/transactions/wallet-sum.ts:10-12,23-45`): an expense lowers it, an income or a transfer in raises it.
  So a purchase on the card deepens the debt and a transfer from a bank wallet to the card reduces it, and that
  transfer is not income or expense (`src/lib/server/transactions/aggregate.ts:150` `MONEY_ROWS` sums only expense and
  income). Purchases already count in the month of their `occurred_on` (the WIB purchase date).
- Net worth: every wallet balance, a card's negative one included, lands in the `wallets` class
  (`src/lib/server/net-worth/summary.ts:100-103`); only `debt` items are liabilities (`src/lib/shared/net-worth.ts:52`).
  `/kekayaan` has one `CreditCardCard` per card with the 30-day spend (`src/lib/server/net-worth/credit-cards.ts:27-52`,
  `src/lib/ui/net-worth/CreditCardCard.svelte:11` "Statement and due days come with FN-25c").
- Bank statement import reads a bank's own mutation list. A debit "KARTU KREDIT/PL … BCA CARD" is categorised to the
  `kartu-kredit` expense tile (`bank-narratives.ts:158`, `src/lib/shared/transactions.ts:114`) and counted as spending.
  FN-48 Part C ("Cocokkan transfer") only pairs a `transfer`-tile debit with a `transfer`-tile credit in two wallets
  (`src/lib/server/transfers/match.ts:34-48`), so a card-bill debit is never paired.
- Statement parsing: a parser returns rows plus printed opening/closing balances (`src/lib/shared/statements/types.ts:31-48`);
  amounts go through `statementRow` and `parseMoneyAmount` (`rows.ts:52-81`), amounts are IDR only
  (`src/lib/shared/csv.ts:206-220` `currency: 'IDR'`); the balance check is warn-only, "opening + rows = closing"
  (`rows.ts:91-99`); a parser's own `inconsistent` flag refuses the whole file (`src/lib/server/statements/read.ts:185-186`);
  a letterhead conflict refuses it (`read.ts:172-173`); passwords are used once and never stored
  (`src/lib/server/statements/pdf-text.ts:47`, `read.ts:131`). No parser reads a card statement; Mandiri's
  consolidated layout lists a "Kartu Kredit" summary section and refuses it (`mandiri.ts:318`).
- Statement continuity (FN-48B) windows the wallet's rows by `occurred_on` between the previous statement's last row
  date and this statement's first row date, with the span taken from the min/max row date
  (`src/lib/server/statements/continuity.ts:50-66,107-121,156-174`; `wallet-sum.ts:77-92`).
- Duplicate flag today is the **same WIB date, type, amount and title, in any wallet**
  (`src/lib/server/imports/csv-import.ts:181-207`), not "within a day in the same wallet" as `docs/FEATURES.md` FN-16
  describes. A card transaction's date and its posting date can differ by days and the statement title rarely equals a
  hand-typed one, so this rule will not catch a card purchase already entered manually.
- Dedupe key is `statement:<sha256 of the file bytes>:<row index>` (`statement-import.ts:98-121`). A re-downloaded PDF
  of the same statement usually has different bytes, so it gets different keys.
- Foreign currency: transactions are stored in the wallet's currency (`schema.ts:626-640`); there is no
  `original_amount_minor` column anywhere in `src/` or `migrations/` (grep, 2026-10-13); `docs/ACCEPTANCE.md:48` "Foreign
  currency converted at the day's rate, original kept" is **Not run**.

## Scope

### Part A (FN-55a): the card wallet

**A1. Card fields on the wallet** (migration, see Architecture notes). For `type = 'kartu_kredit'` only:
`credit_limit_minor` (optional, the limit in the wallet's currency), `statement_day` (optional, 1-31, the day the bill
closes), `due_day` (optional, 1-31, the day payment is due). These are the exact column names `docs/features/fn-25b-wealth-page/PRD.md`
reserved, so FN-25c's "credit-card statement/due days" half is delivered here and not twice. The add/edit wallet form
(`src/lib/ui/wallets/WalletForm.svelte`, `src/lib/server/wallets/validation.ts`) shows the three fields and reworded
balance copy only when the type is "Kartu kredit": "Tagihan berjalan sekarang (utang)" typed as a positive amount and
stored negative, with an explicit "Kartu ini sedang lebih bayar (saldo kredit)" box for the rare positive balance. A
day field outside 1-31, a limit that is not a positive amount of the wallet's currency, or any of the three on a
non-card wallet is refused, never ignored. Changing a card wallet's type away from `kartu_kredit` while it has live
`card_statements` is refused with a message; changing a wallet into a card is allowed.

**A2. Card summary (computed, never typed).** One server function computes, from stored rows plus the last stored card
statement's printed figures, for each live card wallet, in the wallet's currency:

- *Utang sekarang* = the negative of the wallet balance (`walletTransactionsSums` + opening, the FN-04 contract
  `src/lib/server/wallets/balance.ts:6-13`); a positive balance shows as "Saldo kredit".
- *Limit kredit* (typed) and *Kredit tersedia* = limit minus *Utang sekarang*, in rupiah, never as a percent (design
  system: rupiah not percent). Above the limit shows "Melebihi limit" and never a negative available figure. The
  statement's printed "available credit" is not used (it is stale the day after printing).
- *Tagihan terakhir* (only when a card statement is stored): statement date, due date, printed new balance, and the
  **printed** minimum payment, each only as printed on the stored statement; a figure the statement did not print is
  absent, never filled in. Label for the minimum: "Pembayaran minimum (tertera)".
- *Sudah dibayar sejak tagihan* = sum of transfers into the card plus income rows tagged with the `transfer` tile, dated
  strictly after the statement date (a row dated on the statement date is already inside the printed balance).
  *Sisa tagihan* = max(0, printed new balance minus that sum), shown "Lunas" at 0. *Belum ditagih* = purchases and fees
  (expense rows) minus other income rows (refunds), dated strictly after the statement date.
- Reconciliation guard: when a statement is stored and *Utang sekarang* is not equal to printed new balance minus paid
  plus unbilled, the card shows "Saldo dompet tidak cocok dengan tagihan terakhir (selisih Rp X)" with a link to the
  existing FN-37 balance-adjustment form. It never hides the mismatch and never writes an adjustment by itself.
- Due soon: with a stored statement, its printed due date; otherwise the next occurrence of `due_day` on or after
  today's WIB date (a day beyond the month's length is clamped to the month's last day). Shown as "Jatuh tempo dalam N
  hari" or "Jatuh tempo hari ini" or "Lewat N hari" (while *Sisa tagihan* > 0). A card with no dates shows a "Tambah
  tanggal" prompt, as `docs/features/fn-25b-wealth-page/PRD.md` §5 specified.

No interest estimate, no "pay at least", no utilisation score and no recommendation anywhere (product boundary: not
advice).

**A3. Where it shows.**
- `/dompet`: a card row shows the owed amount (negative, as today), a second line "Kredit tersedia Rp X" when a limit is
  set, and a "Jatuh tempo …" chip when dates exist. Total saldo is unchanged (it already nets the card).
- New `/dompet/kartu/[id]` page, only for live `kartu_kredit` wallets of the current space (any other id, another
  space's id, an archived id: the same 404): the A2 summary, a "Bayar tagihan" action, the stored statements list
  (date, new balance, due date) with a link to Riwayat impor, and the count of unmatched bill payments (A5).
- "Bayar tagihan" opens the existing transfer form (`/riwayat/baru`) prefilled: from = the wallet the user picks, to =
  this card, date = today (WIB), amount empty with two optional fill chips "Tagihan terakhir (tertera)" and
  "Pembayaran minimum (tertera)" that copy a printed figure into the amount field for the user to confirm. It adds no
  new write path: saving is FN-05's transfer, so a payment is never an expense and never income.
- `/kekayaan`: `CreditCardCard` keeps its 30-day spend and gains the due chip and *Kredit tersedia*; the "Statement and
  due days come with FN-25c" comment goes. Hidden amounts stay hidden under the eye toggle (FN-25b).

**A4. Net worth: the card balance is a liability.** A `kartu_kredit` wallet with a negative balance is counted in the
`debt` class (negative), not inside `wallets` (`summary.ts:100-103`); a card with a zero or positive balance stays in
`wallets`. The **total is unchanged** (the debt was already subtracted inside `wallets`); only the class split and the
Utang line change, and a debt is still never a bar segment (FN-25b). See Owner decision 8 for the one-day effect on
FN-53's per-group change after deploy.

**A5. Paying the card bill is a transfer: pairing imported rows (extends FN-48 Part C).** "Cocokkan transfer"
(`src/lib/server/transfers/match.ts`) gains a second kind of candidate pair, **card payment**: a debit that is a live
non-demo `expense` row in a non-card wallet whose category tile is `kartu-kredit` or `transfer`, and a credit that is
a live non-demo `income` row in a `kartu_kredit` wallet whose tile is `transfer`; same `amount_minor` and `currency`;
credit date from 1 day before to 3 days after the debit's WIB date (owner decision 5; the existing ±1 day pair rule
is unchanged for every other pair). Everything else is the existing behaviour and is reused: per-pair confirmation,
ambiguous groups shown whole and never picked for the user, the merge into one FN-05 transfer from the bank wallet
to the card, the credit tombstoned with its dedupe key kept, one-step undo (`transfer_links`, migration 0043), stale
and cross-space refusals. A bank debit "KARTU KREDIT/PL …" with no card wallet or no card statement to pair with stays
a counted expense (it may be the user's only record of that card's spending); nothing is auto-merged.

**A6. Fees, interest, refunds, annual fee, installments, foreign currency (rules for stored rows).**
- Fees, interest charges, late charges, annual fee and overseas-transaction fees are **expense** rows in the card
  wallet on the date printed, category tile `biaya-bank` (tax/PPN lines: `pajak`). They are never netted into purchases.
- A refund or credit is an **income** row in the card wallet on its printed date (owner decision 4: counted as income,
  not netted against the original purchase). A payment line on the statement is an income row with the `transfer`
  tile ("Transfer masuk"), feeding A2's "paid" and A5's pairing.
- Installments (cicilan 0%): each monthly installment line printed on a statement is an expense row on its printed
  date, with the printed marker ("Cicilan 3/12") kept in the note. No schedule, remaining-balance or future line is
  created. A manual installment is entered as an FN-36 monthly series with an end date on the card wallet (existing
  feature, `migrations/0023_recurring.sql` `end_on`); the card page links to it in one help line (owner decision 6).
- Foreign-currency card purchase on an IDR card: the stored amount is the **IDR amount the bank billed**; the original
  amount and currency as printed (e.g. "USD 12,50") are kept in the row's note (cleaned and masked), and no rate is
  derived or stored (owner decision 7; `docs/ACCEPTANCE.md:48` stays Not run). A card wallet in a foreign currency
  (FN-47) accepts manual rows with cents and is refused by the statement import ("hanya dompet IDR", the existing
  `unsupported_currency` posture).

### Part B (FN-55b): credit card e-statement import

**B1. Card statements are a distinct parser kind.** `StatementParser` gains `kind: 'bank' | 'card'` (default `bank`; every
existing parser unchanged) and `StatementParse` gains an optional `card` block (statement date, due date, printed
period, previous balance, new balance, minimum payment, limit, printed card last 4, the printed totals block, printed
installment markers). Card issuers get their own parser ids (`bca-card`, `mandiri-card`, `bni-card`, `cimb-card`,
`ocbc-card`) and labels "BCA Kartu Kredit" and so on, because the result needs a card wallet and the sign convention
differs; they are **not** a second layout inside the bank parser (unlike FN-16h, which kept one user-facing OCBC).
The Impor wallet picker (FN-16i) decides what is offered: a `kartu_kredit` wallet offers and auto-detects only card
parsers; any other wallet only bank parsers. A card statement uploaded into a non-card wallet, or a bank statement
into a card wallet, is refused (`institution_mismatch` with its own message), because the sign convention would flip.
The catalogue (`src/lib/shared/statements/catalogue.ts:26-47`) lists each planned card issuer as a disabled row
"Belum didukung" with the alternatives "Spreadsheet/CSV" or "catat manual" until its parser exists.

**B2. Sign convention (reuses the existing balance check unchanged).** A card parser reports balances in the **wallet's
convention**: owed is negative. Printed previous balance P owed becomes `openingBalanceMinor = -P`; printed new
balance N owed becomes `closingBalanceMinor = -N`; a printed credit balance ("CR") is positive. Purchases, fees,
interest and installments are `debit` rows (expense); payments, refunds and credits are `credit` rows (income). So
`balanceCheck` (`rows.ts:91-99`: opening + sum of signed rows = closing) holds exactly when previous − payments −
credits + purchases + fees = new. Direction comes only from the printed column, sign or CR/DB marker, never from the
description text.

**B3. Fields read** (all through `parseMoneyAmount` / `statementRow`; integer sen; `Rp`, IDR only):

| Field | Needed | Rule |
| --- | --- | --- |
| Statement date | required | WIB date; refuse if missing |
| Previous balance, new balance | required | both, else refuse (no "omitted" for cards) |
| Due date | optional | stored; if printed must be on or after the statement date and within 60 days of it, else treated as unreadable and refused |
| Minimum payment | optional | stored **as printed** only, never computed; if printed it must not exceed a positive new balance |
| Credit limit | optional | stored as printed on the statement record; proposed to the wallet only on the user's tick, never auto-written |
| Printed totals (payments, purchases, fees/interest) | optional | when printed, each must equal the sum of the rows of that class |
| Per row: transaction date, posting date, description, amount, direction | required | see date rule below |
| Foreign-currency original amount | optional | kept in the note only (A6) |
| Installment marker | optional | kept in the note only (A6) |
| Printed card last 4 | required if any number is printed | masked to the last 4 before anything is kept |
| Printed period | optional | else see continuity (B7) |

Row date: `occurred_on` = the **transaction (purchase) date**; if only one date is printed it is that one. A day-month
date without a year takes the year that makes it the **latest real date not after the statement date and within 400
days before it** (so `28/12` on a 2026-01-05 statement is 2025-12-28), else the row is unreadable. The posting date
is read for validation only (on or after the transaction date, not after the statement date) and is not stored.
Indonesian and English month spellings are read as the sample prints them.

**B4. The self-consistency check (fail closed, stricter than bank statements).** A card statement is imported only when
**all** hold, else the whole file is refused as `inconsistent` and **nothing is written** (no rows, no batch, no
`card_statements`): (1) every row is readable, a rejected row is a refusal, not a warning (bank statements only warn,
`rows.ts:84-90`); (2) previous balance minus payments minus credits plus purchases plus fees plus interest equals the
printed new balance, as BigInt; (3) opening plus the signed sum of all rows equals the closing (the existing
`balanceCheck` returns `pass`); (4) every printed class total (payments, purchases, fees, interest) equals the sum of its
rows; (5) the rows are not cut by the row cap (a statement past `CSV_MAX_ROWS` is refused, not truncated); (6) every page
shows the same statement date and the same printed card; (7) the page and table structure is intact (see B5). The bank
parsers' known limit (a crafted remark adding a cancelling fake +Y/-Y pair) is accepted and documented in the parser
header exactly as FN-16f/16h did.

**B5. Untrusted input rules (red team rules from FN-16b/e/f/h, binding on every card parser).** Third-party text (merchant
descriptions, installment notes, reference lines) never decides an amount, a direction, a date or the document
structure. A row has exactly one amount-shaped line in its group; zero or two make it unreadable. A header, summary,
totals, "saldo sebelumnya", statement-date or legal line inside the table body, a table line outside a table, a
second letterhead (`letterheadClaims`, `detect.ts:97-104`), or a repeated section refuses the whole file. Row starts
are gated by the column they start in using `PageLayout.lineX` (`types.ts:23-26`) once the sample shows the real
columns. Fixed amount grammar per issuer (fixed two-decimal regexes, as OCBC's `AMOUNT`), never "1.250" guessed. Card
numbers are reduced to the last 4 digits before anything is stored or shown (`maskAccountNumbers`,
`statement-import.ts:68-69` order: mask, then cut). No parser reads a value from text it was not designed to read.

**B6. Passwords.** Card e-statement PDFs are commonly password-protected. The existing flow stays: the password is used
for this read only, never stored or logged (`pdf-text.ts:47`, `read.ts:131`). A parser may carry an optional
`passwordHint` (a `msg()` phrase) shown with the "needs password" and "wrong password" answers
(`src/lib/server/imports/messages.ts:64-67`). A hint is written **only** from the issuer's own e-statement e-mail or
cover text supplied by the owner, as FN-16h recorded OCBC's; until then the generic "Masukkan kata sandi PDF yang
diberikan bank" is shown and no hint is invented.

**B7. Storage, dedupe and continuity.**
- New table `card_statements` (one live row per imported card statement: wallet, import batch, statement date, due date,
  period, previous and new balance in the wallet's convention, printed minimum payment, printed limit, currency; no
  text, no file, no card number). Written in the **same `db.batch` as the import**, guarded; undoing the batch
  tombstones it in the same batch; FN-16j's "Pindahkan ke dompet lain" (`src/lib/server/imports/repo.ts:295`) moves the
  row with the batch and refuses a destination that is not a live same-currency `kartu_kredit` wallet.
- Statement-level dedupe: a unique index on (space, wallet, statement date) for live rows. Importing a second PDF of a
  statement already stored (different bytes, same statement date) is refused "Tagihan ini sudah diimpor" before any row
  is considered. File-hash row keys (`statement:<hash>:<index>`) stay as the second line of defence.
- Row-level duplicates for a card batch: in addition to today's rule (`csv-import.ts:181-207`), a row is flagged "Mungkin
  duplikat" (excluded, tappable) when the same card wallet already has a live, real row of the same type, amount and
  currency dated within 3 days of its transaction date (title ignored). This catches a purchase typed by hand or captured
  from Gmail before the statement arrived. Overlapping statements are caught by the statement-level rule and this one.
- Continuity (FN-48B) works for cards with a **statement-to-statement** rule: the printed previous balance must equal
  the nearest earlier stored card statement's printed new balance; no earlier statement gives "no claim" with the wallet's
  balance shown for information. A card batch's span is its **printed period** (or, if only the statement date is printed,
  the day after the previous stored statement's date to the statement date, else the earliest posting date to the
  statement date), never the min/max transaction date, and its own rows are never inside its own comparison window, so a
  purchase dated in the previous cycle but posted in this one cannot produce a false gap or a false pass. A gap is shown
  with both figures and may be closed with the existing "Catat penyesuaian" (FN-37 row dated the day before the period).
- The bill payment line on the statement (a credit row, "Transfer masuk") is the card side of A5's pairing: after import
  the Impor page's existing "Cocokkan transfer" card counts it, and the card page shows how many payments are unmatched.

**B8. Import UI.** `/impor` (existing, no new route): after the user picks a card wallet and a file, the preview shows the
card summary (statement date, due date, previous balance, payments, purchases, fees and interest, new balance, minimum
payment as printed, limit as printed), the balance check, continuity, the possible-duplicate list, the rows with their
tabs, and "Masukkan N transaksi". The existing loading, empty, error, saving and success states, undo and import history
apply. Refusals reuse the existing messages and add the card-specific ones (wrong wallet kind, statement already
imported). No bank PIN, password for the bank site or OTP is ever requested: the PDF password is the document's own.

**B9. Local verification harness.** `npm run compat:statements` (`scripts/compat-statements.ts`) prints card results as
counts and pass/fail lines only (never a path, file name, card number, description or amount), so the owner can run a
real sample without anything leaving the machine.

### i18n

Every new Indonesian phrase gets an English entry in `src/lib/shared/i18n-en.ts` (`i18n.test.ts` fails otherwise),
including `trf()` templates and server messages. Indicative set: "Tagihan berjalan sekarang (utang)", "Saldo kredit",
"Limit kredit", "Kredit tersedia", "Melebihi limit", "Tanggal tagihan", "Tanggal jatuh tempo", "Jatuh tempo dalam {n}
hari", "Jatuh tempo hari ini", "Lewat {n} hari", "Tagihan terakhir", "Pembayaran minimum (tertera)", "Sudah dibayar sejak
tagihan", "Sisa tagihan", "Belum ditagih", "Lunas", "Bayar tagihan", "Saldo dompet tidak cocok dengan tagihan terakhir
(selisih {amount})", "Tagihan ini sudah diimpor", "Ini tagihan kartu kredit; pilih dompet kartu kredit", "Ini mutasi
rekening; pilih dompet bukan kartu kredit", "Pembayaran kartu belum dicocokkan", and the card-pair labels on
"Cocokkan transfer". No phrase recommends an amount to pay or projects interest.

## Out of scope

- Any real issuer parser in FN-55a/b: each is its own FN-55c run after its sample exists. No layout is guessed.
- Scanned or image-only card statements and phone screenshots (FN-16g's on-device OCR path), CSV/XLS card exports,
  card statements arriving as Gmail attachments (FN-19 never opens attachments); the user downloads the PDF and uploads it.
- A due-date push reminder: FN-24's kinds are a CHECK-constrained list on three tables (`migrations/0012_notifications.sql`;
  `src/lib/shared/notifications.ts:14-22`), so a `card_due` kind needs table rebuilds, a trigger and a settings row.
  Deferred (owner decision 3); the in-app due chip ships.
- Interest calculation, payoff planning, utilisation or credit-score displays, "how much should I pay" guidance, rewards
  or points tracking, card benefit tracking.
- An installment tracker (remaining months, remaining principal, schedule), netting a refund against its purchase,
  storing the original foreign amount and rate in new columns, supplementary-card spend per cardholder views.
- Auto-creating the bank-to-card transfer on import or auto-merging without a per-pair confirmation.
- Public API fields for the card data, assistant (Tanya) tools reading card statements, agent reports. (Wallet rows keep
  appearing in the API unchanged.)
- Connecting to a bank or card issuer, reading balances live, bank login, PIN or OTP of any kind. Never.
- Piutang asset kind (the other half of FN-25c) stays open.
- Changing `MONEY_ROWS`, budgets, safe-to-spend or Laporan arithmetic: they already count purchases on `occurred_on` and
  transfers never; this feature adds tests proving it, not code.

## Acceptance criteria

Verification level in brackets: **Automated** = Vitest on local D1 with fictional fixtures; **Browser** = Playwright on
`wrangler dev`; **Mocked** = fake provider; **Pass** = real runtime or real owner sample. Fixtures are fictional only
(invented names, round numbers, made-up card numbers such as `4111 11** **** 0001`); no value from any real statement
is committed.

**Card wallet (Part A)**

1. Given a signed-in member, when they add a wallet of type Kartu kredit with limit `Rp 15.000.000`, statement day 25,
   due day 12, last 4 `0001` and current debt `Rp 1.250.000,50`, then the wallet saves with opening balance `-125000050`
   sen, `credit_limit_minor = 1500000000`, the card shows the debt as `−Rp 1.250.000,50`, and the values survive a reload.
   [Automated, Browser]
2. Given the same form with type Bank, when statement day, due day or limit is sent, then the write is refused with a
   field message and nothing is stored (hidden fields are not authorization). [Automated]
3. Given day values 0, 32, "12.5", "", a limit of 0, `-1`, `1.000.000,001` or a limit past `10^13` sen, then each is
   refused; "" clears the optional field; nothing is rounded. [Automated]
4. Given a card with live statements, when its type is changed to Bank, then the edit is refused with the message and the
   wallet is unchanged; given a Bank wallet, when changed to Kartu kredit, then it succeeds with no card fields set.
   [Automated]
5. Given a card with limit L and debt D, then Kredit tersedia = L − D to the sen; given D > L, then "Melebihi limit" and
   no negative figure; given no limit, then no available line; given a positive balance, then "Saldo kredit" and no
   "utang". No percent is displayed anywhere on the card. [Automated]
6. Given a stored statement with date S, printed new balance N and due date Dd, and rows after S, then *Sudah dibayar*,
   *Sisa tagihan* and *Belum ditagih* follow A2 exactly, using only rows dated strictly after S; a transfer-in dated on
   S is not counted as paid; a payment larger than N shows "Lunas" and never a negative remainder. Vectors: N =
   `125000050`, payment `100000000` → remainder `25000050`. [Automated]
7. Given a mismatch between the wallet's balance and N − paid + unbilled, then the card shows the reconciliation line with
   the exact difference and links to the FN-37 form; no adjustment row is written by viewing. [Automated]
8. Given due_day 31 and today 2026-02-10 (WIB), then the next due date is 2026-02-28; given today 2028-02-10, 2028-02-29;
   given today 2026-02-28 and due_day 28, "Jatuh tempo hari ini"; given a stored statement with due date earlier than
   today and *Sisa tagihan* > 0, "Lewat N hari" with N by WIB calendar days. Today comes from the WIB date of `now`, so
   23:30 WIB on the 27th and 00:30 WIB on the 28th differ by one day. [Automated]
9. Given the card page `/dompet/kartu/[id]`, when opened by a member of the space, then it shows A2; given another
   space's card id, an archived id, a Bank wallet id or a malformed id, then all four answer the same 404 (status, body,
   timing class). A removed member gets the same 404 on the card page, the form action and the import. [Automated]
10. Given "Bayar tagihan" saved with a bank wallet as source, then one transfer row exists (type transfer, bank → card),
    the bank balance drops and the card's debt drops by the same sen, Beranda/Laporan/budget spending and income totals are
    unchanged, and the Riwayat total for the same filter equals the Beranda figure. [Automated]
11. Given a card purchase of `Rp 25.000` at 23:30 WIB on 2026-10-31 and a bill payment of `Rp 25.000` on 2026-11-05,
    then October's spending includes the purchase, November's spending does not include the payment, and a purchase at
    00:30 WIB on 2026-11-01 lands in November. [Automated]
12. Given a card in the net-worth summary with balance `−125000050`, then the `debt` class holds `−125000050`, the
    `wallets` class excludes it, the **total is identical** to the pre-change total for the same data, no bar segment is
    drawn for it, and a card with balance ≥ 0 stays in `wallets`. The 30-day snapshot comparison on the total is
    unchanged. [Automated]
13. Given the eye toggle hides amounts, then the new card figures (utang, available, last bill, paid, unbilled) are hidden
    on `/dompet`, the card page and `/kekayaan` exactly as other amounts. [Browser]
14. Given a bank debit "KARTU KREDIT/PL …" of `Rp 1.000.000,00` on 2026-10-12 (expense, tile kartu-kredit) in a bank wallet
    and a card payment credit of the same amount on 2026-10-14 (income, tile transfer) in a card wallet, then "Cocokkan
    transfer" lists the pair; confirming merges them into one transfer bank → card, tombstones the credit with its dedupe
    key kept, and the bank wallet, card wallet and totals are right; undo restores both rows exactly. [Automated]
15. Given the same debit and a credit dated 2026-10-16 (4 days later), then no pair is offered; given a credit 1 day
    before the debit, a pair is offered; given two same-amount candidate credits, then the group is shown whole as
    ambiguous and nothing is preselected; given different amounts by one sen, no pair. [Automated]
16. Given a bank debit in the kartu-kredit tile and no card wallet, then it stays a counted expense and no match is
    proposed; given a credit in a non-card wallet, the card-pair rule does not apply (only the existing transfer-tile rule).
    [Automated]
17. Given a fee line `Rp 75.000,00` and an interest line `Rp 123.456,78` imported or typed on a card, then each is an
    expense in the card wallet on its date and is counted in that month's spending with tile `biaya-bank`; given a refund
    `Rp 50.000,00`, then an income row on its date; neither is netted against another row. [Automated]
18. Given an IDR card and a foreign purchase whose statement prints "USD 12,50" and billed `Rp 205.000,00`, then the row is
    `20500000` sen in IDR with the original text in the note and no rate stored; given a USD card wallet, manual entry
    `12,50` stores `1250` and the statement import is refused with the IDR-only message. [Automated]

**Card statement import (Part B), tested with a test-only fictional issuer**

19. Given the fictional card statement fixture (previous `Rp 2.000.000,00`, payments `Rp 2.000.000,00`, purchases
    `Rp 1.250.000,50`, fee `Rp 75.000,00`, new `Rp 1.325.000,50`, minimum `Rp 100.000,00`, limit `Rp 15.000.000,00`), when
    imported into a card wallet, then rows are created with source `statement`, `openingBalanceMinor = -200000000`,
    `closingBalanceMinor = -132500050`, the balance check `pass`, one `card_statements` row holds the printed figures, and
    the card page shows them. [Automated]
20. Given a fixture whose printed new balance is one sen wrong, whose payments total does not equal its payment rows,
    whose purchases total does not equal its rows, or with any unreadable row, then the whole file is refused
    `inconsistent`, zero transactions, zero batches and zero `card_statements` are written. Each of the four is its own test.
    [Automated]
21. Given a fixture with the amount line forged inside a merchant description (two amount-shaped lines in a row), a forged
    "SALDO BARU"/"TOTAL PEMBAYARAN"/header/legal line inside the table, a second bank's letterhead in a remark, a repeated
    statement-date line, or a table line outside a table, then each refuses the whole file and writes nothing. [Automated]
22. Given a fixture where a description mimics a different amount, direction word ("CR", "DB", "PEMBAYARAN") or date,
    then amount, direction and date are unchanged (taken only from the designed column/marker). [Automated]
23. Given a fixture with a row dated `28/12` on a statement dated 2026-01-05, then `occurred_on = 2025-12-28`; `02/01`
    gives 2026-01-02; `29/02` on a 2026-03-01 statement is unreadable (refusal); a posting date before its transaction
    date or after the statement date refuses the file. Statement date 2026-10-31 with a row on 2026-10-31 stays in
    October. [Automated]
24. Given money vectors in the fixture grammar: `1.250.000,50` → `125000050`, `Rp 28.000,00` → `2800000`, `0,00` rejected as a
    row amount, `1.250` (no decimals) unreadable, a CR-suffixed new balance → positive closing, an amount past
    `MAX_AMOUNT_MINOR` unreadable. No float parsing anywhere (grep gate). [Automated]
25. Given a card statement uploaded with a Bank wallet selected, or a bank statement with a card wallet, then it is refused
    with the wrong-wallet-kind message and nothing is written; given a card wallet whose `last_four` differs from the
    printed card, the import is refused with a mismatch message; given a matching or unset `last_four`, it proceeds and
    the wallet's last 4 is never auto-written. [Automated]
26. Given the same statement as a second PDF with different bytes and the same statement date, then the import is refused
    "Tagihan ini sudah diimpor" and nothing is written; given the exact same file twice, the same refusal (not "all rows
    already imported"); after the first batch is undone, the same statement imports again. [Automated]
27. Given a purchase typed by hand 2 days before its printed transaction date with the same amount in the same card
    wallet, then the statement row is flagged "Mungkin duplikat" and excluded until ticked; given a same-amount row 4 days
    away, not flagged; given another wallet's same-amount row, not flagged by the card rule. [Automated]
28. Given two consecutive fictional statements where a purchase dated in the previous cycle posts in the second, then
    continuity of the second is `pass` when its previous balance equals the first's new balance, `gap` with both figures
    when it differs by one sen, never a false gap or pass from the date window, and "Catat penyesuaian" closes the gap with
    one FN-37 row; given no earlier statement, `none` with the wallet balance shown. [Automated]
29. Given a fixture holding more than one printed card (supplementary), then the behaviour defined for the first real
    sample applies; until a sample exists, a statement printing more than one card number is refused as `inconsistent`
    with the "belum didukung" message. [Automated]
30. Given a password-protected fixture PDF, then no password gives `encrypted`, a wrong one `wrong_password`, the right one
    reads; the password appears in no log, response, error or stored row; the issuer hint shows only when the parser
    declares one. [Automated]
31. Given undo of a card batch, then its rows and its `card_statements` row are tombstoned in one batch and the card page
    stops showing the statement; given FN-16j's move to another live same-currency card wallet, the `card_statements` row
    moves with it; to a Bank wallet, a different currency or another space's wallet, the move is refused and nothing
    changes. [Automated]
32. Given a card batch import, then the rows carry `category_source = 'auto'`, fees/interest map to `biaya-bank`, tax to
    `pajak`, payments to the `transfer` tile (income), installment lines keep their marker in the note, and other rows
    use FN-20's resolver; classification uses only fixed phrases at the start of the printed description. [Automated]
33. Given a statement with 10 000 rows or 200 pages, then the existing PDF and row bounds apply (refused, never partial);
    the existing per-user statement throttle applies to card statements; a card statement past the row cap is refused
    rather than truncated. [Automated]
34. Given the Impor picker with a card wallet selected, then only card parsers are selectable (none in this cycle: the
    list shows each planned issuer as disabled "Belum didukung" with its alternative); given a bank wallet, no card issuer
    is selectable. Registering the fictional issuer in production code is a failing test. [Automated]
35. Given the compat harness over a fictional card PDF, then it prints counts and pass/fail only; no path, file name, card
    number, description or amount appears. [Automated]

**Cross-cutting (docs/ENGINEERING_CHECKLIST.md turned into criteria)**

36. *Space authorization:* every touched load and action (`/dompet`, `/dompet/kartu/[id]`, wallet create/edit, `/impor`
    preview and import, undo, move, "Cocokkan transfer", `/kekayaan`) resolves the space through `requireSpaceAccess` or
    `currentSpaceScope`; a two-user, two-space test proves user A cannot read or write space B's cards, statements, pairs or
    batches by id, and a removed member gets the same answer as a non-member. Missing and foreign ids are
    indistinguishable. [Automated]
37. *Persisted state:* every write in A1-A5 and B7 survives a reload and a second device (read from D1); success is shown
    only after the server confirms. [Automated, Browser]
38. *States:* card page, Impor preview and import show distinct loading, empty (no card yet, no statement yet), error
    (each refusal), saving and success states; the no-JS form posts work and show the refusal or success without
    JavaScript. [Browser]
39. *Concurrency and stale forms:* 20 concurrent imports of the same statement yield exactly one batch and one
    `card_statements` row; two concurrent card edits resolve with "changed meanwhile" on the stale one (`updated_at`
    compare); 20 concurrent "Cocokkan" confirms of one pair merge it once. [Automated]
40. *D1 limits:* card summary and pair queries bind id lists once as JSON (`json_each`), no `inArray` on growing lists, no
    `LIKE`; tested with 101+ cards/rows; every scan has a period and a row cap; sums are computed in SQL and exact (BigInt,
    `safeMinor`), a sum past the safe range shows "terlalu besar", never a rounded figure. [Automated]
41. *Migration:* the migration is re-runnable where the engine allows, never edits an applied one, its Drizzle schema and
    SQL agree (CHECKs included), RUNBOOK notes the Time Travel bookmark before a remote apply, and local and remote commands
    stay separate. [Automated]
42. *Masking and untrusted text:* a full 16-digit card number in a description, note or wallet field is stored as the last
    4 only; control and zero-width characters are stripped and length capped before `normalize()`; no statement text is
    rendered as HTML; no bytes or extracted text reach D1, R2, logs or Analytics (grep of the diff). [Automated]
43. *No advice, no invention:* no new string recommends an amount to pay, projects interest, scores usage or says "should";
    no figure appears that is not computed from stored rows or printed on a stored statement; an absent printed field is
    absent in the UI. [Automated copy review plus Browser]
44. *Currency display and WIB:* every amount goes through the shared formatter (`Rp 1.264.000`, `−Rp 25.000` with U+2212,
    `+Rp` for income); every date bucket uses `occurred_on`; the WIB vectors of AC 8, 11, 23 pass. [Automated]
45. *Data demo:* demo cards/rows are badged and excluded from card totals, available credit and net worth. [Automated]
46. *i18n and layout:* every new phrase has an English entry; the card page, the form and the preview have no horizontal
    scroll at 360 px and 44 px touch targets on coarse pointers; AA contrast in light, dark and mono. [Automated, Browser]
47. *Gates:* `npm run gates` is clean; every regression test is shown failing on the unfixed code first (fail-before proof);
    results are reported as run, never claimed unrun.
48. *Real sample (per issuer, FN-55c, not this cycle):* the issuer's parser reads the owner's real sample through
    `npm run compat:statements` with a passing balance check and zero unexplained rejections, and one real import through
    `/impor` is done by the owner in a browser. Until then the row stays Automated, not Pass. [Pass, owner]

## Architecture notes

**Touches (no new Worker, no queue, no AI call):** app Worker only. Statement reading is synchronous in-request PDF text
parsing, as FN-16a/e/f/h. The jobs Worker is untouched except that it already runs `summarizeNetWorth` for snapshots,
so A4 reaches it through the shared function.

- `migrations/0047_credit_cards.sql` (number is the next free one at merge: `0046` is taken by FN-53's
  `0046_net_worth_snapshot_classes.sql` on `feat/fn-53-period-reports`; renumber on merge). Contents: `ALTER TABLE wallets
  ADD` `credit_limit_minor`, `statement_day`, `due_day` as nullable columns with column CHECKs (positive and at most `10^13`;
  1-31; each null unless `type = 'kartu_kredit'`), the 0046/0037 pattern (no table rebuild); `CREATE TABLE card_statements`
  (id, space_id FK cascade, wallet_id, import_batch_id, statement_date, due_date, period_from, period_to,
  previous_balance_minor, new_balance_minor, minimum_payment_minor, limit_minor, currency, created_at, updated_at,
  deleted_at, seq) with a partial unique index (space_id, wallet_id, statement_date) where `deleted_at is null`, an index
  (space_id, wallet_id, deleted_at), and CHECKs (dates are real `YYYY-MM-DD`, balances within safe range, tombstone keeps
  no figures). Mirrors `src/lib/server/db/schema.ts` in the same change. `import_batches` needs **no** new column: its
  existing `wallet_id`, `period_from/to`, `opening/closing_balance_minor` (`schema.ts:597-601`) carry a card batch.
- `src/lib/shared/wallets.ts`: card field constants and types; `WalletFormValues` gains the three fields.
  `src/lib/shared/cards.ts` (new, pure): due-date math (month clamping), available credit, paid/unbilled arithmetic on
  BigInt; reused by the card page, `/kekayaan` and tests so the client and Worker agree.
- `src/lib/server/wallets/{validation,repo}.ts`: the three fields, the type-change guard, `WalletSummary` gains them.
- `src/lib/server/cards/summary.ts` (new): the A2 query set, bounded and SQL-aggregated on top of `wallet-sum.ts`
  (reuse `walletWindowSql`, `walletTransactionsSums`; do not re-implement balance maths) and `walletExpenseTotals`
  (`aggregate.ts:804`).
- `src/lib/server/net-worth/{summary,credit-cards}.ts`, `src/lib/ui/net-worth/CreditCardCard.svelte`: A3, A4.
- `src/lib/server/transfers/match.ts`: the card-pair candidate kind; keep `eligible()` and `PAIRED` for existing pairs,
  add a second set for cards; reuse `applyTransferMatch`/`undoTransferMatch` and `transfer_links` unchanged.
- `src/lib/shared/statements/types.ts` (`kind`, `card` block), new `card-rows.ts` (the card row builder and strict check on
  top of `statementRow`/`balanceCheck`; the only place a card statement amount is read), new `card-dates.ts` (year rule),
  `catalogue.ts` (disabled planned issuers), `parsers.ts` (unchanged until a real parser lands).
- `src/lib/server/statements/{read,statement-import}.ts`: wallet-kind gate, card summary in the preview, guarded
  `card_statements` insert in the import batch; `continuity.ts`: card span and statement-to-statement plan;
  `src/lib/server/imports/{csv-import,repo}.ts`: card duplicate rule, move/undo carry the card row.
- `src/routes/(app)/dompet/+page.*`, new `src/routes/(app)/dompet/kartu/[id]/+page.{server.ts,svelte}`,
  `src/routes/(app)/impor/+page.*` (preview summary, refusal map `+page.server.ts:129-146`),
  `src/lib/server/imports/messages.ts`, `src/lib/shared/i18n.ts` + `i18n-en.ts`.
- Reuse, do not rebuild: `parseMoneyAmount`, `statementRow`, `balanceCheck`, `maskAccountNumbers`, `requireSpaceAccess`,
  `createTransaction`, `walletWindowSql`, `safeMinor`, `PageLayout`/`lineX`, `letterheadClaims`, `extractPdfText`,
  `ocbc-text.ts` date and amount helpers where their grammar fits, `moveImportBatch`.
- Test-only fictional issuer lives under `test/fixtures/statements/` (not `src/`), built with the page-builder pattern of
  `test/fixtures/statements/ocbc.ts`; a test asserts it is absent from `STATEMENT_PARSERS`.
- Security notes for the red team: statement parsers are the highest-risk new input; cycle focus is B4/B5 (forged structure,
  cancelling pairs accepted as known limit, wrong-wallet sign flip, replayed statement, concurrent import, IDOR on the card
  page and the move).

## Prerequisites

- **No credential, secret or provider access is needed** for FN-55a/b: no entry in `.dev.vars.example`, no AI Gateway key
  (parsers are deterministic, no AI credits are spent), no Worker secret, no new dependency. Nothing here can show
  "Belum dikonfigurasi".
- **The only prerequisite is data from the owner:** a real, redacted e-statement per issuer (Owner decisions, "Samples
  the owner must provide"). Without a sample an issuer is shown as "Belum didukung" with its alternative (CSV/Spreadsheet
  or manual entry); this is an unavailable state with a stated reason, never a silent failure and never a guessed parser.
- The PDF password of a sample is supplied out of band through `.pdf-password` or `FIN_SAMPLE_PDF_PASSWORD`
  (`scripts/compat-statements.ts`), never in the repository, a command line argument or a message.
- Remote migration apply (RUNBOOK, with a D1 Time Travel bookmark) is the owner's/orchestrator's later step, not this cycle's.

## Tracker impact

- Closes the credit-card half of `docs/TASKS.md:247`: "**Claude** — FN-25c Kekayaan pass 2: Piutang asset kind and
  credit-card statement/due days (migrations)." Proposed edit when FN-55a lands: rewrite that line to "FN-25c Kekayaan pass 2:
  Piutang asset kind (migration)" (credit-card statement/due days delivered by FN-55a, same column names), keeping the
  FN-25b lows. Add: "**Claude** — FN-55a/b credit card wallet and card e-statement import (this PRD)"; one line
  "**You** — FN-55c: send the redacted card e-statement samples listed in the PRD", and a later "**Claude** — FN-55c-<issuer>"
  line per sample received. Also update `docs/TASKS.md` FN-49 line "Kekayaan Piutang (after FN-25c)" only if Piutang changes.
- `docs/ACCEPTANCE.md`: row "Statement PDF (password) → balance check → duplicates excluded → import → undo" (line 17)
  can reach **Automated** for the card path (fictional fixtures) only after FN-55b; it reaches **Pass** per issuer only after
  the owner's real sample run (AC 48). Row "Space isolation on every load, action and sync push/pull" (line 29) is not moved by
  this feature alone. Row "Foreign currency converted at the day's rate, original kept" (line 48) **stays Not run**
  (owner decision 7). Row "Month/day buckets use the WIB date" (line 49) gains evidence from AC 8, 11, 23 but is not moved
  by this feature alone. A move needs a named check, per `CLAUDE.md`.
- `docs/FEATURES.md`: FN-55 entry added after FN-51; FN-04's "Kartu kredit" wallet type and FN-25b's card cards stay as the
  parity record.

## Owner decisions

Answer once before the build. Proposed default in bold.

1. **Issuers for the first parsers.** Proposed: **BCA, Mandiri, BNI, CIMB Niaga, OCBC**, built one at a time in the order
   the owner's samples arrive; BRI, Permata, Danamon, UOB, Maybank are "later, on request". Which of these do you actually
   hold a card from? A parser for a card you cannot give a sample of is not built.
2. **Samples the owner must provide (exact list).** For each issuer wanted, one **real e-statement PDF** (the password-protected
   original as downloaded, not a screenshot or print-to-PDF), stored by the owner locally in
   `.superpowers/ref/samples/statements/` of the main checkout (git-ignored; never committed, never pasted into a chat), named
   `<issuer>-kartu-kredit-YYYY-MM.pdf`, i.e. `bca-kartu-kredit-YYYY-MM.pdf`, `mandiri-kartu-kredit-YYYY-MM.pdf`,
   `bni-kartu-kredit-YYYY-MM.pdf`, `cimb-kartu-kredit-YYYY-MM.pdf`, `ocbc-kartu-kredit-YYYY-MM.pdf`. Preferably **two months per
   issuer**: one ordinary month and one that contains as many of these as possible: a cicilan/installment line, a
   foreign-currency purchase, an annual fee, an interest/late charge, a refund or credit, a payment line, a supplementary
   card, and (if ever) a credit (CR) balance. Alongside each, a short note (a text file, no secrets) saying: the PDF
   password rule as the bank states it (for example "tanggal lahir, format …", from the issuer's own e-mail), whether the
   statement is one or several PDFs a month, and whether there are supplementary cards. A **text-extract dump**
   (like `ocbc-rekening-koran-2026-04.txt`) is made locally from the PDF by the existing harness. Amounts in the PDF
   **must not be edited** (an edited amount breaks the statement's own totals, which are the self-check); personal data
   (name, address, full card number) is redacted in the dump only, and no value is reproduced in code, fixtures or docs, only
   the structure. **No card sample exists today** (only `ocbc-rekening-koran-2026-04.*`, a bank account, is in the folder), so
   every issuer is "waiting for sample" now.
3. **Due-date push reminder.** Proposed: **defer** (needs a CHECK rebuild on three notification tables, a trigger and a
   settings row; the in-app due chip ships now). Alternative: build it as FN-55d (cheap once FN-24's kind list is rebuilt).
4. **Refunds and credits.** Proposed: **an income row on the card, not netted** against the original purchase. Trade-off:
   month income rises by the refund (honest to the rows, easy to see) but "Pemasukan" is not a pure earnings figure; netting
   needs a refund-link feature (out of scope).
5. **Card payment pairing window.** Proposed: **credit dated 1 day before to 3 days after the bank debit** (card payments
   post later, especially across weekends). Trade-off: a wider window can offer a wrong same-amount pair; every pair is still
   confirmed by the user and ambiguity is shown whole. Existing non-card pairs stay ±1 day.
6. **Installments.** Proposed: **each monthly line counts as that month's expense; the marker is kept in the note; no
   schedule or remaining-balance tracker**; manual cicilan via an FN-36 monthly series with an end date. Trade-off: a
   0% installment purchase is spread across months in reports rather than shown on its purchase day (this is the cash view
   the statement shows). A tracker is a later pass.
7. **Foreign-currency card rows.** Proposed: **store the IDR amount billed; keep the original amount and currency as printed
   in the note; store no rate and no new columns.** Trade-off: no queryable original amount (`docs/ACCEPTANCE.md:48` stays
   Not run). Alternative: add `original_amount_minor`/`original_currency` columns (touches the nine money form pairs).
8. **Card debt in net worth.** Proposed: **a negative card balance moves from the Kas/`wallets` class to the Utang line; the
   total is unchanged.** Trade-off: one-time class shift on deploy day, so FN-53's per-group change (if merged first) shows a
   Wallets-up/Debt-down jump on the first snapshot after deploy; the total and the 30-day total change are unaffected.
   Alternative: leave it inside `wallets`.
9. **Unmatched card payments in income.** Proposed: **a payment line imported into the card counts as income ("Transfer
   masuk") until the user pairs it**, like FN-48C's unpaired transfers today, with a visible "N pembayaran belum dicocokkan"
   count on the card page and Impor. Trade-off: income looks high until pairing. Alternative: exclude `transfer`-tile income
   in card wallets from income totals (changes `aggregate.ts` semantics; not proposed).
10. **"Bayar tagihan" fill chips.** Proposed: **show "Tagihan terakhir (tertera)" and "Pembayaran minimum (tertera)" as
    amount fill chips** (printed figures, user confirms). Trade-off: a printed minimum next to a pay button may read as a
    nudge; wording is neutral, no recommendation. Alternative: only the last-bill chip.
11. **Plan gating, credits, limits, retention.** Proposed: **no plan gating, no AI or credit cost (deterministic parsers),
    the existing 50 wallets per space and statement upload throttle apply, a card statement record is kept until its batch is
    undone or the wallet's space is deleted, 60 live statements per card.** Statement text and files are never stored. Say if
    card import should be Pro-only (not proposed: bank statement import is Free, FN-30).
12. **Supplementary cards.** Proposed: **one bill = one batch across all printed cards, each row's card last 4 kept in the
    note, wallet matched on the primary card's last 4**; until a sample proves the layout, a statement printing more than one
    card number is refused. Confirm after the first sample.
13. **Delivery order.** Proposed: **FN-55a + FN-55b now in one cycle; FN-55c parsers one by one as samples arrive; FN-55d
    reminder only if answer 3 changes.**

## Owner decisions — answered 2026-10-13

- Issuers the owner holds: BRI, BCA, Mandiri, BNI, and CIMB Niaga and/or OCBC. Each issuer parser (FN-55c) is built
  only after the owner sends one redacted card-statement PDF (and its password if protected); until then the issuer
  shows as "waiting for sample". BRI joins the list of issuers.
- Every other default accepted: refunds as income, not netted; card-bill pairing window from 1 day before to 3 days
  after the bank debit; card debt moves from Kas to the Utang line (total unchanged); foreign-currency card rows keep
  the original amount in the note only; cicilan counted as the monthly line, no tracker; quick-fill chips for the last
  bill and the printed minimum; due-date push deferred (in-app due chip ships); supplementary cards out of scope.
- Build now: FN-55a (card wallet, migration, card page, net-worth liability, bill pairing) and FN-55b (card import
  infrastructure proven with a test-only fictional issuer). Migration number: next free after main's 0045 and
  FN-53's 0046 on its branch, so 0047; renumber at merge if needed.
