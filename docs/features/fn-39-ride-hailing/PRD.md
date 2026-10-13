# FN-39 — Ride-hailing and food delivery options

Status: proposed. Risk tier: **Large** (schema migration that rebuilds `categories` and, around it,
`category_budgets`; touches four capture paths and one catalogue).

Owner request (2026-10-08, Indonesian): "Tambahkan opsi dari ridehailing seperti gojek dan grab termasuk food
delivery." Owner chose all four parts below; defaults in **Owner decisions** are proposed and auto-accepted unless
the owner says otherwise.

## Goal

Ride-hailing and food delivery (GoRide/GoCar/GrabBike/GrabCar/Maxim; GoFood/GrabFood/ShopeeFood) are some of the
most frequent small cash-out moments for an Indonesian phone owner, and today they all fall into the generic
"Transportasi" or "Makan & Minum" presets or get typed as a custom category. Giving them their own preset
categories, and recognising the brand/service words automatically wherever MONTRA already guesses a category
(voice, Slack drafts, CSV import, statement import), removes a manual step from the main journey's "record by
voice" and "import a statement" steps without adding a new capture mechanism. The wallet quick-pick chips and the
Langganan catalogue entries round out the same two life areas (ride top-ups as e-wallets, ride/food memberships as
subscriptions) using the exact patterns MONTRA already has for both.

## Scope

### Part 1 — Two new preset categories

- Add two expense presets to `PRESET_CATEGORIES` and `TILE_KEYS` in `src/lib/shared/transactions.ts:90-129`:
  `tileKey: 'ojek-online'`, name `msg('Ojek Online')`, kind `expense`; `tileKey: 'pesan-antar-makanan'`, name
  `msg('Pesan Antar Makanan')`, kind `expense`. Insert them after the existing `transportasi` preset so related
  expense tiles stay grouped; this changes `PRESET_CATEGORIES`' and `TILE_KEYS`' length from 15 to 17 and the
  expense/income split from 10/5 to 12/5.
- Add matching entries to `CATEGORIES` in `src/lib/ui/kit/category.ts:3-19` (`cssVar: '--cat-ojek-online'`,
  `--cat-pesan-antar-makanan`) with new emoji (see Owner decisions) and to `docs/design/tokens.css:59-73` (two new
  `--cat-*` colour tokens, distinct hues from the existing 15 — `category.test.ts:9-12` checks every `cssVar`
  exists in the token file).
- Widen `categories_tile_key_check` in `src/lib/server/db/schema.ts:321,336-338` to the 17 tile keys (Drizzle
  schema; the actual DB constraint comes from the migration below, schema.ts must match it).
- **Migration `migrations/0027_ride_food_categories.sql`** (next free number after `0026_api_tokens.sql`). SQLite
  cannot alter a CHECK constraint, so `categories` is rebuilt, exactly as `migrations/0022_balance_adjustment.sql`
  rebuilt `transactions` for FN-37. Unlike that migration, `categories` has **four** live incoming references, one
  of them `NOT NULL`:
  - `transactions.category_id` (nullable, schema.ts:404), `recurring_transactions.category_id` (nullable,
    schema.ts:487), `drafts.category_id` (nullable, schema.ts:626) — set aside in one scratch table per the
    `__fn37_links` pattern (id → old value), set to `NULL`, restored after the rebuild. Expect far more rows than
    FN-37's drafts/subscriptions case (every categorised transaction), so use one `INSERT … SELECT … WHERE … IS NOT
    NULL` / one `UPDATE … SET … = NULL WHERE … IS NOT NULL` per table, never a per-row loop.
  - `category_budgets.category_id` (schema.ts:733, `NOT NULL`, composite FK to `(categories.space_id,
    categories.id)` via `category_budgets_category_fk`, schema.ts:744-748) **cannot** be nulled. Rebuild
    `category_budgets` **twice**: once beforehand without `category_budgets_category_fk` (same CREATE/INSERT
    SELECT/DROP/RENAME shape, keeping `category_budgets_space_category_uq` and `category_budgets_amount_check`),
    so nothing blocks dropping `categories`; once afterward re-adding the FK against the rebuilt `categories`
    table.
  - Order inside the migration: (1) rebuild `category_budgets` without the FK, (2) set aside and null the three
    nullable `category_id` columns, (3) rebuild `categories` with the widened `categories_tile_key_check`
    (indexes `categories_space_idx`, `categories_space_id_uq` recreated), (4) restore the three nullable columns,
    (5) rebuild `category_budgets` again with the FK restored.
  - The migration is schema-only. It does **not** bulk-insert the two new presets into existing spaces' rows (see
    next bullet) — no raw-SQL attempt to reproduce `bumpSpaceSeq`/`currentSpaceSeq` (`src/lib/server/sync/seq.ts`)
    bookkeeping outside its own TS helpers.
- **Backfill for existing spaces**: extend `ensurePresetCategories` in `src/lib/server/categories/repo.ts:43-73`.
  Today it returns early once a space has *any* category row (first-load seed only). Add a second, idempotent
  path: when the space already has categories but is missing one or both of the two new preset tile keys (checked
  by `isPreset = 1 AND tile_key = …`, not by name, so it never collides with a same-named custom category), insert
  only the missing ones at the end of the expense sort order, in the same one-`db.batch` shape as the existing
  insert (guarded `INSERT … SELECT … WHERE NOT EXISTS`, `bumpSpaceSeq` first). This function is already called
  from every category-touching load/action (`drafts/repo.ts:438`, `imports/csv-import.ts:356`,
  `routes/api/v1/categories/+server.ts:10`, `pengaturan/kategori`, `anggaran`, `langganan`, every `riwayat/*`
  route — grep confirms 13 call sites), so every space gets the two new presets the next time it touches
  categories, transactions, budgets or imports; no separate backfill script, no bulk data migration.
- i18n: `msg('Ojek Online')` and `msg('Pesan Antar Makanan')` need English entries in `src/lib/shared/i18n-en.ts`
  (e.g. "Ride-hailing", "Food delivery") — proper service names (GoRide, Grab, GoFood, …) used elsewhere are never
  translated, only these two MONTRA-authored category names are.
- Update the "exactly 15" assumptions found by inspection: `src/lib/shared/transactions.test.ts:8,19-22`,
  `src/lib/ui/kit/category.test.ts:7`, `src/lib/server/categories/validation.test.ts:41`, the migration-SQL-match
  test at `transactions.test.ts:12-16` (now matches `0027`'s rebuilt `categories_tile_key_check`, not `0004`'s —
  decide and state in the test which migration is authoritative for the *current* constraint, since `0004`'s own
  text must stay unchanged as a historical record), and the categories repo comment "15 presets" at
  `categories/repo.ts:11,38`. `src/lib/server/api/serialize.ts:50,66,128` passes `tile_key` through untyped SQL
  columns and needs no enum change. No other hard-coded "15" or exhaustive tile-key switch exists in budgets,
  reports, demo seed (`scripts/demo-seed.ts` only names specific tiles it uses, not an exhaustive list), CSV
  export, or the public API schemas (none enumerate `TileKey` — confirmed by inspection).

### Part 2 — Automatic recognition (one shared keyword table)

- New shared module `src/lib/shared/category-keywords.ts` exporting a single ordered keyword table and a lookup
  function, so voice, Slack, CSV import and statement import never diverge:
  - `FOOD_DELIVERY_WORDS`: `gofood`, `grabfood`, `shopeefood` → `pesan-antar-makanan`.
  - `RIDE_HAILING_WORDS`: `gojek`, `goride`, `gocar`, `grab`, `grabbike`, `grabcar`, `maxim`, `ojol` → `ojek-online`.
  - The existing fixed map (`kopi`, `makan`, `parkir`, `bensin`) stays, now documented as "widened 2026-10-08,
    owner decision" instead of "owner decision F: nothing broader" (`src/lib/shared/voice-parse.ts:41`).
  - A lookup function takes a list of already-tokenised bare (lower-cased, punctuation-stripped) words and returns
    the matching `TileKey` or `undefined`, checking `FOOD_DELIVERY_WORDS` across *all* words first, then
    `RIDE_HAILING_WORDS`, then the existing fixed words — "food wins over ride" when one sentence contains both
    (e.g. a single item's words contain both `grab` and `gofood`). Matching is whole-word only (exact entry in the
    bare-word list); no `startsWith`/`includes` substring matching, so `grab` and `grabfood` are two independent
    map entries and a sentence written as two separate words ("grab food") matches only `grab` → Ojek Online — a
    known, documented limitation (see Out of scope), not a bug.
- `src/lib/shared/voice-parse.ts:42-47,146-147` (`CATEGORY_WORDS`, the `bareWords.find` lookup in `buildCandidate`)
  calls the new shared lookup instead of its own inline map, so FN-14 voice and FN-29 Slack drafts (which call
  `parseVoiceSentence` directly, `slack-draft-parse.ts:79`) both get the widened recognition with no further
  change to either file.
- **CSV import and statement import** (`src/lib/server/imports/csv-import.ts:346-348`, `categoryOf`): today a row's
  category comes only from an explicit `categoryName` cell; a blank cell falls straight to `FALLBACK_EXPENSE_
  CATEGORY` ("Lainnya") / `FALLBACK_INCOME_CATEGORY` ("Pemasukan Lain"). Statement rows (`src/lib/shared/
  statements/rows.ts:70`) always set `categoryName: ''`, so statements never guess a category today. Change
  `categoryOf` so that when `categoryName` is blank, it tokenises `value.title` (the row's description) and runs
  it through the same shared lookup from Part 2 before falling back to the existing default; when the lookup hits,
  it resolves to the matching preset's **name** (`'Ojek Online'` / `'Pesan Antar Makanan'`), which then flows
  through the existing `categoryNameKey` match-by-name-and-kind logic unchanged (`categories/repo.ts:261-263`) —
  no new category-lookup path, just a smarter `categoryOf`. This is new behaviour for CSV/statement import (they
  do not guess from free text today), scoped to these two services only, not a general merchant-categoriser.
- `src/lib/shared/voice-parse.test.ts:164-171` and a new `category-keywords.test.ts` cover: each new word maps
  correctly, `grab` alone still maps (ride), `grabfood`/`gofood`/`shopeefood` map to food even though they contain
  `grab`/`go`-prefixes, a sentence item containing both a food and a ride word resolves to food, unrelated words
  (`pulsa`) still produce no hint, and the CSV/statement `categoryOf` fallback order (explicit cell → keyword
  guess from title → default).

### Part 3 — Wallet quick-pick chips

- `src/lib/ui/wallets/WalletForm.svelte` gains a row of chips above the `name` field: GoPay, OVO, ShopeePay, DANA.
  Each chip sets `name` to the service's proper name and selects `type = 'e_wallet'` (`WALLET_TYPES`,
  `src/lib/shared/wallets.ts:4`). No GrabPay chip — in Indonesia GrabPay is rebranded OVO, so the OVO chip already
  covers it (owner decision, confirmed in Owner decisions below).
- No-JS fallback follows the pattern already used for the Langganan catalogue (`CataloguePicker.svelte:30-46`,
  `/langganan?tambah=<id>` read server-side) and for Dompet's own `?tambah=1`/`?ubah=<id>` query params
  (`routes/(app)/dompet/+page.svelte:54-55,87-91,161-172`, `+page.server.ts` `queryId` reads): each chip is a plain
  `<a href="/dompet?tambah=1&dompet=gopay">`-style link (query param carries the quick-pick id); `dompet/
  +page.server.ts`'s load reads it and prefills `blank()`'s `name`/`type` for the inline (no-JS) render exactly as
  `data.open`/`inline` already do. With JavaScript, clicking a chip is intercepted (same `intercept()` helper,
  `+page.svelte:80-83`) and sets the already-bound `name` input and `type` radio directly, no navigation — same
  two-path shape the page already uses for add/edit.
- i18n: chip labels are proper nouns (GoPay, OVO, ShopeePay, DANA) and are never translated, matching the
  Langganan catalogue's own rule (`subscriptions-catalogue.ts:6-8`).

### Part 4 — Langganan catalogue entries

- Add entries to `SUBSCRIPTION_CATALOGUE` in `src/lib/shared/subscriptions-catalogue.ts:38-77`: `gopay-plus`
  (name "GoPay Plus", category `tagihan` — a wallet-tier membership, not entertainment), `gofood-plus` (name
  "GoFood Plus", category `tagihan`), `grabunlimited` (name "GrabUnlimited", category `tagihan`). No new
  `SubscriptionCategory` key needed; `tagihan` ("Pulsa & internet"/bills-like recurring membership fees) already
  covers Telkomsel/IndiHome-style recurring services and fits a ride/food membership better than `streaming`,
  `musik` or `game`.
- No price field: `CatalogueEntry` has no `amountMinor` today (`subscriptions-catalogue.ts:31-36`) and none is
  added — `SubscriptionForm`/`validation.ts:105-124` already require the user to type the amount; the catalogue
  only prefills name and category, identical to every existing entry. No guessed price is stored anywhere.

## Out of scope

- A single "GrabPay" wallet chip (GrabPay is OVO in Indonesia; the OVO chip covers it).
- Recognising ride/food words split across two words with a space (e.g. "grab food", "go ride") — only
  single-token brand/service words are matched, consistent with the existing fixed map's whole-word design.
- A general merchant/MCC categoriser for CSV or statement import beyond these two new categories; no change to how
  any other category is guessed or to receipt/Gmail capture (FN-15/FN-19), which already read merchant text through
  AI, not this keyword table.
- Backfilling the two new presets into existing spaces via a bulk data migration or admin script — the lazy
  top-up in `ensurePresetCategories` is the only mechanism this pass.
- New icons/illustrations beyond an emoji per preset (no logos or brand marks for Gojek/Grab/GoPay/OVO/etc., per
  CLAUDE.md's no-brand-copying rule — proper names as plain text only).
- Any change to FN-16/FN-16a's balance-check, dedupe or review flow beyond the one-line `categoryOf` fallback.
- A merchant-name allowlist beyond the fixed keyword table (e.g. regex for "GOJEK*JAKARTA" statement merchant
  codes) — out of scope until a real statement sample shows the need.

## Acceptance criteria

Numbered; Vitest-first (unit/integration against local D1), Playwright/Browser only where real-browser behaviour
(chip click, no-JS form) is the actual subject.

**Presets and migration**

1. Given a space that has never loaded any category route, when `ensurePresetCategories` runs, then it seeds
   exactly 17 categories (12 expense, 5 income), including `Ojek Online` (`ojek-online`) and `Pesan Antar Makanan`
   (`pesan-antar-makanan`) as `is_preset = 1`, `is_hidden = 0`. (Automated — `transactions.test.ts`,
   `categories/repo.test.ts` or equivalent integration test.)
2. Given a space that already has the original 15 presets (seeded before this change) and no row with
   `tile_key in ('ojek-online','pesan-antar-makanan')`, when any route calls `ensurePresetCategories` again, then
   exactly the two missing presets are inserted (idempotent: a second call makes no further insert), the space's
   other 15 categories and any custom categories are unchanged, and the space's sync `seq` is bumped by the
   insert. (Automated.)
3. Given migration `0027` applied to a local D1 with existing `transactions.category_id`, `recurring_
   transactions.category_id`, `drafts.category_id` and `category_budgets.category_id` values set, when the
   migration finishes, then every one of those rows points at the same category id it did before (no row loses or
   changes its category), `categories_tile_key_check` accepts all 17 tile keys and rejects an 18th, and
   `category_budgets_category_fk` is present and enforced again (an insert with a category id from another space
   is refused). (Automated — `npm run db:migrate:local` then a Vitest integration test reading the rebuilt rows.)
4. Given the migration runs twice (re-applied to a fresh local D1, per the engineering checklist's "migrations …
   re-runnable" rule), then it completes without error both times with the same end state. (Automated.)
5. `src/lib/ui/kit/category.test.ts` and `src/lib/shared/transactions.test.ts` are updated to expect 17 and pass;
   every new `--cat-*` token exists in `docs/design/tokens.css`. (Automated.)
6. Given a Pro-gated or shared-space category list (`MAX_CATEGORIES_PER_SPACE = 100`), when the two presets are
   topped up, then the space's custom-category room shrinks by exactly 2 and a space already at the cap minus 1
   can still receive both without exceeding 100 (or, if it is at the cap already, the top-up still succeeds since
   presets are seeded independently of the create-category cap check — confirm `ensurePresetCategories`'s insert
   is not gated by `MAX_CATEGORIES_PER_SPACE`, matching today's first-seed behaviour). (Automated.)

**Automatic recognition**

7. Given the sentence "gojek ke kantor 15rb", when parsed by `parseVoiceSentence`, then the draft's
   `categoryHint` is `'ojek-online'`. Same for `goride`, `gocar`, `grabbike`, `grabcar`, `maxim`, `ojol`, bare
   `grab`. (Automated.)
8. Given the sentence "laper nih gofood 45rb", when parsed, then `categoryHint` is `'pesan-antar-makanan'`. Same
   for `grabfood`, `shopeefood`. (Automated.)
9. Given one item's words contain both a ride word and a food word (e.g. "grab terus gofood 50rb" parsed as one
   item, or a constructed test item with both words present), when categorised, then the result is
   `'pesan-antar-makanan'` (food wins). (Automated.)
10. Given a Slack message "gofood siang 35rb", when `parseSlackMessage` runs, then the resulting draft's
    `categoryHint` is `'pesan-antar-makanan'` — proving Slack inherits the widened table through
    `parseVoiceSentence` with no Slack-specific code change. (Automated.)
11. Given a CSV import row with an empty `categoryName` cell and description "GRABFOOD JKT", when imported, then
    the written transaction's category is the space's `Pesan Antar Makanan` preset (created if the space had never
    topped it up, since `importRows` calls `ensurePresetCategories` first, `csv-import.ts:356`). Given a
    description with no recognised word, the existing "Lainnya"/"Pemasukan Lain" fallback still applies.
    (Automated.)
12. Given a statement row (FN-16a) with description "GOJEK*JAKARTA" and no category column at all, when imported,
    then the transaction's category is `Ojek Online`. (Automated.)
13. Given "pulsa 50rb" or "jual kopi 25rb" (existing non-matching/overridden cases), when parsed, then no spurious
    `categoryHint` is produced — the widened table does not regress the two existing documented exceptions
    (`voice-parse.test.ts:170-171`). (Automated.)
14. Every new Indonesian string this part introduces (none — this part adds only data/lookup code, no new UI
    copy) requires no new i18n entries; confirmed by the i18n-coverage test still passing. (Automated.)

**Wallet quick-pick chips**

15. Given the Dompet "Tambah dompet" form rendered with JavaScript, when the user clicks the GoPay chip, then the
    `name` field shows "GoPay" and the `type` pill shows `e_wallet` selected, without a page navigation.
    (Browser/Playwright.) Same for OVO, ShopeePay, DANA.
16. Given the same form with JavaScript disabled (or the no-JS inline render path, `dompet/+page.svelte:277-283`),
    when the user activates the GoPay chip link, then the page reloads to the add-wallet form with `name` already
    "GoPay" and `type` already `e_wallet` pre-selected, and the form still submits and creates the wallet via
    `?/createWallet` with server-side validation unchanged. (Browser/Playwright, JS-off context.)
17. Given a user then edits the pre-filled name before submitting, when they submit, then the wallet is created
    with the edited name — chips only pre-fill, they never lock the field. (Automated via `WalletForm`'s existing
    validation test, or Browser.)
18. The four chip labels (GoPay, OVO, ShopeePay, DANA) render identically in `id` and `en` locale (proper nouns,
    never translated) — covered by the i18n coverage test having nothing new to assert, and a snapshot/DOM test
    confirming the labels are not run through `tr()`. (Automated.)

**Langganan catalogue**

19. Given the Langganan "Tambah" picker, when the user picks "GoPay Plus", "GoFood Plus" or "GrabUnlimited", then
    the subscription form opens pre-filled with that name and the `tagihan` category, with the amount field empty
    (never a guessed price), exactly like every existing catalogue entry. (Automated — extend
    `subscriptions.test.ts`/`validation.test.ts`'s existing catalogue assertions to the three new ids.)
20. Given the no-JS path (`/langganan?tambah=gopay-plus`), when the page renders without JavaScript, then the same
    pre-filled inline form appears (existing `?tambah=` mechanics, unchanged). (Browser, JS-off.)
21. `catalogueEntry('gopay-plus')` etc. return the expected entry; an unknown id (e.g. a stale link to a removed
    entry) still returns `null` and the form falls back to the existing "unknown catalogue id" refusal. (Automated.)

**Cross-cutting (every applicable `docs/ENGINEERING_CHECKLIST.md` item)**

22. Every load and action touched (`dompet`, `langganan`, `pengaturan/kategori`, `anggaran`, every `riwayat/*`,
    CSV/statement import, Slack draft ingestion) still goes through `requireSpaceAccess`/`isLiveMember` — no new
    route bypasses the shared space-access helper (unchanged call sites, confirmed by not having touched them).
    (Automated — existing cross-space tests for these routes still pass.)
23. The migration is never edited after being applied anywhere (local or staging) and is re-runnable (criterion
    4); `docs/RUNBOOK.md`'s Time Travel bookmark step is noted before any remote apply.
24. The new keyword table operates only on already-cleaned, length-capped, control/zero-width-stripped text
    (reuses `cleanMoneyText`/`cleanText`/`plainText`'s existing sanitisation; no new untrusted-text entry point).
25. The CSV/statement keyword guess is bounded (one pass over the title's words, same cost class as the existing
    `findMoneyMentions` scan) — no new unbounded scan introduced per imported row.
26. `npm run gates` (check, lint, test, build) is clean after the change.
27. Money and dates: no amount or date handling changes in this feature (no new acceptance needed beyond the
    existing statement/CSV/voice money-vector and WIB-boundary tests still passing unmodified).
28. Every new Indonesian phrase (`Ojek Online`, `Pesan Antar Makanan`, `GoPay Plus`, `GoFood Plus`,
    `GrabUnlimited` — the latter three are proper nouns stored as typed, not through `tr()`, matching every other
    catalogue entry) that *is* translated (the two category names) has an English entry in `i18n-en.ts`; the
    i18n-coverage test fails before this PRD's change and passes after (fail-before proof, checklist "Tests").

## Owner decisions

Proposed defaults below; auto-accepted per standing instruction unless the owner overrides.

1. **Tile order**: the two new presets sit right after "Transportasi" in `PRESET_CATEGORIES`/`TILE_KEYS` (expense
   count 10 → 12). *Default: accept.*
2. **Icons/colours**: emoji 🛵 is already used by `transportasi`; propose 🛺 (auto rickshaw, closest free emoji to
   an ojek) for `ojek-online` and 🛍️ is used by `belanja`, so propose 🥡 (takeout box) for
   `pesan-antar-makanan`. Colours: two new hues not already in the 15-token palette (e.g. `--cat-ojek-online:
   #f97316` orange, `--cat-pesan-antar-makanan: #dc2626` red) — final hex picked by the engineer to stay
   AA-contrast in both themes per `docs/design/DESIGN_SYSTEM.md`. *Default: accept, engineer finalises hex.*
3. **GrabPay**: no separate wallet chip; the OVO chip is used for GrabPay top-ups too (same real-world company in
   Indonesia). *Default: accept, as the owner's brief already states.*
4. **Langganan category for the three new entries**: `tagihan`, not a new `SubscriptionCategory` key. *Default:
   accept.*
5. **Word-boundary and priority rule** (food wins over ride; whole-word only, no cross-word phrase matching).
   *Default: accept — matches the existing fixed map's design and keeps the change bounded.*
6. **Backfill mechanism**: lazy top-up on next `ensurePresetCategories` call, no bulk migration script, so a
   dormant space only gets the two new presets the next time someone opens it. *Default: accept — this is also
   how the original 15 presets have always been seeded for new spaces.*
7. **CSV/statement keyword guess scope**: only these two new categories get a title-based keyword guess when the
   category cell is blank; no other preset gains this behaviour in this pass (e.g. "kopi"/"makan"/"parkir"/
   "bensin" words in a statement description still fall through to "Lainnya" unless a later feature extends this).
   *Default: accept — a broader merchant categoriser is a separate, larger feature.*

## Architecture notes (summary)

| Area | Files | Change |
| --- | --- | --- |
| Shared domain | `src/lib/shared/transactions.ts`, `category-keywords.ts` (new) | preset/tile list; keyword table |
| Shared domain | `src/lib/shared/voice-parse.ts`, `connected-apps/slack-draft-parse.ts` (no code change, inherits) | widened lookup |
| UI kit | `src/lib/ui/kit/category.ts`, `docs/design/tokens.css` | 2 new tiles/colours |
| Server | `src/lib/server/db/schema.ts`, `migrations/0027_ride_food_categories.sql` (new) | CHECK widen, FK dance |
| Server | `src/lib/server/categories/repo.ts` (`ensurePresetCategories`) | lazy top-up |
| Server | `src/lib/server/imports/csv-import.ts` (`categoryOf`) | keyword fallback |
| UI | `src/lib/ui/wallets/WalletForm.svelte`, `src/routes/(app)/dompet/+page.svelte`, `+page.server.ts` | chips, `?dompet=` query param |
| Shared domain | `src/lib/shared/subscriptions-catalogue.ts` | 3 new catalogue entries |
| i18n | `src/lib/shared/i18n-en.ts` | 2 new English entries |

No Worker other than the main app Worker is touched (no Queue/Workflow changes); `workers/jobs` and
`workers/inbound` are unaffected.

## Prerequisites

None. No new credential, provider or secret is needed — this is pure schema, shared-code and UI work on data
MONTRA already stores. `.dev.vars.example` is unchanged.

## Tracker impact

- `docs/TASKS.md` has no existing open or blocked line for this — FN-39 is a new catalogue entry created by this
  PRD, not a previously tracked item. Add a new line under **To do** (Claude-owned, no credential): "FN-39
  ride-hailing and food delivery options (migration 0027; categories, voice/Slack/CSV/statement recognition,
  wallet chips, Langganan catalogue)." On completion, move it to `docs/HISTORY.md` with the migration number and
  test evidence, per the standard workflow.
- `docs/ACCEPTANCE.md` has no per-FN rows (its tables are journey- and security-level, not catalogue-id-indexed),
  so no existing row moves. If the owner wants one added, the natural line would sit in the "Required journey"
  table as an extra row ("Voice/CSV/statement recognise ride/food brand words → correct preset category") — not
  added by this PRD since it would be the first catalogue-specific row in that file.
- `docs/FEATURES.md` gains a new `### FN-39 …` entry after FN-38 (added alongside this PRD).
