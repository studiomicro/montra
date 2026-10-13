# FN-16g On-device OCR: summary

**Status: complete** (2026-10-10). Branch `feat/fn-16g-ocr` (based on `integrate/2026-10-10`), not merged, not pushed,
not deployed. QA: PASS (cycle 1 and the cycle 2 re-check). Red team: FAIL in cycle 1 (M1, medium), then PASS in cycle 2.
One fix cycle used out of three.

## Goal (from the PRD)

Scanned or image-only statement PDFs, e-wallet history screenshots (GoPay, OVO, DANA, ShopeePay), mobile-banking
mutation screenshots and camera photos of paper statements become reviewable rows in the existing Impor review and
import flow. Text is recognised **on the device** with Tesseract (tesseract.js, WASM). The image never leaves the
device, and no AI key is needed (owner decision 2026-10-10). Amounts are never invented: low-confidence digits and
failed balance self-checks put a row in review, and a statement that fails its printed-balance check is not imported
whole without the user seeing it.

## What was built

- **Client engine** (`src/lib/ocr/`): support detection, lazy download with progress and size, a Tesseract worker
  (`workerBlobURL: false`), pdf.js page rendering, image handling (EXIF orientation, downscale to 6 MP, projection-profile
  deskew), a cancellable pipeline, and `OcrImport.svelte` with the Kamera (`capture="environment"`) and file actions.
  It covers every state: unsupported, download failed, running and cancellable, nothing recognised, partial, and no JavaScript.
- **Shared deterministic parsing** (`src/lib/shared/ocr/`, `src/lib/shared/statements/{sections,text-layer}.ts`):
  words become lines, then go through the per-bank statement parsers plus new e-wallet and mobile-banking layout
  parsers, using the shared money and date parsers and confidence gates (below 70 refused, 70–89 review, 90 and up
  clean; these thresholds are proposals until real samples exist). Fixtures are fictional only.
- **Server** (`src/lib/server/statements/ocr-{validation,import}.ts`, `/impor` actions `?/previewOcr` and `?/importOcr`):
  the server receives OCR words and confidence only (never the image), with a 512 KB cap and prototype-safe parsing. It
  re-parses everything, ignores client totals, shares the `statement-upload` throttle and reuses the existing import
  core. The dedupe key is institution + account last 4 + wallet + date + signed amount + balance or time, after red team M1.
  `source` stays `statement`. Nothing of the image or OCR text is stored or logged.
- **Assets**: tesseract.js 7.0.0, tesseract.js-core 7.0.0 and pdfjs-dist 6.4.299 (exact pins, Apache-2.0), plus
  tessdata_fast `ind`/`eng` at commit `87416418657359cb625c412a48b6e1d6d41c29bd` (Apache-2.0).
  - `npm run ocr:assets` builds the git-ignored `static/_ocr/<version>/` and checks the SHA-256 of every file.
  - One image run downloads about 9.3 MB decoded (about 4.1 MB gzip). A scanned PDF adds 1.72 MB.
  - The service worker never precaches `/_ocr/`.
- **CSP**:
  - Pages gain only an explicit `worker-src 'self'`.
  - `/_ocr/*` gets its own policy in `_headers`: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; base-uri 'none'`.
  - No `blob:`, no third-party origin, and no `'unsafe-inline'` or `'unsafe-eval'` anywhere.
  - This was verified in Chromium against `wrangler dev`, with a negative control.
  - The red team reviewed it and found it clean.
- **Compat harness**: `npm run compat:ocr` reads redacted samples from `.superpowers/ref/samples/ocr/` (git-ignored).

Migrations: none (0034 left unused). Files: about 65 changed. The main ones are under `src/lib/ocr/`,
`src/lib/shared/ocr/`, `src/lib/server/statements/`, `src/routes/(app)/impor/`, `scripts/ocr-assets.ts`,
`scripts/compat-ocr.ts`, `_headers` and `src/lib/server/csp.ts`. Tests: 13 or more new Vitest files, including
`test/integration/impor-ocr.test.ts` and `impor-ocr-qa.test.ts`, and `e2e/impor-ocr.spec.ts` (4 tests).

## Picker swap note

The Kamera and file picker in `OcrImport.svelte` is self-contained on purpose. The parallel branch
`feat/fn-45-camera-gallery` builds a shared `PhotoPicker` (Kamera + Galeri). After both merge, swap this picker for that
component. This branch has no dependency on it.

## Open lows (tracked in TASKS)

- L2: CI should use `npm ci --ignore-scripts`. A clean build needs raw.githubusercontent.com for the language files
  unless the cache is present (see RUNBOOK).
- L4: extra files planted in `static/_ocr/<version>/` are not detected and would be served under the wasm policy.
  Exploiting this needs write access to the build tree.
- L5: a HEIC with a decoy `ispe` in the first 512 KB and its real `meta` box further on skips the 24 MP cap. The only
  effect is a crashed tab on the user's own device.
- QA: a valid HEIC with no readable `ispe` in its head is refused as damaged. A re-scan into an explicit wallet after
  an import with no wallet chosen gets a different dedupe scope; the "Mungkin duplikat" flag still applies.
- Behaviour: PNG, WebP and HEIC above 24 MP are refused, so a 48 MP HEIC must be saved as JPG first.

## Not verified

- Accuracy on real statements, screenshots and camera photos. All fixtures are fictional, and the confidence
  thresholds are uncalibrated.
- Real phones (Android Chrome, iOS Safari), real camera hardware and real HEIC files.
- The full e2e suite. Only `e2e/impor-ocr.spec.ts` and `e2e/impor.spec.ts` ran.
