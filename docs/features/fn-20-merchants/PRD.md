# FN-20 Merchant recognition and auto-categorisation

Risk tier: **Large** (new table + migration 0035, new AI call path, touches every capture path, new settings page).
Slug: `fn-20-merchants`. Branch: `feat/fn-20-merchants`.

## Goal

Captured and typed transactions arrive with raw descriptors ("QRIS*KOPI KENANGAN JKT 0812…"). Users want a clean merchant name
("Kopi Kenangan") and the right category (Kopi, Transportasi, Gaji) with no work, and one tap to correct it. A correction must
teach that space, so the same descriptor is right next time. Resolution is deterministic first (rules, history, a curated
dictionary); AI is the last step, uses the user's own key (BYOK, FN-41), and only ever suggests one of the space's existing
categories. Every suggestion shows why it was chosen. With no key, everything except the AI step still works.
Follows common merchant-recognition behaviour (FN-20 row in `docs/FEATURES.md`); no other product's brand, copy, logo or mascot is used.

Owner direction 2026-10-10: build now. `docs/TASKS.md:70` ("FN-20 ... blocked by the Gmail decision") is superseded; the Gmail
path plugs into the same resolver later with no change to FN-20.

## Existing code to reuse or extend (do not duplicate)

- **Keyword table (FN-06 fixed map + FN-39):** `src/lib/shared/category-keywords.ts:13-34` (food delivery, ride-hailing, fixed
  kopi/makan/parkir/bensin groups), `lookup` at `:40-49`, `categoryHintFromWords` at `:55` (voice, receipts), and
  `importCategoryFromTitle` at `:64` (CSV/statement; ride+food groups only, `IMPORT_GROUPS` `:38`). FN-20 **extends this module**
  into the deterministic keyword layer: new groups are added to these tables, and the voice-only restriction (`:5-7`, FN-39
  decision 7) is lifted for the new dictionary only after the owner default below. No second keyword table.
- Callers: voice `src/lib/shared/voice-parse.ts:153-154` (`categoryHint`), Slack drafts
  `src/lib/shared/connected-apps/slack-draft-parse.ts:40,94`, receipt items `src/lib/shared/receipts.ts:168-176`
  (`itemCategoryHint`), CSV/statement `src/lib/server/imports/csv-import.ts:325-338` (`categoryNameOf`, used by both FN-18 and
  FN-16a), voice page mapping tile to category `src/routes/(app)/riwayat/suara/+page.svelte:60-75`.
- Tile keys and presets: `src/lib/shared/transactions.ts:92-135` (`PRESET_CATEGORIES`, `TILE_KEYS`, `TileKey`); category repo
  `src/lib/server/categories/repo.ts` (tile lookup, `getCategory` use in `src/lib/server/drafts/repo.ts:268`).
- Drafts: `src/lib/server/drafts/repo.ts:36-52` (`PendingDraft` with `categoryId`, `title`), bulk category
  `:257-275` (`setDraftsCategory`); forwarding drafts `src/lib/server/inbound/draft.ts:120-140` (`captureBatch` inserts
  `title: c.merchant`, no category). Statement masking `src/lib/server/statements/statement-import.ts:60-74`.
- Space scoping: `requireSpaceAccess` `src/lib/server/spaces/access.ts:48` and `SpaceScope`/`isLiveMember` (`:117-127`).
- BYOK: `resolveAnthropicKey(db, userId, env)` `src/lib/server/ai-keys/lookup.ts:37`; gateway URL/ids
  `src/lib/server/ai-keys/anthropic.ts:25-40` (`anthropicGatewayUrl`, `isAiGatewayConfigured`, `ANTHROPIC_VERSION`,
  `classifyAnthropicResponse`); call shape, headers (`cf-aig-skip-cache`, `cf-aig-collect-log: false`), timeout and zod-parsed
  outcome union to copy: `src/lib/server/receipts/anthropic.ts:29-100` and `src/lib/server/tanya/anthropic.ts:25-136`.
- Money masking: `maskAccountNumbers` (used `statement-import.ts:60`); `cleanText`, `TITLE_MAX_LENGTH = 80`
  (`transactions.ts:49`).

## Scope

1. **Shared pure module `src/lib/shared/merchants/`** (runs on device and Worker):
   - `clean.ts`: `cleanDescriptor(raw)` strips payment prefixes (`QRIS*`, `QRIS `, `TRF`, `TRSF E-BANKING`, `BI-FAST`, `DEBIT
     DOMESTIK`, `POS`, `EDC`, `PURCHASE`, `GOPAY`, `OVO`, `DANA`, `SHOPEEPAY`, `LinkAja` as a wallet prefix), masked/long digit runs
     (phone-like, `0812…`, card tails `xxxx1234`), city codes (`JKT`, `BDG`, `SBY`, `TNG`, `DPK`, `BKS` and similar as trailing
     tokens), trailing branch/terminal ids, repeated punctuation; returns Title Case display name and a **normalised key**
     (lower-case, letters+digits, single spaces, max 60 chars) used for rules and cache.
   - `dictionary.ts`: curated, **fictional-safe generic** table of common Indonesian merchant patterns to `{ displayName,
     tileKey }`: coffee shops, minimarkets, supermarkets, ride-hailing and food-delivery (reusing the FN-39 groups), fuel,
     parking, toll, e-commerce, streaming/subscriptions, telco/pulsa, PLN/PDAM/BPJS bills, pharmacies, salary/payroll words
     (`GAJI`, `PAYROLL`, `SALARY` to Gaji), bonus/THR, interest/`BUNGA`, refund/`CASHBACK`. Names are generic descriptive
     text only; no logos, no brand marks, no claimed affiliation. Matching is whole-token or whole-phrase on the normalised key.
     The existing FN-06/FN-39 word maps become the lowest-priority group of the same module (single source of truth).
   - `resolve.ts`: `resolveDeterministic(input, rules, history)` returns `{ merchant, tileKey|categoryId, reason }`.
   - `reason` values: `rule` ("Dari aturanmu"), `history` ("Dari riwayat"), `dictionary` ("Dari daftar pedagang"),
     `keyword` ("Dari kata kunci"), `cache` ("Dari ingatan"), `ai` ("Saran AI"), `none`.
2. **Server module `src/lib/server/merchants/`**:
   - `repo.ts`: rule CRUD, history lookup, cache read/write, all taking a `SpaceScope`/verified `spaceId` from
     `requireSpaceAccess`; never a `space_id` from a form field.
   - `resolve.ts`: the **one entry point** `resolveMerchants(db, scope, items, { env, userId, allowAi })` for a batch of at most
     200 items `{ rawText, type, hintTileKey? }`. Order per item: **user rule, space history, cache, dictionary/keyword, AI**
     (owner order is rule, history, cache, AI; the deterministic dictionary sits after cache lookup misses and before AI;
     see AC-3). Returns `{ merchant, categoryId|null, reason, confidence }` per item.
   - `ai.ts`: batch classifier (see AI rules) using `resolveAnthropicKey`, gateway URL and the receipts/tanya call pattern.
   - `learn.ts`: `learnFromCorrection(db, scope, { descriptor, categoryId, merchantName? })` upserts the rule.
3. **Migration `0035_merchant_rules.sql`** (and the Drizzle schema entry), tables:
   - `merchant_rules` (`id`, `space_id`, `match_key` normalised descriptor, `merchant_name`, `category_id` nullable FK, `kind`
     expense|income, `hits` int, `source` 'correction'|'manual', `created_by`, `created_at`, `updated_at`, `deleted_at`, sync
     seq per project convention); unique `(space_id, match_key, kind)` among live rows (partial index where `deleted_at is null`).
   - `merchant_cache` (`space_id`, `match_key`, `kind`, `merchant_name`, `category_id`, `reason`, `created_at`, `expires_at`);
     primary key `(space_id, match_key, kind)`; stores only the cleaned key and result, never raw descriptors, amounts, dates or
     account numbers. Rows past `expires_at` are ignored and swept opportunistically (bounded delete).
   - Indexes for the lookups above. Re-runnable per checklist; RUNBOOK gets the Time Travel bookmark note.
   - Number **0035**; 0033 (Gmail) and 0034 (OCR) are reserved. If the build finds 0033/0034 merged first, keep 0035.
4. **Capture integration** (all through `resolveMerchants`):
   - Voice (`/riwayat/suara`): resolver runs on each candidate title after parsing; replaces the tile-to-category mapping at
     `+page.svelte:60-75` (loader/action supplies resolved ids; the keyword hint is just one input).
   - CSV (FN-18) and statements (FN-16a): extend `categoryNameOf` (`csv-import.ts:325-338`) to consult the resolver's result
     before the fallback; a category column in the file still wins (explicit data beats guess). CSV and statement imports write
     transactions directly and have no review rows, so the reason chip applies to drafts only (Kotak masuk and Periksa draf).
     "Atur kategori" bulk action unchanged.
   - Forwarding drafts (FN-19): `captureBatch` (`inbound/draft.ts:120`) fills `title` with the cleaned merchant and `category_id`
     when resolved; the original merchant text stays in `note` as today. Gmail (later) calls the same function.
   - Receipt items (`receipts.ts:168`) keep `itemCategoryHint` but it now delegates to the shared dictionary.
   - **Manual entry** (`/riwayat/baru`): as the user types a title (debounced, min 3 chars, one request at a time) a suggestion
     chip appears ("Kopi Kenangan, Kopi · Dari riwayat"); tapping applies it; never auto-overrides a category the user already
     chose. Deterministic only on this path (no AI call while typing); AI only on explicit draft/import batches.
   - Draft review screens (Kotak masuk, Periksa draf; drafts only, imports have no review rows): each row shows the reason chip next to the category; tapping the
     category opens the existing picker; choosing a different category is the one-tap change.
5. **Learning**: any category change on a draft or saved transaction whose title yields a non-empty `match_key` calls
   `learnFromCorrection` for that space (create the rule, or update category and bump `hits`). Optional checkbox is NOT used:
   learning is automatic, visible and reversible in settings. Rules from AI suggestions are never created until the user
   confirms or corrects the row (accepting an unchanged AI suggestion does not write a rule; see decision 5).
6. **Settings `/pengaturan/pedagang`** ("Pedagang & aturan"): list the current space's rules (merchant, category, hits, last used),
   search, delete one, "Hapus semua aturan" (confirm), add-by-hand not included. Link from `/pengaturan` and the category
   settings page. Loading/empty/error/saving/success states; owner and member may both manage rules of a space they belong to.
7. **AI rules** (`ai.ts`):
   - Only runs when `resolveAnthropicKey` returns a key AND `isAiGatewayConfigured(env)` AND the caller allows it (drafts/imports,
     not typing). Otherwise the item stays `none` ("Tanpa kategori") and nothing errors.
   - One request per batch of up to 40 unresolved distinct keys (dedupe by `match_key` first); at most 5 batches per user action;
     timeout 30 s; results cached in `merchant_cache` for 90 days; failures are not cached.
   - Prompt sends only: the cleaned descriptor string (digits runs and masked numbers already stripped), the kind, and the
     space's visible category ids + names for that kind. **Never sends amounts, dates, wallet names, account numbers or raw
     bank text.** Output is zod-validated: per key `{ key, categoryId|null, merchantName? }`; categoryId must be in the sent set
     else discarded; merchant name is cleaned/truncated again and validated like any untrusted text; no new categories, no
     numbers consumed from the model. Invalid output means `none` plus a reviewable result, never a crash.
   - Gateway headers `cf-aig-skip-cache: true`, `cf-aig-collect-log: false`, key in `x-api-key`; model id shared constant, chosen
     like `RECEIPT_MODEL`/`TANYA_MODEL`, not hard-coded in two places.
   - Metering: no credits are consumed (BYOK, user pays own cost); a per-user cap of 20 AI-resolve calls per hour via the existing
     rate-limit helper; over the cap the item falls back to `none`.
8. **i18n**: every new Indonesian string through `tr()/trf()` with `i18n-en.ts` entries (reason labels, settings page, errors,
   empty state, suggestion chip, "Atur kunci AI di Pengaturan › Integrasi" hint).

## Out of scope

- Gmail connection itself (FN-19 API path), OCR / scanned statements (0034), receipt-photo reading changes (FN-15 as is).
- Logos, brand images, merchant icons, any scraping or live merchant database; web search lookups.
- Cross-space or global (all-users) learning; sharing rules between spaces; organisation-wide dictionary edited at runtime.
- Creating new categories automatically; changing amounts, dates, wallets or types; auto-saving anything AI suggested.
- Re-categorising already saved transactions in bulk ("apply rule to past rows") and retro-active history rewrite.
- User-authored rule editor (regex/contains), rule import/export, rule priority UI.
- App-wide AI key or credits metering (BYOK only), Workers AI fallback, embeddings.
- Android share target, push notifications, Slack path changes other than reusing the shared keyword table.
- Dictionary beyond the curated first set (target ~150 patterns); growth is a data-only follow-up.

## Acceptance criteria

Verification level in brackets: A = Automated (Vitest + local D1), B = Browser (Playwright on wrangler dev), M = Mocked
(never counts as working), N = Not verified (real provider).

1. Given the descriptor `QRIS*KOPI KENANGAN JKT 0812 3456 7890`, when cleaned, then merchant = "Kopi Kenangan", the phone-like run,
   `QRIS*` prefix and `JKT` are gone, and the key is `kopi kenangan`. Vectors also: `TRSF E-BANKING DB 1234/FTSCY/WS95031
   GAJI OKT`, `DEBIT DOMESTIK POS INDOMARET 1234 JKT`, `GOPAY-GOJEK 5/10`, masked `xxxx1234`, empty/whitespace, 5,000 chars,
   zero-width and control characters, RTL text; output never contains HTML, never exceeds 80 chars. [A]
2. Given dictionary entries, when "kopi" shop, "ojek"/"gojek", "gaji"/"payroll" descriptors resolve, then categories are Kopi,
   Ojek Online (or Transportasi when the space lacks the preset), Gaji, with reason `dictionary`/`keyword`. Income words
   never map to an expense category and vice versa (kind check). Whole-token matching: "kopitiam" rule from the table, not a
   substring accident (e.g. "grabber" does not match `grab`). [A]
3. Given a user rule, history, cache and AI all disagree for one descriptor, then the winner is user rule, then history,
   then cache, then dictionary/keyword, then AI, in that order, and the reason label matches. Each layer is tested
   by removing the layers above it. [A]
4. Given the same merchant corrected by the user on 3 earlier saved transactions in the space, when a new draft with the same
   key arrives, then history resolves the most frequent category (ties: most recent) with reason `history`; deleted
   (tombstoned) and transfer rows are ignored; a category of another space is never returned. [A]
5. Given a draft is re-categorised by the user, when saved, then a rule for `(space_id, match_key, kind)` is created or updated
   (`hits` + 1) in that space only; the next capture of that descriptor shows "Dari aturanmu". A second correction to another
   category updates the same rule, never creates a duplicate (concurrent 20 corrections leave exactly one live row). [A]
6. Given user A (space 1) and user B (space 2), when A corrects a merchant, then B's resolution is unchanged; a removed member of
   a shared space gets the same 404 as a non-member on the settings page, rule delete and resolver endpoints; rule ids from
   another space read as not found with identical status/body. Space is taken from the session through the shared space-access
   helper, never from the request body. [A, B]
7. Given a rule or cache entry points to a category later hidden or deleted, then the resolver skips it (falls to the next layer)
   and the rule still lists in settings marked "Kategori tidak tersedia". [A]
8. Given no Anthropic key (or unreadable key, or gateway not configured), when a batch resolves, then no network call is made,
   unresolved items are "Tanpa kategori", deterministic layers still work, and the UI shows the hint to set a key without
   blocking save. [A, B]
9. Given a key and a stubbed provider, when 60 unresolved distinct descriptors resolve, then they go in 2 batches of at most 40,
   duplicates in one request, cache is written, a second identical batch makes zero calls. The request body contains no amount,
   date, wallet name or digit run of 6+ digits (asserted by inspecting the stub's received body). [A with stub; this is M]
10. Given a provider response with an unknown category id, extra fields, wrong types, invalid JSON, HTTP 4xx/5xx or a timeout,
    then the item resolves to `none`, nothing crashes, nothing is cached, no amount or category is created, and the user sees a
    reviewable draft, not an error page. A model-returned `merchantName` with HTML/control chars is cleaned before use. [A]
11. Given 21 AI-resolve calls in one hour by one user, then the 21st does not call the provider and falls back without error. [A]
12. Given voice text "beli kopi kenangan 25rb", when drafted, then the draft title is the cleaned merchant, the category is
    resolved with a reason chip, amount is exactly 25.000 minor-unit-correct (parser unchanged), and typing the same sentence
    gives the same result. [A, B]
13. Given a CSV or statement row with an explicit category cell, then the cell wins over any guess; without one, the resolver's
    category is used; with none, the existing fallback (`Tanpa kategori`/income fallback) applies; counts, totals and
    dedupe keys are unchanged versus before the feature (existing `csv-import.test.ts` still passes untouched). [A]
14. Given a forwarded e-mail capture (FN-19), then the draft gets cleaned merchant title and a resolved category when one exists;
    `note` still holds the original text as today; no category is invented for unknown merchants; existing dedupe unchanged. [A]
15. Given the manual add form, when the user types a title of 3+ characters, then at most one request per 400 ms debounce is sent,
    a suggestion chip with the reason appears, tapping applies merchant + category, and a category the user already picked is
    never overwritten. Works without JavaScript as plain form (no chip, no error). [B]
16. Given any draft row (imports have no review rows), when the user taps the category and picks another, then it changes in one tap, the
    row shows no AI/rule chip for the old value, and the new choice is persisted and learned only after the server confirms
    (success shown only after the write). [B]
17. Given `/pengaturan/pedagang`, then it lists only the current space's live rules, searchable, with empty state, loading
    state and error state; deleting one rule removes it (tombstone) and the next capture no longer shows "Dari aturanmu"; "Hapus
    semua aturan" needs confirmation; stale tab (rule changed elsewhere) answers "diubah sementara itu" instead of overwriting;
    persists across reload; works without JS. [A, B]
18. Given 101+ rules/keys in one batch, then queries use `json_each(?)` binding (no `inArray` on growing lists), no statement
    exceeds 100 bound parameters, and a 60-character term is searched with `instr(lower(col), ?)` not `LIKE`. [A]
19. Given the 200-item batch cap, then a 201st item is not resolved (returns `none`) and no query scans unbounded rows; history
    lookup is limited to the last 12 months and 5,000 rows per space. [A]
20. Money and dates: no code path in FN-20 reads, writes or sends `amount_minor`, currency or `occurred_on` except to pass them
    through unchanged; a diff grep shows no float arithmetic on money. WIB bucketing unaffected (existing tests pass). [A]
21. Privacy: `merchant_cache` and rules store only cleaned keys, never raw bank text, full account numbers or mail bodies;
    account/card numbers are masked before keying and logging; no merchant text is written to logs or analytics events;
    deleting a space/account removes its rules and cache (cascade or sweep, tested). [A]
22. Migration 0035 applies on a copy of the current schema, re-runs idempotently, and `npm run db:migrate:local` succeeds;
    the unique index rejects a duplicate live rule but allows re-adding after a tombstone. [A]
23. i18n: every new phrase has an English entry (existing i18n test passes); keyed `{#each}` uses rule/draft ids, never merchant
    text; 360 px layout with no horizontal scroll and 44 px touch targets on the chip and delete buttons; AA contrast in
    light, dark and mono themes. [B]
24. Gates: `npm run gates` (check, lint, test, build) is clean. Each regression test fails on pre-fix code (show the run).
25. **Real provider:** one run of the batch classifier against the real Anthropic API through AI Gateway with a real user key,
    recorded with date and outcome. **NOT verified** in this pass unless that run is made and logged; stub tests never count as
    working AI. Until then ACCEPTANCE keeps this row at "Mocked/NOT verified".

## Architecture notes

- **Where code lives:** `src/lib/shared/merchants/{clean,dictionary,resolve}.ts` (+ tests), `src/lib/shared/category-keywords.ts`
  (extended, re-exports kept so `voice-parse.ts:1` and `receipts.ts:1` imports stay valid), `src/lib/server/merchants/*`,
  `src/routes/(app)/pengaturan/pedagang/+page.{server.ts,svelte}`, a small `POST` endpoint under the app Worker for the manual-entry
  suggestion (CSRF + form-body guard `src/lib/server/forms.ts`, session required), `src/lib/shared/i18n.ts` + `i18n-en.ts`,
  `migrations/0035_merchant_rules.sql`, Drizzle schema `src/lib/server/db/schema.ts`.
- **Workers:** app Worker only. Forwarding consumer (`workers/inbound`) calls the shared resolver via `captureBatch`
  with `allowAi: false` (no user session there; AI for forwarded drafts runs on review open, not in the consumer); jobs Worker
  untouched. If the build finds the consumer has no safe place for DB reads, deterministic layers still apply.
- **Do not**: add a second keyword table, call Anthropic outside `src/lib/server/merchants/ai.ts`, take `space_id` from input, use
  interactive transactions, or span a D1 write and an AI call in one batch (resolve first, write after).
- **Idempotency:** `learnFromCorrection` is one guarded upsert inside `db.batch`; cache writes are `INSERT ... ON CONFLICT DO
  UPDATE`; replays are harmless.
- **Reason surface:** the reason enum is a shared type; UI chips are derived from it; server never sends free-text reasons.
- Dictionary entries live in a TypeScript data file (reviewed in PR), not in D1, so the Worker cold path stays small; cap file at
  about 150 entries.

## Prerequisites

- AI step: user's own Anthropic key saved in `/pengaturan/integrasi` (FN-41, secret `AI_KEYS_ENCRYPTION_KEY` already required for
  FN-41) and `AI_GATEWAY_ACCOUNT_ID` + `AI_GATEWAY_ID` (`.dev.vars.example:29-30`). Missing any: show **"Belum dikonfigurasi"**
  / "Tambahkan kunci Anthropic di Pengaturan › Integrasi AI" with link; all non-AI layers keep working.
- No other secrets. No new Worker bindings. Migration 0035 applied locally; remote apply is a separate, RUNBOOK-noted step
  (Time Travel bookmark first). Do not apply remotely in this pass.

## Owner decisions (all: adopted default, owner said proceed)

1. **Resolve order** rule, history, cache, dictionary/keyword, AI. (Adopted default (owner said proceed).) Deterministic dictionary
   is read before AI but after the owner's three layers.
2. **Dictionary size and content** ~150 generic patterns, descriptive names only, no logos or brand claims, edited in code.
   (Adopted default (owner said proceed).)
3. **Extend import keyword use**: the voice-only groups from FN-06 now also apply to CSV/statement descriptors. (Adopted default
   (owner said proceed).) Reverses the FN-39 decision-7 restriction at `category-keywords.ts:5-7` for the new dictionary.
4. **Learning is automatic** on any category correction in a space, undoable in settings; no per-correction prompt.
   (Adopted default (owner said proceed).)
5. **AI suggestions** do not create rules unless the user corrects them; accepted-as-is suggestions only fill the cache.
   (Adopted default (owner said proceed).)
6. **AI cost**: BYOK, no credit metering; 20 AI-resolve calls per user per hour; 40 keys per request; cache 90 days.
   (Adopted default (owner said proceed).)
7. **Privacy of AI input**: only cleaned descriptor + category names; never amounts, dates, wallets or account numbers.
   (Adopted default (owner said proceed).)
8. **Rule management**: view, search, delete one/all; both owner and member roles may manage a shared space's rules; no add/edit
   by hand. (Adopted default (owner said proceed).)
9. **Rule retention**: kept until deleted, removed with the space/account; cache auto-expires at 90 days. (Adopted default
   (owner said proceed).)
10. **Explicit file category wins** over any guess on CSV/statements. (Adopted default (owner said proceed).)
11. **Manual-entry suggestion** is deterministic only (no AI while typing). (Adopted default (owner said proceed).)
12. **Merchant name overwrite**: cleaned name replaces the title only on drafts and new entries; saved transactions are never
    retitled retroactively. (Adopted default (owner said proceed).)
13. **Plan gating**: none; available to every plan (no Pro lock). (Adopted default (owner said proceed).)

## Tracker impact

- `docs/TASKS.md:70`: the item "**Claude** — FN-19 Gmail API path · FN-20 Merchant recognition (blocked by the Gmail decision)"
  is split: FN-20 moves to done on completion (note "Gmail plugs in later via the same resolver"); the Gmail path stays open.
- `docs/ACCEPTANCE.md`: add a row "Merchant recognition and categorisation" with Automated evidence (resolver, learning,
  isolation tests) and Browser evidence (suggest chip, one-tap change, settings page); add a separate row "Merchant AI step
  against real Anthropic" left **NOT verified** (Mocked only) until a logged real-provider run. Row for "Category guessed from
  words" (FN-06/39) gains a pointer to the shared dictionary.
- `docs/FEATURES.md` FN-20 "Ours" line updated to describe the dictionary, reasons and settings page; `docs/HISTORY.md`
  entry with checks run; `docs/RUNBOOK.md` note for migration 0035.
