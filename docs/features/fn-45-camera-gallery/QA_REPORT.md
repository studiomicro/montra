# QA report: FN-45 camera and gallery photo picker

**Verdict: PASS** (cycle 1, commit 485b4d6 on feat/fn-45-camera-gallery vs integrate/2026-10-10). AC 20 is owner-run (Pass level) and still open.
No blocking findings. `npm run gates` was run clean by the engineer; QA did not rerun it (resource limit, per instruction).

## Commands run
- `npx vitest run src/lib/ui/photos src/lib/shared/photos.test.ts src/lib/shared/i18n src/lib/server/photos` : 5 files, 58 tests passed (real code, no provider).
- `npx vitest run test/i18n-coverage.test.ts test/icons.test.ts test/no-inline-style.test.ts test/integration/barang.test.ts` : 4 files, 40 tests passed (local D1/R2 miniflare, no provider).
- `E2E_PORT=8845 npx playwright test e2e/photo-picker.spec.ts` : 9 passed, 8 skipped (phone project skips by design; runs once in desktop), local wrangler dev, no provider.
- `E2E_PORT=8845 npx playwright test e2e/struk.spec.ts e2e/barang.spec.ts e2e/koleksi.spec.ts` : 27 passed (Struk read is the existing mock at the browser boundary).
- Throwaway probe (not committed, deleted): 360 px phone and 1280 px desktop Struk page in light, dark, mono-light, mono-dark; computed contrast and focus ring; 7 screenshots taken, 2 viewed. Plus one probe of the enhanced required picker (see AC 15).

## Acceptance criteria
1. PASS. `PhotoPicker.test.ts` SSR: one input, name/accept/id/aria-describedby, no capture/multiple, `required` when set; no buttons or fieldset before hydration.
2. PASS (partial evidence, acceptable). `photo-picker.spec.ts` no-JS: one `input[type=file]` named `photo` on Struk (form action `?/read`) and Barang; JPEG/PNG saves with GPS gone; HEIC refused with the fix text without JS. `struk.spec.ts:208` covers the Struk no-JS save refusal then success. Gap: no no-JS non-image refusal posted to Struk `?/read` (no AI key on the e2e server, so `read` answers "not configured" first). Server path is the unchanged `readReceiptPhoto`/`readPhotoField`, which `barang.test.ts` and the Barang no-JS test cover. Not blocking.
3. PASS. Phone test at 360x800 touch: both actions visible, >=44x44, same row and width, capture only on camera input, same accept, no multiple, no horizontal scroll on Struk, Barang sheet and Koleksi.
4. PASS. Camera then gallery on Struk replaces the preview; Barang camera-only saves; camera then gallery saves the gallery PNG; FormData has exactly one non-empty `photo`.
5. PASS. Desktop: only "Pilih foto" and the drop zone, no camera input; synthetic drop shows "Foto dipilih: ..." and the Struk preview.
6. PASS. `picker-mode.test.ts` (phone / desktop / both on missing, throwing, nothing matching) and the userAgent grep test.
7. PASS. Browser drop of 2 files uses the first and shows "2 foto dipilih — hanya foto pertama yang dipakai."; `firstFile` unit-tested for 0/1/several.
8. PASS. `photos.test.ts` covers the heic/heix/mif1/msf1 and compatible-brand cases and the false cases. Re-ran green.
9. PASS. Chromium: HEIC-header file on Struk and Barang shows the fix message with `role="alert"`, input cleared, `aria-invalid`, POST listener empty. Fail-before is by inspection only (the old inputs had no client check, so the file was sent): acceptable, not blocking.
10. PASS. `barang.test.ts` HEIC row now expects `PHOTO_HEIF` (400); GIF and PDF rows added; SVG, polyglot, JPEG/PNG/WebP unchanged. `git diff --stat` shows no change to `src/lib/server/photos/image.ts`.
11. PASS. 4000x3000 JPEG with Orientation 6 and GPS is stored at <=2560, width < height, no `Exif` block and no GPS mark. 1200x900 PNG stored as PNG, same size.
12. PASS. Decodable JPEG over 8 MB is stored under 8 MB (1600x1200 kept); a 8 MB+10 B non-image shows "Foto terlalu besar. Paling besar 8 MB.", input cleared, no POST.
13. PASS. `struk.spec.ts` 3 specs and `barang`/`koleksi` specs pass unchanged (Lampirkan fotonya saja, mocked read and save, no-JS save). Code review of `receipts/reencode.ts` wrapper: same maxSide, quality, name `struk.jpg`, 480 px preview at 0.7, same white fill and `bitmap.close()` in `finally`. There is no automated byte-equality test of the extraction: judged acceptable (identical code path, e2e green).
14. PASS. Slowed decode: "Menyiapkan foto…" in a `role="status"`, submit disabled, then enabled.
15. PASS with one PRD defect (not blocking). Enter and Space open a `filechooser` on each action; actions sit in a `role="group"` named by the field label; "Foto dipilih: ..." is in `role="status"`; focus ring is the global `:focus-visible` 2 px `--brand` (probe: ring 4.63:1 light, 5.9:1 dark, outline 2 px). Required review form: the PRD wording "submitted empty shows the browser validation and does not post" cannot hold. `ReceiptReviewForm.svelte:135` has `novalidate` (from FN-15, df6f2fe, not changed by this diff), so `required` is inert and the server refuses a missing photo as before. Probe confirmed on the same-pattern `BelongingForm.svelte:51` (`novalidate`): setting `required` on the enhanced input and clicking submit still POSTs. Consequences: (a) the engineer's missing browser test is not writable as specified; (b) `PhotoPicker.svelte` `oninvalid`/`firstAction.focus()` is dead code in both current callers. Behaviour is unchanged versus before the feature. Fix the PRD wording at next touch; no code change required.
16. PASS (QA ran the missing screenshots). Phone and desktop modes at 360/1280 px in light, dark, mono-light, mono-dark. Computed: action text on panel 15.5 to 16.8:1; drop-zone hint (muted on bg) 5.07 to 7.43:1; focus ring on bg 4.63 to 5.9:1 (all above 4.5:1 / 3:1). Light-phone and dark-desktop screenshots viewed: no overflow, ring visible, icons render. No hex colour in `PhotoPicker.svelte` (grep empty; `#fff` only in the canvas white fill in `reencode.ts`, a JPEG paper colour, not UI).
17. PASS. `i18n-coverage.test.ts` passes with the 9 new entries in `i18n-en.ts`; Browser test renders "Camera"/"Gallery" and the English aria-labels.
18. PASS. No route, action or loader in the diff; existing cross-space 404 photo tests in barang/koleksi e2e pass; the photo field name is unchanged.
19. PASS by report. Engineer ran gates clean; QA did not rerun. Fail-before for 10 by inspection (old `REFUSALS.type` = `PHOTO_NOT_IMAGE`).
20. OPEN, owner-run. Not verifiable here. Tracker item "FN-45 real-device check" must stay open under "You".

## Judgement of the engineer's reported gaps
- AC 15 required empty form: acceptable. The criterion is unsatisfiable under `novalidate`; see above.
- AC 16 screenshots: acceptable, now closed by the QA probe above.
- AC 2 Struk no-JS refusal: acceptable. No AI key; server path unchanged and covered via Barang and the Struk no-JS save refusal.
- AC 9 client fail-before: acceptable, trivially true by inspection.
- AC 20: not blocking for the Browser level; must stay open for Pass.

## Findings (non-blocking)
1. `src/lib/ui/photos/PhotoPicker.svelte` `oninvalid` handler is dead in the current callers because both host forms use `novalidate` (`ReceiptReviewForm.svelte:135`, `BelongingForm.svelte:51`). Harmless; PRD AC 15 last bullet should be reworded.
   **Resolution (2026-10-13):** ACCEPTED as QA recommends: no code change (the server refuses a missing photo as before). PRD AC
   15's last bullet is reworded for the `novalidate` form in `fix(photos): refuse non-photo drops by their bytes, one file per drop, no drop while preparing` (188045f). The `oninvalid` focus handler stays for a host form
   without `novalidate`.
2. Edge: `PhotoPicker.svelte` `prepared()` returns the original HEIC file if Safari decodes it but the canvas fails (`decoded: true`, original returned). The server then refuses it with `PHOTO_HEIF`, so it is safe and truthful.
3. Checklist skim: strings via `tr`/`trf` with English entries, 44 px targets, 360 px, no-JS, base-name-only status line, no new dependency, no migration. No violation found.
