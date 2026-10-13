# FN-45 Camera and gallery photo picker: summary

Status: **complete** (2026-10-10, branch `feat/fn-45-camera-gallery`; not merged, not deployed). Risk tier Medium,
one fix cycle used (cycle 1 passed QA and red team), no migration.

- Goal (PRD, owner request 2026-10-10 "add camera and import gallery compatibility"): one shared photo picker with
  "Kamera" (`capture="environment"`) and "Galeri" on phones, "Pilih foto" plus drag-and-drop on mouse-only desktops,
  and clear handling of what phone galleries hand over (HEIC/HEIF, large camera photos, EXIF orientation, multi-pick).
- `src/lib/ui/photos/PhotoPicker.svelte` (new): mode chosen by `matchMedia('(any-pointer: coarse)')` in
  `picker-mode.ts`, never the user agent; unsure shows both actions. Without JavaScript it renders the single plain
  `name="photo"` input as before, so all three server actions and field names are unchanged. Actions sit in a
  `<fieldset>` with a hidden legend; 44 px targets, 360 px first, light/dark/mono via tokens (no hex colours).
- Used in Struk (`src/routes/(app)/riwayat/struk/+page.svelte`), `ReceiptReviewForm.svelte` and `PhotoField.svelte`
  (Barang/Koleksi). Existing previews, server-side byte sniffing, EXIF/GPS stripping and size limits unchanged
  (`src/lib/server/photos/image.ts` has no diff).
- HEIC/HEIF: no decoder library (default owner decision). The browser's own decoder is used where it exists (Safari);
  otherwise an Indonesian how-to-fix message shows before upload. The server keeps refusing HEIC but now names it
  (`PHOTO_HEIF` via `isHeifBytes` in `src/lib/shared/photos.ts`, `server/photos/{messages,upload}.ts`).
- Large photos: the receipt re-encoder moved to shared `src/lib/ui/photos/reencode.ts` (upright, max side 2560,
  JPEG 0.85, metadata dropped); item photos are shrunk only when over 8 MB or 2560 px, smaller ones go unchanged.
- Multi-select gallery pick: the first photo is used and the user is told so.
- Text via `tr()`/`trf()`, 11 English entries in `i18n-en.ts`; icons `camera`, `image`.
- Tests: `photos.test.ts`, `picker-mode.test.ts` (incl. a no-userAgent grep), `PhotoPicker.test.ts` (no-JS server
  render), `barang.test.ts` HEIC row now expects `PHOTO_HEIF` plus GIF and PDF rows; `e2e/photo-picker.spec.ts`
  (attributes, no-JS posts, 360 px layout, `setInputFiles` on both inputs, drop zone).
- QA: PASS (AC 1–19; AC 20 real-device check open). Red team (file input handling only): PASS, 0 medium/high.

## Open, non-blocking

- Red team LOW: `PhotoPicker.svelte:197-212` drop ignores `accept`, so a dropped PDF/GIF is posted and refused by the
  server without an early client message. LOW: `PhotoPicker.svelte:177-180` if `assign()` fails after a multi-file
  drop, N `photo` parts post (server reads the first). INFO: a second drop while `preparing` is not blocked.
- QA: `ReceiptReviewForm.svelte:135` and `BelongingForm.svelte:51` carry `novalidate` (pre-existing), so the picker's
  `required`/`oninvalid` focus handler is inert there; reword PRD AC 15 at the next touch. If Safari decodes a HEIC
  but the canvas fails, the original HEIC is sent and the server refuses it with `PHOTO_HEIF`.
- Not verified: real phones (iOS Safari, Android Chrome camera and gallery). Playwright cannot open a camera.

## Hand-off

The statement/screenshot OCR upload on Impor was not touched. Branch `feat/fn-16g-ocr` builds it and should adopt
`PhotoPicker.svelte` after both merge (or keep its own input if it needs PDFs, which the picker does not accept).
