# FN-27 Belongings (Barang)

Slug: `fn-27-belongings`. Phase 4 (Wealth). Risk tier: **Medium** (first feature to write a user-kept photo to
R2; everything else is a straightforward space-scoped CRUD table).

## Goal

Net worth (FN-25) covers cash, investments and debt; belongings fill in the physical half — a laptop, a
motorbike's accessories, furniture — each with a photo, what it cost, and a simple depreciation estimate so
the total current value is honest rather than frozen at purchase price. Some apps recognise the item from its
photo with AI; MONTRA's Anthropic key is on hold, so this pass ships the typed, photographed, manually-valued
version end to end, with AI recognition clearly labelled "Belum dikonfigurasi" rather than silently missing.

## Scope

- **Migration `0014_belongings.sql`** (renumber at merge): `belongings` table, space-scoped: `id`, `space_id`,
  `name`, `purchase_price_minor`, `currency`, `purchased_on` (WIB date), `current_value_minor` (nullable — null
  means "use the depreciation estimate"; set means the user overrode it with their own figure), `photo_key`
  (nullable — the R2 object key, never a public URL, set only once an upload succeeds), `note`, `created_at`,
  `updated_at`, `deleted_at`, `seq`. Content-free tombstone CHECK (a deleted row keeps no content, including
  `photo_key` — see deletion below). Added to `SPACE_SCOPED_TABLES`.
- **`src/lib/shared/belongings.ts`**: `estimatedValueMinor(purchasePriceMinor, purchasedOn, today)` — a
  simple, clearly-labelled-as-an-estimate straight-line depreciation (propose: linear to 20% of purchase price
  over 5 years, then flat — see Owner decisions for the exact curve), pure and unit-tested like
  `budgets/math.ts`'s `safeToSpend`. The UI always labels this figure "Estimasi" / "Estimate", never shown as
  if it were a real valuation, and a stored `current_value_minor` always wins over the estimate when present
  (CLAUDE.md "money is never invented" — the estimate is explicitly flagged as computed, not claimed as fact).
- **`src/lib/server/belongings/{validation,repo}.ts`**: CRUD on the `goals/repo.ts` guarded-insert /
  `writable` / stale-vs-missing pattern; `MAX_BELONGINGS_PER_SPACE` (propose 300 — a physical-items list can
  run longer than a wallet or goal list); a `belongingsTotal(db, spaceId, today)` aggregate (exact BigInt sum
  of each item's `current_value_minor ?? estimatedValueMinor(...)`, grouped by currency, the same "too large"
  null-state convention as everywhere else).
- **Photo upload — the first R2 write in the codebase:**
  - `src/lib/server/belongings/photo.ts`: `storePhoto(env, scope, belongingId, bytes, contentType)` —
    validates the upload server-side (magic-byte sniff, not the client-supplied `Content-Type` header;
    allow-list JPEG/PNG/WebP only; size cap, propose 8 MiB, enforced with the same capped-read pattern as
    `src/lib/server/forms.ts`'s `readCapped`, not `request.formData()` directly on an unbounded body), writes
    to the `FILES` R2 bucket (already bound, `wrangler.jsonc:20`) under a key scoped by space and a random id
    (`belongings/<space_id>/<random>.<ext>`, never a guessable sequential id, never the user's typed file
    name), and only then updates `belongings.photo_key` — so a failed or oversized upload never leaves a
    half-written row.
  - `src/routes/api/v1/belongings/[id]/photo/+server.ts` (`POST` to upload, `GET` to serve): the **R2 object is
    never public** — the bucket has no public access binding, so the only way to read a photo is this
    authenticated route, which calls `requireSpaceAccess` for the belonging's space before streaming the
    object, exactly as every other space-scoped read does. `GET` sets a private, short cache-control (the
    photo itself is not secret to the owning space, but is never cached by a shared/CDN cache) and the
    existing security headers; it never redirects to a signed R2 URL (keeps the one access-check path, per
    CLAUDE.md "a hidden button is not authorization" applied to files too).
  - Deleting a belonging (archive) also deletes its R2 object in the same server action (best-effort: the D1
    tombstone always clears `photo_key` even if the R2 delete call fails, so no dangling reference is ever
    shown; a stray R2 object from a failed delete is swept by the existing hourly jobs-Worker cron, a small
    new "orphan photo sweep" step reusing the pattern FN-21's leftover sweep already establishes in spirit).
- **`/barang` route** (new top-level route, same shape as `/langganan`): list with photo thumbnails (served
  via the authenticated route above, `<img src="/api/v1/belongings/{id}/photo">`, never an inline `data:` URL
  and never `'unsafe-inline'` in CSP), total current value header, add/edit/archive sheet with a native
  `<input type="file" accept="image/*">` (camera or gallery, matching the receipt-scan UI convention already
  named in FEATURES.md FN-15 even though FN-15 itself is on hold), and an explicit "Kenali dari foto (AI)"
  affordance that is **disabled** with "Belum dikonfigurasi" text rather than hidden, so the user knows the
  capability exists and why it is off (matching the existing VAPID/"Belum dikonfigurasi" convention from FN-13).
  Loading/empty/error/saving/success/uploading states match the `/kekayaan` wallet-section pattern, with an
  added "mengunggah foto…" progress state for the upload itself.
- **FN-12 nav:** `barang` is already a `MODULES` flag (`src/lib/shared/feature-flags.ts:8`) with no route
  behind it; this PRD wires the real `/barang` destination and the hidden-module notice.
- **i18n**: every string, including the depreciation disclosure ("Estimasi, bukan nilai pasar sebenarnya" /
  "An estimate, not an actual market value") and the AI-disabled hint.

## Out of scope

- AI photo recognition ("photograph an item and AI recognises it", FEATURES.md FN-27's own mirror line) — on
  hold, Anthropic key not provisioned (`docs/TASKS.md`); the disabled affordance above is the only trace of it
  in this pass.
- Product-name price search (some apps query Google/Amazon/Bing server-side) — out of scope entirely this pass,
  not even a placeholder affordance, since it needs a search provider decision the owner has not made; "Kenali
  dari foto" covers the single AI-gap the request named explicitly.
- Multiple photos per item — one photo per belonging in this pass, matching FN-15's own "one photo per
  receipt" simplicity bias.
- Depreciation curves per category (electronics vs. furniture vs. vehicles ageing differently) — one fixed
  curve for every item this pass (see Owner decisions); category-aware curves are a later refinement.
- Insurance, warranty or resale-marketplace integration.

## Acceptance criteria

1. Given a belonging with no `current_value_minor` override, then its shown value is
   `estimatedValueMinor(purchasePriceMinor, purchasedOn, today)`, visibly labelled "Estimasi", recomputed on
   every load from today's WIB date (never a stored, staling figure).
2. Given a belonging with `current_value_minor` set, then that exact figure is shown instead of the estimate,
   with no "Estimasi" label (it is the user's own stated value).
3. Given a purchase date in the future relative to today (a data-entry mistake) or extremely old, then the
   estimate function still returns a defined, non-negative integer (floor at the curve's stated minimum,
   per Owner decisions) rather than throwing or going negative — proven by a vectors test at 0, 1, 5, 20 and
   100 years since purchase, and at a future purchase date.
4. Given a user uploads a JPEG/PNG/WebP under the size cap, then the object is written to R2 under a
   space-scoped random key, `photo_key` is set only after that write succeeds, and the thumbnail renders via
   the authenticated serving route; given the upload is over the size cap or not a real image (magic-byte
   check fails even if the extension/`Content-Type` header lies), then it is refused with a clear error and no
   partial `photo_key` is ever set.
5. Given a photo's serving route is requested by a user who is not a live member of the belonging's space,
   then it answers the same 404 `requireSpaceAccess` returns elsewhere — never a raw R2 404/403, no existence
   oracle, and never a public/unauthenticated R2 URL appears anywhere in the page's HTML or network requests.
6. Given a belonging with a photo is archived (deleted), then `photo_key` is cleared in the same write that
   tombstones the row (content-free, like every other tombstone), the R2 object delete is attempted in the
   same action, and even if that R2 delete fails, no route ever serves that object again for this item (the
   cleared `photo_key` is the single source of truth, not the R2 object's own existence).
7. Given the "Kenali dari foto (AI)" control, then it is always visibly present but disabled with "Belum
   dikonfigurasi" text, never a dead or misleadingly-enabled button, and clicking/tapping it triggers no
   network request.
8. Given the `barang` module is hidden via FN-12, then `/barang` still loads and its total still counts
   (matching the `/kekayaan` hidden-module convention).
9. Given a space the user is not a live member of, every belongings route and action (including the photo
   upload/serve route) answers exactly as `requireSpaceAccess` does elsewhere.
10. Given a create/update/archive action, it follows the guarded `writable`/stale-vs-missing pattern, survives
    a reload, and shows saving/uploading → success only once the server confirms — an interrupted upload
    (network drop mid-transfer) leaves the belonging exactly as it was before the attempt (no partial row).
11. Given the account-deletion path runs, every belonging (and its R2 photo, best-effort, swept if missed) of
    a space the user was the last live member of is purged; a shared space's belongings survive for the other
    members.
12. Every new Indonesian string has an English entry; every money figure uses `formatMoney`/
    `formatMoneyCompact`; every date shown is the WIB calendar date; the depreciation disclosure text is
    present wherever an estimate (not an override) is shown.

## Architecture notes

- **New migration** `migrations/0014_belongings.sql` (renumber at merge). New Drizzle table `belongings`,
  added to `SPACE_SCOPED_TABLES`.
- **R2 (`FILES` binding, `wrangler.jsonc:20`):** first non-FN-21 R2 writer in the codebase — this feature
  writes directly (no sealing/encryption step), since CLAUDE.md lists "item and collectible photos" alongside
  "attached receipt photos" and "agent reports" as the R2 bullet's own kept-files examples, distinct from the
  FN-21 in-memory-only processing path for statements/screenshots. No conflict with FN-21: that encryption
  scheme is for AI-read *results* of uploaded documents, not for a plain photo the user keeps.
- **Reused:** `requireSpaceAccess`/`isLiveMember`; the goals repo's CRUD pattern; `formatMoney`/
  `formatMoneyCompact`; `readCapped`'s bounded-read pattern (`src/lib/server/forms.ts:18`) adapted for binary
  image bytes instead of a form body; FN-12's `MODULES`/hidden-module notice pattern.
- **New modules:** `src/lib/shared/belongings.ts` (depreciation math, pure); `src/lib/server/belongings/
  {validation,repo,photo}.ts`; `src/routes/api/v1/belongings/[id]/photo/+server.ts`; `/barang` route tree.
- **Worker boundary:** the photo upload/serve route runs in the app Worker (it needs the request's session
  and `requireSpaceAccess`, same as every other authenticated route) — the orphan-photo sweep (best-effort R2
  cleanup after a tombstone) can run either inline in the delete action or as a small step on the existing
  jobs-Worker hourly cron; this PRD leaves the choice to the engineer since both satisfy the acceptance
  criteria (criterion 6 only requires `photo_key` to be cleared immediately, not the R2 object itself).
- **No AI** in this feature (the disabled affordance is UI-only, no server call behind it).

## Prerequisites

- **No new credential needed.** The `FILES` R2 bucket is already bound in both environments
  (`wrangler.jsonc:20`, staging equivalent) on an active Cloudflare Workers Paid account (`docs/TASKS.md`:
  "Cloudflare account on Workers Paid… 2026-10-08").
- **AI photo recognition stays "Belum dikonfigurasi"** until the Anthropic API key and AI Gateway are
  provisioned (`docs/TASKS.md`'s on-hold item) — no action needed from this PRD to unblock it; it is simply
  not built here.

## Owner decisions

All auto-accepted per owner instruction 2026-10-08 (no open questions):

1. **Depreciation curve: straight-line to 20% of purchase price over 5 years, flat (floor at 20%) after** —
   auto-accepted as a simple, universally-understandable default that never goes to zero or negative; always
   labelled "Estimasi" so no user mistakes it for an appraisal. A category-aware curve is deferred.
2. **AI recognition: visible-but-disabled control, not hidden** — auto-accepted so the user understands the
   gap rather than wondering why the feature described in onboarding/marketing copy is missing; trade-off is
   one more "Belum dikonfigurasi" surface to maintain until the key arrives.
3. **One photo per belonging** — auto-accepted, matches FN-15's own stated simplicity; multiple photos is a
   later enhancement with its own storage-cost consideration.
4. **Photo size cap: 8 MiB** — auto-accepted as a generous-but-bounded default for a phone camera photo
   (typically well under this), preventing an unbounded R2 write.
5. **Belonging cap: 300 per space** — auto-accepted; a physical-possessions list plausibly runs longer than
   financial-account lists.
6. **No product-price search** — auto-accepted; out of scope entirely this pass (see Out of scope), since it
   needs a provider decision the owner has not made and the request did not ask for it explicitly.

## Tracker impact

- Adds to `docs/TASKS.md` › "Phases 3 – 5 and later": "FN-27 Belongings: items with R2 photo, depreciation
  estimate (labelled), AI recognition disabled pending Anthropic key."
- `docs/ACCEPTANCE.md` gains a new "Security and privacy" row once checked: "Belonging/collectible photos
  served only through the authenticated route, never a public R2 URL" (shared with FN-28 below).
