# FN-28 Collectibles (Koleksi): engineer report, cycle 1

Branch `fn-28-collectibles` (from `main` 9d3e892, FN-27 in). Risk tier Medium. No push, no deploy, no remote D1.

## Rebase onto main f7acfb7 (FN-29 connected apps)

- QA report d46b147 was cherry-picked, then the branch was rebased onto main f7acfb7.
- The migration was regenerated as `0017_collectibles`, chained to `0016_connected_apps` (journal idx 17,
  prevId d58d70c9…).
- `spaces.ts` keeps FN-29's `connectedApps` scoping and `autoDisconnectItems`. It uses the shared
  `releasePhotoKeys` for belongings and collectibles in the purge, and `SPACE_SCOPED_TABLES` holds both
  features' tables.
- Schema and i18n were merged as FN-29's content plus FN-28's additions.
- Checks:
  - `npm install`: exit 0. `npm run db:reset:local`: exit 0, applied through `0017_collectibles`.
  - Gates (`check && lint && vitest run --maxWorkers=4 && build`): exit 0. check 0 errors and 0 warnings
    (1328 files); lint clean; vitest 125 files, 1959 tests passed; build OK.
  - Full e2e (`E2E_PORT=8863 --workers=2`): 250 passed, 15 skipped, 0 failed, exit 0. No rerun was needed.

## Cycle 2: red team lows (SECURITY_REPORT.md, cherry-picked d1b0c6a)

The failing tests were written first. All 3 new tests failed before the fix: L1 answered 415 instead of 404,
and the L2 edit was accepted. After the fix they pass.

- **L1 (fixed):** the `archive` actions of `/koleksi` and `/barang` now run the access check
  (`requireSpaceAccess` via `collectibleScope` / `belongingScope`) before `readFormBody`.
  - Test, for both routes: a removed member whose session still points at the shared space posts a valid form
    and a malformed `text/plain` body. Both get the identical `404 Not found`, and a request proxy confirms the
    body was never read.
  - Create and update were already access-first (`guardedUpload`).
- **L2 (fixed, controller ruling):** `Data demo` rows are read-only.
  - `writable` requires `is_demo = 0`, and `whyNot` reports `demo` for a live demo row of the space.
  - Edit (with or without a photo, current or stale `updated_at`) and delete get 400 "Data demo tidak bisa
    diubah." (new message, with an English entry).
  - The row is unchanged, and an uploaded photo is cleaned up, so no object and no outbox key are left.
  - UI: demo rows render without an edit link, and `?ubah=<demo id>` opens no form.
- **Checks (light load):**
  - check: 0 errors, 0 warnings (1305 files). Lint clean.
  - Targeted vitest (`--maxWorkers=2`: koleksi, barang, collectibles, i18n and demo-seed tests): 7 files, 94
    tests passed.
  - e2e `koleksi.spec.ts` + `barang.spec.ts` (`E2E_PORT=8863 --workers=2`): 21 passed.

## What works

- `/koleksi` (new `(app)` route, same shape as `/barang`):
  - The list shows live collectibles, newest first. Each row has a thumbnail (or a star placeholder), the
    purchase date (WIB, `formatShortDate`) and the purchase price.
  - On the right of each row: the current value, then the gain in rupiah (`formatMoney(…, 'signed')`, `+Rp` or
    `−Rp` with U+2212, coloured only for meaning), then a smaller percent annotation. The percent is
    `gainPermille` (BigInt tenths) and is left out for a purchase price of 0.
  - The header "Nilai koleksi" shows the value total, with the total gain "… dari harga beli" under it.
  - A disclosure line: "Nilai diisi sendiri, bukan taksiran harga pasar atau penilaian keaslian." Nothing on
    the page claims an appraisal, a grading or authentication.
  - Add and edit open in a sheet (JS) or inline via `?tambah=1` / `?ubah=<id>` (no JS). Delete sits behind a
    confirm.
  - States: loading (skeleton on retry), empty, error (retry), saving, "Mengunggah foto…" and success. The
    success text shows only after the action result.
- Values:
  - The current value is required, as whole IDR units (`wholeAmountMinor`, at most 13 digits, so below
    10^13 rupiah). The same applies to the purchase price; 0 is allowed for both.
  - Gain = `valueMinor − purchasePriceMinor`, an exact integer.
  - Totals are summed with BigInt per currency. A sum past `MAX_SAFE_INTEGER` becomes `null` and the page
    shows "Total terlalu besar untuk ditampilkan". It is never rounded and never fails the page.
- Photos reuse FN-27's module `src/lib/server/photos/` exactly:
  - `PhotoKind = 'belongings' | 'collectibles'`. Keys are `spaces/<space>/collectibles/<uuid>`.
  - The same `readPhotoField` / `sanitizeImage` (magic bytes, metadata allow-list, GPS stripped), the same
    `uploadPhoto` (outbox reservation first) and the same `keepKey`, `cleanUpFiles` and `photoResponse`.
  - `sweepFileDeletions`' "still referenced" guard now checks both tables.
  - New generic batch item `releasePhotoKeys(db, table, where, now)`. It replaces FN-27's private
    `releasePhoto` and `releaseSpacePhotos`, and both repos and `purgeSpaces` use it.
  - New `readPhotoForm(request)`: access first, then the 413 check before reading, then the capped, timed
    read. Both routes use it.
  - The `StoredPhoto` and `PhotoChange` types moved to `photos/store.ts`.
  - UI: `PhotoField.svelte` and `AiUnavailable.svelte` were extracted from `BelongingForm`, which uses them
    with an identical DOM (barang e2e unchanged and passing).
- Serving: `GET /koleksi/[id]/foto` mirrors `/barang/[id]/foto`. It runs `collectibleSpaceId`, then
  `requireSpaceAccess` (an unknown id asks about space '' and gets the same 404 body), then
  `getCollectiblePhoto`, which repeats the live membership check in the same statement, then `photoResponse`.
  Headers are the same as FN-27's: sniffed type, `nosniff`, `inline`, `private, no-cache` + ETag/304, sandbox
  CSP, CORP same-origin.
- Delete leaves a content-free tombstone. A CHECK enforces it: name, amounts, date, note, photo key and type,
  and `created_at` are all null. The photo key moves to the outbox in the same batch, and R2 deletes it inline,
  or later through the queue and cron.
- Account deletion: `purgeSpaces` releases both photo tables under the purge condition, and `collectibles` is in
  `SPACE_SCOPED_TABLES`. Shared spaces keep their items and photos.
- Caps and stale forms:
  - `MAX_COLLECTIBLES_PER_SPACE = 300` is enforced by one guarded `INSERT … SELECT … WHERE count < 300`, which
    also requires a live member.
  - Edit and delete are guarded by `updated_at` and membership. A stale form gets 409 with FN-04's "Berubah
    sejak terakhir dimuat…". A missing or other-space id gets 404 "Koleksi tidak ditemukan.".
- FN-12: `MODULE_NAV.koleksi = '/koleksi'` and a sidebar entry (icon `star`). Hiding the module hides only
  that entry. `/koleksi` still loads with "Koleksi disembunyikan dari menu. Angkanya tetap dihitung.", and the
  Kekayaan row keeps counting. Only "Ruang bersama" still says "Belum ada menu untuk disembunyikan".
- `/kekayaan`: a "Koleksi" row after "Barang", with the same pattern (GroupRow → `/koleksi`, the same total as
  the page, "Belum ada" when empty, "Tidak bisa dimuat" on failure). It is hidden with its module. It is not
  added into the FN-25 net-worth figure, consistent with Barang.
- `Data demo`:
  - `is_demo` column. `scripts/demo-seed.ts` adds 2 fictional collectibles without photos to every eligible
    local space (idempotent, deterministic ids).
  - They are listed with the "Data demo" badge, with a note that demo rows are not counted, and are excluded
    from `/koleksi` and `/kekayaan` totals.
  - Form writes always store `is_demo = 0`.
- AI and automated price are UI-only and disabled:
  - "Kenali dari foto (AI)" and "Perkirakan nilai (AI)" are disabled buttons with "Belum dikonfigurasi. Isi
    nama dan harga sendiri dulu." (FN-27's phrase).
  - "Harga pasar otomatis" is a disabled checkbox with "Belum dikonfigurasi. Untuk sekarang semua koleksi
    memakai nilai yang kamu isi sendiri."
  - No handler and no request (e2e counts zero requests).

## External price source: verified, not adopted (manual values only)

These pages were checked on 2026-10-08, around 00:57 UTC, fetched server-side as untrusted text:

- https://docs.pokemontcg.io/ carries a banner: "The Pokémon TCG API is deprecated. New account registrations
  are no longer available. Existing API keys will continue to function through March 1, 2027. Please migrate
  your application to Scrydex."
- https://docs.pokemontcg.io/getting-started/rate-limits: without a key the limit is 1000 requests a day and
  30 a minute.
- https://pokemontcg.io/: "The Pokémon TCG API is now part of Scrydex".

The service still answers keyless, but it is deprecated with an announced migration to a different (key-based)
provider. I found no terms that clearly permit commercial use. Under the brief ("only if … keyless,
commercially permitted … verified") and the PRD's own Prerequisites fallback, the feature ships with every
collectible on manual value and the toggle disabled with "Belum dikonfigurasi". Consequences:

- There is no `prices.ts`, no KV key and no cron step.
- No `price_source` / `price_symbol` columns. A later migration adds them when a source is approved, rather
  than columns kept "for later".
- No CSP change: AC 6 holds trivially. An integration test asserts that no create, edit, delete or load calls
  `fetch`.

## Files

- Migration `migrations/0017_collectibles.sql` (renumbered at the rebase onto FN-29), plus
  `meta/0017_snapshot.json` (prevId = 0016_connected_apps' id d58d70c9…) and journal idx 17 with tag
  `0017_collectibles`: table `collectibles` with a photo CHECK, a
  content/tombstone CHECK and index `(space_id, deleted_at, created_at)`.
- New:
  - `src/lib/shared/collectibles.ts`
  - `src/lib/server/collectibles/{messages,validation,repo}.ts`
  - `src/lib/ui/collectibles/CollectibleForm.svelte`
  - `src/lib/ui/photos/{PhotoField,AiUnavailable}.svelte`
  - `src/routes/(app)/koleksi/{+page.server.ts,+page.svelte,[id]/foto/+server.ts}`
  - `e2e/koleksi.spec.ts`
  - `e2e/photos.ts` (image builders moved out of `barang.spec.ts`)
- Changed:
  - `db/schema.ts`
  - `photos/{store,upload}.ts`
  - `belongings/{repo,validation}.ts` (uses the shared release helper; `isPurchaseDate` exported)
  - `barang/+page.server.ts` (`readPhotoForm`)
  - `BelongingForm.svelte`
  - `spaces/spaces.ts`
  - `kekayaan/+page.{server.ts,svelte}`
  - `ui/shell/nav.ts`
  - `i18n-en.ts` (27 new entries)
  - `scripts/demo-seed.ts`
  - e2e `fitur`, `shell` and `barang` specs

## Tests

- Unit:
  - `shared/collectibles.test.ts`: gain exactness at the 13-digit maximum, unsafe input refused, permille
    rounding toward zero, formatting.
  - `server/collectibles/validation.test.ts`: whole-unit parsing, required value, decimals, signs, exponent
    and 14 digits refused, date bounds, name/note caps, echo.
  - `server/collectibles/totals.test.ts`: demo excluded, exact sums, overflow becomes null for value and gain,
    300 × maximum.
  - `ui/shell/nav.test.ts`: Koleksi entry and hiding.
  - `scripts/demo-seed.test.ts`: demo collectibles listed, idempotent, total empty.
- Integration `test/integration/koleksi.test.ts` (local D1 + R2, 27 tests):
  - Value, gain and total reconcile with `/kekayaan`. Demo rows are excluded. Overflow becomes null. Echo on
    refusal. No `fetch`.
  - Sanitised upload under the collectibles key with the photo headers and 304.
  - Spoofed HTML, SVG, polyglot and PNG-as-text/html are judged by their bytes.
  - Oversized file and an announced 413. R2 put outage, then the grace sweep.
  - The sweep keeps a key a live collectible holds.
  - Replace, stale replace and "Hapus foto".
  - Tombstone and CHECK. R2 delete outage, then queue and sweep.
  - Stranger, removed member, signed out and odd ids get an identical 404. A removed member's edit gets 404
    and nothing changes. Stranger edit and delete are refused.
  - 20 concurrent creates at 290 stop at exactly 300. A refused create deletes its photo. The cap is
    independent of belongings.
  - Account purge removes both photo tables. Loader logs carry only a label.
- Fail-before proof, shown in cycle 1:
  - With `collectibles` removed from the sweep's referenced guard, "the sweep never deletes an object a live
    collectible still holds" fails.
  - With the `releasePhotoKeys(db, collectibles, …)` purge step removed, "purges the personal space's
    collectibles and photos" fails.
  - Both pass with the code restored.

## Checks run

- `npm install`: exit 0. `npx svelte-kit sync`: OK. `npm run db:reset:local`: exit 0, migrations through 0015
  at reset time. The collectibles migration is applied by every test D1 and by the e2e migrate step.
- Gates:
  - check: 0 errors, 0 warnings (1305 files).
  - lint: clean.
  - vitest, first run (`--maxWorkers=4`, load average about 40): 2 files failed, 3 tests. All were `fetch
    failed / other side closed` workerd socket drops in `kekayaan-routes` and `net-worth-routes`. Rerun alone,
    both files passed (28/28).
  - Final gates (`check && lint && vitest run --maxWorkers=4 && build`): exit 0. check 0 errors and
    0 warnings (1305 files); prettier and eslint clean; vitest 117 files, 1866 tests passed; build OK.
- Targeted e2e (`E2E_PORT=8863 --workers=2`; koleksi, barang, fitur, shell, kekayaan): 64 passed, 3 skipped,
  0 failed.
- Full e2e (`E2E_PORT=8863 --workers=2`): 244 passed, 15 skipped, 0 failed, exit 0. No rerun was needed.
  `koleksi.spec.ts` passed 10/10 (phone + desktop).

## Pre-handoff probes

- Cross-space photo: a stranger, a removed member, signed out, an unknown id and a 500-character id all get an
  identical 404 `{"message":"Not found"}` (integration). Over HTTP, a stranger's body equals the unknown-id
  body (e2e). PASS.
- Removed member: photo 404 after `removeMember`. Their update with the old space cookie gets 404 and the row
  is unchanged. PASS.
- Deletion removes the R2 object: the prefix and the outbox are empty after a delete. With R2 delete failing,
  the outbox shows attempts 1, `file_sweep` is queued and the sweep removes the object. After a delete the
  photo URL gets 404 with the unknown-id body (e2e). PASS.
- Purge: deleting the account empties the personal space's collectibles and belongings photos (2 outbox keys,
  then `sweepSoon`, then the prefix is empty). The shared space's item and photo stay (200). PASS.
- Spoofed file refused via the shared module: HTML named `.jpg` gets "Foto harus berupa JPEG, PNG atau
  WebP.". The JPEG-magic polyglot gets "Foto tidak bisa dibaca.". SVG is refused. No row and no object
  (integration + e2e). PASS.
- Cap concurrency: 20 concurrent creates at 290 give 10 ok and 10 "batas terbanyak", exactly 300 live. PASS.
- Stale form: a second tab's replace gets 409 "Berubah sejak terakhir dimuat…". The new object is removed and
  the row is identical. PASS.
- No-JS upload: refusal with its reason, and name and value echoed; then a PNG is saved, listed with
  `−Rp 50.000`, and served as image/png without GPS (e2e, JS disabled). PASS.
- 360 px: no horizontal scroll with the sheet open, and with two rows (value, gain, percent) listed. Phone
  project, e2e. PASS.
- User copy: no file path, object key or id in any message. PASS.

## Decisions (defaults auto-accepted; own recommendations recorded)

1. Manual value only. The Pokémon TCG source is deprecated (see above). The "Harga pasar otomatis" toggle is
   disabled with "Belum dikonfigurasi". It is worded generically, not as "Kartu Pokémon TCG", to avoid a
   third-party product name for a feature that does not work.
2. The current value is required (`manual_value_minor NOT NULL` on a live row). With no price source and no
   estimate curve, a blank value would have to be invented.
3. Gain is shown in rupiah first, with the percent as a small annotation (PRD Owner decision 2), computed
   exactly in tenths with BigInt for display only.
4. The serving route is `/koleksi/[id]/foto`, not `/api/v1/collectibles/[id]/photo`. This follows FN-27's
   precedent (CLAUDE.md keeps `/api/v1` for webhooks and integrations; uploads are no-JS form actions).
5. Cap 300 per space, counting live rows including demo rows.
6. Collectibles are not added into the FN-25 net-worth total. They get their own Kekayaan row, like Barang.
   Folding both into net worth is a separate decision.
7. Demo rows can be edited and deleted like any row. Editing keeps them `Data demo`.

## Gaps

- No automated market price for any category (above). No AI identification or valuation (Belum dikonfigurasi).
- Guest mode and sync of the new table are not built (no sync pull exists).
- Real R2 (staging) was not exercised; local R2 (miniflare) only.
