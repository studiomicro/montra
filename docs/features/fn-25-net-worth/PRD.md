# FN-25 Net worth (Kekayaan)

Slug: `fn-25-net-worth`. Phase 4 (Wealth). Risk tier: **Large** (new money-bearing tables, three external price
sources fetched server-side only, currency conversion with stored rate+date, extends the existing `/kekayaan`
page that already carries FN-04 wallets and FN-10 goals).

## Goal

`/kekayaan` today only answers "what are my wallets worth" (FN-04) and "how close are my savings goals"
(FN-10). A net-worth page is the one number a wealth-tracking user actually opens the app for: everything they
own and owe — cash, investments, crypto, gold, property, debt — in one total with a 30-day change. FN-25 adds
that total without inventing any figure: prices come from named free sources fetched by the jobs Worker and
cached, or the user's own typed value when no source applies; nothing here is investment advice.

## Scope

- **Migration `0012_net_worth.sql`** (renumber at merge; see FN-24's PRD for the same caveat — these five PRDs
  land together and the engineer picks the final contiguous numbers at merge time).
  - `net_worth_items` table, space-scoped: `id`, `space_id`, `kind` (enum `cash`, `investment_stock`,
    `investment_crypto`, `investment_gold`, `property`, `vehicle`, `debt`, `other_asset`), `name`,
    `currency`, `quantity` (nullable REAL‑as‑TEXT or integer-scaled — see note below; null for a plain manual
    value), `price_source` (enum `manual`, `indodax`, `gold_api`; null = manual), `price_symbol` (e.g. the
    Indodax pair `btcidr`, or null for manual/gold), `manual_value_minor` (the user's own current value, used
    when `price_source` is `manual` or as the fallback when a priced item's live fetch has never succeeded),
    `is_liability` (boolean — debts subtract from the total instead of adding), `acquired_on` (nullable WIB
    date, informational), `note`, `created_at`, `updated_at`, `deleted_at`, `seq`. Content-free tombstone CHECK
    matching `wallets`/`goals`. Added to `SPACE_SCOPED_TABLES`.
  - **Quantity precision:** crypto/gold quantities need fractional units (0.015 BTC, 2.5 grams). Per
    CLAUDE.md "never floats": store `quantity_scaled` as an integer (×10^8 for crypto, matching Indodax's own
    satoshi-level precision; ×1000 for gold grams) with a fixed `quantity_scale` column recording which, so
    arithmetic stays integer end to end; the UI shows/accepts decimal text and the server parses it the same
    disciplined way `wholeAmountMinor` parses money (new `src/lib/server/net-worth/validation.ts` helper, not
    a reuse of the money parser, since these are physical quantities, not currency).
  - `price_cache` is **not** a D1 table — prices are cached in the `CACHE` KV namespace (already bound,
    `wrangler.jsonc:21`, unused until now), keyed `price:<source>:<symbol>:<date-hour>`, so no migration is
    needed for it and a KV outage degrades to "last cached price" or "Belum ada harga" rather than a failed
    page.
- **`src/lib/shared/net-worth.ts`**: `NetWorthKind` enum and labels (`msg()`-wrapped, same pattern as
  `src/lib/shared/wallets.ts` `WALLET_TYPE_LABELS`), the fixed troy-ounce-to-gram constant (31.1034768 g —
  a physical constant, not a guessed figure, fine to hard-code), quantity scale constants, and pure
  `netWorthValueMinor(item, priceMinor | null)` so the "what does this item contribute to the total" logic is
  one tested function shared by the server aggregate and (if ever needed) a client preview.
- **`src/lib/server/net-worth/prices.ts`** (server-only — CLAUDE.md "any external price API is server-side
  only, never from the browser"; strict CSP already in place means the page itself could never call these
  hosts from client JS anyway):
  - `fetchIndodaxTicker(symbol)`: `GET https://indodax.com/api/ticker/<pair>` (public, keyless, documented at
    `indodax.com/downloads/BITCOINCOID-API-DOCUMENTATION.pdf`) → last price already in IDR, no FX conversion
    needed. Covers the coins Indodax lists (BTC, ETH, USDT and more); an item naming a coin Indodax does not
    list falls back to manual value (never "closest match").
  - `fetchGoldSpotUsd()`: `GET https://api.gold-api.com/price/XAU` (free, keyless; terms at `gold-api.com`) →
    USD per troy ounce.
  - `fetchUsdIdrRate(date)`: `GET https://api.frankfurter.dev/v1/<date>?from=USD&to=IDR` (free, keyless, no
    rate limit stated, ECB-sourced, ID-currency-inclusive, commercial use permitted per their published terms)
    → the day's rate, stored with its date exactly as CLAUDE.md requires for `original_amount_minor`/
    `original_currency` conversions elsewhere. Gold's IDR-per-gram price is `(USD/oz ÷ 31.1034768) × rate`,
    computed in a way that keeps the final minor-unit figure an integer (round at the last step only, never
    chained float rounding).
  - **IDX stocks: no automated source this pass.** No free, legitimate, keyless, server-usable IDX price feed
    was found with verifiable terms (searched 2026-10-08; candidates were either undocumented
    scraping-pattern gateways or required a paid/key-gated plan). `investment_stock` items are **manual value
    only** in this pass — see Owner decisions. This keeps the feature honest: CLAUDE.md forbids inventing a
    figure or hard-coding a guessed quota, and a scraped, unverified source is worse than an explicit manual
    field.
  - Each fetcher has a short timeout (reuse the `AbortSignal.timeout` pattern from `push/send.ts:63`), never
    retries synchronously inside a page load (the jobs Worker cron does the fetching; the page load only reads
    KV), and every failure leaves the last cached price (or "Belum ada harga" / the manual fallback) rather
    than a failed page.
- **`workers/jobs/src/cron.ts`**: on the existing hourly WIB cron tick, for every distinct `(price_source,
  price_symbol)` pair in use across all spaces (one bounded query, not one fetch per item), fetch and write to
  KV with a TTL slightly longer than the cron interval, plus the day's USD/IDR rate once per WIB day. A failed
  fetch leaves the previous KV value in place (KV `put` only on success) and logs the source/symbol, never the
  response body.
- **`src/lib/server/net-worth/repo.ts`**: CRUD modelled exactly on `src/lib/server/goals/repo.ts` (guarded
  insert with a per-space cap, `writable`/`whyNot` stale-vs-missing, `bumpSpaceSeq`); `MAX_ITEMS_PER_SPACE`
  (propose 200, matching the order of magnitude of `MAX_GOALS_PER_SPACE=50`/wallet caps, scaled up since a
  wealth tracker plausibly lists more items than goals). A `netWorthSummary(db, spaceId, prices)` aggregate
  returning per-kind subtotals, the grand total (assets minus liabilities, exact TEXT+BigInt sum with the
  existing "too large" null state — reuse `safeMinor` from `src/lib/server/transactions/aggregate.ts`), and the
  30-day change (today's total minus the total computed from a 30-day-old snapshot — see migration note below
  on how "30 days ago" is answered without a time machine).
  - **30-day change implementation:** net worth has no transaction history to replay, so the "Naik Rp 42 jt
    dalam 30 hari" figure needs its own daily snapshot. Add `net_worth_snapshots` (space-scoped,
    `(space_id, date)` unique, `total_minor`, `currency`) written once per WIB day by the same cron tick that
    refreshes prices (compute today's total, upsert today's row). The 30-day change compares today's live
    total with the snapshot closest to 30 days ago (or the oldest snapshot if the space is younger than 30
    days, shown as "sejak mulai mencatat" / "since you started" rather than a false 30-day figure). Also added
    to `SPACE_SCOPED_TABLES`.
- **`/kekayaan`**: extends the existing page (`src/routes/(app)/kekayaan/+page.server.ts/.svelte`) with a new
  net-worth section above or alongside Dompet/Tabungan — total figure (big number, `formatMoney`), 30-day
  change line, per-class allocation (Kas, Investasi, Kripto, Emas, Properti & aset — the FEATURES.md class
  names, reusing `msg()`/`trf()`), and a list of items grouped by kind with add/edit/archive actions following
  the exact sheet-or-inline-form pattern already built for wallets on the same page (`WalletForm.svelte`'s
  sibling, a new `NetWorthItemForm.svelte`). Loading/empty/error/saving/success states match the wallet
  section's (`Skeleton`, `ErrorState`, `EmptyState`, the `track()` submit-function pattern,
  `invalidateAll`-on-conflict).
- **No portfolio-screenshot import in this pass** (see Out of scope) — the add form is always typed.
- **i18n**: every new string in `src/lib/shared/i18n.ts` + `i18n-en.ts`; price-source attribution text ("Harga
  dari Indodax", "Harga emas: gold-api.com", both informational, not advice) also translated.

## Out of scope

- Portfolio screenshot import/read (FEATURES.md FN-25's "portfolio screenshot import (read, never stored)") —
  that is an AI-read path blocked on the on-hold Anthropic key (`docs/TASKS.md`); this pass is manual entry
  and the three named price sources only.
- IDX stock prices from any automated source (see Scope note) — manual value only; revisit if the owner
  procures a licensed market-data vendor (a new owner decision, not auto-acceptable without a real quota/terms
  page to cite).
- Any investment, trading or "should I buy/sell" guidance — CLAUDE.md forbids financial advice; the page shows
  figures and a 30-day change only.
- Multi-currency net worth totals beyond IDR/USD gold conversion — if a user records an asset in a currency
  other than IDR (e.g. a USD brokerage balance as a manual value), it is listed separately like
  `otherCurrencies` on Beranda (`src/lib/server/budgets/math.ts:187`), never silently summed into the IDR
  total without a stored rate.
- Debt payoff schedules, amortisation or interest calculations — a debt item is a flat current-value liability.

## Acceptance criteria

1. Given a signed-in user's space, when `/kekayaan` loads, then the net-worth total equals the sum of every
   live item's contribution (assets added, `is_liability` items subtracted), computed in integer minor units
   via exact BigInt summation, and shows "terlalu besar" / null-state text instead of a wrong number if the
   exact sum exceeds the safe display range (matching the existing wallet-balance "too large" convention).
2. Given an item with `price_source = 'indodax'` and a symbol the jobs cron has successfully priced within the
   last cache TTL, then its contribution uses that cached IDR price × quantity; given the cron has never
   succeeded for that symbol (cold cache) or the cache has expired without a successful refresh, then the item
   falls back to its `manual_value_minor` and the UI states the price is not live ("Harga belum tersedia,
   memakai nilai manual").
3. Given an item with `price_source = 'gold_api'`, then its IDR-per-gram value is computed from the cached
   USD/oz price and the cached same-day USD/IDR rate, both stored with their fetch date, and the computed
   figure rounds only once at the final minor-unit step (a vectors test proves no float drift across a range
   of quantities).
4. Given an item with `price_source = 'manual'` (including every `investment_stock` item, since no automated
   source exists), then its value is exactly `manual_value_minor` with no price fetch attempted.
5. Given the jobs Worker cron fetch to Indodax, gold-api.com or frankfurter.dev fails (timeout, non-2xx,
   malformed body), then the previous cached price is kept, the failure is logged without the response body,
   and no `/kekayaan` page load ever throws for a stale or missing price — it always shows a number or an
   explicit "Belum ada harga" state.
6. Given no browser ever calls Indodax, gold-api.com or frankfurter.dev directly (CLAUDE.md "any external
   price API is server-side only"), then the CSP for `/kekayaan` lists no new `connect-src` host for these
   APIs, and a code review confirms the three fetchers exist only in `src/lib/server/net-worth/prices.ts` and
   `workers/jobs`.
7. Given a space with a 30-day-old or older snapshot, when `/kekayaan` loads, then the 30-day change equals
   today's total minus the matching snapshot's total, shown as a rupiah difference ("Naik Rp 42 jt dalam 30
   hari" / "Turun Rp…"), not a percentage (CLAUDE.md "rupiah not percent"); given the space is younger than 30
   days, then the change is shown against the oldest available snapshot with wording that says "since you
   started", never a fabricated 30-day figure.
8. Given a user adds, edits or archives a net-worth item, then the write goes through `requireSpaceAccess` for
   that space and the guarded `writable`/`stale`-vs-`missing` check (matching goals/wallets), survives a page
   reload, and shows saving → success only after the server confirms (the `track()` pattern already used on
   `/kekayaan` for wallets).
9. Given a quantity field (BTC amount, gold grams), when a value with more precision than the stored scale is
   typed (e.g. `0.123456789` BTC against an 8-decimal scale), then it is refused with a clear error rather
   than silently truncated; whole numbers, the exact scale's decimal count, and fewer decimals all parse to
   the exact same integer `quantity_scaled` a human would expect (a parser vectors test, like
   `wholeAmountMinor`'s).
10. Given 20 concurrent item creates in one space at the cap (`MAX_ITEMS_PER_SPACE`), then exactly that many
    succeed and the rest are refused with the limit message, never over by one (concurrency probe, matching
    the goals/wallets guarded-insert pattern).
11. Given a space the user is not a live member of, every net-worth route, action and the price-cache read
    path for that space's items answer exactly as `requireSpaceAccess` does elsewhere — 404 for an unknown or
    foreign id, no existence oracle.
12. Given the account-deletion path runs, every net-worth item and snapshot of a space the user was the last
    live member of is purged via `SPACE_SCOPED_TABLES`/`purgeSpaces`; a shared space's items survive for the
    other members.
13. Given a hidden "Kekayaan" module (FN-12 feature toggle), then the page still loads and totals still count
    (matching the existing `hiddenModules.includes('kekayaan')` notice already on the page), consistent with
    "all modules feed the same numbers" (FEATURES.md FN-12).
14. Every new Indonesian string has an English entry; every money figure uses `formatMoney`/
    `formatMoneyCompact`; attribution text near a priced item names its source but never claims investment
    advice; no page text implies MONTRA holds, moves or custodies any asset.

## Architecture notes

- **New migration** `migrations/0012_net_worth.sql` (renumber at merge — see FN-24). New Drizzle tables in
  `src/lib/server/db/schema.ts`: `netWorthItems`, `netWorthSnapshots`. Both added to `SPACE_SCOPED_TABLES`
  (`src/lib/server/spaces/spaces.ts:237`), ahead of `wallets`/`spaces` like every other child table.
- **KV (`CACHE` binding, `wrangler.jsonc:21`):** first real use in the codebase. Key scheme documented in
  `src/lib/server/net-worth/prices.ts`; TTL set via KV's own `expirationTtl` option, no manual sweep needed.
- **Reused:** `requireSpaceAccess`/`isLiveMember` (`spaces/access.ts`); the goals repo's guarded-insert/
  `writable`/`whyNot` pattern (`goals/repo.ts`) as the template for `net-worth/repo.ts`; `safeMinor` and the
  exact-BigInt-sum convention (`transactions/aggregate.ts`); `formatMoney`/`formatMoneyCompact`
  (`money-format.ts`); the wallet section's sheet/inline-form/`track()` UI pattern on `/kekayaan` itself
  (`src/routes/(app)/kekayaan/+page.svelte`) as the template for the new net-worth section, so the page stays
  one coherent screen rather than three different interaction styles.
- **New modules:** `src/lib/shared/net-worth.ts` (enums, labels, pure value math); `src/lib/server/net-worth/
  {validation,repo,prices,summary}.ts`; `workers/jobs/src/cron.ts` gains the price-refresh tick (shared with
  FN-24's cron additions — both land in the same file; coordinate at merge to avoid a conflicting rewrite).
- **Worker boundary:** price fetches run only in `workers/jobs` (cron) — never in the app Worker's request
  path, so a page load never waits on a third-party HTTP call and the strict CSP never needs an external
  `connect-src` for the browser.
- **No AI** in this pass (portfolio screenshot reading is explicitly out of scope, blocked on the on-hold key).

## Prerequisites

- **No new credential needed.** Indodax's ticker endpoint, gold-api.com and frankfurter.dev are all public
  and keyless per the terms cited above; if the engineer's build-time check finds any of the three now
  requires a key or has materially changed terms (CLAUDE.md: "re-check official docs… never hard-code guessed
  pricing, quotas"), that source is replaced with manual-value-only for its class and the owner is informed —
  this PRD's acceptance criteria 2–5 already require a graceful manual fallback, so that change needs no PRD
  rewrite.
- **IDX stock prices:** no source chosen this pass (manual only); procuring a licensed vendor is a future
  owner decision, not a prerequisite for shipping this PRD.

## Owner decisions

All auto-accepted per owner instruction 2026-10-08 (no open questions):

1. **Crypto price source: Indodax public ticker**, not CoinGecko — auto-accepted because it needs no API key
   (CoinGecko's free tier requires a free sign-up key per its current terms), returns prices already in IDR
   (no FX conversion risk), and comes from a Bappebti-regulated Indonesian exchange appropriate for an
   Indonesia-first product. Trade-off: only coins Indodax lists get a live price; everything else is manual.
2. **Gold price source: gold-api.com (XAU/USD) + frankfurter.dev (USD→IDR)**, not a single combined API —
   auto-accepted as the only verified-free, keyless combination found; the two-hop conversion is the
   documented CLAUDE.md pattern (stored rate + date) already used for foreign-currency transactions.
3. **IDX stocks: manual value only, no automated price this pass** — auto-accepted; no legitimate free/keyless
   server-side source was found with citable terms, and CLAUDE.md forbids guessing one. Trade-off: a stock
   item's value is only as current as the user keeps it.
4. **Item cap: 200 per space** — auto-accepted as a round number an order of magnitude above the goals/wallet
   caps, generous for a personal wealth list without being unbounded.
5. **30-day change via daily snapshots, not a transaction-style ledger** — auto-accepted as the simplest
   correct design; trade-off is one extra small table and a "since you started" wording for spaces younger
   than 30 days instead of a true 30-day figure.
6. **No portfolio screenshot import this pass** — auto-accepted; it is an AI-read path and the Anthropic key
   is on hold per `docs/TASKS.md`; typed/manual entry covers every asset class in the meantime.
7. **Price refresh cadence: the existing hourly 06–23 WIB cron**, not a separate schedule — auto-accepted to
   avoid a second Cron Trigger; crypto/gold prices do not need sub-hourly freshness for a net-worth summary.

## Tracker impact

- Adds the Phase 4 breakdown to `docs/TASKS.md` › "Phases 3 – 5 and later": "FN-25 Net worth: items, Indodax/
  gold-api/frankfurter price cron, KV cache, snapshots, manual fallback."
- `docs/ACCEPTANCE.md` gets a new "Money and dates" row once built and checked: "Net worth total = sum of live
  items (assets − liabilities), exact; 30-day change from daily snapshot" — and a "Security and privacy" row:
  "External price APIs called server-side only (jobs Worker), never from the browser."
