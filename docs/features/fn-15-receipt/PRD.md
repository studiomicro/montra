# FN-15 Receipt scan (Struk) — PRD

Catalog entry: `docs/FEATURES.md` › FN-15 (line 178-186). Phase: 2 — Capture. Tracker: `docs/TASKS.md` › Phase 2 ›
"FN-15 Receipt · FN-16 Statement · FN-17 Spreadsheet (blocked by AI Gateway key for Pass level)" (`docs/TASKS.md:60`).
Owner request 2026-10-09: "move to reading receipt feature." Risk tier: **Large** (new external input — an
uploaded photo read by a real external AI provider — per `/build-feature`'s risk table; same tier as FN-16a and
FN-41, both of which this PRD builds directly on).

**Hard build-order dependency, not a "Belum dikonfigurasi" degraded state:** this PRD can only be implemented once
`fn-41-integrations-byok` (branch `fn-41-integrations-byok`, currently in security review) merges to `main`. Today
`main` has none of: `src/lib/server/ai-keys/*`, `resolveAnthropicKey()`, migration `0028_ai_keys.sql`, or the
`AI_GATEWAY_ACCOUNT_ID`/`AI_GATEWAY_ID`/`AI_KEYS_ENCRYPTION_KEY` entries in `Env`/`.dev.vars.example` (confirmed by
reading `src/worker-configuration.d.ts` and `.dev.vars.example` on `main`; they exist only in the
`.claude/worktrees/fn-41` tree). Per the precedent FN-07 and FN-11 both already set ("do not stub a pretend
validator... wait for the real one"), this feature is **blocked** on FN-41 landing on `main`, not merely degraded —
do not reimplement a parallel key lookup or gateway URL helper.

## Goal

Beranda's Struk button and the Tambah sheet's "Struk" path have sat disabled since FN-00/FN-08
(`src/routes/(app)/+page.svelte:406-421`: `disabled`, badged "Segera", captioned "Membaca foto struk belum
tersedia."; `src/lib/ui/shell/nav.ts:121`: `{ id: 'struk', ... }` with no `href`, rendered by `AddSheet.svelte:23-32`
as a disabled button captioned "Segera hadir"). `docs/FEATURES.md:178-186` and `docs/PRD.md`'s success metrics
(§4: "receipt accuracy ≥ 95% on the golden set... receipt ≤ 8 s") commit to a camera-to-draft path that is faster
than typing a grocery receipt's ten lines by hand. FN-41 (BYOK) now exists specifically so a feature like this one
does not have to wait for the owner's own Anthropic key (`docs/TASKS.md:43,100-101`, on hold) — a user who adds
their own key can use Struk today, pay their own AI cost, and everyone else sees exactly why the button is
unavailable and what unblocks it. This PRD turns that button into a real capture path: photo in, an editable,
reconciled draft of the receipt out, in seconds, saved as one transaction or split per item with the photo kept as
proof — never inventing a total that does not add up.

## Scope

### Entry points (wiring existing placeholders, not new UI chrome)

- `src/routes/(app)/+page.svelte:406-421` — the disabled "Struk" button becomes a real link to `/riwayat/struk`
  whenever `isAiGatewayConfigured(env)` is true (see Architecture notes); when the gateway itself is unset (owner
  prerequisite, see Prerequisites), it stays disabled with "Pembacaan struk dengan AI belum dikonfigurasi." (and
  English) — the honest, already-established wording pattern FN-16a used for its own AI-gated card
  (`src/routes/(app)/impor/+page.svelte:629-636`), not a new placeholder shape.
- `src/lib/ui/shell/nav.ts:121` — the `struk` `ADD_PATHS` entry gets `href: '/riwayat/struk'` (same gate); when the
  gateway is unset, `AddSheet.svelte`'s existing disabled-button branch (`src/lib/ui/shell/AddSheet.svelte:23-32`)
  renders exactly as it does today for every other not-yet-wired path — no change to that component.
- Both entry points reaching `/riwayat/struk` with the gateway configured but **no personal key** (the common
  case until a user visits `/pengaturan/integrasi`) land on the page in its "no key" state (criterion 2), not a
  dead end.

### `/riwayat/struk` (new route, mirrors `/riwayat/suara`'s and `/riwayat/baru`'s tree shape)

One page, four states, no reload between them (a `File` the browser holds stays available in page state across
Svelte Kit `use:enhance` form-action round trips on the same page load; a full reload loses it, same posture as
FN-21's in-memory key — see Architecture notes "why no server-side pending-read storage"):

1. **Picker.** Camera or gallery (`accept` = `PHOTO_ACCEPT`, `#lib/shared/photos` — JPEG/PNG/WebP; iOS converts a
   HEIC camera-roll pick to JPEG before the browser ever sees it, the same comment already on the belongings photo
   field applies here unchanged). One photo; choosing a second photo replaces the first (never two receipts in one
   capture — catalog: "one photo per receipt"). Before the file is attached to the form, client-side JS **always**
   re-encodes it through an off-screen canvas (`createImageBitmap(file, { imageOrientation: 'from-image' })` →
   `drawImage` → `canvas.toBlob('image/jpeg', …)`), scaled so neither dimension exceeds 1568 px (Anthropic's own
   resize threshold — see Architecture notes "image bounds"), which both bounds upload size/AI token cost and
   bakes in the correct orientation and strips EXIF/GPS **before the byte ever leaves the device** — stronger than
   FN-27's server-side-only EXIF strip, because a receipt photo may be taken with location services on. A browser
   where canvas re-encoding is unavailable (no `OffscreenCanvas`/`createImageBitmap`) still submits the original
   file; the server's `sanitizeImage` (`#lib/server/photos/image`) is the backstop either way (criterion 6).
   - **No Anthropic key configured** (`resolveAnthropicKey` returns `null`): the picker still works, but instead
     of "Baca struk" the primary action is "Tambahkan kunci Anthropic di Pengaturan › Integrasi" (link to
     `/pengaturan/integrasi`, owner's exact wording from the brief) with "Lampirkan fotonya saja" as a visible
     secondary action (criterion 2).
2. **Reading.** "Baca struk" tapped: the photo (re-encoded bytes) posts to action `read`; visible progress states
   "Mengunggah…" → "Membaca strukmu…" → the result, matching the catalog's "upload → reading → ready" (criterion
   7). A failure (timeout, unreadable photo, "this is not a receipt," provider error) shows a specific message and
   two ways out: "Baca lagi" (resubmits the same held file) or "Lampirkan fotonya saja" (criterion 8-9).
3. **Review.** Every field editable: shop (title), date (occurred_on), items (name + amount each, add/remove
   row), tax (PB1), service charge, discount, total, a payment-method guess shown as plain text (not auto-applied
   silently — see wallet matching below). Banners: "Periksa totalnya" when `Σitems + tax + service − discount ≠
   total` (criterion 10); "Periksa tanggalnya" when the read date is implausible (in the future beyond today WIB,
   or more than 2 years in the past — a loose sanity bound, never a hard refusal, criterion 11). A toggle "Satu
   transaksi" (default) / "Pisah per item" (criterion 13-14). "Baca lagi" re-runs action `read` on the same held
   file (rate-limited, see Architecture notes); "Lampirkan fotonya saja" discards the AI result and hands the held
   file to `/riwayat/baru` (criterion 16). A checkbox "Simpan foto struk sebagai bukti" (default **on** — see Owner
   decisions) controls whether the photo is kept in R2 after saving.
4. **Save.** "Simpan {n} transaksi" (singular wording when `n = 1`) posts the full edited form plus the held file
   (needed again only when the photo is kept) to action `save`. Success returns to `/riwayat` (or stays with a
   confirmed-saved state showing what was written) — never optimistic (criterion 17).

### Server modules

- `src/lib/server/receipts/` (new):
  - `image.ts` — thin wrapper choosing nothing new: calls `sanitizeImage`/`sniffImageType` from
    `#lib/server/photos/image` unchanged (no second image sanitiser; checklist › reuse).
  - `prompt.ts` — the vision prompt and the strict JSON schema asked of the model (shop, items, tax, service,
    discount, total, currency, occurred_on, payment method guess), written for Indonesian receipt conventions:
    "Rp" with dot thousands separators, PB1/pajak restoran 10%, "service"/"servis" lines, dates as `DD/MM/YY` or
    `DD-MM-YYYY`, QRIS/debit/kredit/tunai/e-wallet payment lines. The model is told to answer **only** the JSON
    schema, fields `null` when not legible, and never to invent a figure it cannot read (CLAUDE.md "money is never
    invented" extends to the prompt itself: the model is asked to leave a field null rather than guess).
  - `schema.ts` — the zod schema validating the model's JSON response (checklist › "Schema-validated output":
    invalid output becomes a clear "Tidak bisa membaca strukmu" error with retry, never a crash and never a
    confirmed row built from a half-parsed response).
  - `reconcile.ts` — pure, shared-shape logic (works on the already-validated schema output): computes the
    items/tax/service/discount-vs-total check and the date-sanity check (both pure functions, unit-testable with
    no network).
  - `anthropic.ts` — `readReceiptImage(env, apiKey, imageBytes, mimeType, fetchFn?, timeoutMs?)`: one Messages API
    call through the app's AI Gateway (`anthropicGatewayUrl`/`isAiGatewayConfigured` **imported unchanged** from
    `#lib/server/ai-keys/anthropic`, FN-41 — no second gateway-URL builder), one image content block + the
    `prompt.ts` text, `max_tokens` generous enough for a long itemised receipt (propose 2048 — re-verify Anthropic's
    current per-request output cap at implementation), model **`claude-sonnet-5-5`** (see Owner decisions — the
    current mid-tier vision model as of this writing; the engineer re-checks `docs.claude.com`'s model list before
    relying on this id, per CLAUDE.md's "never hard-code a guessed... SDK capability," exactly the caveat FN-41's
    own `anthropic.ts` already carries for its test model). Returns one of: parsed-and-schema-valid result,
    `'not_a_receipt'` (the model says so explicitly — the prompt asks it to), or the same four
    network/invalid/quota/unreadable-shaped outcomes `classifyAnthropicResponse` (FN-41) already defines for a
    non-2xx response — **reused, not re-implemented**, for everything except the 2xx body, which this module parses
    with its own schema (FN-41's function classifies status/error-body shape only, not a Messages success body).
  - `dedupe.ts` — `receiptDedupeKey(photoBytes, rowIndex)` → `receipt:<sha256 of the final, re-encoded photo
    bytes>:<rowIndex>`, the same `source:<hash>:<index>` shape FN-18 (`csv:<hash>:<index>`) and FN-16a
    (`statement:<hash>:<index>`) already use — **no new dedupe scheme**. Hashing the post-resize bytes (not the
    original) is deliberate: "Baca lagi" on the same held file always re-hashes to the same key, so a resubmitted
    read never risks creating a second transaction from the same photo once saved.
  - `duplicate.ts` — a same-space, same-day-±1, same-amount query against live `transactions`, reusing the exact
    "possible duplicate" shape FN-16a/FN-18 already query with (no new heuristic) — shown as an inline "Mungkin
    sudah dicatat" note per matching item/total on the review screen; tappable to include anyway, never silently
    excluded (unlike FN-16/19's own import review, this screen has no bulk "exclude" state to manage — one receipt,
    a handful of rows).
  - `save.ts` — `saveReceiptTransactions(db, scope, rows, env, now)`: builds `NewTransaction[]` (one row, or one row
    per ticked item plus one "Pajak & servis" row — see Scope "Split per item" below) and calls `insertTransactions`
    (FN-05, unchanged) in one `db.batch`; when the photo is kept, the same batch also runs `reservePhotoKey` (FN-27
    pattern, `#lib/server/photos/store`) before the R2 `putPhoto` call and a guarded `UPDATE transactions SET
    photo_key = ?, photo_type = ? WHERE id = ? AND space_id = ?` + `keepKey` in the follow-up batch — **not** a
    change to `insertTransactions`'s row shape, which stays exactly as FN-05/18/36/37 already call it; every other
    caller of `insertTransactions` is unaffected (checklist › reuse, don't duplicate a shared write path).
  - `messages.ts` — `msg()`-wrapped strings for this feature.
- **Split per item (catalog: "each ticked item its own expense with a guessed category, tax + service + discount
  as one 'Pajak & servis' transaction so the total still matches"):**
  - Each item's category is guessed via `categoryHintFromWords` (`#lib/shared/category-keywords`, unchanged — the
    item's name, lower-cased and split on non-letter/digit characters, same tokenisation
    `importCategoryFromTitle` already uses) falling back to "Tanpa kategori" (FN-06) when no keyword matches — no
    second category-guess heuristic.
  - The combined tax/service/discount row's amount is `tax_minor + service_minor − discount_minor`. When that is
    **zero or negative** (a discount-heavy receipt), no such row is created and the toggle is disabled for that
    receipt with an inline note "Diskon lebih besar dari pajak dan servis — gunakan 'Satu transaksi'" (and
    English); this is a deliberate, bounded edge case, not a silent negative-expense row (Owner decision 5).
  - Every item and the tax/service row carries `extras.paymentMethod` set to the printed payment-method guess
    (FN-18's existing free-text column, reused unchanged — no new column for this).
  - The kept photo (if any) attaches to the tax/service row when one exists, else the first item row (Owner
    decision 6) — one definitive place to view the receipt, not duplicated across every split row.
- **One transaction mode:** one row; `title` = shop name (or "Struk" when unread); `note` = every item name and
  amount, one per line, followed by tax/service/discount/total lines exactly as read — plain text, FN-05's
  existing `note` field, length-capped like every other note (existing `NOTE_MAX_LENGTH`, unchanged).
- **Wallet:** never auto-applied from the payment-method guess without the user seeing it — the review screen
  shows the printed payment method as text and offers the same wallet picker `/riwayat/baru` already has,
  defaulting to the matching wallet by FN-04's existing name/type matching when one is unambiguous, else the
  favourite wallet (FN-04, unchanged matching logic, no new heuristic) — the user can always change it before
  saving.
- **"Lampirkan fotonya saja" / `/riwayat/baru` extension:** `/riwayat/baru`'s existing create action
  (`src/routes/(app)/riwayat/baru/+page.server.ts:88-103`) gains one additive optional `photo` field: when present,
  the body is read with `readPhotoForm`/`PHOTO_FORM_MAX_BYTES`-shaped bounds (`#lib/server/photos/upload`,
  reused — the action's body-read call switches from the default-capped `readFormBody` to the photo-aware one only
  when a photo may be present; a plain manual entry with no photo keeps today's 8 KiB cap and timing, since the
  photo-aware reader accepts anything up to and including a plain small text form too) and, on a successful save,
  the image is sanitised, uploaded (`uploadPhoto`, FN-27 pattern) and linked the same way `save.ts` above does.
  `/riwayat/struk`'s "Lampirkan fotonya saja" hands the held file to this form via a client-side `FormData` carry
  (no re-upload prompt) with the AI read, if any, discarded — the user types the fields manually from here, same
  as any other manual entry.
- **Migration `0029_receipt_photos.sql`** (chained after FN-41's `0028_ai_keys.sql` — renumber at merge if landing
  order differs, same caveat every PRD here carries): rebuilds `transactions` (same class of change FN-37's `0022`
  already did for `adjustment_direction`) adding `photo_key text` and `photo_type text`, with
  `transactions_content_check` extended so a tombstone also requires both null (mirroring the exact
  `belongings`/`collectibles` `photo_key`/`photo_type` CHECK shape at `schema.ts:1118-1133`), and a live row
  requiring `photo_type` to be one of `PHOTO_TYPES` whenever `photo_key` is set. A transaction's delete path
  (`src/lib/server/transactions/repo.ts`'s tombstone builder) is extended to call `releasePhotoKeys`/`cleanUpFiles`
  (FN-27 pattern, unchanged functions) exactly once more, for this one new photo-bearing table — no second file-
  outbox mechanism.
- **New route** `src/routes/(app)/riwayat/[id]/foto/+server.ts` — serves a transaction's kept photo via
  `photoResponse` (`#lib/server/photos/store`, unchanged), identical access-checked, cached, CSP-locked pattern as
  `barang/[id]/foto`/`koleksi/[id]/foto`; 404 when the row has no photo or the requester is not a member of the
  owning space (no existence oracle).
- **Riwayat display:** the transaction detail view gains a photo thumbnail (link to the route above) whenever
  `photo_key` is set — the smallest possible addition to the existing detail screen, not a redesign of it.
- **i18n:** every new Indonesian phrase ("Baca struk", "Membaca strukmu…", "Periksa totalnya", "Periksa
  tanggalnya", "Tidak bisa membaca strukmu", "Ini sepertinya bukan struk", "Satu transaksi", "Pisah per item",
  "Simpan foto struk sebagai bukti", "Mungkin sudah dicatat", "Tambahkan kunci Anthropic di Pengaturan ›
  Integrasi", "Lampirkan fotonya saja", "Pembacaan struk dengan AI belum dikonfigurasi.", the save-summary `trf()`
  template, every outcome message reused from FN-41's four-outcome shape) added to `src/lib/shared/i18n.ts` with an
  English entry in `i18n-en.ts`; the existing coverage test fails the build if one is missing.
- **UI states:** loading (the three progress captions above), empty (picker with nothing chosen yet), error (per
  outcome: no-gateway, no-key, invalid-key, quota, network/timeout, unreadable-photo, not-a-receipt, schema-invalid
  — each a distinct, truthful message, never conflated, mirroring FN-41's own discipline), saving ("Menyimpan…",
  buttons disabled), success (confirmed only after the server's write returns).

### Rate limiting

- New `ThrottleScope` `'receipt-read'` (`src/lib/server/auth/throttle.ts`'s `THROTTLE_SCOPES`), per user via
  `overUserAttemptLimit`, covering both action `read` and "Baca lagi" (every call that reaches the provider).
  Propose **10 attempts per 10-minute window** (see Owner decisions) — looser than FN-41's 5/10 min "Tes koneksi"
  budget (a one-token ping) since a real receipt may legitimately need two or three re-reads (bad lighting, a
  crumpled corner), stricter than the general `THROTTLE_MAX_ATTEMPTS = 20` since this is a full vision call the
  user's own Anthropic account pays for and Montra's own AI Gateway logs/quota absorb the request volume either
  way.
- The same upload-slot risk FN-16a's own red team already flagged for itself ("upload slot held while the body
  uploads... 503 for others on that isolate," `docs/TASKS.md:121-122`, still open) applies identically to this
  route's photo upload; this PRD inherits that known limitation rather than re-solving it twice — once FN-16a's fix
  lands, this route's photo-form read should reuse the same mitigation, not a second one.

### Golden-set accuracy harness (owner's explicit interest, per `docs/PRD.md`'s accuracy metric)

- **`npm run compat:receipts`** → `scripts/compat-receipts.ts` (new, same `assertLocalOnly`-guarded, plain-`node`
  shape as `scripts/compat-statements.ts`): walks `.superpowers/ref/samples/receipts/**` (skipped with a one-line
  notice, exit 0, when empty — the state at hand-off and in CI, never part of `npm run gates`). For each image, if
  a sibling `<name>.expected.json` exists (owner-authored: shop/total/date/item count) **and** a real
  `sk-ant-…`/gateway pair is available locally (read from `.dev.vars`, never a CLI argument that could leak into
  shell history), it calls `readReceiptImage` for real and prints whether each expected field matched — counts and
  pass/fail only, never a receipt's own merchant name, item text or amount in stdout (same discipline
  `compat-statements.ts` already holds, extended here to receipts instead of its current placeholder "needs OCR"
  line, which this script replaces now that FN-15 exists). Without a key configured, it prints "tidak ada kunci
  Anthropic lokal — hanya menghitung sampel" and still reports file counts, never attempting a call. **Never part
  of `npm run gates`/CI** — this is an owner-run, manual, real-provider check (checklist › "No real providers in
  tests"), exactly FN-41's own precedent for its "Tes koneksi" owner check.
- **Deterministic Vitest coverage** (committed, synthetic, fictional): a handful of tiny, hand-built JPEG/PNG
  fixtures (`test/fixtures/receipts/`, obviously fictional merchants/amounts) drive `schema.ts`/`reconcile.ts`/
  `dedupe.ts`/`save.ts` against a **mocked** `fetchFn` returning canned JSON bodies (never the real gateway or
  Anthropic) — covering a clean read, a reconciliation mismatch, a not-a-receipt answer, a schema-invalid answer,
  and the four provider-error outcomes reused from FN-41.

## Out of scope

- **FN-21 account-key sealing of the read result.** FN-21's own "Out of scope" line names this PRD as the feature
  that "will actually call `sealToPublicKey` against a real AI-read result" (`docs/features/fn-21-account-key/
  PRD.md:124-126`), but **this pass does not** — see Owner decisions #1 for the full reasoning (FN-16a already set
  the same precedent: it calls no sealing either, and FN-11's `drafts` table already stores every field, including
  receipt-shaped ones, in plain D1 columns). The receipt photo **bytes** are still never stored unless the user
  explicitly keeps them (R2, unsealed, access-controlled — the FN-27 pattern, which also never used FN-21's
  sealing for a kept belongings photo). This PRD flags, but does not resolve, the gap between CLAUDE.md's "results
  are sealed to the account key" wording and the shipped-plain `drafts`/`transactions` architecture every capture
  feature so far has used.
- **The FN-11 drafts inbox.** This screen reviews and edits the receipt itself, synchronously, with the user
  present holding the photo — exactly the "richer per-row editing" FN-11's own PRD deferred to "each capture
  feature's own review screen" (`docs/features/fn-11-inbox/PRD.md:101-104`). Nothing in this pass writes a
  `drafts` row; Kotak Masuk stays for captures with no user present at capture time (Gmail, Slack).
- **Foreign-currency receipts.** The schema's `currency` field is informational only this pass; every saved
  transaction is `IDR` (receipts in Indonesia are overwhelmingly IDR; FN-05's foreign-currency conversion path is
  a separate, already-built feature this PRD does not extend). A receipt the model reads as a non-IDR currency is
  flagged "Periksa totalnya" rather than silently converted.
- **PDF receipts, multi-photo receipts, batch scanning of several receipts at once.** One photo per receipt, no
  PDF — exactly the catalog line.
- **Per-plan monthly upload limits.** `docs/FEATURES.md:342`'s "Free — ... 10 document uploads per month" mirror
  line is not enforced anywhere yet (confirmed: no mention in `docs/features/fn-30-billing/PRD.md`); this pass adds
  only the per-user rate-limit above to protect Montra's own infrastructure, not a plan-tiered monthly ceiling —
  that is FN-30's job if the owner wants it (Owner decision #7).
- **Editing/adding a photo on an already-saved transaction later from Riwayat's edit screen.** This pass only
  attaches a photo at creation time (receipt-read save or "Lampirkan fotonya saja"); removing or replacing a photo
  after the fact is a future FN-05 edit-screen extension.
- **A formal UU PDP cross-border-processing legal notice.** The public legal pages already carry a placeholder
  ("Teks ketentuan, kebijakan privasi dan pemberitahuan pemrosesan di luar Indonesia masih draf, menunggu tinjauan
  hukum," `src/routes/(app)/pengaturan/privasi/+page.svelte:213-216`) pending legal review — unchanged by this PRD.
  This feature adds only a short, honest, in-screen notice at the point of upload (Scope, review screen) that the
  photo is sent to Anthropic through Montra's AI Gateway to be read and is not kept there.
- **Workers AI Whisper-style local fallback, offline reading, or a Workflow/Queue.** The read is one synchronous
  request/response in the app Worker (Owner decision #2) — no `workers/jobs` involvement.
- **Credits or AI-spend metering on Montra's side.** The user's own Anthropic account is billed (BYOK, FN-41); this
  pass's only cost control is the per-user rate-limit above.

## Acceptance criteria

**Entry points and gating**

1. Given `AI_GATEWAY_ACCOUNT_ID`/`AI_GATEWAY_ID` are both set, when a signed-in user opens Beranda or the Tambah
   sheet, then "Struk" is a live link to `/riwayat/struk`; given either is unset, "Struk" stays disabled/absent
   exactly as today, captioned "Pembacaan struk dengan AI belum dikonfigurasi." (and English).
2. Given the gateway is configured but `resolveAnthropicKey(db, userId, env)` returns `null` for the signed-in
   user, when `/riwayat/struk` loads, then the picker shows "Tambahkan kunci Anthropic di Pengaturan ›
   Integrasi" (linking to `/pengaturan/integrasi`) and "Lampirkan fotonya saja" instead of "Baca struk" — the
   photo picker itself still works.
3. Given a signed-out visitor, when they request `/riwayat/struk` (GET or any action), then they are redirected to
   `/masuk`, identically to every other `(app)` route gated by `locals.user`.

**Reading**

4. Given a user with a valid, working Anthropic key and the gateway configured, when they submit a real-shaped
   (fixture) receipt photo to action `read`, then the response is schema-valid, reconciled fields populate the
   review form, and no reconciliation banner shows (clean case).
5. Given the model's JSON response fails `schema.ts`'s zod validation (fixture: malformed/truncated JSON, a field
   of the wrong type), then the user sees "Tidak bisa membaca strukmu" with "Baca lagi"/"Lampirkan fotonya saja" —
   never a crash, never a partially-populated, unvalidated form.
6. Given an uploaded file that is not a JPEG/PNG/WebP by its sniffed bytes, or fails `sanitizeImage`'s
   dimension/malformed checks, then it is refused **before** any provider call (the same `PHOTO_NOT_IMAGE`/
   `PHOTO_UNREADABLE`/`PHOTO_DIMENSIONS`-shaped messages FN-27 already uses) — no bytes of a refused file are ever
   sent to Anthropic.
7. Given the provider call is in flight, the page shows the "Mengunggah…" → "Membaca strukmu…" progression; given
   it exceeds the configured timeout, the outcome is the network/timeout message, never an indefinite spinner.
8. Given the model's own answer states the image is not a receipt (prompt-defined signal), then the page shows
   "Ini sepertinya bukan struk" with "Baca lagi"/"Lampirkan fotonya saja" — distinct from the schema-invalid and
   network messages.
9. Given a provider 401/403/429/5xx response (simulated by a test double, never the real provider in `npm test`),
   then the four FN-41-shaped outcomes (`classifyAnthropicResponse`, reused unchanged) map to the same distinct,
   truthful invalid/quota/network messages as `/pengaturan/integrasi`'s own "Tes koneksi" — no fifth, FN-15-specific
   re-interpretation of the same provider response shapes.
10. Given `Σitems + tax + service − discount ≠ total` by more than a rounding-safe tolerance of 0 (exact integer
    minor-unit arithmetic — never a float comparison), then "Periksa totalnya" shows and the user may still edit
    and save; the save action re-checks reconciliation on the **edited** values before writing (never trusts the
    original AI numbers once the user has touched a field).
11. Given the read date is more than 2 years in the past or is after today's WIB date, then "Periksa tanggalnya"
    shows; the user may still edit and save.

**Review and save**

12. Given the "Satu transaksi" toggle, when "Simpan" is submitted, then exactly one `transactions` row is created
    with `source = 'receipt'`, `title` = the (possibly edited) shop name, `note` containing every item/tax/
    service/discount/total line, and `dedupe_key = receiptDedupeKey(photoBytes, 0)`.
13. Given the "Pisah per item" toggle with items `A, B` and a positive combined tax/service/discount amount, when
    "Simpan" is submitted, then three `transactions` rows are created in one `db.batch` (item A, item B, "Pajak &
    servis"), each with its own `dedupe_key = receiptDedupeKey(photoBytes, i)`, each item's `category_id` guessed
    via `categoryHintFromWords` (or "Tanpa kategori"), and the sum of all three rows' signed amounts equals the
    read total exactly.
14. Given "Pisah per item" with a combined tax/service/discount amount ≤ 0, then the toggle is disabled for that
    receipt with the inline note from Scope, and only "Satu transaksi" can be submitted.
15. Given the "Simpan foto struk sebagai bukti" checkbox is on at save time, then the re-encoded photo bytes are
    sanitised again server-side, uploaded to R2 under a fresh `spaces/<space_id>/receipts/<uuid>` key (reusing
    `newPhotoKey`'s shape, a new `PhotoKind = 'receipts'`), the owning row (the single row, or the tax/service row,
    or the first item row per Scope) is updated with `photo_key`/`photo_type` in the same guarded batch, and
    `/riwayat/<id>/foto` serves it only to a member of the owning space; given the checkbox is off, no R2 object is
    ever written and both columns stay null.
16. Given "Lampirkan fotonya saja" is chosen (from the picker's no-key state, a failed read, or the review screen),
    then the held photo file carries over to `/riwayat/baru` without a second file picker, the AI result (if any)
    is discarded, and the user completes the transaction manually; saving there with the photo present attaches it
    exactly as criterion 15 describes.
17. Given any "Simpan" submission, when the page reloads after the response, then the created row(s) and (if kept)
    the photo persist — written to D1/R2, never shown as saved before the server confirms.
18. Given the same photo (identical re-encoded bytes) is read, reviewed and saved, then "Baca lagi" is used, and
    the result is saved again, then the second save creates **zero** new rows for any row index already saved
    (the dedupe unique index refuses the re-insert) — a deleted or already-saved receipt row is never recreated
    from the same source (CLAUDE.md › Data and runtime conventions).
19. Given a possible-duplicate match (same space, ±1 day, same amount) exists for an item or the total, then the
    review screen shows "Mungkin sudah dicatat" next to that row; saving anyway is allowed (no silent exclusion,
    unlike FN-16/19's own bulk-import duplicate handling, which this screen does not replicate).

**Rate limiting and abuse**

20. Given 11 `read`/"Baca lagi" attempts inside one 10-minute window for one user, then the 11th is refused with a
    rate-limit message before any provider call is attempted — no provider call is billed to the user's Anthropic
    account for a refused attempt (identical guarantee to FN-41 criterion 17).
21. Given a crafted request posting a `walletId`/`categoryId` from a different space on the save action, then the
    server resolves wallets/categories against `locals.space.id` only (FN-04/06's existing scoped lookups,
    unchanged) — a foreign id is refused or ignored, never written against another space's row.

**Access, money, dates, i18n**

22. Every load and action under `/riwayat/struk` and the extended `/riwayat/baru` resolves the space through
    `currentSpaceScope(locals)` — no client-supplied space id, wallet id or category id is trusted without that
    scope check (checklist › "One access rule").
23. A pre-handoff cross-space probe (crawl `/riwayat/struk`'s actions and `/riwayat/[id]/foto` as a non-member and
    a removed member of the owning space) returns nothing and never 200s.
24. A pre-handoff concurrency probe (20 concurrent "Simpan" submissions of the same held receipt) ends with each
    dedupe-keyed row created exactly once, never a 500 (same guarded-insert guarantee FN-18/FN-16a already prove
    for their own sources).
25. Every amount renders through `formatMoney`/`formatMoneyCompact` (`#lib/shared/money-format`); every date
    (occurred_on, "Periksa tanggalnya"'s sanity check) uses WIB via `#lib/shared/dates` — no hand-built `Rp` string
    or ad hoc date math anywhere in this feature.
26. Every Indonesian phrase added for this feature has an English entry in `i18n-en.ts`; `npm run test`
    (`src/lib/shared/i18n.test.ts`) fails if one is missing.
27. User-facing error text never contains a file path, stack trace, row id, raw provider response body, or the
    user's Anthropic key.
28. `{#each}` lists (items, possible-duplicate notes) key by a stable row index or id, never by item name text.
29. Focus returns to the opener when any sheet/picker in this feature closes; every button meets the 44 px touch
    target and AA contrast in both themes (reuse `Button`/`GroupList`/`IconRow`, no new bespoke control shapes).
30. `npm run gates` (check, lint, test, build) is clean on the branch before hand-off; every new regression test
    (schema-invalid response, not-a-receipt, reconciliation mismatch, dedupe-survives-"Baca lagi"-and-resave,
    split-mode negative-tax disables the toggle, cross-space probe, rate-limit refusal, photo-kept round trip
    through `/riwayat/[id]/foto`) is shown failing on the unfixed code first (checklist › "Fail-before proof").

## Architecture notes

**Modules touched / added**

- `src/lib/server/receipts/{image,prompt,schema,reconcile,anthropic,dedupe,duplicate,save,messages}.ts` — new, as
  in Scope.
- `src/lib/server/ai-keys/{lookup,anthropic}.ts` (FN-41, once merged) — `resolveAnthropicKey`,
  `anthropicGatewayUrl`, `isAiGatewayConfigured`, `classifyAnthropicResponse` **imported unchanged**; this is the
  first real caller FN-41's own PRD named as the reason `resolveAnthropicKey` exists
  (`.claude/worktrees/fn-41/src/lib/server/ai-keys/lookup.ts:32-35`).
- `src/lib/server/photos/{image,store,upload}.ts` (FN-27) — `sanitizeImage`, `sniffImageType`, `newPhotoKey`,
  `reservePhotoKey`, `putPhoto`, `keepKey`, `releasePhotoKeys`, `cleanUpFiles`, `photoResponse`, `PhotoField`/
  `readPhotoField`/`readPhotoForm` — reused unchanged; `PhotoKind` widens from `'belongings' | 'collectibles'` to
  include `'receipts'` (one-line type change, no behaviour change to the existing two kinds).
- `src/lib/server/transactions/repo.ts` — `insertTransactions`/`createTransaction` called unchanged; the delete/
  tombstone path extended to release a photo key exactly as belongings/collectibles already do.
- `src/lib/shared/category-keywords.ts` (`categoryHintFromWords`) — reused unchanged for item category guesses.
- `src/lib/server/auth/throttle.ts` — new `'receipt-read'` scope added to `THROTTLE_SCOPES`.
- `src/routes/(app)/riwayat/struk/{+page.server.ts,+page.svelte}` (new), `src/routes/(app)/riwayat/[id]/foto/
  +server.ts` (new), `src/routes/(app)/riwayat/baru/+page.server.ts` (extended, additive `photo` field),
  `src/routes/(app)/+page.svelte` (gate the existing disabled button), `src/lib/ui/shell/nav.ts` (add `href` to the
  `struk` entry) — no change to `AddSheet.svelte`/`GroupList`/`IconRow` component code.
- Migration `0029_receipt_photos.sql` (see Scope) — generated by `drizzle-kit generate` from the schema change,
  applied only via `npm run db:migrate:local`.
- `scripts/compat-receipts.ts`, `test/fixtures/receipts/` — new, as in Scope.
- Worker: app Worker only. No `workers/jobs` involvement — the vision call is one `fetch()` awaited inside a
  SvelteKit form action; Cloudflare Workers' CPU-time limit counts active execution, not time spent awaiting a
  subrequest response, so a multi-second provider call does not by itself exhaust the Worker's CPU budget (the
  same reasoning FN-16a's synchronous PDF parse and FN-41's synchronous "Tes koneksi" already rely on) — re-verify
  the current CPU-time and subrequest wall-clock limits against `developers.cloudflare.com/workers/platform/
  limits` at implementation time rather than trusting this PRD's number if it has changed.

**Why no server-side pending-read storage between `read` and `save`**

The photo bytes and the AI's JSON result live only in the browser's page state between the `read` and `save`
requests (the held `File`/`Blob` plus the rendered form fields); nothing is cached, queued or persisted server-side
in between. This is a deliberate reading of CLAUDE.md's "processed in memory, never stored" rule as applying
per-request: each of `read`/`save`/"Baca lagi" independently receives, processes and discards the bytes within its
own request lifetime, with no intermediate D1/R2/KV row representing "a pending receipt read." The cost is the same
one FN-21 already accepted for its own in-memory key (`docs/features/fn-21-account-key/PRD.md` criterion 16): a
full page reload between upload and save loses the held file and the user must re-pick the photo. This is judged
acceptable for a single, short, same-screen flow (unlike FN-21's sign-in-to-later-use span) and avoids inventing a
new sealed-or-unsealed intermediate storage layer no other capture feature in this codebase has needed yet.

**Reuse / do not duplicate**

- `insertTransactions` is the only transaction write path; this feature adds no second `INSERT INTO transactions`.
- `sanitizeImage`/`sniffImageType` is the only image check; no second sanitiser, no HEIC/PDF support added anywhere
  (client-side canvas re-encoding handles orientation/EXIF/size; the server backstop is unchanged from FN-27).
- `classifyAnthropicResponse`/`anthropicGatewayUrl`/`isAiGatewayConfigured` (FN-41) are the only gateway-URL and
  error-classification logic; this feature adds its own 2xx-body schema only.
- `categoryHintFromWords` (FN-06/39) is the only category-guess heuristic for item names.
- The `source:<hash>:<index>` dedupe-key shape (FN-18/FN-16a) is unchanged, applied with `source = 'receipt'`.

## Prerequisites

- **Build order (not a credential): `fn-41-integrations-byok` merged to `main`.** This PRD cannot be implemented
  before `src/lib/server/ai-keys/*`, migration `0028_ai_keys.sql` and the `AI_GATEWAY_ACCOUNT_ID`/`AI_GATEWAY_ID`/
  `AI_KEYS_ENCRYPTION_KEY` `Env` entries exist on `main`.
- **You — `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID`** (already requested by FN-41's own Prerequisites; this PRD
  adds no new ask here, only a second, real caller of the same two secrets). Unset → Struk stays disabled
  everywhere with "Pembacaan struk dengan AI belum dikonfigurasi." (criterion 1); needs no owner Anthropic key.
- **You (per user, optional) — a personal Anthropic key via `/pengaturan/integrasi`.** Without one, a signed-in
  user sees "Tambahkan kunci Anthropic di Pengaturan › Integrasi" and can still use "Lampirkan fotonya saja"
  (criterion 2). This PRD requests no owner Anthropic key and does not touch `docs/TASKS.md`'s on-hold owner item.
- **You (optional, for the golden-set harness only) — redacted receipt photos** in
  `.superpowers/ref/samples/receipts/` (git-ignored, confirmed empty today) with a sibling `<name>.expected.json`
  per photo, plus your own personal Anthropic key in local `.dev.vars` to run `npm run compat:receipts` manually.
  Never required for `npm run gates` to pass.

## Owner decisions

Proposed defaults below; proceeding on these per the standing auto-accept-defaults policy — flagging the ones
that are genuinely open trade-offs (not credentials) so the owner can correct any of them later without reopening
the whole PRD.

1. **No FN-21 account-key sealing of the AI read result this pass.** Default: **unsealed**, same plain `D1`
   storage every other capture source already uses once it becomes a transaction. *Reasoning:* FN-21's own design
   (private key unwrapped only in-memory, never persisted across a reload, `docs/features/fn-21-account-key/
   PRD.md` criteria 14-16) is not actually usable for a flow where review could reasonably happen after a reload,
   and no shipped feature (FN-11's drafts, FN-16a's statement rows) has sealed anything yet. *Trade-off:* a D1
   breach would expose receipt contents in the clear, same exposure every other transaction already has; the
   alternative (building a reload-persistent, encrypted-at-rest session key store first) is a separate, larger
   feature FN-21 itself deferred, not something to improvise inside this PRD.
2. **Synchronous request/response, not a Queue/Workflow.** Default: one awaited `fetch()` inside a form action.
   *Reasoning:* a vision call is a few seconds (PRD target ≤ 8 s), CLAUDE.md names Workflows for statement reading
   specifically, not receipts; FN-41's "Tes koneksi" already set the synchronous precedent for a gateway call from
   the app Worker. *Trade-off:* a very slow provider response holds the request open longer than a Queue-based
   design would; acceptable given the bounded timeout and the interactive, user-present nature of this flow.
3. **Extraction model: `claude-sonnet-5-5`.** Default: the stronger mid-tier vision model, not the cheapest Haiku
   tier. *Reasoning:* the user pays their own Anthropic cost (BYOK); `docs/PRD.md`'s 95% accuracy target is better
   served by the stronger model, and a receipt's itemised, multi-field extraction is exactly the kind of task
   where a cheaper model's mistakes cost the user a wrong transaction. *Trade-off:* a cheaper-but-weaker default
   would cost the user less per read; re-verify this model id and its current price against `docs.claude.com`
   before relying on it — it may already have changed by implementation time.
4. **Photo kept by default ("Simpan foto struk sebagai bukti" defaults on).** *Reasoning:* matches the catalog's
   "photo stays attached as proof" framing as the expected outcome, not an opt-in extra; a user who does not want
   it can untick it every time (no persisted preference this pass). *Trade-off:* more R2 storage used by default;
   acceptable since the photo is only ever the user's own receipt, access-controlled per space, same as a
   belongings photo.
5. **A discount-heavy receipt (combined tax/service/discount ≤ 0) disables "Pisah per item" rather than writing a
   negative "Pajak & servis" row.** *Trade-off:* that receipt can only be saved as one transaction; the alternative
   (a negative-amount expense row, or folding the excess discount into one of the item rows) either breaks the
   "expense rows are always positive magnitude" convention every other transaction type relies on, or silently
   changes an item's printed price — both worse than a narrow, explained restriction.
6. **The kept photo attaches to the tax/service row (or the first item) in split mode, never to every row.**
   *Trade-off:* viewing the photo from a specific item row is one extra tap (open the tax/service row, or the
   first item); duplicating the same R2 object's key across every split row was considered and rejected as
   needless complexity for no real benefit (it is the same photo either way).
7. **No per-plan monthly upload ceiling this pass** (`docs/FEATURES.md`'s Free-plan "10 document uploads per
   month" line stays unenforced, as it already is for every other capture path). *Trade-off:* a Free-plan user can
   read as many receipts as the per-user rate-limit allows, at their own Anthropic cost — if the owner wants a
   Montra-side ceiling independent of the user's own key, that is FN-30's decision to make and enforce across
   every AI capture path at once, not a one-feature carve-out here.
8. **Rate limit: 10 `read`/"Baca lagi" attempts per 10-minute window per user.** *Trade-off:* a user fighting a
   genuinely hard-to-read receipt (glare, a folded corner) may hit the limit after a run of real retries; looser
   than this risks a scripted loop burning a stolen key's quota through Montra's own gateway with no local cost to
   the attacker beyond the key itself.

## Tracker impact

- Closes the FN-15 half of `docs/TASKS.md`'s combined line "FN-15 Receipt · FN-16 Statement · FN-17 Spreadsheet
  (blocked by AI Gateway key for Pass level)" (`docs/TASKS.md:60`) — recommend splitting that line once this PRD is
  accepted into "FN-15 done" / "FN-16's AI half and FN-17 still blocked," the same split FN-16a's PRD already
  recommended for the statement half.
- Moves `docs/ACCEPTANCE.md` rows once implemented and verified:
  - "Receipt photo → split per item → total equals receipt" (Required journey) — **Browser** once a Playwright
    journey runs the picker → read (mocked provider) → split → save path end to end.
  - "Uploaded files never written to R2 or D1; partner copy deleted" (Security and privacy) — this feature is a
    second proof point for the "never written... unless kept" half (criterion 6, 15); the "partner copy deleted"
    half of that row stays Anthropic/AI-Gateway's own retention behaviour, not independently verifiable from here.
  - "Integer minor units; slang and locale vectors parse exactly" (Money and dates) — a third real-save-path
    caller of exact-integer reconciliation arithmetic, alongside FN-18 and FN-16a.
- `docs/FEATURES.md`'s FN-15 catalog entry (line 178-186) is **not edited** by this PRD: nothing here changes what
  Montra mirrors or deliberately differs from common receipt-scan behaviour — the BYOK gating, synchronous
  design, dedupe scheme and unsealed storage are all implementation decisions already governed by FN-41/FN-27/
  FN-18's own "Ours" precedents, not a new mirror/differ claim about FN-15 itself.
