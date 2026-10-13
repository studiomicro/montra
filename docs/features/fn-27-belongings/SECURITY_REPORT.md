# FN-27 Belongings: security report (red team, cycle 1)

Reviewed: `git diff fa58797..4a301e2` (the first user-file storage in R2). Local only: no `--remote`, no
login, no deploy.

## Verdict: FAIL

One medium finding (M1): a crafted image under 8 MiB makes the metadata stripper allocate about 1 GB of
JS heap. A Worker isolate has 128 MB. The other findings are low and are listed so they are tracked.

## Findings

### M1 (medium): a segment-flood image exhausts Worker memory in the hand-written stripper

- **Where:** `src/lib/server/photos/image.ts:132-135` (JPEG RST/TEM markers at top level push a new 2-byte
  `Uint8Array.of(...)` each), `:152-160` (every kept empty segment pushes a subarray), `:221` (PNG kept
  chunk per 12 bytes), `:267-271` (WebP: `b.slice` copy per 8-byte chunk). All parts are held in
  `out[]` until `concat`. Nothing limits the number of segments or chunks.
- **Exploit:** any signed-in user (sign-up is free) posts `/barang?/create` with a 8 MiB "JPEG":
  `FFD8` + SOF0 1x1 + 4 million `FF D0` pairs + SOS + `00 FFD9`. It passes the sniffer and the size cap.
  `sanitizeJpeg` builds about 4 M typed-array objects.
  Measured on Node (same V8), from the bundled `image.ts`:

  | Input | Heap increase | RSS increase | CPU |
  | --- | --- | --- | --- |
  | `jpegRst` | +976 MB | +1102 MB | 1168 ms |
  | `jpegApp0` (empty APP0s) | +298 MB | | 483 ms |
  | `webpFlood` (empty ALPH) | +258 MB | | 616 ms |
  | `pngFlood` (empty gAMA) | +97 MB | | 375 ms |

  Live on `wrangler dev :8839`: `POST /barang 200 OK (1141ms)` and `createdWithPhoto`. The file was
  **accepted and stored**. Local workerd does not enforce the 128 MB isolate limit. In production the
  isolate exceeds its memory limit and is reset. That fails every concurrent request on that isolate,
  including other users' requests. Repeating the upload is a cheap, authenticated DoS. The flood file is
  also stored in R2 and served to the space.
- **Fix:**
  1. Count the parts in each walker and refuse with `Malformed` past a small bound (for example 4096 JPEG
     segments or RST markers outside a scan, 4096 PNG chunks, 1024 WebP chunks).
  2. Refuse RSTn and TEM markers outside entropy-coded data. They are only valid inside a scan.
  3. Better still, write the output into one preallocated `Uint8Array(input.length + 64)` with an offset,
     instead of collecting thousands of views.
  4. Add a regression test with each flood file that checks the result is `refused malformed` and the run
     stays well under the 128 MB isolate limit. Probe script:
     `<scratchpad>`.

### L1 (low): the dimension (decompression-bomb) check can be bypassed with a second SOF

- **Where:** `image.ts:142-147`. Every SOFn overwrites `width`/`height`, so the **last** frame header wins.
  Browsers use the **first** one.
- **Exploit:** `FFD8`, SOF0 65000x65000, SOS, data, then SOF0 1x1, SOS, `FFD9`. The upload is accepted as
  1x1 (probe `jpegDoubleSof → ok 1x1`). A space co-member's browser reads a 4.2-gigapixel header when it
  shows the thumbnail. Browsers have their own decode caps, so the impact is a degraded or crashed tab for
  other members of the same space.
  WebP is similar: a VP8X canvas inside the limit can carry a larger VP8 or VP8L bitstream. Only VP8X is
  measured (`image.ts:251-265`).
- **Fix:** refuse a second SOF (`Malformed`). For WebP, read the bitstream size too and require it to fit
  inside the canvas.

### L2 (low): some metadata carriers survive stripping

- **Where:**
  - `image.ts:152`: APP2 is kept whatever its payload. That includes `MPF\0` (multi-picture data) and
    FlashPix `FPXR`, not only `ICC_PROFILE`.
  - APP0 is kept, so a JFXX thumbnail of a cropped photo can show the uncropped picture.
  - Unknown markers `0xF0–0xFD` are kept.
  - PNG `iCCP` keeps its free-text profile name.
  - WebP `ANMF` frames are copied whole, so unknown sub-chunks inside them survive.
- **Exploit or failure:** probe `jpegApp2Mpf`: text in an APP2 `MPF` segment and in an `FFF0` segment is
  present in the stored file ("METADATA SURVIVES"). Real phones put MPF in APP2 (no GPS). GPS and XMP are in
  APP1, which is correctly dropped. So the realistic leak is small: device-model strings in ICC
  `desc`/`dmdd`, and JFXX thumbnails.
- **Fix:**
  - Keep APP2 only when the payload starts with `ICC_PROFILE\0`.
  - Keep APP0 only when it starts with `JFIF\0`, and rewrite it with a 0x0 thumbnail.
  - Drop `0xF0–0xFD`.
  - Optionally blank the iCCP profile name.

### L3 (low): honest-size concurrency headroom

- **Where:** `src/lib/server/forms.ts:18-48` and `src/lib/server/photos/upload.ts:357`.
- **Failure:** one 8 MiB upload holds about 5 copies at once: the stream chunks, the joined body,
  `formData()`, `arrayBuffer()` and the sanitised output. That is roughly 40 MB. Three concurrent uploads on
  one isolate get close to 128 MB.
- **Fix:** drop references early. For example, parse multipart from the joined body only once, null
  `chunks` after joining, and stop keeping both the `File` and its bytes. Consider rate-limiting photo
  uploads per user.

### L4 (low): loaders log whole error objects

- **Where:** `src/routes/(app)/barang/+page.server.ts:90` and `src/routes/(app)/kekayaan/+page.server.ts:128`
  call `console.error(..., e)`.
- **Failure:** Drizzle and D1 errors include the query and its bound parameters (here only the space id).
  This is against the red-team FN-18 L2 rule: log `errorLabel(e)` only.
- **Fix:** use `errorLabel(e)`.

## Verified OK (with evidence)

- **Byte sniffing:**
  - Type is decided only by magic bytes. SVG, GIF, HEIC and PDF are refused (unit tests pass).
  - The client file name and `type` are never read. In the live test, `type: text/html` on a valid JPEG was
    stored and served as `image/jpeg`.
  - Trailing bytes after EOI or IEND, and after the RIFF size, are cut, so GIFAR or ZIP-style polyglots
    lose their payload.
  - The output type always equals the sniffed type, and the DB CHECK limits `photo_type` to the three types.
- **Truncated or corrupt files:** these end as `Malformed` or `RangeError`, which become `refused`. No
  unhandled throw path was found (`ascii` beyond the end gives a short string, which the regex then refuses).
- **Body caps:**
  - Access is checked before the body is read.
  - A `Content-Length` above 8 MiB + 64 KiB gets 413 without reading the body.
  - A chunked 9 MiB body with no `Content-Length` is cut by `readCapped`: live result `400 Invalid form`.
  - The per-file cap is `PHOTO_MAX_BYTES`.
- **CSRF:** a cross-origin `POST /barang?/create` was refused with 403 (live, SvelteKit `checkOrigin`).
- **Serving route** (live, `/barang/<id>/foto`):
  - The owner gets 200 with `content-type: image/jpeg`, `nosniff`, `inline`, `private, no-cache`,
    `CSP default-src 'none'; sandbox; frame-ancestors 'none'` and `CORP same-origin`.
  - The ETag is the first 32 hex characters of SHA-256 of the random key. It reveals nothing and changes
    when the photo is replaced. The 304 is only sent after the access check.
  - Another user and an unknown id get the same `404 {"status":404,"message":"Not found"}`. A signed-out
    request gets 303 to sign-in.
  - Removed member: `isLiveMember` is checked in the same statement as the read (integration test
    "a member sees the photo; a stranger and a removed member…" passes).
  - The page data has no `photo_key` (live `__data.json` check). There is no public R2 URL.
- **IDOR:** user B archiving user A's item gets `404 Barang tidak ditemukan.` (live). Every write is scoped to
  the session's space, and the id is only matched inside that space through the `writable` guard (with
  `isLiveMember` and `updated_at`).
- **R2 keys:** `spaces/<spaceId>/belongings/<randomUUID>` is built server-side only. No user input goes into
  a key, so there is no traversal. The sweep and `deleteFiles` only receive keys from `file_deletions` or
  from `RETURNING`, never from a form, so another space's objects cannot be deleted with a forged key.
- **Lifecycle:**
  - The upload key is reserved before the put. `keepKey` runs in the same batch as the row write, and only
    when the row holds the key.
  - Replace, remove, archive and a stale or refused update all release keys to the outbox. Tombstones are
    content-free (CHECK constraint).
  - `purgeSpaces` releases photo keys before it deletes the space. Account deletion runs `sweepSoon`, and
    the jobs Worker has a `FILES` binding, a `file_sweep` queue job and an hourly cron sweep.
  - Batches are bounded at 100, and R2 deletes are idempotent.
  - Only `purgeSpaces` deletes spaces, so the FK cascade orphans no R2 objects.
- **Cap:** 300 items, enforced in one guarded `INSERT … SELECT` (integration test "20 concurrent creates at
  290 stop at exactly 300" passes).
- **Depreciation:** BigInt in whole units, the loss rounded down, the floor at 20 %, and a future purchase
  date counts as age 0. Totals are BigInt and become null past `MAX_SAFE_INTEGER`
  (`src/lib/shared/belongings.test.ts` and `totals.test.ts` pass).
- **No `{@html}`** in the new UI. No secrets in loaders.
- **ENGINEERING_CHECKLIST:** the only gaps are the logging rule (L4) and bounded work inside the image
  walker (M1).

## Commands run

- `npm ci` → exit 0. `npx svelte-kit sync` → 0. `npm run db:reset:local` → 0. `npm run build` → 0.
- `npx vitest run --maxWorkers=2 src/lib/server/photos src/lib/server/belongings src/lib/shared/belongings.test.ts test/integration/barang.test.ts workers/jobs/src/queue.test.ts`
  → `Test Files 6 passed (6) / Tests 76 passed (76)`.
- `node --expose-gc probe.mjs <case>` (bundled `image.ts`):
  - `jpegDoubleSof ok 1x1`
  - `jpegApp2Mpf METADATA SURVIVES`
  - `jpegRst ok … heapΔMB=976 ms=1168`
  - `jpegApp0 heapΔMB=298`
  - `pngFlood heapΔMB=97`
  - `webpFlood heapΔMB=258`
- `wrangler dev --local --port 8839`, using `node live.mjs basic|flood`:
  - create 200; own photo 200; other 404; unknown 404; anon 303
  - cross-space archive 404; CSRF 403; chunked 9 MiB 400
  - flood create 200 in 1141 ms
  - The server was stopped afterwards.
- Full Playwright was not run (the machine is loaded, as instructed).

## Cycle 2–3 re-check (head b26cb7c, rebased on c401a94)

**Overall: PASS.** No medium or high findings remain. The new findings below are all low and are tracked.

Scope: `src/lib/server/photos/` (all of it), the upload actions in `src/routes/(app)/barang/+page.server.ts`,
`src/lib/server/forms.ts` (`readInto`) and the loader logging. Probes:
`scratchpad/probe2.mjs`, run on the bundled `image.ts`, and a live run on `wrangler dev :8839`.

### Earlier findings

| Id | Status | Evidence |
| --- | --- | --- |
| M1 segment-flood memory | **FIXED** | One preallocated `Writer` (input + 64 bytes); at most 4096 markers or chunks (64 for WebP); RST/TEM/SOI outside a scan refused. Re-run on Node: `jpegRst`, `jpegApp0`, `pngFlood` and `webpFlood` are all `refused malformed` in 0–1 ms with heap Δ 0–1 MB (was 976 MB / 1168 ms). Fill-byte and 8 MiB in-scan RST files take ≤13 ms, heap Δ 0. Live: flood upload `POST /barang 400` "Foto tidak bisa dibaca" in 88 ms (was 200 and stored). |
| L1 second SOF / canvas bypass | **FIXED** | Big SOF then small: `refused dimensions` (checked at the first header). Small then big: `refused malformed` (second SOF). WebP canvas ≠ bitstream: `refused malformed`. Animation: refused. PNG second IHDR: refused. |
| L2 metadata survival | **FIXED** | APP2 MPF, `FFF0`, COM and JFXX: stripped. JFIF with thumbnail: rewritten to 16 bytes, thumbnail gone. EXIF with a GPS IFD pointer: only the rebuilt Orientation APP1 is kept. PNG tEXt, iCCP, eXIf and a wrong-size gAMA: stripped. WebP EXIF and XMP: stripped, flags cleared (output flags `0x20`, ICC only). |
| L3 upload copies | **FIXED (mitigated)** | `readInto` fills one buffer of the declared length, and `readPhotoField` deletes the file from the form after reading it. See N4 for a side effect. |
| L4 whole-error logging | **FIXED** | `barang:91` and `kekayaan:144,173,183,192` now log `errorLabel(e)`. |

### Attack checks requested by the controller

- **ICC as a carrier.** The JPEG APP2 and WebP ICCP checks cover only the wrapper: signature, sequence 1…n
  with the same count, and ≤64 KiB. The profile body is never parsed. A 1-segment "profile" holding
  `desc:SECRET…<html><script>` is kept byte for byte (probe `ICC arbitrary text → KEPT`, also for WebP).
  - This does not make the serving route an XSS vector: it serves the sniffed `image/*` type with
    `nosniff`, `CSP default-src 'none'; sandbox` and CORP same-origin. The uploader can hide bytes in the
    entropy data anyway.
  - It is not a meaningful privacy leak either. Real device profiles (sRGB IEC61966-2.1, Display P3) carry
    a vendor `desc`/`cprt` and header manufacturer/model fields that name the profile vendor, not the user,
    the unit or the location.
  - **Stripping `desc`/`cprt` is not worth it**: rewriting the tag table risks breaking colour (R16) for no
    real privacy gain. See N1 for a cheap structural check instead.
- **Malformed ICC sequence numbers.** Wrong sequence numbers, duplicate sequence numbers and a count of 0
  all drop the profile whole, and the image is still accepted. More than 8 segments are dropped as well.
- **RIFF size lies.** A size longer than the file is refused. A size shorter than the chunks is refused
  (`riff short by 1`). A size shorter than the file cuts the trailer; the output RIFF size is patched and
  equals the length − 8 (`riffsize ok true`). Odd chunks are padded and the output length is even.
- **Trailer truncation (R15).** For JPEG, PNG and WebP, the bytes after EOI, IEND or the RIFF end (`PK…<html>`)
  are cut and never parsed. Each output starts with its own signature (FFD8, PNG signature, RIFF/WEBP) and
  ends on a complete EOI, IEND or chunk. No path changes the type, and `photo_type` comes from the sniff.
- **Rewritten APP1.** The bytes are
  `ffe1 0022 457869660000 4d4d002a00000008 0001 0112 0003 00000001 0006 0000 00000000`. The length 34 is
  correct, the TIFF header and IFD0 are well formed, it holds one SHORT Orientation entry and no next IFD.
  Well-formed.

### New findings (all low)

- **N1 (low): the ICC body is not checked structurally.**
  - Where: `image.ts:159-169` (JPEG) and `image.ts:374-381` (WebP ICCP).
  - Problem: an arbitrary ≤64 KiB blob is kept as a "profile". The impact is limited, as explained above.
  - Fix (optional): require `acsp` at offset 36, and a profile-size field (bytes 0–3) equal to the joined
    length, so only real profiles pass. Do not rewrite tags.
- **N2 (low/info): repeated JFIF segments are all written.**
  - Where: `image.ts:227-230` (`!wroteHeader` is checked, but nothing marks that a JFIF was already written).
  - Problem: three APP0 JFIF segments give three rewritten APP0s. Twenty tiny ones overflow the +64 slack and
    are refused as malformed. This is not exploitable.
  - Fix: write the JFIF once.
- **N3 (low/info): VP8X larger than 10 bytes is copied whole.**
  - Where: `image.ts:365-373`.
  - Problem: attacker bytes after the 10-byte VP8X payload are kept (`fat VP8X → KEPT`). libwebp rejects such
    a file, so it cannot be shown. No camera writes this.
  - Fix: require `size === 10`.
- **N4 (low): the declared Content-Length is preallocated.**
  - Where: `forms.ts` (`readInto`, from `new Uint8Array(declared)`).
  - Problem: a signed-in client can declare 8.06 MiB, send almost nothing and hold that allocation for up
    to `PHOTO_FORM_TIMEOUT_MS` (120 s) per connection. Before, memory only grew with the bytes actually
    received. A few such connections on one isolate take a large share of its 128 MB.
  - Fix: grow a buffer as bytes arrive (doubling, capped at `max`), or only preallocate for small `max`.
    Optionally rate-limit photo uploads per user.

### Commands (re-check)

- `git switch --detach b26cb7c`; `npm ci` → 0; `npx svelte-kit sync` → 0; `npm run db:reset:local` → 0;
  `npm run build` → 0.
- `npx vitest run --maxWorkers=2 src/lib/server/photos src/lib/server/belongings src/lib/shared/belongings.test.ts test/integration/barang.test.ts workers/jobs/src/queue.test.ts`
  → `Test Files 6 passed (6) / Tests 97 passed (97)`.
- `node --expose-gc probe2.mjs` → the results quoted above.
- `wrangler dev --local --port 8839` with `live.mjs basic|flood`:
  - create 200; own photo 200 with the same headers as before; other user 404 with the same body; unknown
    404; anon 303
  - cross-space archive 404; CSRF 403; chunked 9 MiB 400
  - flood 400 in 88 ms
  - The server was stopped afterwards.
  - One `POST /daftar` returned 500 on wrangler dev ("Network connection lost") and the retry succeeded. It
    happened in both cycles, outside this diff, and was not investigated.
- Playwright was not run (the machine is loaded).
