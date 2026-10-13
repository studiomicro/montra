# FN-28 Collectibles (Koleksi)

Slug: `fn-28-collectibles`. Phase 4 (Wealth). Risk tier: **Medium** (reuses FN-27's photo infrastructure; adds
one narrow, optional external price source).

## Goal

Collectibles complete the net-worth picture for a user who holds trading cards, sneakers or other items whose
value moves independently of what they paid. Most collectibles have no reliable free price feed, so this
feature is built around manual value as the honest default, with one narrow exception (Pokémon TCG cards,
where a genuinely free, keyless price source exists) wired in as an automated option — never a blanket promise
of "market prices" MONTRA cannot actually source for every collectible category.

## Scope

- **Migration `0015_collectibles.sql`** (renumber at merge): `collectibles` table, space-scoped: `id`,
  `space_id`, `name`, `purchase_price_minor`, `currency`, `purchased_on` (WIB date), `price_source` (enum
  `manual`, `pokemontcg`; default `manual`), `price_symbol` (nullable — the card's catalogue id when
  `price_source = 'pokemontcg'`, e.g. `base1-4` for a specific printing; null for manual), `manual_value_minor`
  (the user's own current value; used when `price_source = 'manual'` or as the fallback when a priced item's
  cache is cold), `photo_key` (nullable, same R2 convention as FN-27's `belongings.photo_key`), `note`,
  `created_at`, `updated_at`, `deleted_at`, `seq`. Content-free tombstone CHECK. Added to
  `SPACE_SCOPED_TABLES`.
- **`src/lib/server/collectibles/prices.ts`**: `fetchPokemonTcgCardPrice(cardId)` — `GET
  https://api.pokemontcg.io/v2/cards/<id>`, keyless (per the service's own documented free quota at build
  time — the engineer re-verifies the current limit before shipping, per CLAUDE.md "never hard-code guessed
  quotas"; if a key is later required or the quota tightens below what an hourly cron needs, this source
  degrades to manual for that item exactly like FN-25's gold/crypto sources degrade), returning the card's
  market price in USD. Converted to IDR with the **same `fetchUsdIdrRate(date)` helper FN-25 builds**
  (`src/lib/server/net-worth/prices.ts`) — no second FX implementation. Cached in the same `CACHE` KV
  namespace FN-25 uses, key scheme `price:pokemontcg:<cardId>:<date-hour>`, refreshed by the same jobs-Worker
  hourly cron tick that refreshes FN-25's prices (one shared "refresh every priced symbol in use" step reading
  across both `net_worth_items` and `collectibles`, not two separate cron loops).
- **`src/lib/server/collectibles/{validation,repo}.ts`**: CRUD on the same guarded-insert/`writable`/
  stale-vs-missing pattern as `goals/repo.ts` and FN-27's `belongings/repo.ts`; `MAX_COLLECTIBLES_PER_SPACE`
  (propose 300, matching belongings); a `collectiblesTotal`/per-item `gainMinor` (current value minus
  `purchase_price_minor`, exact integer subtraction, never a float percent calculation feeding back into a
  stored figure).
- **Photo upload/serving:** reuses FN-27's exact pattern — `src/lib/server/belongings/photo.ts`'s
  `storePhoto`/serving-route logic is generalised into a shared `src/lib/server/photos/` module (object-key
  prefix and owning table as parameters) so FN-27 and FN-28 share one validated-upload, one authenticated-serve
  implementation rather than two copies; `src/routes/api/v1/collectibles/[id]/photo/+server.ts` is a thin
  wrapper calling the shared module with `collectibles` as the scope. (If FN-27 ships first, this PRD extracts
  its photo code into the shared module as part of FN-28's build; if FN-28 ships first, the shared module is
  built once and FN-27 is the thin wrapper instead — whichever lands second does the extraction.)
- **`/koleksi` route** (new top-level route, same shape as `/barang`/`/langganan`): list with photo
  thumbnails, each row showing current value (live-priced or manual) and the gain **in rupiah** against
  purchase price as the primary figure (`formatMoney` of `gainMinor`, signed, ink-and-white with colour only
  for meaning — per the design system's "rupiah not percent" rule, which this PRD follows even though
  FEATURES.md's mirror line names a percent: a small secondary percent annotation may accompany it, but the
  rupiah figure is first and never omitted), a total current value header, and an add/edit/archive sheet with
  the same photo upload UI as FN-27. A "Kartu Pokémon TCG" toggle in the add form switches `price_source` to
  `pokemontcg` and asks for the catalogue card id/name (typed search against the same public API's card-search
  endpoint, informational only, never an identification claim); every other collectible defaults to, and stays,
  `manual`. An "Kenali dari foto (AI)" control is shown disabled with "Belum dikonfigurasi" text, identical to
  FN-27's.
- **FN-12 nav:** `koleksi` is already a `MODULES` flag with no route; this PRD wires `/koleksi` and the
  hidden-module notice.
- **i18n**: every string, including the manual-vs-priced disclosure and the AI-disabled hint (shared phrasing
  with FN-27 where identical, to avoid two slightly different translations of the same idea).

## Out of scope

- AI identification of a collectible from its photo (FEATURES.md FN-28's "trading cards… follow market
  prices" implies recognition; the user request explicitly puts this on hold) — the disabled
  affordance is the only trace, same as FN-27.
- Any game/category beyond Pokémon TCG for automated pricing — sports cards, Magic: The Gathering, sneakers,
  Funko Pop and every other collectible type is manual value only in this pass (no verified free, legitimate,
  keyless source was found for them at the time of writing; see Owner decisions).
- Grading/condition-adjusted pricing (a PSA 10 vs. raw card) — the fetched price is the catalogue's own
  "market price" field as-is, not condition-adjusted; the manual-value path remains the escape hatch for a
  user who disagrees.
- Marketplace listing or selling integration.

## Acceptance criteria

1. Given a collectible with `price_source = 'manual'`, then its current value is exactly
   `manual_value_minor`, with no price fetch attempted.
2. Given a collectible with `price_source = 'pokemontcg'` and a cached price within TTL, then its current
   value is that cached USD price converted to IDR via the shared FX helper, rounded only once at the final
   minor-unit step; given the cache is cold or the upstream call fails, then it falls back to
   `manual_value_minor` and the UI states the price is not live, matching FN-25's exact fallback wording
   pattern for consistency.
3. Given a collectible's gain is computed, then it is `currentValueMinor − purchase_price_minor` as an exact
   integer, shown in rupiah as the primary figure (signed, `−` U+2212 for a loss) with any percent shown only
   as a smaller secondary annotation, never the reverse.
4. Given the photo upload/serving path, it behaves exactly as FN-27's acceptance criteria 4–6 describe
   (magic-byte validation, size cap, space-scoped random key, authenticated serve-only route, tombstone clears
   `photo_key`, best-effort R2 cleanup) — proven by the same test shapes, whichever feature's code the shared
   module's tests live under.
5. Given the "Kartu Pokémon TCG" toggle is off (the default), then no network call to `api.pokemontcg.io` is
   ever made for that item.
6. Given no browser ever calls `api.pokemontcg.io` or the FX helper's host directly (CLAUDE.md "any external
   price API is server-side only"), then `/koleksi`'s CSP lists no such `connect-src` host, and the fetch
   exists only in `src/lib/server/collectibles/prices.ts` and the jobs-Worker cron.
7. Given the `koleksi` module is hidden via FN-12, then `/koleksi` still loads and its total still counts.
8. Given a space the user is not a live member of, every collectibles route and action (list, write, photo
   upload/serve) answers exactly as `requireSpaceAccess` does elsewhere.
9. Given a create/update/archive action, it follows the guarded `writable`/stale-vs-missing pattern, survives
   a reload, and shows saving/uploading → success only once the server confirms.
10. Given the account-deletion path runs, every collectible (and its R2 photo, best-effort) of a space the
    user was the last live member of is purged; a shared space's collectibles survive for the other members.
11. Every new Indonesian string has an English entry; every money figure uses `formatMoney`/
    `formatMoneyCompact`; every date shown is the WIB calendar date; no page text claims MONTRA grades,
    authenticates or appraises an item — the fetched figure is labelled as a market price from its named
    source, never as MONTRA's own valuation.

## Architecture notes

- **New migration** `migrations/0015_collectibles.sql` (renumber at merge — coordinate with FN-24/25/26/27,
  landing in the same window). New Drizzle table `collectibles`, added to `SPACE_SCOPED_TABLES`.
- **Reused:** `requireSpaceAccess`/`isLiveMember`; the goals-repo CRUD pattern; FN-25's `fetchUsdIdrRate` and
  `CACHE` KV key scheme (extended with a `pokemontcg` prefix); FN-27's photo validation/storage/serving logic,
  extracted into a shared `src/lib/server/photos/` module parameterised by owning table and R2 key prefix —
  whichever of FN-27/FN-28 lands second does this extraction so neither duplicates the other's upload code.
  `formatMoney`/`formatMoneyCompact`; FN-12's `MODULES`/hidden-module notice pattern.
- **New modules:** `src/lib/server/collectibles/{validation,repo,prices}.ts`; `/koleksi` route tree;
  `src/routes/api/v1/collectibles/[id]/photo/+server.ts`.
- **Worker boundary:** the Pokémon TCG price fetch runs in the jobs-Worker cron (same tick as FN-25's price
  refresh, one shared loop over both tables' distinct priced symbols), never the app Worker's request path.
- **No AI** in this feature (the disabled affordance is UI-only).

## Prerequisites

- **No new credential needed for the Pokémon TCG path** if the engineer's build-time check confirms
  `api.pokemontcg.io` is still keyless at its current free quota; if that has changed since this PRD was
  written (2026-10-08), the feature ships with every collectible on manual value only and the toggle removed
  or disabled with "Belum dikonfigurasi" — the acceptance criteria above already require a graceful manual
  fallback, so no PRD rewrite is needed either way.
- **FILES R2 bucket**: already bound, no new credential (same as FN-27).
- **AI identification stays "Belum dikonfigurasi"** pending the on-hold Anthropic key, same as FN-27.

## Owner decisions

All auto-accepted per owner instruction 2026-10-08 (no open questions):

1. **Automated pricing scoped to Pokémon TCG cards only**, every other collectible manual-only — auto-accepted
   as the one category with a verified free, keyless, legitimate price source at the time of writing; broader
   "trading cards and certain game items" coverage (a broader scope) would require paid/key-gated vendors
   this pass does not procure.
2. **Gain shown in rupiah first, percent only as a secondary annotation** — auto-accepted per CLAUDE.md's
   locked design-system rule ("rupiah not percent"), a deliberate difference from the percent-first
   convention of comparable apps, which CLAUDE.md allows (behaviour only, never brand — and here not even
   behaviour, since our own design system is the locked constraint).
3. **Shared photo module with FN-27** rather than two independent implementations — auto-accepted to avoid
   maintaining two upload/serve code paths for the same R2 pattern; trade-off is a small refactor cost
   whichever feature lands second.
4. **Collectible cap: 300 per space** — auto-accepted, matching FN-27's belongings cap.
5. **No condition/grading adjustment** — auto-accepted; the catalogue's raw market-price field is shown as-is,
   with manual override always available for a user who disagrees.

## Tracker impact

- Adds to `docs/TASKS.md` › "Phases 3 – 5 and later": "FN-28 Collectibles: items with R2 photo, Pokémon TCG
  auto-price (manual elsewhere), AI identification disabled pending Anthropic key. Depends on FN-25 (shared
  FX/KV) and FN-27 (shared photo module)."
- `docs/ACCEPTANCE.md` gains the shared "Security and privacy" row from FN-27 ("Belonging/collectible photos
  served only through the authenticated route, never a public R2 URL") and a "Money and dates" row: "External
  price APIs (Pokémon TCG, gold, crypto, FX) called server-side only; manual value is always the fallback."
