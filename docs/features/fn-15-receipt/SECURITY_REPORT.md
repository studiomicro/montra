# FN-15 Receipt scan (Struk) — Security report

Reviewed: `git diff main...HEAD` in `.claude/worktrees/fn-15-rt` (detached at 4f3df5d, rebased on main), against the
PRD threat model and `docs/ENGINEERING_CHECKLIST.md`. Risk tier: Large (AI capture, new external input, migration).

## Verdict: PASS

No medium or high findings. Three low findings and some notes are listed below so they stay tracked.

## Findings

### L1 (low): a "Lampirkan fotonya saja" create attaches its photo to an existing row whose id the client sends as `clientId`
`src/lib/server/transactions/repo.ts:354-356` (`createTransaction` puts `attachPhoto` in the batch without
checking that the insert wrote anything) together with `src/lib/server/transactions/client-id.ts:29-37` and
`src/routes/(app)/riwayat/baru/+page.server.ts` (`createTransactionOnce(..., stored)`).
`attachPhoto` updates `WHERE id = <clientId> AND space_id = <scope> AND deleted_at IS NULL AND photo_key IS NULL`.
When the `fresh` guard refuses the insert because that id already exists, the UPDATE still runs in the same batch.
`createTransactionOnce` then finds the existing row and answers `ok`.
**Reproduction:** a member of a shared space copies another member's transaction UUID from `/riwayat/<id>`. They
POST multipart `?/create` to `/riwayat/baru` with `clientId=<that id>`, any valid form fields and a photo. The
other member's row now carries the uploader's image. Its `updated_at` and `seq` do not change, so the
optimistic-concurrency check is bypassed and other devices are never told about the change.
**Impact:** limited to spaces the attacker already belongs to, where members can edit each other's rows anyway, and
a row that already has a photo is never overwritten. That makes this low: an integrity and sync gap, not a
cross-space leak.
**Fix:** make `attachPhoto` in `createTransaction` depend on the insert, with a `batchAssert` that the row was written,
as `saveReceiptTransactions` already does, or by adding `created_at = <now>` to its WHERE so it only matches the
row this batch inserted. Add a test that sends a
`clientId` of an existing row.

### L2 (low): a partial remote apply of migration 0029 is not re-runnable (the same posture as FN-39 L1)
`migrations/0029_receipt_photos.sql:9-13, 66-68`. Lines 12-13 clear `drafts.saved_transaction_id` and
`subscriptions.linked_transaction_id`, which lines 66-67 restore. If a remote D1 `/query` run stops between
those two points, the links exist only in `__fn15_links`. A re-run stops at `CREATE TABLE __fn15_links` (no
`IF NOT EXISTS`), which fails safe, but recovery is manual. Checked:
- every column is copied;
- the 6 FKs are kept, including `recurring_series_id ON DELETE set null`;
- the type, source and content CHECKs are carried over, with `photo_*` added to the tombstone clause;
- all 7 earlier indexes are recreated, including the partial unique `transactions_dedupe_uq`;
- no trigger lives on `transactions`;
- `drafts` and `subscriptions` are the only tables that reference it;
- `test/integration/migration-0029.test.ts` passes.

**Mitigation:** RUNBOOK's Time Travel bookmark. Record pre and post row counts of `transactions`, `drafts` with
`saved_transaction_id`, and `subscriptions` with `linked_transaction_id` for this apply.

### L3 (low): `?/save` can write `source = 'receipt'` rows with no AI read behind them
`src/routes/(app)/riwayat/struk/+page.server.ts` `save`. By design, nothing ties a save to an earlier `read`.
Any signed-in member can POST arbitrary reviewed values plus any valid image, and get rows tagged `receipt`.
Every field is still validated and space-scoped, the transaction create limit applies, and the dedupe key comes
from the server-side hash of the bytes. Changing one byte of the image therefore gives new keys. The result is
mislabelled capture provenance in the user's own space, not an exploit. Note it in case `source` is ever used for
trust, billing or accuracy metrics.

## Checked and found sound
- **Upload bounds.** Order of checks:
  1. `Content-Length` > 5 MiB + 64 KiB is refused before the lane;
  2. the per-user and per-isolate lane (`RECEIPT_LANE_MAX = 3`, one per user) is reserved before the body is read;
  3. the `receipt-read` throttle (10 per 10 min, fails closed) is counted before the body is read and before the
     provider call;
  4. the body is read with a byte cap and stall deadlines.

  `sanitizeImage` sniffs JPEG, PNG and WebP by their bytes, so SVG, HTML, HEIC and polyglots are refused or have
  their trailers dropped. It enforces the segment cap and side and pixel caps, then adds a provider cap of 8000 px
  and 5 MiB. It strips metadata, so EXIF and GPS never reach Anthropic or R2. Pixels are never decoded, so a
  decompression bomb costs nothing. The file name and the browser-given type are never read.
- **Provider call.** The gateway URL comes only from env, with id-regex-checked ids. Other properties:
  - `redirect: 'manual'`;
  - a 45 s `AbortSignal` that also covers the answer body;
  - answers capped at 256 KiB and error bodies at 4 KiB, used only for classification and never echoed;
  - no logging anywhere in the module;
  - the key is resolved server-side and only `hasKey: boolean` reaches page data;
  - `cf-aig-skip-cache: true` and `cf-aig-collect-log: false`.

  Repeated "Baca lagi", parallel tabs and CSRF are covered by the throttle, the lane, and the hooks-level
  cross-site form check, which includes multipart.
- **AI output.** The output uses a strict JSON schema and a strict zod check. The model returns only text fields.
  - **No ids:** no wallet, category or space id comes from the model. The wallet is guessed from the space's own
    wallets, and categories come only from preset tile hints.
  - **Amounts:** the shared parser handles them, giving `0 < x ≤ MAX_AMOUNT_MINOR` whole rupiah or null.
  - **Dates and currency:** `isDateString` is checked, a far date is flagged by `receiptDateCheck`, and a
    non-IDR currency only shows a warning.
  - **Text:** text is cleaned and length-capped, and card or account numbers are masked to the last 4 digits.
  - **Rendering:** there is no `{@html}` in any changed Svelte file; the only uses are pre-existing blog and
    release notes.

  Injection fixtures are covered by tests.
- **Saves.** Every field is re-parsed on the server. The wallet goes through `getWallet(spaceId)` and categories
  through `listCategories(spaceId)`. `capturedTransactionInput` runs per row. `acceptMismatch` skips only the
  reconciliation error: date, amount, item and category checks still run. All rows are written or none:
  `photoAlreadySaved` sits in the insert guard and `allWritten` is asserted. Tombstones keep their dedupe key, so
  a deleted row is never recreated. An uploaded photo is cleaned up when the save fails, with the sweep as a
  fallback.
- **Photos.** R2 keys are `spaces/<space>/receipts/<randomUUID>` and never come from user input.
  - **Access:** `/riwayat/[id]/foto` checks `requireSpaceAccess` plus live membership in the read statement, and
    gives one 404 for every reason.
  - **Headers:** the stored sniffed type, `nosniff`, a CSP, `CORP: same-origin`, `private, no-cache` and
    `inline`.
  - **Release:** the photo is released on every transaction tombstone path (edit, suara undo, API, sync push),
    on space purge and account deletion (`purgeSpaces`), and in the sweep's reference check.
  - **Export:** limited to live, non-demo rows of the user's live spaces, with `photo_key` omitted. This is the
    same scope as `transactions.json` and belongings photos.
- **Checklist.** Keeping the photo in R2 is the PRD's owner decision 4, an explicit and untickable user choice. The
  bytes are sanitised and access-controlled, and nothing is kept when the box is off. Nothing about the read
  (bytes or text) is written to D1, KV or logs. `compat:receipts` reads the key only from `.dev.vars` and never
  logs it.

## Commands
- `flock … npx vitest run --maxWorkers=2 src/lib/server/receipts src/lib/shared/receipts.test.ts test/integration/struk.test.ts test/integration/migration-0029.test.ts`
  → 6 files, 95 tests passed. The real Anthropic API was not called.
