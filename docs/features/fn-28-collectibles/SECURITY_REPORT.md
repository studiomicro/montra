# FN-28 Collectibles: security report (cycle 1)

Reviewed: `git diff 9d3e892..178fc04` (narrow review, Medium tier; reuses FN-27's photo module).

## Verdict: PASS

No critical, high or medium findings. Two low findings are tracked below.

## Focus checks

- **Photo hardening kept on both routes.** `src/lib/server/photos/image.ts` (byte sniffing, allow-list stripper)
  and `src/lib/server/forms.ts` `readFormBody` (growing buffer, total/idle deadlines) are unchanged in the diff.
  The new `readPhotoForm` (`src/lib/server/photos/upload.ts:23-26`) is the exact prior sequence from `/barang`:
  `announcesTooLarge`, then `readFormBody(PHOTO_FORM_MAX_BYTES, 120 s, 20 s)`. Both `/barang` and `/koleksi` call
  it only after `requireSpaceAccess` (`koleksi/+page.server.ts:95-103`, `barang/+page.server.ts` `guardedUpload`).
  `readPhotoField` still caps at PHOTO_MAX_BYTES (8 MiB) and never reads the file name or browser type.
- **No kind confusion.** `releasePhotoKeys(db, table, where, now)` (`photos/store.ts:73-88`) selects
  `photo_key` only from the table it is given; every caller passes its own table with its own guard
  (`collectibles/repo.ts:294,300,326`, `belongings/repo.ts`, `spaces.ts:290-291`). Keys are generated server-side
  (`spaces/<space>/<kind>/<uuid>`) and never read from a form, so a belongings key cannot be placed on a
  collectible row. `/koleksi/[id]/foto` reads only the `collectibles` table, so a belongings id answers the
  unknown-id 404. The sweep's "still referenced" check now covers both tables (`store.ts:120-121`), so neither
  table's live object is deleted by the other's release or by the sweep.
- **Photo route.** Same shape as FN-27: unknown id → `requireSpaceAccess(…, '')` 404; read repeats live
  membership in the same statement; headers from `photoResponse` (sniffed type, nosniff, sandbox CSP, CORP
  same-origin, private no-cache). Integration test covers member / stranger / removed member / signed out / odd
  ids with identical 404s.
- **IDOR.** Update and archive are one guarded statement (`id` + live in session space + `updated_at` + live
  membership); another space's id answers `missing` like an unknown id.
- **Caps under concurrency.** The 300 cap is in the guarded `INSERT … SELECT` subquery
  (`collectibles/repo.ts:204-205`); the 20-concurrent test stops at exactly 300; a refused create deletes its
  already-written photo.
- **Money.** `wholeAmountMinor` refuses decimals/signs/exponents and >13 digits; gain is an integer difference of
  two ≤10^13 values; totals use BigInt with a `null` "too large" state; `gainPermille` is BigInt. Demo rows
  are skipped in `collectiblesTotalsOf` and the form never writes `is_demo = 1`.
- **Purge.** `purgeSpaces` releases collectible photo keys before the deletes in the same batch, under the same
  `stillPurgeable` guard; account deletion uses it (`auth/delete-account.ts:64`); tested.
- **Disabled AI / price controls.** `AiUnavailable.svelte` renders `disabled` buttons with no handler; no
  `fetch` in the route, repo or components; integration test asserts no network on create/edit/delete.
- No `{@html}`, no raw SQL interpolation (all `sql` templates bind values), no secrets or ids in logs.

## Findings

### L1 (low): archive action reads the body before the access check
`src/routes/(app)/koleksi/+page.server.ts:195-196` calls `readFormBody` before `collectibleScope`. Same order as
`/barang` (pre-existing). Bounded by the default 8 KiB / 10 s guard, so the cost to an unauthenticated or
non-member caller is negligible. Fix (optional, both routes): resolve the scope first.

### L2 (low): edits keep `is_demo` on demo rows
`updateCollectible` does not clear `is_demo`, so a user editing a `Data demo` row turns it into real-looking data
that stays excluded from totals. Demo rows exist only from the local seed script, so this is a local-review
oddity, not a production exposure. Fix (optional): refuse edits of demo rows, or document it.

## Commands run

- `npm ci` → exit 0; `npx svelte-kit sync` → exit 0; `npm run db:reset:local` → exit 0
- `npx vitest run --maxWorkers=2 test/integration/koleksi.test.ts src/lib/server/collectibles src/lib/shared/collectibles.test.ts`
  → 4 files, 54 tests passed
- `npx vitest run --maxWorkers=2 test/integration/barang.test.ts test/integration/delete-account.test.ts src/lib/server/photos`
  → 3 files, 57 tests passed
- Playwright not run (machine load, per instructions); no wrangler dev, no remote commands.
