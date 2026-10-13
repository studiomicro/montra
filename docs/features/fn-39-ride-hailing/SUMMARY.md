# FN-39 Ride-hailing and food delivery options: summary

Status: **complete** (2026-10-09).

Goal (PRD): give Gojek, Grab, Maxim and ShopeeFood spending its own place: two preset categories, automatic
recognition, e-wallet quick-picks and ride/food memberships in Langganan.

- Migration: `migrations/0027_ride_food_categories.sql` (categories rebuilt with a 17-key tile check;
  category_budgets and recurring_transactions rebuilt around it; links set aside in `__fn39_links` and restored).
- Main files: `src/lib/shared/category-keywords.ts` (new), `src/lib/shared/transactions.ts`, `voice-parse.ts`,
  `wallets.ts`, `subscriptions-catalogue.ts`, `src/lib/server/categories/repo.ts`, `budgets/category-repo.ts`,
  `imports/csv-import.ts`, `db/schema.ts`, `src/lib/ui/kit/category.ts`, `WalletForm.svelte`, dompet route,
  `docs/design/tokens.css` (two category colours).
- Tests: category-keywords, csv-import, WalletForm render, migration-0027 integration, plus cases in transactions,
  impor, impor-statements, dompet-routes, voice, slack, subscriptions and wallets; e2e langganan no-JS link.
- QA: PASS (`QA_REPORT.md`). Red team: PASS (`SECURITY_REPORT.md`; L1 remote apply not atomic, I1/I2 informational).
- Not verified: migration 0027 on staging D1.
