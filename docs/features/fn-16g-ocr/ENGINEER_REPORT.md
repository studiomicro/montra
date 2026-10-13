# FN-16g On-device OCR: engineer report (cycle 1)

Branch `feat/fn-16g-ocr` (based on `integrate/2026-10-10`). No migration (0034 unused). No new secret or binding.

## Versions, licences, sizes (re-verified 2026-10-10)

`npm view <pkg> version license dist.unpackedSize`:

```
tesseract.js@7.0.0: version = '7.0.0' license = 'Apache-2.0' dist.unpackedSize = 1411341
tesseract.js-core@7.0.0: version = '7.0.0' license = 'Apache-2.0' dist.unpackedSize = 45262431
pdfjs-dist@6.4.299: version = '6.4.299' license = 'Apache-2.0' dist.unpackedSize = 34913648
```

Pinned exactly in `package.json` (`npm install --save-exact`). `npm audit --omit=dev`: `found 0 vulnerabilities`.
Full `npm audit`: 3 high, all `sharp <0.35.5` (dev, pre-existing, identical before the install).

Install scripts: `tesseract.js` declares `postinstall: opencollective-postinstall || true`. This npm runs no
unapproved install script (`npm warn install-scripts … tesseract.js@7.0.0 (postinstall …)` — not approved, not
run). Nothing needs it.

Files served (bytes, exact, also pinned in `src/lib/shared/ocr/assets.ts`; gzip -9 for the wire estimate):

| File | Bytes | gzip |
| - | - | - |
| `worker.min.js` | 111,307 | 33,625 |
| `tesseract.esm.min.js` (page-side module) | 63,220 | 10,615 |
| `core/tesseract-core-simd-lstm.wasm.js` | 3,899,472 | 1,461,552 |
| `core/tesseract-core-relaxedsimd-lstm.wasm.js` | 3,905,767 | — |
| `core/tesseract-core-lstm.wasm.js` | 3,896,484 | — |
| `lang/ind.traineddata` (SHA-256 69786901…95d88) | 1,122,661 | 607,776 |
| `lang/eng.traineddata` (SHA-256 7d4322bd…170b2) | 4,113,088 | 1,967,615 |
| `pdf/pdf.min.mjs` | 458,904 | 131,591 |
| `pdf/pdf.worker.min.mjs` | 1,264,342 | 374,051 |
| `pdf/wasm/openjpeg.wasm`, `jbig2.wasm`, `qcms_bg.wasm` | 251,131 / 103,671 / 96,589 | — |

One image run downloads 9,309,748 bytes decoded (about 4.1 MB gzip on the wire); a PDF adds 1,723,246. The UI
shows the decoded figure ("sekitar 9,3 MB"), because that is what its byte counter counts. The whole folder is
19.3 MB plus licences; the largest file is 4.1 MB (Workers static asset limit 25 MiB).

`eval(` / `new Function` / `Function(` in the shipped files: cores 0/0/0; `pdf.min.mjs` 0/0/0;
`pdf.worker.min.mjs` 1 `new Function` match is `new FunctionBasedShading` (a class name); `worker.min.js` and
`tesseract.esm.min.js` only the webpack/regenerator fallbacks `new Function("return this")` and
`Function("r","regeneratorRuntime = r")`, both behind a `typeof globalThis` check that is always true in a
browser. No `https://` host other than the unused default `cdn.jsdelivr.net` strings inside the two tesseract.js
files; every location is overridden (`engine.ts`), and both CSPs would block any other host anyway.

## CSP (PRD Scope 2) — verified in Chromium

- Pages: `worker-src 'self'` added to `CSP_DIRECTIVES` (SvelteKit global config); no `blob:`, no
  `'wasm-unsafe-eval'`. `cspHeader()`'s quoting regex knows `wasm-unsafe-eval`.
- `/_ocr/*`: `Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self';
  worker-src 'none'; base-uri 'none'` + `Cache-Control: public, max-age=31536000, immutable`, attached by the root
  `_headers` file (option (a) of the PRD: adapter-cloudflare copies it into the build and appends its own
  `/_app/*` rules; Workers Assets serves the files without running the Worker). `nosniff` comes from the existing
  `/*` rule. `csp.test.ts` asserts `_headers` carries exactly `ocrAssetCsp()`.
- Browser evidence (`wrangler dev` of the build, Playwright Chromium):
  - A real OCR run (tesseract.js worker from `/_ocr/…/worker.min.js`, `workerBlobURL: false`) and a pdf.js
    render (worker `pdf.worker.min.mjs`) complete with **zero** CSP violations under the page policy
    `script-src 'self' 'nonce-…'` (no `wasm-unsafe-eval`).
  - Negative control: serving `worker.min.js` with `script-src 'self'` (no `'wasm-unsafe-eval'`) makes the worker
    fail with `CompileError: WebAssembly.instantiate(): … violates … "script-src 'self'"`. So the dedicated worker
    runs under its own response policy, and the per-resource scoping is what enables WebAssembly — on no page.
  - `e2e/impor-ocr.spec.ts` test 1 asserts the `/_ocr/` response headers, the page header, zero `/_ocr/`
    requests before a pick, no `blob:` worker, no request to another origin, no violation during the run.
- Criterion 9 (fallback `'wasm-unsafe-eval'` on `/impor`): **not needed** (evidence above).
- Pre-existing, not FN-16g: every app page reports one `script-src eval` violation on load from zod's JIT probe
  (`Function('')` inside a try/catch, client chunk shared by the app entry). The e2e test clears it before the
  pick; flagged here for the red team.

### Proposed RUNBOOK text (for the orchestrator)

> **On-device OCR engine (FN-16g).** `npm run ocr:assets` (also run by `npm run build` and `npm run dev`) copies
> the pinned tesseract.js 7.0.0 / tesseract.js-core 7.0.0 / pdfjs-dist 6.4.299 files from `node_modules` and
> downloads `ind`/`eng` tessdata_fast from commit `87416418657359cb625c412a48b6e1d6d41c29bd` into the git-ignored
> `static/_ocr/<version>/` (downloads cached in `.ocr-cache/`; every file, npm or downloaded, is checked against its pinned size and SHA-256, also when the
> "already built" shortcut applies; any mismatch fails the build). The first build on a machine needs network to raw.githubusercontent.com. The files are served as static
> assets under `/_ocr/<version>/` with the policy in the root `_headers` (`/_ocr/*`: `script-src 'self'
> 'wasm-unsafe-eval'`, immutable cache); pages never get `'wasm-unsafe-eval'`. **Bumping a version:** re-run
> `npm view <pkg> version license dist.unpackedSize`, update the pins in `package.json` and the sizes and SHA-256 hashes (every entry) and
> `OCR_ASSET_VERSION` in `src/lib/shared/ocr/assets.ts` (a new folder name, because the old one is cached as
> immutable), run `npm run ocr:assets -- --force`, then `npm run compat:ocr` on the owner's samples and the
> `e2e/impor-ocr.spec.ts` spec. If the OCR block says "Mesin baca belum terpasang di server ini.", the build ran
> without `ocr:assets`.
>
> **CI and deploy (red team L2).** Install with `npm ci --ignore-scripts`: `tesseract.js` has an install script
> (`opencollective-postinstall || true`) that serves no purpose here, and the build runs no package script except
> `ocr:assets` itself. The build needs network access to raw.githubusercontent.com for the two language files
> (pinned commit, SHA-256 checked) unless `static/_ocr/<version>/` or `.ocr-cache/` is already present and
> intact; a clean build with GitHub unreachable fails with "download failed". Keep `.ocr-cache/` between CI
> builds (cache key: `TESSDATA_FAST_COMMIT`) to avoid that dependency.

## Cycle 2 fixes (red team report, cycle 1)

- **M1:** the OCR dedupe tuple now starts with the institution id, the section's `accountLast4` (empty when the
  file has none) and the target wallet id. A re-scan into the same wallet keeps its keys; the same date and
  amount at another bank, account or wallet is a new record. Keys differ from cycle 1's (nothing shipped yet).
- **L1:** `OCR_ASSETS` pins a SHA-256 for every file (npm files too); `verifyAsset` checks it for all, and
  `ocrAssetsCurrent` hashes the built files instead of trusting sizes.
- **L3:** PNG, WebP and HEIC over 24 MP declared are refused before decoding (`too_big_to_decode`); a HEIC's size
  is read from its `ispe` boxes in the 512 KB head and a HEIC without one is refused as damaged. JPEG keeps the
  64 MP cap (it decodes scaled). A 24 to 64 MP HEIC (a 48 MP phone mode) now has to be saved as JPG.
- **L2:** no code change; the ops note is in the RUNBOOK text above.

## As built: choices and deviations from the PRD text

- tesseract.js's page-side module is served from `/_ocr/` (`tesseract.esm.min.js`) and loaded with a dynamic
  `import()`, not bundled by Vite: the app bundle then holds none of the library and none of its CDN default
  strings (criterion 4 checks built chunks). pdf.js likewise (`pdf/pdf.min.mjs`).
- `corePath` is the explicit core file, chosen with the same relaxed-SIMD/SIMD probe modules tesseract.js uses,
  so the download step can prefetch exactly that file with a byte counter (tesseract's own progress has no bytes).
  The browser HTTP cache then serves the worker's `importScripts`.
- pdfjs-dist 6.4.299 has no `isEvalSupported` / `enableScripting` getDocument options (not in its types);
  `pdf.min.mjs` has no eval, and the workers' policy has no `'unsafe-eval'`.
- A screenshot row with a lost or unsure sign is `direction_unknown`; ticked in, it imports as an expense, which
  the review row says in words ("dianggap pengeluaran"). No inline editing (A6).
- A row shows one review reason (priority: direction, balance mismatch, low confidence, photo unclear, year
  assumed, relative date, overlap, no balance check).
- Screenshot rules added for safety: a figure poisoned (< 70) anywhere below the status-bar line refuses the
  whole screenshot reading; a row line with more than amount + unsigned running balance is unreadable (a figure
  planted next to the amount never prices the row); an assumed year that would make a future date rejects the row.
- Bank statements: the per-bank parsers give no word positions, so `low_confidence` marks every row whose amount
  or day/month equals a figure read at 70–89 (errs towards review).
- A word longer than 64 characters is refused (400), not cut, by the server's schema.
- HEIC (superseded by cycle 2, L3): the size is read from the `ispe` boxes in the 512 KB head and refused above
  24 MP before decoding; a HEIC without a readable `ispe` there is refused. Chrome cannot decode HEIC and shows
  "Gambar tidak bisa dibaca di perangkat ini…".
- The compat harness feeds images to the engine directly (no EXIF/deskew in Node, no canvas).
- `hasReadableText`, the EXIF orientation reader and the multi-account section picker moved to shared modules
  (`statements/text-layer.ts`, `ocr/exif.ts`, `statements/sections.ts`) so device and server use one rule.

## Not verified

Real screenshots, real camera hardware, real phones, real scanned statements: the screenshot layout parsers and
the confidence thresholds (70/90, unclear < 60 or < 8 words) are written from the PRD and fictional fixtures only
(owner items in the PRD Prerequisites).
