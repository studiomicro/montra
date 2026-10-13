# FN-47 More currencies and decimal amounts — SUMMARY

Status: **complete** (2026-10-11). Goal: TWD, HKD and CNY ("CNY (RMB)") as wallet, budget, subscription and
net-worth currencies, and cents in amount fields for 2-decimal currencies (USD, SGD, MYR, EUR, AUD, GBP, TWD, HKD,
CNY), read with the UI language's separators; IDR and JPY stay whole units.

- Built: shared amount reading (`src/lib/shared/amount-input.ts`), strict server reader `amountMinorFromText`
  (`src/lib/server/forms.ts`) used by every amount path, locale stored on queued offline writes, edit forms keep
  cents, currency-aware refusal copy, refused input echoed back, TWD FX up to 40 days old, answer-guard words.
- Migrations: none.
- QA: PASS (cycle 2). Red team: PASS (cycle 2); L1–L3 fixed; L4 (codes spelled with spaces, older than FN-47) open.
- Owner-visible rule: amounts show sen only when non-zero (`HKD 1.234` for 1.234,00), as for IDR.
- Not done: `QUEUE_AMOUNT_MISSING` and the net-worth hint still say whole numbers; the no-JS budget form re-shows the
  stored amount after a refusal.
