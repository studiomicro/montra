# FN-45 camera/gallery picker: security report (narrow scope: file input handling)

Verdict: PASS (no medium/high findings; 2 low, 1 info).

Scope: `git diff integrate/2026-10-10..HEAD`, files: PhotoPicker.svelte, picker-mode.ts, photos/reencode.ts,
receipts/reencode.ts, shared/photos.ts, server/photos/{messages,upload}.ts, the three callers (PhotoField,
ReceiptReviewForm, riwayat/struk). Read-only review; no gates or suites run (QA passed).

## Checks

- Server is the only authority: PASS. `readPhotoField` (server/photos/upload.ts:54-67) still checks size
  (`PHOTO_MAX_BYTES`, :59) and `sanitizeImage` (byte sniff, allowlist rewrite, dimension/pixel caps, image.ts
  unchanged). `isHeifBytes` runs only after the sanitiser refused (:64), picks a message, never accepts. Name and
  browser type never read. Limits unchanged (8 MB file, 8 MB+64 KB body, 10 000 px, 50 MP, idle/total timeouts).
  HEIC, GIF, PDF and polyglots that do not parse as JPEG/PNG/WebP are refused regardless of the client.
- EXIF/GPS: PASS. Every stored photo passes `sanitizeImage` (JPEG: only DHT/DQT/DRI/SOS + rewritten JFIF +
  orientation-only APP1; PNG `PNG_KEEP` allowlist; WebP drops EXIF/XMP). That covers files sent unchanged when
  small, the canvas-fail fallback (`reencode.ts` returns original), and a `prepared()` throw (PhotoPicker:162).
  Client re-encode is only an extra layer.
- Status text: PASS. No `{@html}` in any changed file. File name goes through `baseName` and Svelte text
  interpolation (PhotoPicker:155,297); `trf` is a plain replace (i18n.ts:24). Server messages are constants.
- Multi-file posts: PASS. `form.get('photo')` returns only the first entry; later `photo` parts are never read or
  stored (extras bounded by the unchanged body cap). Client keeps one file in one named input (`take`:149-150,
  `name` only on owner input), and the callers set `photo` explicitly for the Struk fetch.
- No new route, loader or action; routes diff is a single svelte file; no space/ID handling touched.
- Object URLs: PASS. None created (`createObjectURL` absent); previews are small JPEG `data:` URLs (CSP-safe).
- DoS: PASS. Server unchanged. Client now decodes item photos too (`createImageBitmap`, reencode.ts:30), but only
  the user's own file on their own device (receipts already did); output canvas capped at 2560 px.

## Findings

1. LOW - PhotoPicker.svelte:197-212 (ondrop): the drop zone ignores `accept`; a dropped PDF/GIF/text file is
   assigned to the form input and (item photos: size check only; Struk: re-encode fails soft) is sent. Server
   refuses with PHOTO_NOT_IMAGE / PHOTO_UNREADABLE, so no security impact, only a wasted upload and a
   server-side error instead of an immediate client message. Optional fix: refuse non-JPEG/PNG/WebP/HEIF by
   sniffed bytes before `take`.
   **Resolution (2026-10-13):** FIXED in `fix(photos): refuse non-photo drops by their bytes, one file per drop, no drop while preparing` (188045f). A drop reads the first file's bytes through the shared `sniffImageType`
   (moved to `src/lib/shared/photos.ts`, the server's own check) and `isHeifBytes`; anything else shows "Foto harus
   berupa JPEG, PNG atau WebP." at once and nothing is assigned. Tests: `src/lib/ui/photos/picker-mode.test.ts` ›
   "dropDecision (FN-45 red team 1 and 3)" and `e2e/photo-picker.spec.ts` › "desktop: a dropped PDF is refused at
   once by its bytes; nothing is put in the input (red team 1)".
2. LOW - PhotoPicker.svelte:177-180: when `assign()` fails after a multi-file drop (`gallery.files = files`
   holding N files), the input keeps all N files and the form posts N `photo` parts. Server uses the first and
   ignores the rest (safe, bounded by body cap). Optional fix: `input.value = ''` and show the error instead.
   **Resolution (2026-10-13):** FIXED in `fix(photos): refuse non-photo drops by their bytes, one file per drop, no drop while preparing` (188045f). Only the first dropped file is put into the input (`assign`); when that fails the
   input is cleared and the message shown, so N parts are never posted. Covered by the e2e drop test of two photos
   (`held` is `['pertama.jpg']`); a browser that refuses the assignment cannot be simulated in Chromium.
3. INFO - PhotoPicker.svelte:197: a second drop while `preparing` is not blocked (the disabled fieldset does not
   stop events on itself); two overlapping `take` calls can interleave status text and `onpick`. Last writer
   wins; submit stays locked by the first unlock only, so a brief window exists where submit re-enables early.
   Server still validates whatever is posted.
   **Resolution (2026-10-13):** FIXED in `fix(photos): refuse non-photo drops by their bytes, one file per drop, no drop while preparing` (188045f). A drop while a photo is still being prepared (or while the previous drop's bytes
   are read) is ignored. Test: `picker-mode.test.ts` › "ignores a second drop while the first is still being
   prepared, and an empty drop".

## Commands

None run (read-only code review; QA gates already green).
