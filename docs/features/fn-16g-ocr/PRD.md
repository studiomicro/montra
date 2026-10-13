# FN-16g On-device OCR for scanned statements, screenshots and camera photos: PRD

Catalog entry: `docs/FEATURES.md` > FN-16 (line 188-205). FN-16a made the deterministic subset (text-layer PDF, CSV) and
handed image-only PDFs and screenshots to "FN-16's AI read", blocked on the on-hold Anthropic key
(`docs/TASKS.md:67`, `:124`; refusal `needs_ai` at `src/lib/server/statements/read.ts:155`,
`src/lib/server/statements/pdf-text.ts:133`, message `STATEMENT_NEEDS_AI` at `src/lib/server/imports/messages.ts:51`).
FN-16g replaces that hand-off with **on-device OCR (Tesseract compiled to WASM, run in the browser)**: no AI key, and the
image never leaves the device. Risk tier: **Large** (new external input, capture path, new CSP surface, per
`.claude/commands/build-feature.md:15`). **No migration** (see Owner decisions: `source` stays `statement`; number 0034
stays reserved and unused; 0033 is FN-19 Gmail).

## Owner decisions

DECIDED 2026-10-10 (owner):

- **D1 Engine.** On-device OCR with Tesseract in the browser (`tesseract.js`, WASM). Not Claude vision. No AI key. The
  image never leaves the device for OCR. Cloudflare Workers cannot host it (no WASM threads/file system budget; CPU cap),
  so it runs in a browser Web Worker.
- **D2 Inputs.** Scanned or image-only statement PDFs (pages rendered client-side with `pdfjs-dist`), e-wallet history
  screenshots (GoPay, OVO, DANA, ShopeePay) and mobile-banking mutation screenshots (BCA, Mandiri, BRI, BNI and others).
- **D3 Camera (added 2026-10-10, relayed by the orchestrating session).** The OCR upload also accepts photos taken with
  the phone camera, for example a photo of a paper statement, not only gallery screenshots and PDFs. A camera action sits
  next to the file/gallery pick. This feature's picker is **self-contained**: the parallel branch
  `feat/fn-45-camera-gallery` builds a shared `PhotoPicker` (Kamera + Galeri) for Struk and item photos; FN-16g does not
  depend on it and its picker is written so it can be swapped for that component after both merge (the SUMMARY states
  this).

DEFAULT ADOPTED (owner-visible trade-offs; the owner said proceed, change any of these before the build if wanted):

| # | Topic | Default adopted |
| - | - | - |
| A1 | `source` for OCR rows | Stays `statement` (existing value, no migration). A `screenshot` source would need migration 0034 and a CHECK rebuild of `transactions` and `import_batches` (`src/lib/server/db/schema.ts:543,744`) for no user-visible gain. OCR origin is visible only in the dedupe-key prefix `ocr:`. |
| A2 | What reaches the server | The **OCR text** (words, line boxes, confidences), never the image or the PDF. The server parses and re-validates it and holds it in memory only. This matches today's rule that statement text is processed in memory and never stored (`CLAUDE.md` Uploads). |
| A3 | Language data | `tessdata_fast` `ind` + `eng` (5.2 MB raw, about 2.5 MB over the wire compressed). `tessdata_best` rejected: 23.7 MB, too heavy for phones, small accuracy gain on printed digits. |
| A4 | Where assets come from | Not committed. A script fetches the two traineddata files from a pinned tessdata_fast commit and checks SHA-256; core, worker and pdf.js files are copied from the pinned npm packages at build time into git-ignored `static/_ocr/<version>/`. Needs network on the first build only. |
| A5 | Limits | Image or PDF file at most 15 MB (same as `STATEMENT_MAX_BYTES`, `read.ts:19`); at most 5 images or 12 PDF pages per run; at most 6 megapixels per page after downscale (long side at most 3000 px); declared source image at most 64 MP for JPEG and at most 24 MP for PNG, WebP and HEIC (amended in cycle 2, red team L3: those decode at full size); whole run at most 5 minutes, one page at most 60 s. |
| A6 | Row review | A row that is low-confidence or has no readable direction is shown as `Perlu ditinjau`, **excluded by default**, and can be ticked in. No inline amount editing in this pass (edit the saved transaction in Riwayat). |
| A7 | Multi-image | Up to 5 images form one import (pages in the order added). The same row appearing in two images (scroll overlap) is flagged `Mungkin duplikat`, excluded by default, tickable. No automatic stitching. |
| A8 | Auto-correct of digits | None. A character that looks like a digit but is a letter (`O`, `l`, `S`, `B`) is never turned into a digit; the row is unreadable or flagged. |
| A9 | Offline | First OCR needs a network to download engine and language data. Later runs use the browser HTTP cache plus tesseract's IndexedDB language cache (language data only, never user content). A fully offline first run is out of scope. |
| A10 | Harness scope | `npm run compat:ocr` runs images (PNG/JPG) through the same pipeline in Node. Scanned PDFs are verified in the browser e2e with a fictional PDF; Node PDF rendering (native canvas dependency) is not added. |
| A11 | Throttle | Shares the existing `statement-upload` bucket (30 per 10 minutes per user, `validation.ts:23`) so OCR cannot add a second quota to abuse. |

## Goal

A large part of Indonesian users cannot export a text statement: bank mobile apps show only mutation lists, e-wallets (GoPay,
OVO, DANA, ShopeePay) offer no export, and some banks mail scanned or image-only PDFs. Their only record is a screenshot, a photo
of a paper statement, or an image PDF. FN-16g reads those on the user's own phone with Tesseract, turns the recognised
text into rows with deterministic code (the same money and date parsers and the same per-bank parsers as FN-16a), and lands
them in the existing `/impor` review where dedupe, undo and import history already work. Money is never invented: a digit the
engine is unsure of, or a statement that fails its printed-balance self-check, is surfaced for review or refused, never
guessed.

## Scope

### 1. Engine, versions and assets (self-hosted, pinned)

Verified 2026-10-10 with `npm view <pkg> version license dist.unpackedSize`, `npm pack` + `ls -l` of each tarball, and the
GitHub API for tessdata (`/repos/tesseract-ocr/<repo>` license, `commits/main`):

| Asset | Pin | License | Size | Note |
| - | - | - | - | - |
| `tesseract.js` | **7.0.0** (npm `latest`, published 2025-12-15) | Apache-2.0 | `dist/worker.min.js` 111 KB (about 34 KB gzip) | Worker script served from our origin; `tesseract.min.js` glue 63 KB is bundled by Vite instead. |
| `tesseract.js-core` | **7.0.0** | Apache-2.0 | `tesseract-core-simd-lstm.wasm.js` 3.9 MB (1.46 MB gzip); relaxedsimd-lstm 3.9 MB; plain lstm 3.9 MB | npm dist-tag `latest` is still 6.1.2, but `tesseract.js@7.0.0` depends on `^7.0.0`, so pin core to exactly 7.0.0. Ship **only the three `-lstm` `.wasm.js` variants** (tessdata_fast is LSTM-only, so legacy cores are dead weight); tesseract.js picks relaxedsimd, simd or plain by `wasm-feature-detect`; one variant (about 3.9 MB) is downloaded per phone. The wasm is embedded as base64 in the `.wasm.js`, so no separate `.wasm` fetch. |
| `pdfjs-dist` | **6.4.299** (npm `latest`) | Apache-2.0 | `build/pdf.min.mjs` 459 KB, `build/pdf.worker.min.mjs` 1.26 MB; `wasm/openjpeg.wasm` 251 KB, `jbig2.wasm` 104 KB, `qcms_bg.wasm` 97 KB | Needs Node >= 22.13 (repo is `>=22`). Scanned PDFs often hold JPX/JBIG2 images, so `wasmUrl` points at our copy. No `eval`/`new Function` in `pdf.min.mjs` (grep 0 hits); still pass `isEvalSupported: false`, `enableScripting: false`. Separate from the server-side `unpdf@1.8.1` bundle; do not mix them. |
| `ind.traineddata` | `tesseract-ocr/tessdata_fast` commit `87416418657359cb625c412a48b6e1d6d41c29bd` (2024-08-01) | Apache-2.0 (repo license via API) | 1,122,661 B; SHA-256 `69786901da87ab8766c1ea7fbb10b28f2110c14da3f6c8f2735df131fba95d88` | |
| `eng.traineddata` | same commit | Apache-2.0 | 4,113,088 B; SHA-256 `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` | `tessdata_best` for reference: eng 15.4 MB, ind 8.3 MB (not used). |

First-use download on a phone: worker 34 KB + core about 1.5 MB + languages about 2.5 MB (compressed) = about 4 MB, plus pdf.js
(about 0.6 MB compressed, only for a PDF). The engineer re-verifies every number above (versions, licenses, sizes, hashes) with
the same commands before pinning and writes the actual figures in the ENGINEER_REPORT; any difference blocks.

- `package.json`: add `tesseract.js` `7.0.0`, `tesseract.js-core` `7.0.0`, `pdfjs-dist` `6.4.299` with **exact** versions (no `^`),
  matching the repo's `unpdf` pin style. Check `npm audit` for the three and `scripts` for no install hooks
  (`tesseract.js` pulls `opencollective-postinstall`: verify it does nothing at install, or install with the project's
  existing ignore-scripts policy; record the result).
- `scripts/ocr-assets.ts` (new) plus `npm run ocr:assets`, run before `build` and `dev`: copies worker, three LSTM cores, pdf.js
  `pdf.min.mjs`/worker/`wasm/*` + their `LICENSE_*` files from `node_modules` into `static/_ocr/<ocr-asset-version>/`; downloads
  `ind` and `eng` traineddata from the pinned commit URL, verifies the SHA-256 constants in the script, fails the build on any
  mismatch, and caches downloads in git-ignored `.ocr-cache/`. A `THIRD_PARTY_NOTICES` entry (Apache-2.0 texts for tesseract.js,
  tesseract.js-core, pdf.js, tessdata_fast) ships in `static/_ocr/`. `static/_ocr/` and `.ocr-cache/` are git-ignored.
- Everything is requested from the app origin (`/_ocr/<version>/...`). Configure tesseract with explicit `workerPath`, `corePath`
  (directory; tesseract.js picks the variant), `langPath`, `gzip: false` (raw `.traineddata`, the CDN compresses in transit),
  `workerBlobURL: false` (see CSP), `cacheMethod: 'write'`, `oem` LSTM only. Never leave a default: tesseract.js defaults to
  `https://cdn.jsdelivr.net/...` for worker, core and `https://tessdata.projectnaptha.com` for language data
  (`src/worker/browser/defaultOptions.js`, `src/worker-script/browser/getCore.js`); a test fails if a built client file contains
  those hosts or any other `https://` fetch target (see criterion 6).
- **Service worker**: `src/service-worker/index.ts` precaches every file in `$app/manifest` `assets`
  (`src/lib/shared/sw-policy.ts:22-31`), which would download `static/_ocr/` (about 10 MB) on install. `shellPaths` must exclude
  `/_ocr/`, and `requestPolicy` must leave `/_ocr/*` to the browser (HTTP cache). Test in `sw-policy.test.ts`.

### 2. CSP (as tight as possible; every change documented)

Today: `default-src 'self'`, `script-src 'self'`, `connect-src 'self'`, `img-src 'self' data:`, no `worker-src`, SvelteKit
`csp: { mode: 'auto' }` global in `vite.config.ts:28`, directives in `src/lib/server/csp.ts:11-24`, header writer
`cspHeader()` with a quoting regex at `csp.ts:28-32` that only knows `self|none|unsafe-hashes|unsafe-eval|strict-dynamic|sha...`.

Design (the engineer verifies each claim in a real browser and records the result; the red team reviews this section first):

1. **Page document (global, unchanged except one explicit directive):** add `'worker-src': ['self']`. This is already the effective
   fallback (`worker-src` falls back to `child-src`, `script-src`, `default-src`), so the change documents intent and blocks a
   future `blob:` loosening; it adds no capability. **No `blob:` anywhere**: `workerBlobURL: false` makes tesseract.js do
   `new Worker('/_ocr/<v>/worker.min.js')` instead of a `blob:` bootstrap (`spawnWorker.js`: the blob path is the default); the
   page uses `createImageBitmap(file)` and canvases, never `URL.createObjectURL` and never an `<img src=blob:>`, so `img-src` is
   untouched. tesseract's canvas path reads the canvas through `toBlob` + `FileReader`, not `fetch(dataURL)`, so `connect-src`
   stays `'self'` (`worker/browser/loadImage.js`).
2. **`'wasm-unsafe-eval'` only on the OCR asset responses, not on any page.** WebAssembly compilation inside a dedicated Worker
   is governed by that worker script's own response CSP. So `/_ocr/**` responses carry
   `Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'`
   (the pdf.js worker is same-origin too; its sub-fetches of wasm and traineddata are `connect-src 'self'`). The pages that load
   OCR (`/impor`) keep `script-src 'self'` with no `'wasm-unsafe-eval'`. This is per-resource, which is tighter than any per-route
   change (SvelteKit's `csp` option is global; its generated nonces/hashes live in the response header, so a hook that rewrote it
   per route would need to parse SvelteKit's header; avoid).
3. **How the header is attached** (the engineer picks the first that works and tests the real response header in `wrangler dev`):
   (a) a `static/_headers` rule for `/_ocr/*` if the adapter's generated `_headers` merges with it; (b) otherwise serve `/_ocr/*`
   from the Worker like `src/lib/server/site-static.ts:42` does (read from `ASSETS`, set the header, long `Cache-Control:
   public, max-age=31536000, immutable` because the folder is versioned). A unit test asserts the header string.
4. **Fallback if the browser test shows the main thread must instantiate WASM** (e.g. pdf.js running image decoders on the page
   thread): then, and only then, `/impor` alone gets `'wasm-unsafe-eval'` in `script-src`, via the global config if SvelteKit offers
   no per-route switch (document why global: `kit.csp` has no route scope), and the PRD/engineer report states which pages it
   weakens. Prefer pdf.js worker mode (default) so this stays unneeded.
5. **`cspHeader()`'s `source()` regex** (`csp.ts:29`) gains `wasm-unsafe-eval` so the keyword is emitted quoted
   (`'wasm-unsafe-eval'`), via a shared builder `ocrAssetCsp()` in `csp.ts` that reuses `source()`; the existing
   `csp.test.ts` gets cases: the keyword is quoted, `blob:` and `unsafe-inline`/`unsafe-eval` never appear in the page policy, and
   the page policy equals the vite config's directives.
6. The red team reviews: no new `connect-src` host, no `blob:`/`data:` worker, no `'unsafe-eval'` (tesseract core uses WASM
   compile, not `eval`: engineer greps `*.wasm.js` for `new Function`/`eval(` and records the result), Trusted Types not
   applicable, `/_ocr/**` not user-writable, `X-Content-Type-Options: nosniff` on it.

### 3. Client OCR module (browser only, lazy)

New folder `src/lib/ocr/` (client-only; never imported from `+page.server.ts`, `src/lib/server` or `workers/`; a Vitest import guard
in the spirit of `scripts/node-imports.test.ts` keeps `tesseract.js`/`pdfjs-dist` out of server and shared code).

- **Lazy**: nothing from `tesseract.js` or `pdfjs-dist` is imported, preloaded or fetched on page load, route load or tab
  switch. They load via dynamic `import()` only after the user picks a file or takes a photo, and `/impor`'s initial bundle does not
  grow (check the build output size diff in the report). `modulepreload` hints for them are not emitted.
- **Capability gate** (before anything is downloaded): `WebAssembly`, `Worker`, `OffscreenCanvas` or `<canvas>`,
  `createImageBitmap`. Missing: state `unsupported`, copy `Peramban ini belum bisa membaca gambar di perangkat. Coba Chrome atau
  Safari terbaru, atau unggah PDF/CSV.`; the other import paths stay usable.
- **Download step**: shows what is downloading, with size and progress (`Mengunduh mesin baca (sekitar 4 MB, sekali saja)`; byte
  progress from tesseract's logger `status: 'loading tesseract core'`/`'loading language traineddata'` and a byte counter for pdf.js
  assets via `fetch` streams); `Batal` terminates the worker. A failed download (network, 404, hash/size mismatch, `Content-Type`
  wrong) shows `Gagal mengunduh mesin baca. Periksa sambungan lalu coba lagi.` with `Coba lagi`; nothing half-loaded is reused. On
  a metered connection (`navigator.connection.saveData === true`) ask before downloading.
- **Inputs**:
  - One control group: `Ambil foto` (`<input type="file" accept="image/*" capture="environment">`), `Pilih dari galeri/berkas`
    (`<input type="file" accept="image/*,application/pdf" multiple>`), plus drag and drop on desktop. Neither input is a
    `<form>` file field posted to the server; selected files are read client-side only.
  - **Camera states**: permission denied, no camera, or a desktop browser that ignores `capture`: the browser falls back to its own
    file chooser, the page shows `Kamera tidak tersedia. Pilih foto dari galeri atau berkas.` and focuses `Pilih dari galeri/berkas`.
    A cancelled camera/chooser is not an error.
  - File kind decided by **magic bytes** (the existing `sniffStatementFile` pattern, `src/lib/shared/statements/detect.ts:20-30`;
    add PNG, JPEG, WebP, HEIC detection in `src/lib/shared/ocr/image-kind.ts`), never by name or MIME.
  - A PDF that **has** a text layer is not OCRed: the page says so and routes to the existing text-PDF path (`hasReadableText`
    logic, `pdf-text.ts:122-127`); `needs_ai` for an image-only PDF is replaced by this OCR path when the browser can run it,
    and keeps its message only when it cannot (state `unsupported`).
  - Password-protected PDF: pdf.js `PasswordException`; ask for the password in the existing field, used once in memory, never
    sent to the server (OCR is client-side) and never stored.
- **Pixel and memory limits (phone first, 360 px wide, 2-4 GB RAM)** (A5): declared image dimensions read from the header by shared
  code (`src/lib/shared/ocr/image-kind.ts`, PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X, HEIC `ispe`) and refused above 64 MP (JPEG) or 24 MP (PNG, WebP, HEIC; amended in cycle 2) **before** decoding
  (`Foto terlalu besar...`); decoded with `createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth/resizeHeight })` so
  a 48 MP camera photo is never fully materialised; canvases are sequential (one page at a time), zeroed (`width = height = 0`) and
  the bitmap `close()`d after each page; the Tesseract scheduler uses **one** worker (no pool) so peak memory is about one page
  canvas plus the engine. PDFs: pages rendered at a scale giving a long side at most 3000 px and at most 6 MP, only the first 12
  pages, the rest reported as `pagesNotProcessed` (same wording as FN-16a's). pdf.js options: `isEvalSupported: false`,
  `enableScripting: false`, `disableFontFace`-agnostic (text is not extracted here), `maxImageSize` 64 MP, a render timeout, and
  `loadingTask.destroy()` on every exit.
- **Camera photo handling (D3)**:
  - **EXIF orientation applied** by `createImageBitmap` `imageOrientation: 'from-image'` (explicit even though it is the modern
    default), so a portrait phone photo stored rotated is upright before OCR. Browsers that ignore the option are detected with a
    one-time 2x1 JPEG probe at start; if unsupported, the module reads the EXIF orientation tag itself in shared code
    (`src/lib/shared/ocr/exif.ts`, orientation 1-8, bounded read of the first 64 KB) and rotates the canvas. Tested with fixtures of
    all 8 orientations.
  - **Downscale to the pixel cap** before OCR (above), then **deskew**: a pure function in `src/lib/shared/ocr/deskew.ts` estimates
    the skew angle of a grayscale downscaled copy by a projection-profile search over -15 to +15 degrees at 0.5 degree steps
    (variance of row sums) and the caller rotates the page canvas when `abs(angle) >= 0.7`. Pure over a typed array so it is
    Vitest-testable with a synthetic skewed text-bar raster (no image files). Tesseract's OSD (`osd.traineddata`, about 10 MB) is
    **not** shipped: too heavy for phones.
  - **Perspective/curl** (a phone held at an angle, a curled page) is not corrected. Instead a per-page quality signal drives the UI:
    mean word confidence below 60 or fewer than 8 recognised words on a page shows `Foto kurang jelas. Coba lagi dengan cahaya
    cukup, kertas rata dan kamera lurus di atas kertas.` with `Ambil ulang`; rows from that page are marked for review, never
    silently accepted.
  - Photos of paper statements have **no text layer**, so they follow exactly the same statement self-checks as scanned PDFs
    (section 5): a bank statement photo that fails its printed running-balance chain is not imported whole.
- **Run**: one tesseract worker, languages `ind+eng`, `tessedit_pageseg_mode` `PSM.AUTO` (6/`SINGLE_BLOCK` is wrong for multi-column
  statements), `preserve_interword_spaces: '1'`, `tessedit_char_whitelist` is **not** set globally (it hurts description text); a
  second pass restricted to digits and `.,-+` on amount-column word boxes is optional and out of scope. Output requested:
  `blocks`/`lines`/`words` with `text`, `confidence` (0-100) and `bbox`; nothing else is kept. Progress: `Membaca halaman 2 dari 5
  (40%)`; `Batal` calls `worker.terminate()` and drops partial results (no half import). Live region announces progress and result
  to screen readers.
- **Output of the client module** (the only thing that leaves the device): `OcrDocument` = `{ pages: [{ widthPx, heightPx,
  meanConf, lines: [{ y, x, text, words: [{ t, c, x0, x1 }] }] }] }` with integer coordinates only; no image data, no page
  thumbnails, no file name. Built by pure code in `src/lib/shared/ocr/lines.ts` (word boxes grouped into lines by vertical overlap,
  ordered top-to-bottom, left-to-right, columns kept with gap-preserving spacing) so the Worker and the client share it.

### 4. Server contract (re-validates everything)

Two new form actions on `/impor` next to `previewStatement`/`importStatement`
(`src/routes/(app)/impor/+page.server.ts:394-395`): `?/previewOcr` and `?/importOcr`. They follow the statement actions' guards
exactly:

- Space from `currentSpaceScope` (`+page.server.ts:209`), throttle via `overUserAttemptLimit(... 'statement-upload',
  STATEMENT_UPLOADS_PER_WINDOW)` (A11), body read through `readFormBody` with a smaller cap (`OCR_BODY_MAX_BYTES` = 512 KB) and the
  same timeouts; 400/408/413/415, never 500. Import is also subject to `overTransactionCreateLimit` as `importStatementAction`
  is (`+page.server.ts:283`). The PDF lane (`reservePdfRead`) is not used (no PDF parsing here).
- Fields: `ocr` (the `OcrDocument` JSON string), `institution` (picked id or ''), `defaultWalletId`, `skipPossibleDuplicates`,
  `include` (indices of review rows the user ticked in) and `exclude` (indices of normal rows the user unticked), `statementSection`
  (FN-16e picker). Parsed with zod in `src/lib/server/statements/ocr-validation.ts`: at most 12 pages, 250 lines per page, 3,000
  words per page, word text at most 64 chars, confidence integer 0-100, coordinates integers in [0, 20000], unknown keys refused,
  prototype-safe. All text goes through `cleanText` (control/zero-width stripped, length capped before `normalize()`) before any
  parser sees it. `include`/`exclude` are integer arrays bounded to `CSV_MAX_ROWS`.
- **The server never trusts client rows, totals, balances or institutions.** It rebuilds the document from the words, runs the same
  shared parsers itself (below), recomputes the balance check, applies bounds, and ignores any client-computed figure. A client may
  only choose, among rows the server itself produced, which to include.
- `src/lib/server/statements/ocr-import.ts` (new) mirrors `statement-import.ts`: `prepare` -> `previewRows`/`importRows` from
  `src/lib/server/imports/csv-import.ts` unchanged (same "Mungkin duplikat" query, same validator, same all-or-nothing
  `db.batch`, same undo), `source: 'statement'`, `format: null`, masking via the same `maskRow` (account numbers cut to the last 4
  digits before storage and before they reach a page).
- **Dedupe key** (a replayed or re-scanned image must not double-import; the existing key hashes file bytes the server never sees):
  `ocr:<sha256-128 of date | signed amount minor | printed balance-after if any, else time of day if any, else ''>:<n>` where `n`
  is the 0-based occurrence of the identical tuple within this import. The description text is **not** in the key (OCR jitter would
  change it between scans). Scanning the same statement twice produces the same keys; the "Mungkin duplikat" query is the
  backstop (same amount, at most one day apart, same wallet). A deleted captured row is never recreated from the same key
  (existing rule, `CLAUDE.md` Data and runtime conventions).
- **Nothing stored**: the OCR JSON, its text and the image are never written to D1, R2, KV, logs or the audit trail; error logs use
  the existing fixed-line + `errorLabel` pattern (`+page.server.ts:152-157`). `import_batches.filename` is null for OCR imports (a
  photo file name is personal). Nothing is kept, so no sealed result (FN-21) is produced; if the engineer finds a reason to keep
  anything, it must go through the FN-21 sealed path and the PRD is amended first.
- The `needs_ai` refusal stays for an uploaded image-only PDF reaching the old file action, with the changed copy pointing to
  `Baca di perangkat`.

### 5. Deterministic interpretation (shared, `src/lib/shared/ocr/` and `src/lib/shared/statements/`)

Pipeline per run, in `src/lib/shared/ocr/read.ts` (pure, runs identically in Vitest, the compat harness and the Worker):

1. `OcrDocument` -> **text pages** (`string[]`, lines joined with `\n`, column gaps as runs of spaces) for the existing
   **per-bank statement parsers** (`BCA`, `BNI`, `MANDIRI`, `OCBC`, `STATEMENT_PARSERS`, `parsers.ts:12`), called with `{ format:
   'pdf_text', pages }` unchanged: letterhead detection, `letterheadClaims` conflict refusal, running-balance chains, printed
   totals, sections picker and `inconsistent` refusal all apply to scanned statements and camera photos of paper statements.
   Bank parsers expect a text layer's token shapes, so the conversion stage may normalise **layout only** (spaces, line breaks),
   never characters of amounts or dates.
2. **Low-confidence numerics are poisoned, not repaired.** Any word that looks numeric (digits, `.`, `,`, `Rp`, or a date-like
   token) with confidence below `OCR_MIN_NUMERIC_CONF` (proposed 70) is replaced by an unparseable marker before the parsers run,
   so the row becomes `unparseable_amount`/`unparseable_date`, the balance check shows a gap, and the file is refused as
   `inconsistent` (the existing whole-file refusal) instead of importing a possibly wrong amount. Words between 70 and
   `OCR_REVIEW_NUMERIC_CONF` (proposed 90) are kept but their row carries `review: 'low_confidence'`. Both thresholds are single
   constants in `src/lib/shared/ocr/confidence.ts`, calibrated later with the compat harness on real samples (the proposals are
   starting points, not measured).
3. **Bank statements** (a bank letterhead is claimed): bank parser rows + the printed-balance self-check. A statement that fails
   it is **not imported whole silently**: refusal `inconsistent` with `Saldo tidak cocok. Pastikan foto/pindaian jelas dan semua
   halaman ikut.` plus counts only (pages, rows read, gap in rupiah), never row text. A statement with no printed balances reports
   `omitted` and every row carries `review: 'no_balance_check'` (excluded by default; user may tick in).
4. **Screenshots** (no bank letterhead claimed): new layout parsers in `src/lib/shared/ocr/screens/`, one module per family, tested
   with **fictional fixtures only** (hand-written `OcrDocument` JSON; invented names, amounts, account numbers; no real person's data,
   no other product's logos, mascots or copy):
   - `ewallet.ts`: GoPay, OVO, DANA, ShopeePay history lists (wallet identified by on-screen word, e.g. the app's own name; naming
     an app in code is nominative, no brand asset is copied). Row = optional day-group header (`10 Okt 2026`/`Hari ini`/`Kemarin`
     resolved against the WIB date at import, see below), a title line, an amount line, optional time and status line. Rows with
     status `Gagal`, `Dibatalkan`, `Menunggu` are skipped and counted.
   - `mobile-banking.ts`: BCA, Mandiri (Livin'), BRI (BRImo), BNI and generic mutation lists: date, description, amount with `DB`/`CR`,
     `+`/`-` or `D`/`K`; running saldo per row when shown.
   - Direction: taken only from an explicit, confidently-read sign or `DB/CR/D/K` marker. Sign lost or unreadable (colour is not
     visible to OCR) -> `review: 'direction_unknown'`, never inferred from words like "Top Up" or "Pembayaran".
   - Year: a screenshot prints day and month without a year more often than not. The year comes from the printed date if there is one,
     else from a printed period, else the row is `review: 'year_assumed'` using the current WIB year only when that makes the date
     not in the future (never a future date) and is excluded by default.
   - Relative days (`Hari ini`, `Kemarin`) use `parseRelativeIndonesianDate` (`src/lib/shared/dates.ts:266`) against the WIB date at
     import time; the screenshot is taken to be recent, so rows with a relative date are `review: 'relative_date'`.
   - Amounts only via `parseMoneyAmount` (`src/lib/shared/money-parse.ts:353`): `Rp 1.250.000`, `1.250.000,00`, `IDR 1,250,000.00`,
     `-Rp25.000`; integer minor units, cap `MAX_AMOUNT_MINOR`; rows through `statementRow` (`rows.ts:60`), which stays the only place
     a statement amount is read. Dates only via `isDateString`/`dateInPeriod` (`rows.ts:23`). WIB bucketing is the existing
     `occurred_on` rule.
   - When a screenshot shows a running balance for consecutive rows, the parser verifies each row's amount against the balance
     difference; a mismatch marks both rows `review: 'balance_mismatch'` (not corrected).
   - Detection is by the app's own on-screen words and header shapes, never by image size or a guess; no claim -> `format belum
     didukung` with counts only. Two families claiming -> refused (the FN-16e conflict rule).
5. `MappedRow` (`src/lib/shared/csv.ts`) gains an optional `review` reason on the OK value (ignored by CSV paths); the server
   returns the preview rows (date, type, masked title, amount, review reason) for the OCR flow only, since OCR needs a per-row
   review that FN-16a's counts-only preview did not.
6. Every screenshot-family parser is labelled **unverified against real screenshots** in its file header and in the report until the
   **You** item below is done.

### 6. Impor UI (Indonesian, 360 px first)

Inside `src/routes/(app)/impor/+page.svelte` (mutasi card at `:614`): a new block `Baca dari foto atau tangkapan layar` next to the
PDF/CSV upload, using the existing card, button and sheet components (no new design language). Controls: `Ambil foto`,
`Pilih dari galeri/berkas`, wallet pick (existing), institution pick (`Deteksi otomatis` default), then the stepper
`Unduh mesin -> Baca -> Tinjau -> Masukkan`.

States (each has copy, an `aria-live` announcement and an automated check where listed in the criteria): idle; unsupported;
downloading (size, percent, `Batal`); download failed (`Coba lagi`); reading (page x of y, `Batal`); camera unavailable;
photo unclear; nothing recognised (`Tidak ada transaksi yang terbaca. Coba tangkapan layar yang lebih jelas.`); partial success
(`12 transaksi terbaca, 3 perlu ditinjau, 1 halaman dilewati`); refused (`inconsistent`, `institution_unknown`, section picker);
preview (summary: pages, rows, in/out totals computed by the server, balance check status, duplicates, `Perlu ditinjau` group
collapsed with the reason in plain words, per-row tick); imported (success only after the server write is confirmed, with
`Lihat di Riwayat` and Undo from import history, as FN-18).

Layout: the two capture buttons stack full width at 360 px with at least 44 px height (coarse pointer), no horizontal scroll, the
row list wraps long titles; focus returns to the opener after a sheet closes; headings do not skip. All text via `tr()`/`trf()`
with an English entry in `src/lib/shared/i18n-en.ts` (including server messages and `trf()` templates).

### 7. Compat harness

- `scripts/compat-ocr.ts` + `npm run compat:ocr [-- --dir .superpowers/ref/samples/ocr]`, modelled on `scripts/compat-statements.ts`:
  for each PNG/JPG in the git-ignored folder, runs tesseract.js in Node with the same local assets and the same `src/lib/shared/ocr`
  pipeline, then prints a table of **counts and shapes only** (file index, pixel size, mean confidence, recognised words, institution
  detected, rows read, rows for review by reason, rows rejected, balance check status, run time); never row text, never amounts,
  never a file name's content. `tesseract.js` in Node is a dev-only import of the script; the script refuses to run on a directory
  outside `.superpowers/ref/samples/`. Missing folder or empty: prints `tidak ada sampel` and exits 0.
- Tested with a Vitest test of the report formatter on fictional data (no engine in CI), like `compat-statements.test.ts`.

## Out of scope

- Claude/AI vision, any OCR on the server, any third-party OCR service, any CDN or tracker.
- Bank PIN/password/OTP, bank login scraping, auto-capture of other apps' screens, Android share target (FN-45/share target is its
  own item).
- Orientation/script detection via `osd.traineddata`, perspective correction, curl unwarping, handwriting, languages other than
  `ind` and `eng`, the legacy Tesseract engine.
- A new `source` value or any migration; storing images, thumbnails or OCR text; sealed results (nothing is kept).
- Automatic stitching of overlapping scroll screenshots; inline editing of an amount in the review list; auto-correction of
  digits from the balance chain.
- Receipt (Struk, FN-15) OCR and item photos; Slack/Gmail paths; a shared `PhotoPicker` (parallel branch; swapped in later).
- Fully offline first-time use; background OCR while the tab is closed; Node-side PDF rendering in the harness.
- Per-bank parsers for institutions without a redacted sample (existing FN-16a posture); BRI/CIMB/Jago statement layouts.

## Acceptance criteria

Verification level in brackets: **Unit** = Vitest, no browser; **Browser** = Playwright, real Chromium; **Manual** = owner on a phone
(listed under Prerequisites). The qa-tester tests these verbatim.

**Assets, versions, CSP**

1. [Unit] `package.json` pins `tesseract.js` 7.0.0, `tesseract.js-core` 7.0.0, `pdfjs-dist` 6.4.299 with exact versions; the ENGINEER_REPORT quotes the
   re-run `npm view` lines (version, license, unpackedSize) and `npm audit` result; a changed version or non-Apache-2.0 license
   (or one outside MIT/Apache-2.0/BSD) fails the task.
2. [Unit] `scripts/ocr-assets.ts` writes `static/_ocr/<version>/` and fails on a SHA-256 mismatch of `ind`/`eng` traineddata, on a missing
   file, and on a tampered file (test with a temp dir and altered bytes). Traineddata pin = commit `87416418...41c29bd` and hashes in
   the PRD table.
3. [Unit] A test lists the built asset set and asserts: only the three `-lstm` `.wasm.js` cores, `worker.min.js`, the pdf.js files and wasm,
   `ind`/`eng`, license notices; no legacy cores, no `*.map`.
4. [Unit] No source or built client file contains `cdn.jsdelivr.net`, `unpkg.com`, `tessdata.projectnaptha.com`, `cdnjs`, or any
   `https://` literal used as a load target by the OCR module; `workerBlobURL` is `false` and `workerPath`, `corePath`, `langPath`
   are explicit `/_ocr/...` paths (grep test on `src/lib/ocr`).
5. [Unit] `sw-policy`: `/_ocr/*` is excluded from `shellPaths` and answered `network`; installing the service worker never fetches
   `/_ocr/` (the precache list contains none).
6. [Browser] Loading `/impor`, `/`, `/dompet` makes **zero** requests to `/_ocr/` and the page's JS payload does not include
   tesseract or pdf.js code; after choosing an image, requests to `/_ocr/` appear, all to the app origin, none to any other host
   (network log asserted).
7. [Unit] `csp.test.ts`: the page policy has `worker-src 'self'`, no `blob:`, no `'unsafe-inline'`, no `'unsafe-eval'`, no `'wasm-unsafe-eval'`;
   `ocrAssetCsp()` quotes `'wasm-unsafe-eval'` (regex fix) and equals the header string tested in criterion 8; `cspHeader()` of the page is
   unchanged except for `worker-src`; the vite config still passes `CSP_DIRECTIVES`.
8. [Browser] The response header of `/_ocr/<v>/worker.min.js` and of a traineddata file is the OCR asset policy (with `nosniff`, immutable
   cache); the page's header lacks `wasm-unsafe-eval`; during a full OCR run on `/impor` the console shows **no CSP violation**
   and no `blob:` worker (checked via `securitypolicyviolation` events and the worker list).
9. [Browser] If the run fails under the page policy because WASM must be compiled on the page thread, the engineer documents it, applies
   the narrowest fallback in Scope 2.4, and the red team reviews it; otherwise this criterion is "not needed" with the test from 8
   as evidence.

**Client states and limits**

10. [Browser] Choosing a PNG screenshot (fictional, drawn in-page on a canvas) shows the download step with a size and progress, then
    `Membaca halaman 1 dari 1`, then the review; `Batal` during download and during reading ends the run, the worker is terminated
    (no `Worker` left), and nothing is posted to the server.
11. [Unit] The capability gate returns `unsupported` when `WebAssembly`, `Worker` or `createImageBitmap` is missing (stubbed globals) and no
    `/_ocr/` request is made; the unsupported copy and the fallback to PDF/CSV are shown.
12. [Unit] A failed download (fetch rejects, 404, wrong size) leaves state `download_failed` with `Coba lagi`; a retry works; an asset
    whose size differs from the pinned manifest is rejected. (Hash check of the traineddata is by build script; the client checks size and
    `Content-Type`.)
13. [Unit] Limits: a 16 MB file, a 6th image, a declared 65 MP JPEG or 25 MP PNG/WebP/HEIC (amended in cycle 2), a PDF over 12 pages (the 13th onward is `pagesNotProcessed`), and a run over
    5 minutes/60 s per page are refused or cut with a specific message; header-dimension reading is tested for PNG, JPEG, WebP with
    crafted headers (including a lying huge size) and refuses before decode.
14. [Browser] At 360 px: both capture actions are visible without scrolling horizontally, stacked, each at least 44 px high, focus ring
    visible, the row list has no horizontal scroll with a 60-character title.
15. [Browser] The camera input has `capture="environment"` and `accept="image/*"`; in a context where no camera/`capture` is honoured the file
    chooser path still completes a run; the "Kamera tidak tersedia" copy appears when `getUserMedia`-style detection (or the input's
    change event with no file after a tap) shows no camera, and focus moves to the gallery pick. (Real camera hardware: Manual.)
16. [Unit] EXIF: fixtures for orientations 1-8 (tiny JPEGs with the tag) yield upright output dimensions and a marker-pixel position test; the
    explicit `imageOrientation: 'from-image'` probe path and the manual-EXIF fallback both pass.
17. [Unit] Deskew: a synthetic text-bar raster rotated by -12, -3, 0, 4, 11 degrees is estimated within 0.75 degree and de-rotated; a blank or
    near-blank page returns 0 (no rotation); input larger than the working size is downscaled first (bounded time).
18. [Unit] Quality gate: a page with mean word confidence below 60 or under 8 words yields `photo_unclear`, and every row from it is
    `review`; a clean page does not.
19. [Unit] Memory discipline: the pipeline processes pages sequentially, closes each bitmap and zeroes each canvas (stubbed objects record
    calls); the scheduler uses exactly one worker; no `URL.createObjectURL` call exists in `src/lib/ocr` (grep test).

**Interpretation (all Unit, shared code, fictional fixtures)**

20. Bank statement text pages derived from an `OcrDocument` of an existing fictional BCA/BNI/Mandiri/OCBC statement fixture produce the same
    rows as the text-layer path; the running-balance chain passes.
21. A numeric word at confidence 60 (below 70) in an amount makes the file `inconsistent` (whole file refused, nothing importable); at confidence
    80 the row is kept with `review: 'low_confidence'`; at 95 it is clean. Boundary values 69/70/89/90 asserted.
22. A letter in a numeric token (`1O.000`, `l.250.000`) is never converted to a digit; the row is rejected/flagged. (A8)
23. A statement that fails its printed running-balance chain, or whose opening + rows differs from the closing, is refused whole
    (`inconsistent`), never imported partially; a statement printing no balances is `omitted` with all rows `review`.
24. E-wallet and mobile-banking screenshot fixtures (>= 3 per family: clean, noisy, partial/cropped) parse to the expected rows; direction
    comes only from an explicit confident sign/marker; missing sign gives `direction_unknown`; failed/cancelled/pending rows are skipped
    and counted; relative dates and missing years give the review reasons in Scope 5.4; no row ever has a future date.
25. Money vectors through the shared parser from screenshot text: `Rp 1.250.000`, `1.250.000,50`, `Rp 28.000,00`, `IDR 1,250,000.00`, `-Rp25.000`,
    `+Rp 100.000`, `25rb`-style text is **not** accepted as a statement amount; amounts are integers; amount above `MAX_AMOUNT_MINOR` or zero is
    rejected.
26. WIB dates: a row at 23:30 WIB on the last day of a month and 00:30 on the first land on the printed date's `occurred_on`; a December/January period
    assigns the right years (`dateInPeriod`).
27. A screenshot printing running saldo with one row whose amount disagrees with the saldo difference marks both neighbouring rows
    `balance_mismatch`; nothing is corrected.
28. Planted-structure checks carried over from FN-16a/e: two bank letterheads in one document are refused (`institution_conflict`); a manual pick of another
    parser is `institution_mismatch`; text planted inside a remark does not change a row's amount or direction.
29. Untrusted text: control and zero-width characters, a 10,000-character word, `<script>` text and a `=cmd|...` title are cleaned/capped; nothing is
    rendered as HTML (Svelte text interpolation only, no `{@html}`); CSV export prefixes are unchanged for imported titles.
30. Same input, same output: the pipeline is deterministic (same `OcrDocument` twice gives identical rows, keys and order).

**Server, import, privacy**

31. [Unit/integration, local D1] `previewOcr`/`importOcr` require a session and a space; a non-member and a removed member get the same 404 as
    other space routes; a wallet id from another space is `not found` before anything is read; two users, two spaces, no leakage
    (checklist cross-space probe).
32. [Unit] The server ignores any client-supplied rows, totals, balance or institution beyond the validated picks: a payload whose words say one
    thing while a hidden `rows`/`totalMinor` field says another imports only what the server computed; unknown keys are refused.
33. [Unit] Bounds: a 513 KB body (413/400), 13 pages, 251 lines, 3,001 words, a 65-character word, confidence 101 or `NaN`, negative or huge
    coordinates, `include`/`exclude` of 10,000 entries or out-of-range indices, a non-JSON or `__proto__` payload each answer 400/413/415, never 500.
34. [Unit/integration] Throttle: the 31st OCR or statement request in the window by one user answers 429; the 30-request bucket is shared with
    `previewStatement`/`importStatement`; 20 concurrent imports of the same payload from one user create each row exactly once (dedupe keys + the
    existing guarded batch); `overTransactionCreateLimit` holds exactly.
35. [Integration] Import writes rows with `source: 'statement'`, keys `ocr:...:<n>`, masked titles, `occurred_on` WIB dates, correct signs and
    `import_batches` counts; importing the same OCR twice (re-scan with different description jitter, same amounts/dates/balances) creates no
    second row; identical rows within one image get distinct `n`; review rows are excluded unless ticked in; excluded normal rows are not written;
    undo removes exactly the batch; a deleted captured row is not recreated by a re-scan.
36. [Unit] No persistence: a grep/test over the diff finds no D1/R2/KV/log/audit write of the `ocr` payload, words or image bytes; `import_batches.filename`
    is null for OCR imports; error paths log a fixed line only; no migration file is added (0034 absent).
37. [Unit] The old file-upload action with an image-only PDF no longer says "perlu dibaca AI"; it points to `Baca di perangkat` (and stays correct
    for the case where the browser cannot OCR).

**Impor review flow and UI**

38. [Browser] Full journey with a fictional in-page-drawn statement screenshot: pick -> download -> read -> preview with the review group and ticks -> import
    -> success only after the server confirms -> rows visible in Riwayat with the right amounts and WIB dates -> undo from history -> gone; reload keeps
    imported state.
39. [Unit] Every state in Scope 6 renders its Indonesian copy and its English twin (`i18n.test.ts` fails on a missing English entry, including `trf()`
    templates and server messages); user copy contains no file path or internal identifier.
40. [Browser] No-JS: the OCR block is hidden or explains it needs JavaScript; the PDF/CSV forms still work without JavaScript; the OCR actions reject a
    non-multipart/oversized body with 400/413, not 500.
41. [Unit] Accessibility: progress, errors and result are in a live region; focus returns to the opener after the review sheet closes; no heading skip;
    touch targets at least 44 px on coarse pointers; AA contrast in both themes (existing `contrast.test.ts` tokens only).
42. [Unit] Idempotent UI: pressing import twice (double tap) sends one request; the in-flight state disables the button; a stale preview (the user changed the
    wallet or ticks) forces a fresh preview before import ("changed meanwhile" rule).

**Compat harness and docs**

43. [Unit] `npm run compat:ocr` with no folder prints `tidak ada sampel`, exit 0; the formatter test shows only counts and shapes; the script refuses a
    directory outside `.superpowers/ref/samples/`.
44. [Review] `docs/FEATURES.md` FN-16 gets the FN-16g line; `docs/TASKS.md`, `docs/ACCEPTANCE.md` and `docs/RUNBOOK.md` (new `npm run ocr:assets`, build needs
    network once) are updated per Tracker impact; CLAUDE.md is **not** edited (a new `source` would be documented in docs only, and none is added).

## Architecture notes

- New: `src/lib/ocr/` (client: gate, loader, run, camera picker, download progress), `src/lib/shared/ocr/` (`image-kind.ts`, `exif.ts`, `deskew.ts`,
  `lines.ts`, `confidence.ts`, `read.ts`, `screens/ewallet.ts`, `screens/mobile-banking.ts`), `src/lib/server/statements/ocr-validation.ts`,
  `ocr-import.ts`, messages in `src/lib/server/imports/messages.ts`, `scripts/ocr-assets.ts`, `scripts/compat-ocr.ts`, one e2e spec
  `e2e/impor-ocr.spec.ts`.
- Touched: `src/lib/server/csp.ts` (+ test), `src/lib/shared/sw-policy.ts` (+ test), `vite.config.ts` (`ssr.noExternal` unaffected; client chunks for the
  OCR module only), `src/routes/(app)/impor/+page.server.ts` and `+page.svelte`, `src/lib/shared/csv.ts` (optional `review` on the OK value),
  `src/lib/shared/i18n.ts` + `i18n-en.ts`, `package.json`, `.gitignore` (`static/_ocr/`, `.ocr-cache/`), `docs/*`.
- Reused unchanged: `parseMoneyAmount`, `statementRow`, `dateInPeriod`, `balanceCheck`, `STATEMENT_PARSERS`, `detectInstitution`/`letterheadClaims`,
  `previewRows`/`importRows`/`fallbackWalletOf`, `cleanText`/`maskAccountNumbers`, `readFormBody`, `overUserAttemptLimit`, `overTransactionCreateLimit`,
  the import history and undo.
- No Worker other than the app Worker is touched; no migration; no new secret or binding. Static assets are served by the existing `ASSETS` binding
  (25 MiB per file limit; the largest OCR file is 3.9 MB).
- Server CPU is small (text parsing, no PDF.js, no WASM) so the Workers CPU cap is not a risk; the work that is heavy runs on the user's phone.
- The pdf.js client build is a second copy of PDF.js next to the server-side `unpdf` bundle; they share nothing and must not be imported by the same
  module (the server one is patched by `scripts/pdfjs-bounded.ts`).
- **As built (cycle 1, engineer):** CSP Scope 2 works as designed, verified in Chromium against `wrangler dev`: the
  `/_ocr/*` rule in the root `_headers` file (option (a)) carries `'wasm-unsafe-eval'` for the engine's own workers,
  pages keep `script-src 'self'` and a full OCR and pdf.js run shows no violation; a negative control without
  `'wasm-unsafe-eval'` on `worker.min.js` fails with a WebAssembly CSP `CompileError`. The fallback of Scope 2.4 was
  not needed. Deviations (page-side tesseract.js module served from `/_ocr/` instead of bundled, explicit core file,
  review-reason priority, extra screenshot safety rules) and the proposed RUNBOOK text are in `ENGINEER_REPORT.md`.

## E2e and test economy (build-feature step 0d, Large; machine has 16 GB shared with another pipeline)

- Logic in Vitest (criteria 1-5, 7, 11-13, 16-37, 39, 41-43); no engine in unit tests, only `OcrDocument` JSON and tiny synthetic rasters.
- **One** Playwright spec file, Chromium only, serial, at most 4 tests: (a) lazy-load and zero third-party requests + CSP header + no violations
  (6, 8); (b) full journey with an in-page generated fictional screenshot, including cancel and the 360 px layout checks (10, 14, 38); (c) camera input
  attributes and fallback (15); (d) a fictional image-only PDF generated in-page (canvas -> minimal PDF built in the test) through pdf.js render + OCR to
  prove the PDF path and `pagesNotProcessed`. No real network except `localhost`. Fixtures are generated in the test, so no binary fixtures are committed
  and none contain real data.
- The full e2e suite runs on `main` before the deploy that ships this (Large). Do not run the OCR spec in parallel with another pipeline's browser work.

## Prerequisites

- No credential, secret or AI key. `.dev.vars.example` is not changed. Build/dev needs network once for `npm run ocr:assets` (GitHub raw for tessdata,
  npm for packages).
- **You** (owner): put redacted real samples in `.superpowers/ref/samples/ocr/` (git-ignored, blanket `.superpowers/` rule, `.gitignore:33`): GoPay, OVO,
  DANA, ShopeePay history screenshots; BCA, Mandiri, BRI, BNI (and others) mobile-banking mutation screenshots; at least one scanned or image-only
  statement PDF exported as PNG pages; at least one phone-camera photo of a paper statement. Redact names, account and card numbers. Then run
  `npm run compat:ocr`. Accuracy on real material is **not verified** until this is done; screenshot layout parsers and the confidence thresholds are
  calibrated from those samples.
- **You**: after merge, one run on a real phone (Android Chrome and iOS Safari) of each path: camera photo, gallery screenshot, scanned PDF (checks camera
  hardware, EXIF in practice, memory on a mid-range phone, download time on mobile data).
- When assets are missing at runtime (the build step was skipped), the OCR block shows `Mesin baca belum terpasang di server ini.` and the other import paths
  keep working (same `Belum dikonfigurasi`-style unavailable behaviour).

## Tracker impact

- `docs/TASKS.md`: line 67 `- [ ] **Claude** — FN-15 Receipt · FN-16 Statement · FN-17 Spreadsheet (blocked by AI Gateway key for Pass level).` : add
  `FN-16g on-device OCR (no key needed)` as done; the "Baca dengan AI" half of FN-16 (image PDFs/screenshots via Claude) is superseded by this decision and
  noted as such; add the **You** items above (samples, real-phone check).
- `docs/FEATURES.md` FN-16: add an "Ours - FN-16g" paragraph (on-device OCR, camera, limits, what leaves the device).
- `docs/ACCEPTANCE.md`: row "Uploaded files never written to R2 or D1; partner copy deleted" may move for the OCR path with the named check from criterion 36; the
  journey row "Statement PDF (password) -> balance check -> duplicates excluded -> import -> undo" stays Not run for real banks; add a row "Scanned statement,
  screenshot and camera photo OCR accuracy on real samples": **Not run** until the owner's samples are processed; browser rows only with the named Playwright
  spec.
- `docs/RUNBOOK.md`: `npm run ocr:assets`, the pinned versions and hashes, how to bump (re-run the verification commands, update the manifest, re-run the
  harness), and the `/_ocr/` CSP header.
- `docs/HISTORY.md`: at completion, with what is NOT verified (real screenshots, real camera hardware, real phones).
