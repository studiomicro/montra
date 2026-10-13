# FN-25 Net worth (Kekayaan bersih) — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted).

- **Built:** migration `0014_net_worth.sql` (`net_worth_items`, `net_worth_snapshots` with a `partial` flag); items for
  crypto, gold, property, vehicle, other assets and debt kinds; manual values or provider prices (Indodax
  `ticker_all`, gold-api.com, Frankfurter v2 — keyless, verified 2026-10-08) fetched by the jobs Worker, cached per
  source in KV with last-good fallback, stale label, 72 h manual fallback and a >50 % jump hold; unknown coin codes
  refused; FX conversion with stored rate and date, currencies without a rate listed separately; net worth = wallets +
  items − debts in exact BigInt with the overflow state; daily WIB snapshots with a rotating cron cursor; partial
  snapshots excluded from the 30-day change; "not investment advice" notice; `/kekayaan` order: net worth, wallets,
  goals, Langganan.
- **Red team:** FAIL (M1 snapshot starvation beyond 100 spaces, M2 junk coin codes starving real prices) → fixed,
  re-check PASS. **QA:** PASS 14/14.
- **Known limits:** about 1.800 snapshots per day (scale item); stock prices manual only.
