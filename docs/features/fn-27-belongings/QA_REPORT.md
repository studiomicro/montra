# FN-27 Belongings (Barang) — QA report

**Verdict: PASS**

Reviewed at `b26cb7c` (detached, on `main` `c401a94`). Local only: no `--remote`, no login, no deploy.

## Commands run

- `npm ci` → exit 0, mock/fixture-free install.
- `npx svelte-kit sync` → exit 0.
- `npm run db:reset:local` → exit 0, migrations applied through `0015_belongings` on local D1 (real SQLite via
  miniflare, no mock).
- `npm run gates` → exit 0. `check`: 0 errors, 0 warnings, 1286 files. `lint` (prettier + eslint): clean.
  `test` (vitest, local D1 + local R2 via miniflare, no real provider): 113 files, 1805 tests passed. `build`: OK.
- `npx vitest run test/integration/barang.test.ts --maxWorkers=4` → 1 file, 22 tests passed (local D1 + local R2).
- Full Playwright (`E2E_PORT=8862`, `--workers=2`, real Chromium headless shell against local `wrangler`/miniflare,
  no real provider) → 234 passed, 15 skipped, 0 failed (4.7m). No rerun needed (0 failures).
- `e2e/barang.spec.ts` within the full run: 10/10 passed (5 specs × phone + desktop).

## PRD net-worth question

FN-27 PRD acceptance criteria (1–12) make no mention of belongings counting toward the FN-25 net-worth total; the
Goal section's "physical half" line is about belongings' own total being honest (depreciation, not frozen at
purchase price), not about merging into `/kekayaan`'s net-worth figure. FN-25's own PRD defines its total strictly
as the sum of `net_worth_items` rows (acceptance criterion 1), a separate table with its own `other_asset` kind for
manually-tracked physical assets. The engineer's row-not-merged design (Barang gets its own total/row on
`/kekayaan`, same convention as the pre-existing Langganan row) matches this and matches precedent (wallets/goals
also have their own figures, not folded into the net-worth number). **Not a FAIL**: the PRD does not require the
merge, and no acceptance criterion depends on it.

## Checked criteria

1. PASS — estimate shown and labelled "Estimasi", recomputed from `wibTodayString()` on every `/barang` load
   (`+page.server.ts:77-78`), never stored. Unit vectors in `belongings.test.ts`.
2. PASS — `belongingValue()` returns the user's figure unlabelled when `currentValueMinor !== null`, including a
   stored `0` (test "a stored zero is the user's figure, not use the estimate").
3. PASS — vectors at 0/1/5/20/100 years and a future purchase date all return a defined, non-negative integer,
   floored at 20 %; `estimatedValueMinor` throws `RangeError` for a negative/unsafe price or a non-date rather
   than producing a bad number.
4. PASS — `uploadPhoto`/`storePhoto` writes to R2 under `spaces/<spaceId>/belongings/<uuid>` only after magic-byte
   sniffing passes; `photo_key` is set only in the same D1 batch that confirms the row holds the key (`keepKey`).
   Oversize and non-image (SVG/HEIC/polyglot, spoofed `Content-Type`) are refused with no object and no partial
   key — integration tests "oversize file", "spoofed/SVG/HEIC/polyglot refused with no object", e2e "spoofed, SVG
   and polyglot files are refused by their bytes; nothing is saved" (passed).
5. PASS — `GET /barang/[id]/foto` calls `requireSpaceAccess` on `belongingSpaceId` (unknown id → space `''`, same
   404), then re-checks `isLiveMember` in the same statement as the read (`getBelongingPhoto`). e2e "another
   account gets the same 404 for my photo as for an unknown id" passed; integration confirms a removed member gets
   the same answer. No public/unauthenticated R2 URL: the bucket has no public binding and `<img src>` is always
   the app route.
6. PASS — `archiveBelonging` clears `photo_key`/`photo_type` in the same tombstone write that moves the key to
   `file_deletions`; the serving route answers 404 from the cleared column regardless of R2's own state (verified
   by the integration test with R2 delete forced to fail: tombstone still hides the photo, outbox keeps the key,
   `file_sweep` finishes it).
7. PASS — "Kenali dari foto (AI)" is always rendered, `disabled`, with "Belum dikonfigurasi. Isi nama dan harga
   sendiri dulu." e2e asserts the button is visible+disabled and that a forced click produces zero network
   requests (`e2e/barang.spec.ts:246`, passed).
8. PASS — hiding the `barang` module only removes its nav entry; `/barang` still loads with the hidden-module
   note and its total still counts (e2e `fitur.spec.ts` "Barang and the two switches without a nav entry persist;
   only Barang leaves the nav", passed).
9. PASS — every belongings route/action (list/create/update/archive load+actions, the photo GET) goes through
   `requireSpaceAccess`/`isLiveMember`; stranger, removed member and unknown id all get the identical 404 body in
   both the integration suite and the live e2e check. Sync push/pull: no sync pull/push module exists anywhere in
   this codebase yet (confirmed: `src/lib/server/sync/` holds only `seq.ts`); this is a pre-existing, codebase-wide
   gap outside FN-27's scope, not a regression introduced here.
10. PASS — create/update/archive use the `writable`/stale-vs-missing guard (`updated_at` match + `isLiveMember`
    evaluated at write time); a second tab's stale save is refused and its new photo's key is released, not left
    dangling (integration "replace / stale replace (new object removed) / remove photo"). Reload persistence and
    saving/uploading→success-after-confirmation states are covered by the e2e "add an item with a photo" spec.
    An interrupted upload (R2 outage) leaves no row (integration "R2 put outage (no row, reservation swept only
    after grace)").
11. PASS — `purgeSpaces` releases a space's belonging photo keys (`releaseSpacePhotos`) before deleting the space;
    `belongings` is in `SPACE_SCOPED_TABLES`; account deletion runs `sweepSoon`. Integration test "purges the
    personal space's items and photos; a shared space's items stay for the others" passed.
12. PASS — `Kenali dari foto (AI)` and the depreciation disclosure strings both have English entries in
    `i18n-en.ts` (checked directly); the codebase-wide i18n-coverage test (`test/i18n-coverage.test.ts`) passed as
    part of gates. Money via `formatMoney`/`formatMoneyCompact` is used in the totals (reused from existing
    helpers, not hand-formatted — confirmed by reading `+page.svelte`). Dates use the new `formatShortDate` on the
    WIB `purchasedOn` string, not a UTC-shifted `Date`. The "Estimasi, bukan nilai pasar sebenarnya." disclosure is
    rendered wherever an estimate (not an override) is shown (`+page.svelte:241`).

## Additional verification (task-specific checks)

- **WIB month boundary**: FN-27 reuses the already-covered `wibTodayString()`; existing `dates.test.ts` vectors
  explicitly cover 23:30 WIB on the last day of a month (incl. Dec→Jan and Feb 29 2024 leap case) — not retested
  from scratch since the helper and its tests predate this feature and are unchanged by this diff.
- **Trailer truncation (R15)**: `image.test.ts` "R15: data after the image end is cut, never refused and never
  parsed" — Ultra HDR/motion-photo JPEG and 100 KB PNG/WebP trailers are cut, not refused; output ends exactly at
  EOI/IEND/RIFF-end. Matches the controller ruling.
- **Bounded colour profiles (R16)**: JPEG/PNG/WebP ICC-profile tests cover kept-in-place, incomplete/out-of-
  order/duplicate/oversized/bad-signature-dropped, and the WebP VP8X ICC flag cleared when dropped — all passing.
- **Refusal messages in both languages**: `PHOTO_NOT_IMAGE`/`PHOTO_UNREADABLE`/`PHOTO_TOO_LARGE`
  (`src/lib/server/photos/messages.ts`) have `i18n-en.ts` entries; e2e confirms the Indonesian text renders in the
  sheet and no-JS form.
- **Headers/404 identical**: verified in code (`photoResponse`: `nosniff`, `inline`, `private, no-cache`, CSP
  `default-src 'none'; sandbox; frame-ancestors 'none'`, CORP `same-origin`, ETag+304) and by the passing
  integration/e2e cross-account tests.
- **300 cap**: `createBelonging`'s guarded `INSERT…SELECT` with a count check inside the same guard; integration
  test "20 concurrent creates at 290 stop at exactly 300" passed (gates run).
- **Depreciation labelled "Estimasi"**: confirmed in `+page.svelte` and `belongingValue()`; never applied when
  `current_value_minor` is set (criterion 2).
- **No fabricated figures**: totals are exact BigInt sums (`totalsOf`), null ("too large") past
  `MAX_SAFE_INTEGER`, never silently rounded.
- **360 px / no-JS**: e2e "the AI control is visible, disabled and sends nothing; 360 px has no horizontal
  scroll" and "without JavaScript: an upload is refused with its reason, then saved and shown" both passed.

## ENGINEERING_CHECKLIST review

Walked the diff against `docs/ENGINEERING_CHECKLIST.md`:

- Data access: `deleteFiles`/`sweepFileDeletions` use the bounded `IN (SELECT value FROM json_each(?))` pattern
  (not unbounded `inArray`), batched and capped at `FILE_DELETE_BATCH` = 100 — compliant.
- Concurrent writes: every belongings write is one guarded statement inside `db.batch`, matching the
  `writable`/stale-vs-missing pattern — compliant.
- Money/dates: integers only (BigInt math in `estimatedValueMinor`), one currency per sum (`totalsOf` groups by
  currency), WIB dates throughout — compliant.
- Access/privacy: one access rule (`requireSpaceAccess`/`isLiveMember`), no existence oracle (identical 404s) —
  compliant.
- "No upload persistence" item: this is explicitly scoped to the FN-21 in-memory statement/screenshot/receipt
  path; CLAUDE.md's R2 bullet names "item and collectible photos" as a kept-file exception, so belongings writing
  to R2 is in scope, not a violation — confirmed no conflict.
- Web/output: CSP additions are per-route only (the photo route's own strict CSP, no `unsafe-inline` anywhere);
  form bodies use the shared capped-read guard (`readPhotoField`/`readCapped`) — compliant.
- UI quality: i18n coverage test passes; `formatMoney`/`formatMoneyCompact` reused, not hand-formatted; focus
  return and 44 px targets covered by e2e.
- No violations found specific to this diff.

## Findings

None. All twelve acceptance criteria verified with passing tests (existing plus the engineer's own cycle-1/2/3
regression suite for the two security rulings); `npm run gates` is clean; the full Playwright suite including
`barang.spec.ts` passed on both phone and desktop projects with no reruns needed.
