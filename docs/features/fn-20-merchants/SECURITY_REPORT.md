# FN-20 Merchant recognition — Security report

- **Reviewer:** red-team-pentester
- **Diff:** `git diff 6093a3f..1317ef1` (QA PASS at 1317ef1)
- **Date:** 2026-10-10

## Verdict: PASS

No medium or high findings. Four low findings are listed below so they are tracked.

## Scope reviewed

- `src/lib/server/merchants/{repo,resolve,learn,drafts,ai}.ts` and `src/lib/shared/merchants/*`
- `migrations/0035_merchant_rules.sql`
- Routes: `/pengaturan/pedagang` (load, `hapus`, `hapusSemua`), `/riwayat/saran` (POST), `/kotak-masuk/periksa` (`suggest`, `setCategory` learning), `/kotak-masuk` load (reason chips), `/riwayat/[id]/edit` (learning), `/riwayat/suara` (`parse`), `/impor` (CSV and statement AI step)
- Inbound capture (`src/lib/server/inbound/draft.ts`), the throttle change (`auth/throttle.ts`), export decisions (`export/tables.ts`), and space purge plus account deletion (`spaces/spaces.ts`, `auth/delete-account.ts`)
- Svelte views: `pengaturan/pedagang/+page.svelte`, `periksa/+page.svelte`, `TransactionForm.svelte`, `DraftSummary.svelte`, `riwayat/suara/+page.svelte`

## What holds

- **Space scoping and IDOR.** Every new loader, action and endpoint takes its space from `currentSpaceScope(locals)`. That helper calls `requireSpaceAccess` with `locals.user.id`, so a removed member or a stranger gets the same 404. No route reads a space id from the form.
  - A rule id is looked up only inside the session space (`deleteRule`). A foreign id, a deleted id and an unknown id all return the same 404.
  - All reads (`rulesForKeys`, `cacheForKeys`, `historyForKeys`, `listRules`) filter on `space_id`.
- **Removed members.** Writes repeat `isLiveMember` in the same SQL statement: `upsertRule`, `deleteRule`, `deleteAllRules` and `fillDraftCategories`. Probe: a removed member's `learnFromCorrection` returns false and writes no row. Probe: the routes return 404 (existing test).
- **Roles.** Owner and member manage rules alike. This is PRD owner decision 8, not a gap.
- **The cache is per space, not global.** Its primary key is `(space_id, match_key, kind)`, and reads filter on `space_id`.
  - Probe: space A's AI answer is never served to space B. B's own key is asked instead.
  - `writeCache` keeps a category only while it is a category of the same space and kind. Probe: a foreign category id passed directly is stored as null.
  - Rules use the same pattern: the upsert checks `c.space_id = spaceId`, kind, not deleted and not hidden.
- **AI output and prompt injection.**
  - The prompt is JSON-encoded. It holds cleaned keys (digit runs and ids stripped), the kind, and category names under `cN` refs. It holds no amount, date, wallet or raw text. Probe: a `999` in the descriptor never reaches the request body.
  - The answer is checked twice: by a strict JSON schema and by a strict zod schema (`.strict()`, length caps, at most 80 results). Only keys that were asked for are kept.
  - Refs map back only to ids that were offered. Probe: a raw 36-character UUID from another space fails the schema, and nothing is cached. Probe: an unknown ref (`c999`) becomes null.
  - No number from the model is used. The model never creates a category.
  - A model-supplied name goes through `cleanDescriptor`. Probe: `<img onerror…> Transfer 1234567890…` comes back without `<`, `>` or any 4-digit run.
- **BYOK key.**
  - The key is resolved server-side per acting user (`resolveAnthropicKey(db, opts.userId)`) and is sent only in the `x-api-key` header to the gateway URL.
  - The fetch uses `redirect: 'manual'`, so a redirect cannot carry the key elsewhere.
  - `catch` blocks log only `e.message` or nothing. Probe: a fetch error whose message contains the key yields no `sk-ant` in any console output or in the `?/suggest` action result.
  - The key never appears in page data. The gateway is called with `cf-aig-collect-log: false` and `cf-aig-skip-cache: true`.
- **AI cap and batch bounds.**
  - Batches: at most 40 keys per call and 5 calls per action. `RESOLVE_BATCH_MAX` is 200 items.
  - Rate limit: 20 calls per user per hour, enforced by `overUserAttemptLimit(…, 'merchant-ai', 20, 1h)` before each call. It fails closed on a database error. The counter is an atomic `UPDATE … RETURNING`.
  - AI runs only on explicit actions: "Isi kategori otomatis" and imports. Typing, voice, inbound mail and the draft reason chips are deterministic only. Inbound mail never spends the user's key.
  - The throttle sweep change keeps the hourly rows. Existing 10-minute scopes are unaffected, because each counter matches on its exact `windowStart`.
- **The suggest endpoint (DoS bounds).**
  - The body is capped by `readFormBody` at 8 KiB. Probe: a 2 MB body gets a 400.
  - The endpoint handles at most 20 items. Each title is cut to `TITLE_MAX_LENGTH*4` before cleaning, then to 300.
  - Key lists are bound as one `json_each` parameter, and every query has a `limit`.
  - The history read is bounded at 5,000 rows from the last 12 months.
- **CSRF.** `hooks.server.ts` `isCrossSiteForm` refuses cross-origin form-type POSTs on every non-Bearer route. That covers the `/riwayat/saran` `+server.ts` (the client posts `application/x-www-form-urlencoded`) and all new form actions.
- **Stored XSS.**
  - No `{@html}` or `innerHTML` appears in any changed Svelte file. Merchant names are rendered as text.
  - Names are cleaned to letters, digits, `&` and `'` before storage, and the database checks cap them at 80 characters.
  - The `?dihapus=` query value is only tested for presence, never rendered.
- **SQL injection.** All new SQL is a Drizzle `sql` template with bound parameters. `json_extract` paths are bound constants. There is no string interpolation.
- **Export and deletion.**
  - Export: `merchant_rules` is exported as JSON without `created_by`. `merchant_cache` is `export: 'none'` with a reason (derived AI cache).
  - Deletion: both tables are in `SPACE_SCOPED_TABLES`, ordered before `categories`, so space purge and account deletion remove them. `created_by` is `ON DELETE SET NULL` for a member who deletes their account while the shared space stays. Existing test: "deleting the account removes its space rules and cache".
  - Nothing hard-deletes categories outside the purge, so the `no action` foreign key from the rules and the cache to `categories` cannot block a flow.

## Findings

### L1 (low): `/riwayat/saran` has no per-user throttle, and each request does a 5,000-row history read

- **Location:** `src/routes/(app)/riwayat/saran/+server.ts:17`, `src/lib/server/merchants/repo.ts:109-118`
- **Scenario:** A signed-in user scripts POSTs to `/riwayat/saran` in a loop. Each request reads up to 5,000 transaction rows plus categories, rules and cache, then runs `cleanDescriptor` on every row. A probe measured 217 ms in Node for 5,000 adversarial titles. The client debounce of 400 ms, one request at a time, does not bind a script.
- **Impact:** The user can only burn the app's D1 reads and Worker CPU. The impact is cost amplification by an authenticated account, with no data exposure.
- **Fix:** Add a cheap per-user budget, for example `overUserAttemptLimit(…, 'merchant-suggest', 120, 10min)`. Alternatively, memoise the history tally per space for a short time.

### L2 (low): an AI-chosen merchant name from the cache can become the title of later drafts

- **Location:** `src/lib/server/merchants/resolve.ts:117-120`, `src/lib/server/inbound/draft.ts:113-126`
- **Scenario:**
  1. A descriptor the attacker controls is classified by AI once in the victim's space, through an import or "Isi kategori otomatis". Examples are a transfer sender name or an e-wallet note.
  2. Prompt injection makes the model return a name such as `Gaji Kantor`.
  3. For 90 days, an inbound capture with the same key gets that name as its draft title.
- **Impact:** The text is sanitised (no digits or markup, at most 80 characters) and stays in the same space. The original mail text is kept in the note, and the row is still a draft for review. The risk is a misleading label only.
- **Fix:** Keep the deterministic cleaned name for titles, and show the AI name only as the suggestion chip. Alternatively, accept the risk and document it.

- **Resolution (2026-10-13):** FIXED per owner decision (2026-10-13, "Suggestion only") in `fix(lows): owner decisions for FN-19 L5, FN-20 L2, FN-25b L2, FN-30 L1/L2`. `resolveMerchants` keeps
  `merchant` as the name cleaned from the bank or mail text and returns an AI-recognised name (this call or the
  cache) separately as `suggestedName`, so a capture's title is never the AI's. Kotak masuk offers it as "Pakai nama
  …" (`useName`: the form carries only the draft id and version; the server re-resolves the name and writes it
  guarded on `updated_at`); the typing chip stays tap-to-apply. Tests: `test/integration/merchants-redteam.test.ts` ›
  "L2 (owner decision 2026-10-13): an AI-picked name is a suggestion only, never the title of a later capture"
  (failed before) and `test/integration/kotak-masuk-routes.test.ts` › "offers the cached AI name without changing the
  title; only a tap applies it, re-resolved on the server".

### L3 (low): `writeCache` checks that the space is live, but not the caller's live membership

- **Location:** `src/lib/server/merchants/repo.ts:160-171`
- **Scenario:** A member starts "Isi kategori otomatis" in a shared space. The owner removes the member during the AI call, which can take up to 30 s. The cache write still lands in the space.
- **Impact:** The content is only a category of that space, or null, plus a sanitised name. It was computed with the removed member's own key, for drafts that member could see at request time. The impact is negligible.
- **Fix:** Add `isLiveMember(spaceId, userId)` to the `INSERT … SELECT` guard, as the rule writes do.

### L4 (low): the AI hourly cap uses a fixed window

- **Location:** `src/lib/server/auth/throttle.ts:129`
- **Scenario:** 20 calls at 10:59 and 20 calls at 11:00 make 40 provider calls within about one minute.
- **Impact:** The calls are billed to the user's own key, by the user's own action. The worst case is 2× the stated cap.
- **Fix:** Accept and document, or use a sliding two-bucket count.

- **Resolution (2026-10-13, cycle 2):** FIXED (the report's second option) in `fix(lows): cycle 2: masking, guard and lure normalisation, Gmail re-seal sweep, sliding AI cap, page-level amount mask`. FN-50 brought a
  sliding-window counter (`overUserSlidingLimit`, one-minute buckets) to main; it now takes a window length, and the
  merchant AI cap uses a sliding hour, so no 60 minutes ever hold more than `MERCHANT_AI_CALLS_PER_HOUR` calls
  (`THROTTLE_LONGEST_WINDOW_MS` is 61 minutes so the cleanup keeps every bucket it reads). Test:
  `test/integration/merchants-redteam.test.ts` › "L4 (cycle 2): the hourly AI cap slides, so 20 calls at 10:59 leave
  none for 11:00" (failed with the fixed window: `used`).

## Engineering checklist notes

- Masking: descriptors are cleaned (ids and digit runs stripped) before storage or prompting. The inbound note keeps `maskAccountNumbers(original)`.
- No real providers in tests: every AI test uses an injected fetch double. AC-25 (real Anthropic) stays NOT verified, as QA recorded.
- "Metered against the user's credits": this path uses the user's own key (BYOK). It is capped by the hourly budget, not by credits, which matches the receipt-read precedent.
- No transaction spans an AI call: the resolver resolves first and writes after. The import resolves once per import, outside the D1 batch.

## Commands run

- `npx vitest run test/integration/merchants-redteam.test.ts`: 6 passed (6).
- `npx vitest run test/integration/merchants-redteam.test.ts src/lib/server/merchants/ai.test.ts`: 2 files, 13 passed (13).
- `npx eslint test/integration/merchants-redteam.test.ts`: clean. Prettier was applied to the same file.
- Full gates were not run (out of scope for this review).

## Regression tests kept

`test/integration/merchants-redteam.test.ts` covers:

- a foreign category id or an unknown ref from the model;
- a prompt-injected name, and cache isolation between spaces;
- BYOK key confinement in logs and action output;
- a removed member's learning write;
- the 8 KiB body cap and the 20-item cap on the suggest endpoint;
- a CPU sanity check of the history cleaning.

No AI provider is reached.
