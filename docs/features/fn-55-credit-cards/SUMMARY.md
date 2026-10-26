# FN-55 Credit cards and credit card e-statement import — SUMMARY

Status: **complete for FN-55a and FN-55b** (2026-10-13), three cycles. FN-55c (one parser per issuer) waits for the
owner's card statement samples: BRI, BCA, Mandiri, BNI, CIMB Niaga, OCBC show "menunggu contoh tagihan".

- FN-55a: a credit card is a wallet kind with limit, statement day and due day; a card page with billed vs unbilled,
  the printed minimum, available credit and a due chip; purchases count on the purchase date; paying the bill is a
  transfer, and an imported bank "KARTU KREDIT/PL …" debit pairs with the card credit (−1/+3 days, FN-48C); card debt
  sits on Utang in net worth and in FN-53's `classes` split (total unchanged); refunds are income, fees and interest
  expenses, cicilan monthly lines, foreign amounts in the note; quick-fill chips for the last bill and the minimum.
- FN-55b: card statement import as its own parser kind for card wallets only: the whole statement is refused on any
  unreadable row, a broken identity (previous − payments − credits + purchases + fees = new balance), a row date
  outside the printed period (transaction date at most 60 days before it, never after posting; no-period statements
  bounded from the statement date) or mixed currency; card numbers masked to last 4; card dedupe and continuity by
  printed period; the preview respects hidden amounts. Proven with a test-only fictional issuer that is never
  registered in production.
- Guards: a bank-statement batch cannot move into a card, and a wallet holding bank-statement imports cannot be
  retyped to a card (`bank_statements_locked`).
- Migration: `0047_credit_cards.sql` (wallet card columns, `card_statements`).
- QA: FAIL cycle 1 (three specs, test-side), PASS cycles 2–3. Red team: PASS cycles 1–3; open low L2-R (a retype
  that lands while a bank import runs) logged in `docs/TASKS.md`.
- Not verified: any real issuer statement; staging.
