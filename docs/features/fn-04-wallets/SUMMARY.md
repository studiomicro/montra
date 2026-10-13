# FN-04 Wallets — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (owner accepted defaults: Kekayaan tab only, negative opening
balance allowed, no Investasi type yet).

- **Built:** migration `0003_wallets.sql` (`wallets`, per-space `space_seq` counter); `src/lib/server/wallets/*`
  (repo, balance contract `walletBalanceMinor`, validation), `src/lib/server/sync/seq.ts`, `isLiveMember` re-check in
  every write, `/kekayaan` wallets section with add/edit/archive/restore and favourite (exactly one), currency
  allow-list (IDR, USD, SGD, MYR, EUR, JPY, AUD, GBP), masked last-4 refused not truncated, 50 wallets per space;
  `wallets`/`space_seq` in `SPACE_SCOPED_TABLES` with a schema-coverage test; Sheet: unique title id, max-height
  scroll, `onclose`; e2e `kekayaan.spec.ts`.
- **QA:** PASS 29/29. **Red team:** PASS; Lows fixed in cycle 3 (no echo of a refused card number; opening balance
  accepts whole units only — decimals refused, never multiplied).
