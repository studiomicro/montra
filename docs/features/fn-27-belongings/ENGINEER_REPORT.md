# FN-27 Belongings (Barang) — engineer report, cycles 1–4

Branch `fn-27-belongings` (from `main` fa58797). Risk tier Medium: first user-kept file written to R2.

## Cycle 2: red team findings (SECURITY_REPORT.md) and rebase onto main 7081ad7 (FN-26)

The failing tests were written first. Against the cycle-1 `image.ts`, 12 of the new tests failed: the five
flood files took 11–65 s each, plus the L1 and L2 cases. The L4 test failed when the log line went back to
`e`.

- **M1 (fixed):** `src/lib/server/photos/image.ts` was rewritten as a single pass. Output goes into one
  preallocated `Writer` buffer (input + 64 bytes; no per-segment arrays). Headers are read in place
  (`ascii` without spreading).
  - Hard caps: `MAX_SEGMENTS = 4096` markers or chunks for JPEG and PNG, 64 chunks for WebP.
  - RSTn, TEM and a stray SOI outside entropy-coded data are refused.
  - More than `TRAILER_TOLERANCE = 1024` bytes after EOI, IEND or the RIFF end are refused.
  - CPU is bounded by the caps plus one linear scan.
  - The red-team repro (8 388 532 bytes: SOI + SOF 1x1 + 4 M `FF D0` + SOS + EOI) is now refused as
    `malformed` in 0.37 ms. Heap growth is +0.01 MB; the one output buffer is about 8 MB of external
    memory. Before the fix the red team measured +976 MB.
  - Regression tests cover the repro, JPEG APP0 and DRI floods, a PNG gAMA flood and a WebP ALPH flood. Each
    asserts `malformed`, heap growth < 24 MB and < 1 s. A legitimate 8 MiB scan stays < 24 MB.
- **L1 (fixed):** a second SOF is refused. Every frame header is size-checked as it is read (JPEG SOF, PNG
  IHDR, WebP VP8X canvas and VP8/VP8L bitstream). A WebP whose canvas and bitstream sizes differ is refused.
- **L2 (fixed, now an allow-list):**
  - JPEG keeps SOI, DQT, DHT, DRI, one SOFn, SOS with its scan data, and EOI. An APP0 JFIF is rewritten
    with a 0x0 thumbnail and keeps only its density. The EXIF Orientation goes into a new 34-byte APP1
    (decision: keep it, so portrait photos stay upright). Everything else is dropped: APP2 ICC and MPF,
    APP14 Adobe, 0xF0–0xFD, comments and JFXX.
  - PNG keeps IHDR, PLTE, tRNS, IDAT and IEND only. A second IHDR is refused.
  - WebP keeps VP8X (alpha flag only), ALPH and one VP8/VP8L bitstream. Animation (the flag, ANIM or ANMF)
    is refused.
  - Tests per format walk the output and assert the exact marker or chunk list.
- **L3 (fixed):**
  - `readCapped` reads a body with a declared Content-Length straight into one buffer of that size, with no
    chunk list plus a joined copy. A body longer than declared is refused.
  - `readPhotoField` removes the file from the `FormData` once its bytes are read.
  - Peak memory after parsing is the file bytes plus one output buffer. There is no streaming multipart
    parser; that is a remaining gap.
- **L4 (fixed):** the `/barang` and `/kekayaan` loaders log a fixed message plus `errorLabel(e)`. An
  integration test renames the table, then asserts that the logs hold no SQL, message or space id.
- **Rebase:**
  - The migration was regenerated as `0015_belongings`, chained to `0013_subscriptions` (journal idx 14).
  - Nav merged with FN-26: `MODULE_NAV` has kekayaan, langganan and barang; the sidebar order is Langganan,
    Barang, Impor, Kotak masuk, Pengaturan; desktop has 9 links.
  - The Barang row on `/kekayaan` now follows FN-26's Langganan row. It is a `GroupRow href` with an icon,
    and it is hidden together with its module. `/barang` itself still loads with the hidden-module note.
  - `fitur.spec.ts` and `shell.spec.ts` were updated.

**Cycle 2 checks:**

- `npm install`: exit 0. `npm run db:reset:local`: exit 0, applied through `0015_belongings`.
- Gates (`check && lint && vitest run --maxWorkers=4 && build`): exit 0.
  - check: 0 errors, 0 warnings (1269 files).
  - prettier and eslint: clean.
  - vitest: 107 files, 1726 tests passed.
  - build: OK.
- Full e2e (`E2E_PORT=8856 --workers=2`): 230 passed, 15 skipped, 0 failed. No rerun was needed.

Cycle 2 raised two trade-offs for the owner: refusing data after EOI, and dropping ICC. The controller ruled
on both in cycle 3 (R15, R16).

## Cycle 4: red-team re-check lows (no rebase; main c401a94)

The failing tests were written first: the N1, N2, N3 and N4 tests failed before the fix and pass after it.

- **N1:** an ICC profile is kept only when it is at least 128 bytes, its size field (bytes 0–3) equals the
  joined length, and `acsp` is at offset 36. This holds for JPEG (the header must be in segment 1) and for
  WebP ICCP. Otherwise the profile is dropped, and for WebP the ICC flag is cleared.
- **N2:** only the first JFIF segment is written.
- **N3:** a VP8X chunk that is not exactly 10 bytes is refused.
- **N4:** `readCapped` no longer preallocates the declared Content-Length.
  - It starts at 64 KiB and doubles as bytes arrive, capped at the declared length or `max`.
  - The wall-clock deadline cancels the read with 408. The photo upload deadline went from 120 s to 30 s.
  - Test: a stub declares 8 MiB and sends 3 bytes. Buffer memory grows by less than 1 MiB, the read gets 408
    and the stream is cancelled.
  - Cycle 4b (R17): the total deadline is back to 120 s (8 MiB needs about 0.6 Mbit/s), with a 20 s idle timeout (no bytes for 20 s → 408). Test: a slow but steady stream completes past the idle limit; a stalled one is refused after the idle time.
- **Checks:**
  - Gates (`--maxWorkers=4`): exit 0. check 0 errors and 0 warnings (1286 files); lint clean; vitest 113
    files, 1809 tests passed; build OK.
  - `e2e/barang.spec.ts` (`E2E_PORT=8856 --workers=2`): 11 passed.
  - Cycle 4b: no rebase was needed, because the branch was already on main c401a94.
    - Gates (`--maxWorkers=4`): exit 0. check 0 errors and 0 warnings (1286 files); lint clean; vitest 113
      files, 1810 tests passed; build OK.
    - `e2e/barang.spec.ts` + `e2e/kekayaan.spec.ts`: 24 passed, 3 skipped.

## Cycle 3: controller rulings R15 / R16, rebase onto main c401a94 (FN-25 in)

- **R15: data after the image end is cut, never refused.** The bytes after EOI, IEND or the RIFF end are not
  parsed. Removed: `TRAILER_TOLERANCE` and `checkTrailer`.
  - Unit test: a JPEG followed by an Ultra HDR gain-map JPEG and a 3 MiB MP4 is accepted. The output is
    byte-identical to the primary image and ends at `FF D9`.
  - PNG and WebP: a 100 KB trailer is cut.
  - Integration test: a motion-photo-shaped upload is stored ending at EOI, without `ftyp`, under 1 KiB.
- **R16: colour is kept.**
  - JPEG keeps APP2 `ICC_PROFILE` segments only, and only as one complete profile. Each segment must carry
    the signature, the sequence numbers 1…n must be in order with the same count, at most 8 segments, and
    the profile data must total at most 64 KiB. Otherwise every ICC segment is dropped. MPF and FlashPix
    APP2 are always dropped.
  - PNG keeps `sRGB`, `gAMA` and `cHRM` only at their fixed sizes (1, 4 and 32 bytes). iCCP is still
    dropped.
  - WebP keeps `ICCP` up to 64 KiB, directly after VP8X, and sets the VP8X ICC flag only when it is kept.
    An oversized profile is dropped and the flag cleared.
  - Tests per format: the ICC profile kept and in place; incomplete, out-of-order, duplicate, oversized and
    bad-signature profiles dropped; the exact PNG chunk list; the WebP flag `0x30` versus `0` for an
    oversized ICCP.
- **Rebase:**
  - Migration `0015_belongings` was regenerated, chained to `0014_net_worth` (prevId d1e1a791…, journal
    idx 15).
  - `SPACE_SCOPED_TABLES` holds subscriptions, notifications, net worth items/snapshots, belongings, goals
    and the rest.
  - The jobs cron runs the notification sweep, then the file sweep, then the tick log, then the FN-25 net
    worth tick.
  - `/kekayaan` order: Net worth, Wallets, Goals, Langganan row, Barang row (each module row hidden with its
    module). The net worth loader also logs `errorLabel(e)`.
  - Net worth does not include belongings yet (outside FN-27).

**Cycle 3 checks:**

- `npm install`: exit 0. `npm run db:reset:local`: exit 0, applied through `0015_belongings`.
- Gates (`check && lint && vitest run --maxWorkers=4 && build`): exit 0.
  - check: 0 errors, 0 warnings (1286 files).
  - lint: clean.
  - vitest: 113 files, 1805 tests passed.
  - build: OK.
- Full e2e (`E2E_PORT=8856 --workers=2`): 234 passed, 15 skipped, 0 failed. No rerun was needed.

## What works

- `/barang` (new `(app)` route): list of live belongings (newest first) with a thumbnail, the purchase date (WIB,
  `formatShortDate`) and price, and the current value — the user's own figure, or the straight-line estimate
  labelled "Estimasi" — under a total header ("Nilai barang", per currency, exact BigInt sum, "too large" null
  state) with the disclosure "Estimasi, bukan nilai pasar sebenarnya." whenever an estimate is in it. Add / edit
  in a sheet (JS) or inline via `?tambah=1` / `?ubah=<id>` (no JS); delete behind a confirm. Loading (skeleton on
  retry), empty, error (retry), saving, "Mengunggah foto…" (when a file is attached) and success states; success
  text only after the action result.
- Estimate: `estimatedValueMinor` (src/lib/shared/belongings.ts) — linear to 20 % of the purchase price over
  1826 days (5 × 365 + 1), flat after; whole-unit BigInt math, loss rounded down so it never falls below the
  floor; future purchase date = age 0. Recomputed from today's WIB date on every load, never stored.
- Photo upload (multipart form action, works without JS): access checked first, a body announced past
  8 MiB + 64 KiB refused with 413 + "Foto terlalu besar" before reading, then read with the capped reader
  (`readFormBody`, now with an optional timeout: 120 s for uploads). `readPhotoField` ignores file name and
  browser type; `sanitizeImage` sniffs magic bytes (JPEG/PNG/WebP only; SVG, HEIC, GIF, PDF, HTML refused),
  walks and rebuilds the container keeping only image data and colour info, drops EXIF (GPS, camera,
  thumbnail), XMP, IPTC, comments, PNG text/eXIf/tIME, WebP EXIF/XMP (flags cleared, RIFF size fixed), cuts
  trailing bytes (polyglot tails), and caps frames at 10 000 px per side / 50 MP. A JPEG keeps its Orientation
  in a fresh minimal APP1 so portrait photos stay upright.
- R2 (`FILES`): key `spaces/<spaceId>/belongings/<uuid>`; never a user name, never public. Every key goes
  through the `file_deletions` outbox (migration 0015): reserved (due in 15 min) before `put`, cleared in the
  same D1 batch that stores it on the row (`keepKey`), so a crash or failed write leaves only a swept object;
  replace / remove / delete move the old key to the outbox in the same batch as the row write, then
  `cleanUpFiles` deletes it inline; if R2 fails the row stays (attempts+1), a `file_sweep` job is queued and the
  hourly cron sweeps too (`sweepFileDeletions`, bounded 100, skips any key a live row still holds).
- Serving: `GET /barang/[id]/foto` → `belongingSpaceId` → `requireSpaceAccess` (unknown id asks about space
  '' so the answer is the same 404 body) → `getBelongingPhoto` (re-checks `isLiveMember` in the same
  statement) → `photoResponse`: Content-Type from the stored sniffed type, `nosniff`, `inline`,
  `private, no-cache` + ETag (revalidated each view, 304 when unchanged), CSP
  `default-src 'none'; sandbox; frame-ancestors 'none'`, CORP same-origin. `<img src>` is our own route
  (`img-src 'self'` holds; no data: URL, no unsafe-inline).
- Delete = content-free tombstone (CHECK-enforced: name, amounts, date, note, photo key/type and created_at all
  null), photo key to the outbox in the same batch; the route answers 404 at once whatever R2 does.
- Account deletion: `purgeSpaces` first moves the purged spaces' photo keys to the outbox (same guarded batch),
  `belongings` is in `SPACE_SCOPED_TABLES`; the account action then runs `sweepSoon` (inline sweep, queue
  follow-up on failure or a full batch). Shared spaces' items and photos stay for the other members.
- "Kenali dari foto (AI)": always visible, `disabled`, with "Belum dikonfigurasi. Isi nama dan harga sendiri
  dulu." — no handler, no request (e2e counts zero requests).
- FN-12: `barang` now has a nav entry (sidebar `/barang`, icon `box`; `MODULE_NAV.barang`, `visibleExtras`);
  hiding it hides that entry only; `/barang` still loads with the hidden-module note, and the "Barang" value row
  on `/kekayaan` (same rows and estimate as `/barang`) keeps counting. Mobile reaches `/barang` from that row.
- Jobs Worker: new `file_sweep` job (queue, bounded retries/DLQ as configured) and a cron step; a sweep failure
  never stops the tick's other work.

## Files

- Migration `migrations/0015_belongings.sql` (+ `meta/0015_snapshot.json`, journal idx 15 tag
  `0015_belongings`; chained to 0014_net_worth on main (cycle 3 rebase)): `belongings`,
  `file_deletions`.
- New: `src/lib/shared/{belongings,photos}.ts`; `src/lib/server/belongings/{messages,validation,repo}.ts`;
  `src/lib/server/photos/{image,store,upload,messages}.ts` (kind-parameterised for FN-28:
  `PhotoKind = 'belongings'`, add `'collectibles'` plus its table in `sweepFileDeletions`' "referenced" guard
  and a `releaseSpacePhotos`-style purge step); `src/lib/ui/belongings/BelongingForm.svelte`;
  `src/routes/(app)/barang/{+page.server.ts,+page.svelte,[id]/foto/+server.ts}`.
- Changed: `db/schema.ts`, `spaces/spaces.ts` (SPACE_SCOPED_TABLES, purge step, `now` param),
  `auth/delete-account.ts` (passes `now`), `pengaturan/akun/+page.server.ts` (`sweepSoon` after deletion),
  `forms.ts` (optional timeout), `shared/jobs.ts`, `workers/jobs/src/{index,queue}.ts`, `shared/dates.ts`
  (`formatShortDate`), `ui/icons.ts`, `ui/shell/{nav.ts,Sidebar.svelte}`, `kekayaan/+page.{server.ts,svelte}`,
  `i18n-en.ts` (47 entries), `test/helpers/d1.ts` (also returns the proxy env with local R2).

## Tests

- Unit: `shared/belongings.test.ts` (vectors 0/1/5/20/100 years + future date, floor rounding, 13-digit max,
  refusals), `server/photos/image.test.ts` (sniffing; JPEG/PNG/WebP stripping, orientation kept, trailing
  bytes cut, idempotent, malformed and dimension refusals), `server/belongings/validation.test.ts`,
  `server/belongings/totals.test.ts`, `shared/dates.test.ts` (+formatShortDate), `ui/shell/nav.test.ts`
  (Barang entry), `workers/jobs/src/queue.test.ts` (file_sweep ack / follow-up / retry).
- Integration `test/integration/barang.test.ts` (local D1 + local R2, 20 tests): estimate vs own figure and
  total reconciling with `/kekayaan`; validation echo; sanitized upload under the space key with no GPS,
  headers, ETag 304; spoofed HTML/SVG/HEIC/polyglot refused with no object; PNG sent as text/html accepted as
  PNG; oversize file and announced oversize body; R2 put outage (no row, reservation swept only after grace);
  replace / stale replace (new object removed) / remove photo; delete tombstone + object gone; R2 delete outage
  (outbox attempts 1, `file_sweep` queued, sweep finishes); stranger / removed member / unknown id identical
  404; stranger update/delete changes nothing; signed out; 20 concurrent creates at 290 → exactly 300; refused
  create at the cap deletes its photo; account deletion purges personal items + photos, shared stay.
- e2e `e2e/barang.spec.ts` (phone + desktop): real canvas JPEG with spliced EXIF GPS → thumbnail decodes via
  our route, GPS absent from the served bytes, no non-origin request; delete → URL 404 with the unknown-id
  body; spoofed/SVG/polyglot refused in the sheet; cross-account 404 identical; AI control disabled with zero
  requests, 360 px no horizontal scroll; no-JS refusal then success.

- Existing e2e updated for the new Barang nav entry: `fitur.spec.ts` (Barang no longer "Belum ada menu…"; hiding
  it drops its sidebar entry; `/barang` shows the hidden note), `shell.spec.ts` (desktop sidebar 8 links).
  The `/kekayaan` Barang row says "Belum ada" when empty (no "Rp" figure on an empty Kekayaan page).

## Checks run

- `npm run gates`: check 0 errors / 0 warnings (1249 files); prettier + eslint clean; vitest 103 files,
  1560 tests passed; build OK. (Two earlier gate runs each lost one unrelated integration file to a workerd
  "other side closed" socket error at load average ~26–33; the rerun was clean.)
- Full e2e `E2E_PORT=8856 --workers=2`: 218 passed, 15 skipped, 2 failed (`riwayat.spec.ts:139`, `:199`,
  5 s visibility timeouts at high load); `riwayat.spec.ts` rerun alone: 15 passed. The previous full run
  (before the nav/test updates) had those two passing. `barang.spec.ts` 11/11 (both projects) in both runs.

## Pre-handoff probes

- Polyglot / spoofed: HTML as `foto.jpg`+`image/jpeg` → "Foto harus berupa JPEG, PNG atau WebP."; JPEG magic +
  HTML → "Foto tidak bisa dibaca."; PNG sent as `text/html` stored as `image/png` (integration + e2e) — PASS.
- SVG (`image/svg+xml`, with script) refused, nothing stored (integration + e2e) — PASS.
- Oversize: 8 MiB + 1 file → 400 "Foto terlalu besar"; announced 16 MiB body → 413 before reading; no row, no
  object (integration) — PASS.
- EXIF GPS stripped: served bytes of a real browser JPEG with spliced GPS contain neither the GPS text nor
  the GPS IFD tag 0x8825; PNG tEXt GPS gone (e2e + integration) — PASS.
- Cross-space photo URL: stranger, removed member, unknown id, 500-char id → identical 404 `Not found` body
  (integration); stranger vs unknown body identical over HTTP (e2e) — PASS.
- Removed member: photo 404 after `removeMember` (integration) — PASS.
- Deletion removes object: R2 prefix empty and outbox empty after delete; with R2 failing the tombstone still
  hides the photo, outbox keeps it (attempts 1), `file_sweep` queued, sweep removes it (integration) — PASS.
- No-JS upload: refusal with reason and echoed name, then a valid PNG saved and listed (e2e, JS disabled) — PASS.
- Concurrency: 20 concurrent creates at 290 → exactly 300 live, 10 "batas terbanyak" (integration) — PASS.
- Two tabs: stale update with a new photo → 409 "Berubah sejak…", new object removed, row unchanged — PASS.
- 360 px: no horizontal scroll with the add sheet open (e2e) — PASS.
- User copy: no file path, object key or id in any message — PASS (keys appear only in the img URL's item id).

## Decisions recorded (defaults auto-accepted; own recommendations)

1. Depreciation: straight-line to 20 % over 1826 days, flat after (PRD Owner decision 1), labelled "Estimasi".
2. AI recognition: disabled control with "Belum dikonfigurasi" (no server call).
3. Size cap 8 MiB (PRD Owner decision 4; the brief's "e.g. 5 MB" was an example).
4. Types JPEG/PNG/WebP only; **HEIC refused** — browsers other than Safari cannot show it and stripping its
   metadata needs an ISO-BMFF rewriter; `accept="image/jpeg,image/png,image/webp"` makes iOS convert HEIC to
   JPEG before upload.
5. Metadata stripping without a library: a container-level rewrite (no decode/re-encode in the Worker, no
   dependency). Rationale: no vetted Workers-compatible image codec is in the tree; re-encoding 8 MiB in a
   Worker costs CPU and quality. Pixel data is copied unchanged.
6. Serving route is `/barang/[id]/foto` (in `(app)`), not the PRD's `/api/v1/belongings/[id]/photo`:
   CLAUDE.md keeps `/api/v1` for webhooks, share target and integrations; uploads are form actions so they work
   without JavaScript.
7. `Cache-Control: private, no-cache` with an ETag rather than a max-age: a removed member's browser cannot
   reuse a cached photo without passing the access check again.
8. Purchase dates 1950-01-01 … today (WIB); future dates refused in the form (the estimate still handles them).
   Purchase price 0 allowed (a gift). Cap 300 counts live items (tombstones are content-free and not listed).
9. R2 cleanup through a D1 outbox (`file_deletions`) instead of queue-only retry, so no failure point (R2, D1,
   queue, Worker eviction) can lose a key; queue + hourly cron drain it.

## Gaps / not done

- Guest mode (IndexedDB) for belongings and sync of the new table are not built (no sync pull exists yet).
- No orphan scan of R2 by listing prefixes: not needed by construction (the key is recorded in D1 before
  `put` runs, so every object the app writes is either on a row or in the outbox), but objects written by
  hand outside the app would not be found.
- Real R2 (staging) not exercised; local R2 (miniflare) only. No deploy, no remote D1.
- No demo seed rows for belongings.
