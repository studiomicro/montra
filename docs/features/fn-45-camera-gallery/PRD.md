# FN-45 — Camera and gallery photo picker

Status: proposed. Risk tier: **Medium**. No migration, no new table or column, no new space-scoped query, no
provider or credential. One new shared component, a small shared detection module, and changes at three call
sites. Those call sites are FN-15 Struk and FN-27/FN-28 item photos. Both upload paths already pass through the
FN-27 server sanitiser, so this feature is breadth, not depth.

Owner request (2026-10-10): "add camera and import gallery compatibility." The owner asked for proceed-automatically.
The **Owner decisions** below are accepted with their proposed defaults.

## Goal

Every photo in Montra today is picked through one bare `<input type="file" accept="image/jpeg,image/png,image/webp">`.
On a phone, the user gets the OS's own chooser. On some Android builds that chooser opens the gallery straight
away and hides the camera. On iOS it shows a three-way menu. A user who stands at a till with a receipt, or who
photographs a new item, should reach the camera in one tap. A user who picks an older photo should reach the
gallery in one tap. Some gallery photos will not work: Android galleries keep HEIC/HEIF files that iOS would have
converted, and camera photos can be 48 MP and over the 8 MB cap. In those cases the user should get a clear
Indonesian message that says how to fix it, or a photo that has been made to fit. Today they get a vague refusal
after the upload. This serves the "record a receipt" and "keep a photo of what you own" steps of the main
journey without changing what the server accepts or stores.

## Current behaviour (cite before changing)

- **Accepted types and cap.** `src/lib/shared/photos.ts:5-10`: `PHOTO_TYPES` jpeg/png/webp, `PHOTO_MAX_BYTES`
  8 MiB, `PHOTO_ACCEPT` is those three types joined. Because `image/heic` is not listed, iOS Safari transcodes a
  HEIC library photo to JPEG before handing it over. Android does not: depending on the gallery app, a HEIC file is
  either hidden by the MIME filter or returned as-is. Desktop drag-and-drop ignores `accept` entirely.
- **Struk (FN-15).** `src/routes/(app)/riwayat/struk/+page.svelte:268-275`: one input, `name="photo"`, label
  "Pilih atau ambil foto struk", hint at `:276-280`, preview `<img>` at `:282-284`, "Menyiapkan foto…" status at
  `:285-287`. `onpick` (`:69-83`) passes the first file to `reencodeReceiptPhoto`. With JavaScript, the read
  (`:108-129`) posts the held, re-encoded `File`, not the input. Without JavaScript the form posts the input as-is
  (`:131-135`). "Lampirkan fotonya saja" hands the held photo to `/riwayat/baru` (`src/lib/ui/receipts/held-photo.ts`,
  `src/routes/(app)/riwayat/baru/+page.svelte:36-38, 98-105`).
- **Receipt client downscale and EXIF already exist.** `src/lib/ui/receipts/reencode.ts:13-48`: `createImageBitmap(file,
  { imageOrientation: 'from-image' })` (`:19`) bakes the EXIF orientation in. It draws the photo on a canvas whose
  longest side is at most `RECEIPT_MAX_SIDE` = 2576 px (`src/lib/shared/receipts.ts:18`). It re-encodes to JPEG at
  0.85 (`:20`), which drops every metadata block, location included. It also makes a 480 px `data:` preview
  (`reencode.ts:4, 42`). If the browser cannot decode the file (for example HEIC on Chrome), it returns the original
  file and no preview (`:16, :20-22`). The server then refuses it. Safari can decode HEIC, so Struk on iPhone already
  converts a HEIC photo that reaches it.
- **Receipt review form (no-JS save).** `src/lib/ui/receipts/ReceiptReviewForm.svelte:378-384`: the input is
  rendered only when `!heldPhoto`, which in practice means the no-JS path. It has `name="photo"`, is `required`,
  and its label is "Foto struk (pilih lagi untuk menyimpan)".
- **Item photos (FN-27 Barang, FN-28 Koleksi).** `src/lib/ui/photos/PhotoField.svelte:36-57`: one input with
  `name="photo"`, label "Foto (opsional)" or "Ganti foto", hint at `:47-49`, and a "Hapus foto" checkbox
  (`name="removePhoto"`). The only client check is the 8 MB size check (`:25-33`). There is **no client downscale,
  no preview and no client EXIF handling**. The file goes up as picked inside a `use:enhance` form
  (`src/lib/ui/belongings/BelongingForm.svelte:49`; `CollectibleForm.svelte:100` uses the same field). A 48 MP
  camera JPEG over 8 MB is therefore refused on the device and cannot be used at all.
- **Server sniffing and stripping (unchanged by this feature).** `src/lib/server/photos/upload.ts:48-58`
  (`readPhotoField`) refuses a file over 8 MiB, then calls `sanitizeImage` (`src/lib/server/photos/image.ts:441-458`).
  That function sniffs the magic bytes (`:91-99`, JPEG/PNG/WebP only; HEIC, SVG, GIF and PDF are refused, tested at
  `image.test.ts:23-29` and `test/integration/barang.test.ts:320`). It rebuilds the container by allow-list,
  dropping EXIF GPS, XMP and IPTC. For JPEG it **keeps the EXIF Orientation tag** in a new minimal APP1
  (`image.ts:202-209, 258`), so stored item photos still display upright. It also enforces 10 000 px per side and
  50 MP (`:4-6, :86`). Receipts add a 5 MiB / 8000 px provider bound (`src/lib/server/receipts/image.ts:18-22,
  41-53`). Refusal messages: `src/lib/server/photos/messages.ts:4-9`. A HEIC file gets
  "Foto harus berupa JPEG, PNG atau WebP.", which does not tell the user how to fix it.
- **Existing drop-zone pattern.** `src/routes/(app)/impor/+page.svelte:83-91, 485-515`. A `<label>` wraps a
  visually hidden input that keeps its own `aria-label`. `ondragover` and `ondrop` assign `fileInput.files = files`
  so the form posts the dropped file as if it had been picked. FN-45 reuses this pattern; it does not invent a new one.
- **Existing e2e selectors.** `e2e/struk.spec.ts:26-31` (`getByLabel('Pilih atau ambil foto struk')`),
  `e2e/barang.spec.ts:63, 234, 242` and `e2e/koleksi.spec.ts:64, 249, 258` (`getByLabel('Foto (opsional)')`).
  Fixtures come from `e2e/photos.ts` (a real browser JPEG with EXIF GPS spliced in).

## Scope

### Part 1 — `PhotoPicker` component

New `src/lib/ui/photos/PhotoPicker.svelte` (Svelte 5 runes), the one file-picking control for photos.

- **Server render and no JavaScript.** It renders exactly one visible native
  `<input type="file" name={name} accept={PHOTO_ACCEPT}>`. That input has no `capture` attribute, no `multiple`,
  the caller's `id`, label, `aria-describedby` and `required`, and the same look as today. Without JavaScript the
  form posts exactly as it does now: same field name, same action, same server code.
- **After hydration (progressive enhancement), mode is chosen on the client:**
  - **Phone mode.** Two side-by-side actions of equal width: **"Kamera"** (camera icon) and **"Galeri"**
    (image icon). "Kamera" opens an input with `capture="environment"`. "Galeri" opens the original input, which has
    no `capture`. Both inputs use the same `accept`.
  - **Desktop mode.** One action, **"Pilih foto"**, plus a drop zone with the text "atau tarik foto ke sini".
    The drop zone reuses the Impor drop pattern.
  - **Detection rule.** No user-agent sniffing. Use phone mode when `matchMedia('(any-pointer: coarse)')` matches.
    Use desktop mode only when `matchMedia` exists, `(any-pointer: coarse)` does not match and
    `(pointer: fine)` matches. In every other case, including when `matchMedia` is missing or throws, show both
    actions ("when unsure, show both"). `navigator.mediaDevices` is **not** used to decide: desktop browsers ignore
    `capture`, and a webcam does not make a phone. The rule is a pure function in a new
    `src/lib/ui/photos/picker-mode.ts`, which takes a `matchMedia`-like argument so it can be unit-tested.
- **One field name at submit.** Exactly one input carries `name={name}` when the form is submitted. The rule: the
  input that received the most recent pick holds the name. The other input loses the name and has its value cleared.
  A dropped file is assigned to the gallery input (`input.files = dataTransfer.files`, as Impor does).
  If that assignment is not supported, the drop is refused with a message. It must never be silently lost.
  This keeps `readPhotoField(form, 'photo')` (`upload.ts:49`) reading the right file. That matters most for the
  `use:enhance` item forms, which build their `FormData` from the form element.
- **Accessibility.** Each action is a real focusable control: either the native input inside a styled `<label>`
  (the Impor pattern, with focus shown through `:focus-within`) or a `<button>` that calls `input.click()`. The
  engineer picks one. Requirements:
  - Each control has its own accessible name: "Ambil foto dengan kamera", "Pilih foto dari galeri", or
    "Pilih foto" on desktop.
  - The two actions sit in a `role="group"` labelled by the field's visible label.
  - Each target is at least 44 × 44 px (`docs/ENGINEERING_CHECKLIST.md` › Accessibility).
  - Enter and Space open the picker.
  - The visible focus ring meets AA in light, dark and mono.
  - Once a file has been picked, a polite `role="status"` line names it, for example "Foto dipilih: IMG_2026.jpg".
    This replaces the native "no file chosen" text, which the styled control hides.
  - Errors use `aria-invalid` and `aria-describedby`, which already exist in `PhotoField.svelte:44-45`.
  - When the browser's required-field check fires, focus goes to the first picker action.
- **Layout.** Phone first at 360 px: two actions in one row, each at least 44 px tall, no horizontal scroll. The
  drop zone is used in desktop mode only. Colours, radii and type come from tokens (`docs/design/DESIGN_SYSTEM.md`).
  Reuse the visual style of `Button` `secondary`. Never hard-code a hex value. Works in light, dark and mono.
  New icons `camera` and `image` go into `src/lib/ui/icons.ts`. Draw them in the same stroke style as the existing
  set; never copy them from a brand icon pack.
- **Props (shape, not code).**
  - `id`, `name` (default `photo`), `label`, `describedby` (the caller's hint id), `required`, `invalid`.
  - `onpick(file: File)`: called with the one prepared file after the gallery-compatibility steps in Part 3.
    Callers that need the original file (Struk's re-encode) use this.
  - An optional `prepare` flag: `'none'` (the default; Struk does its own re-encode) or `'downscale'` (item photos).
  - A bindable `clear()` or equivalent, so a caller can reset both inputs.

### Part 2 — Use it at the three call sites (behaviour preserved)

1. **Struk** (`src/routes/(app)/riwayat/struk/+page.svelte:266-281`). Replace the input with
   `<PhotoPicker id="{uid}-photo" name="photo" label="Pilih atau ambil foto struk" …>`.
   - `onpick` feeds the existing `reencodeReceiptPhoto` flow (`:69-83`) unchanged. "One photo per receipt: a
     second pick replaces the first" still holds.
   - Unchanged: preview, "Menyiapkan foto…", upload progress, read ticket, "Lampirkan fotonya saja" hand-off and
     the 2576 px re-encode.
2. **Receipt review form** (`src/lib/ui/receipts/ReceiptReviewForm.svelte:378-384`). Replace the `!heldPhoto`
   input with `PhotoPicker`. Keep `required` and the label "Foto struk (pilih lagi untuk menyimpan)".
   - This path is mostly server-rendered without JavaScript, so it is the plain input there.
3. **Item photos** (`src/lib/ui/photos/PhotoField.svelte:36-50`). `PhotoField` keeps its own label text ("Foto
   (opsional)" / "Ganti foto"), its hint, its server error and its "Hapus foto" checkbox, and renders `PhotoPicker`
   with `prepare="downscale"` (Part 3). Its 8 MB check (`:25-33`) moves after preparation, so it applies to the
   file that is actually sent. `BelongingForm` and `CollectibleForm` are unchanged apart from what `PhotoField`
   does inside.

Existing labels stay on the gallery or default input. `getByLabel('Foto (opsional)')` and
`getByLabel('Pilih atau ambil foto struk')` must each still resolve to exactly one element, the named gallery
input, so existing e2e selectors keep working. If that is impossible, update the selectors in the same change and
say so in the handoff.

### Part 3 — Gallery compatibility (client-side, before any upload)

Order inside `PhotoPicker` for every pick or drop:

1. **Several files.** A drop can carry several files, as can an OS picker that ignores the missing `multiple`.
   Use `files[0]` and show a status line: "{n} foto dipilih — hanya foto pertama yang dipakai." The inputs never
   set `multiple`.
2. **HEIC/HEIF detection.** A new shared pure function, `isHeifBytes(bytes)`, goes into
   `src/lib/shared/photos.ts` so the client and the server share it. It checks the first 32 bytes for an ISO-BMFF
   `ftyp` box whose major or compatible brand is in the HEIF family (`heic`, `heix`, `hevc`, `hevx`, `heim`, `heis`,
   `hevm`, `hevs`, `mif1`, `msf1`). It reads the bytes from `file.slice(0, 32)` and never trusts the name or the
   browser-given type.
3. **When HEIF is detected,** try the browser's own decoder:
   `createImageBitmap(file, { imageOrientation: 'from-image' })`.
   - **It decodes** (Safari does): re-encode to JPEG through the same canvas path as `reencode.ts`. That gives
     orientation baked in, metadata dropped, the longest side capped as in step 5, and the result named
     `foto.jpg`. The user sees nothing different.
   - **It fails** (Chrome on Android and desktop): clear the input, upload nothing, and show the fix message
     (Owner decision 1):
     "Foto HEIC/HEIF belum bisa dipakai. Ambil foto lewat tombol Kamera, atau ubah format kamera ke JPEG
     (Android: Kamera › Setelan › Format gambar; iPhone: Pengaturan › Kamera › Format › Paling Kompatibel), lalu
     pilih lagi."
   - No HEIC decoder library is added (Owner decision 1).
4. **Struk (`prepare='none'`).** Hand the file to `onpick`. The existing `reencodeReceiptPhoto` already
   downscales to 2576 px, bakes orientation and strips metadata. HEIF that Safari decoded in step 3 arrives as JPEG.
5. **Item photos (`prepare='downscale'`, Owner decision 3).** Re-encode when the file is over `PHOTO_MAX_BYTES`
   or its longest side is over the new `PHOTO_UPLOAD_MAX_SIDE` = 2560 px. The re-encode uses the same decode, bake
   orientation, cap the side and output JPEG 0.85 path as `reencode.ts`. Extract a shared
   `src/lib/ui/photos/reencode.ts` with `{ maxSide, quality, previewSide? }`, and turn
   `src/lib/ui/receipts/reencode.ts` into a thin wrapper whose output is byte-for-byte the same as today.
   - The prepared file replaces the gallery input's `files` and holds the field name. If assigning `files` is not
     supported, keep the original file and let the existing 8 MB check decide.
   - A photo at or under both limits is sent **unchanged**. That keeps PNG and WebP transparency and quality, and
     the server keeps its orientation tag (`image.ts:258`). This means there is no double rotation.
   - If decoding fails for a non-HEIF file (for example a giant image that runs out of memory on iOS), send the
     original. The 8 MB check and the server stay the backstop.
6. **EXIF orientation.**
   - Every re-encoded output uses `imageOrientation: 'from-image'` and carries no EXIF, so it displays upright
     everywhere.
   - An item photo sent unchanged keeps its Orientation tag through the server sanitiser, as it does today.
   - No manual rotate UI.
7. While steps 3 and 5 run, show "Menyiapkan foto…" (the existing string) and disable the form's submit control.
   This mirrors Struk's `preparing` state (`+page.svelte:74-82`).

**Server message for HEIC (Owner decision 2).** Without JavaScript, or when a HEIC file reaches the server by
another route, the refusal must give the same fix:
- `readPhotoField` (`upload.ts:48-58`) answers a new `PHOTO_HEIF` message when `sanitizeImage` refuses with
  `reason: 'type'` and `isHeifBytes` matches.
- Wording: "Foto HEIC/HEIF belum bisa dipakai. Ubah format kamera ke JPEG (Android: Kamera › Setelan › Format
  gambar; iPhone: Pengaturan › Kamera › Format › Paling Kompatibel), lalu pilih lagi."
- What the server accepts does **not** change. `sniffImageType` and `sanitizeImage` in `image.ts` are untouched.
  HEIC is still refused, only with a better message.
- `test/integration/barang.test.ts:320` changes its expected message for the HEIC row from `PHOTO_NOT_IMAGE` to
  `PHOTO_HEIF`. Every other row is unchanged.

### Part 4 — Strings

Every new Indonesian phrase goes through `tr()`/`trf()` (`src/lib/shared/i18n.ts`) with an English entry in
`src/lib/shared/i18n-en.ts`. Server messages use `msg()`. New phrases:
- "Kamera", "Galeri", "Pilih foto", "Ambil foto dengan kamera", "Pilih foto dari galeri"
- "atau tarik foto ke sini"
- `trf` "Foto dipilih: {name}"
- `trf` "{n} foto dipilih — hanya foto pertama yang dipakai."
- the HEIF fix message (client and server forms)
- "Foto yang ditarik tidak bisa dipakai di peramban ini. Pilih lewat tombol."

## Out of scope

- **Impor statement or screenshot OCR upload.** Branch `feat/fn-16g-ocr` builds it, and after FN-45 merges it adopts
  `PhotoPicker`. **Hand-off:** FN-45 keeps the component generic: `name`, `accept` (default `PHOTO_ACCEPT`),
  `prepare` and `onpick` are props, and no Struk- or item-specific text lives inside it. The existing Impor CSV and
  statement inputs (`impor/+page.svelte:506-515, 704-717`) are not touched.
- A live in-page camera viewfinder (`getUserMedia`). `capture` hands the photo to the OS camera app, so no camera
  permission prompt and no CSP change are needed.
- A client-side HEIC/HEIF decoder library or WASM (Owner decision 1).
- Several photos per receipt or per item. Cropping, rotating or editing UI.
- Any change to what the server accepts, the 8 MiB, 10 000 px, 5 MiB or 8000 px limits, R2 storage, the sanitiser
  in `image.ts`, form actions, field names or loaders.
- A preview for item photos (`PhotoField` has none today; not requested).
- "Kenali dari foto (AI)" (`AiUnavailable`, still unconfigured).

## Acceptance criteria

Verification levels follow `docs/ACCEPTANCE.md`: **Automated** (Vitest), **Browser** (Playwright on local
`wrangler dev`) and **Pass** (real device, owner-run). Real iOS Safari and Android Chrome camera and gallery
behaviour **cannot be verified here**. Playwright cannot open a real camera.

1. **No-JS markup (Automated, SSR render test).** Given `PhotoPicker` rendered with `svelte/server`, then the markup
   has exactly one `<input type="file">`. That input has `name="photo"`, `accept="image/jpeg,image/png,image/webp"`,
   no `capture`, no `multiple`, the caller's `id`, label and `aria-describedby`, and `required` when the prop is set.
2. **No-JS post (Browser, `javaScriptEnabled: false`).**
   - On `/barang`, one visible file input posts a JPEG and the item is saved with a photo. That photo is served
     with the GPS data gone (as in `barang.spec.ts` today).
   - On `/riwayat/struk`, the picker posts to `?/read` with the field `photo`.
   - On each page, a refusal (non-image bytes) shows its message without JavaScript.
3. **Phone mode (Browser, 360 × 800 context with `hasTouch: true` and `isMobile: true`).**
   - On `/riwayat/struk`, "Kamera" and "Galeri" are both visible, each at least 44 × 44 px.
   - The camera input has `capture="environment"`. The gallery input has no `capture`. Both have the same `accept`.
   - There is no horizontal scroll (`expectNoHorizontalScroll`). The same holds in `PhotoField` on `/barang` and
     `/koleksi`.
4. **Both inputs work (Browser).**
   - On `/riwayat/struk`, `setInputFiles` on the camera input shows the "Pratinjau foto struk" preview. Doing it
     again on the gallery input replaces that preview.
   - On `/barang`, a photo set through the camera input saves with the item. The server receives exactly one
     non-empty `photo`, checked by the saved photo existing.
   - Setting the gallery input after the camera input saves the gallery photo.
5. **Desktop mode (Browser, default desktop context, `any-pointer: fine` only).**
   - Only "Pilih foto" and the drop zone are shown. No `capture` input is in the DOM.
   - Dropping a JPEG (a synthetic `drop` event with a `DataTransfer`) shows the "Foto dipilih: …" status and
     the Struk preview.
6. **Detection (Automated).**
   - `picker-mode.ts` with a fake `matchMedia` returns phone when `any-pointer: coarse` matches, and desktop for
     fine-only.
   - It returns both actions when `matchMedia` is missing, throws, or nothing matches.
   - A grep test confirms `picker-mode.ts` and `PhotoPicker.svelte` never read `navigator.userAgent`.
7. **Several files (Browser and Automated).** Given a drop of 2 JPEGs, then only the first is used, and the status
   says "2 foto dipilih — hanya foto pertama yang dipakai." The `firstFile` helper is unit-tested for 0, 1 and 3
   files.
8. **HEIC detection (Automated).**
   - `isHeifBytes` is true for `ftypheic`, `ftypheix`, `ftypmif1` and `ftypmsf1` headers, and true for a
     compatible-brand-only match.
   - It is false for JPEG, PNG, WebP, `ftypisom` (MP4), `ftypavif` alone, and input shorter than 12 bytes.
9. **HEIC on a browser that cannot decode it (Browser, Chromium).** Given a HEIC-header file set on the gallery
   input of `/riwayat/struk` and of `/barang`, then the client fix message is shown with `role="alert"`, the input
   is cleared, and **no request** is sent to `?/read` or `?/create`. The test checks that with a request listener.
10. **HEIC reaching the server (Automated integration).** Given a HEIC body posted to the Barang create action,
    then it is refused (400) with `PHOTO_HEIF`. JPEG, PNG and WebP are still accepted. SVG, GIF, PDF and the polyglot
    are still refused with their existing messages (`barang.test.ts:313-330`). `image.ts` has no diff.
11. **Item photo downscale (Browser).**
    - Given a 4000 × 3000 JPEG with EXIF Orientation 6 and GPS, set on `/barang`'s picker, then the stored photo's
      longest side is at most 2560 px. It is upright: width < height after the orientation is baked in. It has no GPS
      or EXIF block.
    - Given a 1200 × 900 PNG under 8 MB, then the stored photo is PNG with the same dimensions. It was not
      re-encoded.
12. **Large file (Browser).** Given a JPEG over 8 MB that the browser can decode, then it is re-encoded under
    8 MB and saved. Given a non-image file over 8 MB, then "Foto terlalu besar. Paling besar 8 MB." is shown and
    nothing is sent.
13. **Struk unchanged (Browser and Automated).**
    - The existing `e2e/struk.spec.ts` flows pass unchanged: "Lampirkan fotonya saja", the mocked read, save with
      the kept photo, and Baca lagi.
    - `reencodeReceiptPhoto`'s output (2576 px cap, JPEG 0.85, 480 px preview) is the same after the extraction.
    - The mocked read is not a working capture path.
14. **Preparing state (Browser).** While a photo is being prepared, "Menyiapkan foto…" is announced in a
    `role="status"` and the submit control is disabled. Afterwards it is enabled again.
15. **Accessibility (Browser).**
    - Tab reaches "Kamera" and then "Galeri", or "Pilih foto". Each has a visible focus ring, and each opens its
      chooser on Enter and on Space (assert a `filechooser` event).
    - The actions are in a group named by the field label.
    - After a pick, "Foto dipilih: {name}" is in a polite live region.
    - `ReceiptReviewForm`'s required picker, submitted empty, is refused by the server with its photo message
      (the form has `novalidate`, so the browser's own check does not run; reworded 2026-10-13 after QA).
16. **Themes (Browser screenshots).** Phone mode and desktop mode, in light, dark and mono at 360 px. The controls
    meet AA (text 4.5:1, focus ring 3:1). No hex colour in `PhotoPicker.svelte`.
17. **i18n (Automated).** The existing English-coverage test passes with every new phrase. Phone mode renders
    "Camera" and "Gallery" when the user's language is English.
18. **Authorization unchanged (Automated).** No new route, action or loader. The existing Barang, Koleksi and Struk
    cross-space and non-member tests pass unchanged. Picking a photo never changes which space a write goes to.
19. **Gates.** `npm run gates` (check, lint, test, build) is clean. QA runs it; the PRD author does not run it.
    The fail-before proof for 9 and 10: today's code sends the HEIC (9) or answers `PHOTO_NOT_IMAGE` (10).
20. **Real devices (Pass, owner-run, not verifiable here).**
    - On an iPhone (Safari and the installed PWA), "Kamera" opens the rear camera and "Galeri" opens Photos.
    - On an Android phone (Chrome), "Kamera" opens the camera app. "Galeri" opens the photo picker. A HEIC gallery
      photo shows the fix message.
    - A 48/50 MP photo is downscaled and saved on both phones.

## Architecture notes

- **New files.**
  - `src/lib/ui/photos/PhotoPicker.svelte`
  - `src/lib/ui/photos/picker-mode.ts` (pure: mode from `matchMedia`, `firstFile`) with `.test.ts`
  - `src/lib/ui/photos/reencode.ts` (extracted from receipts)
  - `src/lib/ui/photos/PhotoPicker.test.ts` (SSR markup)
  - icons `camera` and `image` in `src/lib/ui/icons.ts`
- **Changed files.**
  - `src/lib/shared/photos.ts`: `isHeifBytes`, `PHOTO_UPLOAD_MAX_SIDE`, plus a test.
  - `src/lib/server/photos/messages.ts`: `PHOTO_HEIF`.
  - `src/lib/server/photos/upload.ts`: the HEIF refusal branch only.
  - `src/lib/ui/receipts/reencode.ts`: becomes a wrapper.
  - `src/lib/ui/photos/PhotoField.svelte`
  - `src/lib/ui/receipts/ReceiptReviewForm.svelte`
  - `src/routes/(app)/riwayat/struk/+page.svelte`
  - `src/lib/shared/i18n-en.ts`
  - `test/integration/barang.test.ts` (HEIC row)
  - e2e: `struk.spec.ts`, `barang.spec.ts`, `koleksi.spec.ts`, plus a new `e2e/photo-picker.spec.ts` for the
    phone, desktop, no-JS, HEIC and drop cases
  - `e2e/photos.ts`: HEIC-header and large or oriented JPEG builders, drawn by the browser canvas as today. No
    binary fixtures from real people.
- **Untouched.** `src/lib/server/photos/image.ts`, `src/lib/server/receipts/image.ts`, every
  `+page.server.ts`, the R2 store, `held-photo.ts`, migrations and Workers. No CSP change: previews stay `data:`
  URLs (`reencode.ts:3`). No new npm dependency.
- **Svelte 5.** Use `$state`, `$derived` and `$props`. Run detection in `$effect` or `onMount` (client only), so
  server and client markup match before hydration. Key no `{#each}` by file name.
- **Memory.** Canvases never exceed the target size. `bitmap.close()` runs in a `finally` block, as in
  `reencode.ts:45-47`. Use `createImageBitmap`'s `resizeWidth`/`resizeHeight` where supported, so a 50 MP decode
  is not held at full size. Treat a decode failure as "send the original".
- **Checklist items in scope.** i18n; truthful state (a photo is only reported saved after the server confirms the
  write, unchanged); accessibility (44 px, focus, AA); 360 px; no-JS forms; user copy never shows a file path
  (the status line shows the file's base name only, never a path); no upload persistence (nothing new is stored
  outside the existing R2 item-photo path).

## Owner decisions (proposed defaults, accepted)

1. **HEIC/HEIF from Android galleries.** Default: no decoder library. Use the browser's own decoder when it has one
   (Safari converts silently). Otherwise show a clear Indonesian fix message before any upload. *Alternative:*
   self-host a WASM HEIC decoder (libheif, LGPL, about 1–2 MB). Rejected for now on size and licence.
2. **Server HEIC message.** Default: the server answers a specific "how to fix" message for HEIC bytes (no-JS or
   other routes). It still refuses the file. What the server accepts does not change.
3. **Item-photo downscale.** Default: re-encode on the client only when a photo is over 8 MB or its longest side
   is over **2560 px**, to JPEG 0.85 at 2560 px. Smaller photos are sent as picked. This bounds upload time on
   mobile data and R2 use (shown in `/pengaturan/pemakaian`). Struk keeps its 2576 px / 0.85 rule.
4. **Which camera.** Default: `capture="environment"` (rear camera) everywhere: receipts and items.
5. **Detection.** Default: phone mode on `any-pointer: coarse`, which covers touch laptops and tablets with a
   trackpad (a harmless extra button). Desktop mode only on fine-only pointers. Both actions when unsure.
6. **Several photos picked or dropped.** Default: use the first and say so. No multi-photo support.
7. **Labels.** Default: "Kamera" / "Galeri" on phones, "Pilih foto" on desktop. English: "Camera" / "Gallery" /
   "Choose photo".
8. **Drop zone.** Default: desktop mode only. Phones do not get a drop target.

## Prerequisites

None. There are no secrets, providers or credentials. Struk's own "Belum dikonfigurasi" / no-key states
(`+page.svelte:256-265`) are unchanged. The picker still works there for "Lampirkan fotonya saja".

## Tracker impact

- `docs/TASKS.md`: no existing item covers this. At ship time, add and close
  "**Claude** — FN-45 camera and gallery photo picker (Struk, Barang, Koleksi)".
  Keep open a **You** item: "FN-45 real-device check: iPhone Safari/PWA and Android Chrome camera, gallery, HEIC
  message, 48 MP downscale".
- `docs/ACCEPTANCE.md`: add a row "Photo picker: camera and gallery on phone, HEIC message, downscale".
  It moves to **Browser** after AC 2–16 pass in Playwright, and to **Pass** only after the owner-run AC 20. The
  existing row "Receipt photo → split per item → total equals receipt" (still Not run, blocked by the provider
  key) is not moved by this feature.
- Hand-off note for `feat/fn-16g-ocr`: adopt `PhotoPicker` for the statement or screenshot upload after FN-45 merges.
  Pass its own `accept` and `prepare`.
