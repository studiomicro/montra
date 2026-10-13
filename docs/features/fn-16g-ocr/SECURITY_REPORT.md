# FN-16g on-device OCR: red team report (cycle 1)

Diff reviewed: `git diff 58e5d2c..HEAD` (engineer d7a72b7, QA c50e83f), with PRD, ENGINEER_REPORT and QA_REPORT.

**Verdict: PASS** (cycle 2: M1, L1 and L3 fixed and verified; no medium or high finding remains; see "Cycle 2 re-check" below). Cycle 1 was FAIL on M1.

## Commands run

- `npx vitest run src/lib/server/csp.test.ts src/lib/shared/sw-policy.test.ts scripts/ocr-assets.test.ts src/lib/ocr/guard.test.ts src/lib/shared/ocr/image-kind.test.ts src/lib/shared/ocr/exif.test.ts`: `Test Files 6 passed (6)`, `Tests 38 passed (38)`.
- `npx vitest run test/integration/impor-ocr.test.ts test/integration/impor-ocr-qa.test.ts`: `Test Files 2 passed (2)`, `Tests 16 passed (16)` (local D1).
- A temporary probe test (deleted afterwards, nothing committed) ran `parseOcrFields` and `readOcrDocument` on payloads at the 512 KB cap. Results: 12 pages of 250 lines took 10-21 ms to parse and 6-19 ms to read; 960 GoPay-style rows took 9.6 ms and 13.9 ms. `__proto__` and `constructor.prototype` keys were refused (`ok: false`) and `Object.prototype` stayed clean.
- Greps over `static/_ocr/<version>/` and `node_modules`: no `isEvalSupported`; one `new Function("return this")` (the webpack global probe in `worker.min.js`, inside try/catch); jsDelivr default URLs inside `worker.min.js`; `tesseract.js` has an install script (`opencollective-postinstall || true`).

## CSP review (owner focus): no change needed

- **Page policy** (`src/lib/server/csp.ts:21`): `worker-src 'self'` was added. It is exactly the old fallback through `script-src 'self'`, so nothing gets looser. `source()` (`csp.ts:30`) now quotes `wasm-unsafe-eval`, but `CSP_DIRECTIVES` never uses that keyword. `csp.test.ts` checks that `blob:`, `unsafe-inline`, `'unsafe-eval'` and `wasm-unsafe-eval` are all absent, and that the page header is unchanged apart from `worker-src`. Prerendered pages use the same `cspHeader()`.
- **`/_ocr/*` rule** (`_headers:24-26`): the header is `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; base-uri 'none'`. It has no `blob:`, no `data:`, no third-party origin and no `'unsafe-inline'` or `'unsafe-eval'`. A test keeps it equal to `ocrAssetCsp()`, and `nosniff` comes from the `/*` rule.
- **Can the wasm permission reach app pages?** No.
  - `_headers` applies only to responses that Workers Assets serves.
  - `wrangler.jsonc:9` sets `html_handling: "none"` and has no `not_found_handling`. A missing `/_ocr/...` file therefore goes to the Worker and gets the page CSP, not the wasm policy.
  - The page imports `tesseract.esm.min.js` and `pdf.min.mjs` as modules, so they run under the page policy. Only the two dedicated workers (`worker.min.js`, `pdf.worker.min.mjs`) run under the `/_ocr/` policy.
  - The engineer's negative control confirms per-response scoping: the worker fails under `script-src 'self'` alone.
- **Other files served with the wasm-enabled policy:** only the fixed `OCR_ASSETS` list (JS, wasm, traineddata, licence texts) plus `THIRD_PARTY_NOTICES.txt`. There is no HTML or SVG. A licence file without an extension is served as non-HTML with `nosniff`, and `default-src 'none'` covers it even if someone opens it directly. `buildOcrAssets` deletes every other version folder. Nothing else under `static/` matches `/_ocr/*`.
- **Service worker** (`src/lib/shared/sw-policy.ts:15,34,54`): `/_ocr/` is never precached and is always `network`. Navigations keep `navigate`. The policy is tested.
- **Remaining exposure:** a script that already runs on the page (XSS) could start the `/_ocr/` worker and pass any same-origin `corePath`, and that worker can compile wasm. This gains nothing beyond what XSS already has. `connect-src 'self'` and `script-src 'self'` stop the jsDelivr defaults in `worker.min.js` even if the overrides in `engine.ts` were removed.
- **Checklist "CSP: per-route additions only":** the page `worker-src 'self'` is global but restates the existing fallback, so it is compliant in substance.

## Findings

### M1 (medium): the OCR dedupe key collides across banks, accounts, wallets and screenshot apps, so genuine rows are silently skipped for good

`src/lib/server/statements/ocr-import.ts:111` builds the key tuple as `date|signedAmount|keyPart`:

- For every scanned statement, `keyPart` is `''` (`src/lib/shared/ocr/read.ts:170`).
- For a screenshot row with no printed balance and no time, `keyPart` is also `''` (`src/lib/shared/ocr/screens/common.ts:496`).

The "already imported" lookup is scoped by space and source only (`src/lib/server/imports/csv-import.ts:153-155`), and every OCR row has source `statement`. The key carries no institution, account (`accountLast4` or section), wallet or screenshot family.

**Repro:** in one space, import a scanned BCA September statement that holds `30/09 BIAYA ADM -10.000,00` into wallet A. Then import a scanned Mandiri September statement that holds `30/09 Biaya Adm -10.000` into wallet B. Both rows get `ocr:<sha256("2026-09-30|-1000000|")>:0`. The Mandiri row is counted as "already" and never written.

- The Mandiri statement passed its own balance check, so wallet B's total is now wrong.
- The "Mungkin duplikat" backstop does not flag this case: it matches on the same wallet, and the row is filtered before that check anyway.
- Under the tombstone rule, deleting the BCA row does not free the key, so the Mandiri row cannot be imported by OCR later either.
- A GoPay screenshot of a `-Rp25.000` payment on day D likewise blocks a `-25.000` bank debit on day D from a statement scan.

QA finding 2 covered only same-account re-scans. This cross-account case is a new failure mode. It silently loses records in a finance app during ordinary use.

**Fix:** put the institution id and the account scope (the section's `accountLast4` when present, and the fallback wallet id) into the tuple. The PRD's re-scan idempotence still holds, because a re-scan has the same institution and account. Add a test for two institutions with the same date and amount in one space.

### L1 (low): npm-sourced engine files are checked by size only, and the fast path trusts sizes for every file

`scripts/ocr-assets.ts:50` checks SHA-256 only for the two tessdata files. The engine JS and wasm files are verified by byte count only. `ocrAssetsCurrent` (`scripts/ocr-assets.ts:140-146`) skips the whole rebuild when sizes match, and that includes the hash-pinned language files.

The npm lockfile's `sha512` integrity protects clean installs. It does not protect a dev machine whose `node_modules` or `static/_ocr/` was altered with sizes kept, for example by a malicious dependency's install script. `npm run build` or `deploy:staging` from that tree would then ship the altered worker code under the wasm-enabled policy.

**Fix:** pin SHA-256 for every `OCR_ASSETS` entry and verify the hashes in the fast path too (about 20 MB, tens of ms).

### L2 (low): `tesseract.js` brings an install-time script and a build-time network fetch

- `tesseract.js@7.0.0` has `hasInstallScript: true` (`opencollective-postinstall || true`), which runs on every `npm ci`. Its runtime dependencies (`node-fetch`, `is-url`, `idb-keyval` and others) are installed but never shipped; only `dist/` files are copied.
- `npm run dev` and `npm run build` fetch tessdata from `raw.githubusercontent.com` with redirects followed. The SHA-256 pin makes this safe for integrity, but a clean build fails when GitHub is unreachable.

**Accept or mitigate:** run `npm ci --ignore-scripts` in deploy and CI, and keep `.ocr-cache/` between builds.

**Resolution (2026-10-13, corrected in cycle 2): FIX.** CI is on main (`5a486bc`): `ci.yml` and `deploy-staging.yml` install with `npm ci --ignore-scripts`, so the install script never runs. `ci.yml` now restores `.ocr-cache/` in the `build` and `e2e` jobs (key `ocr-<hash of src/lib/shared/ocr/assets.ts>`) and saves it only from pushes to main, so a warm build does not depend on GitHub being reachable and pull requests from forks never write it. `docs/RUNBOOK.md` › On-device OCR assets keeps both lines.

### L3 (low): client decode limits can be bypassed by a crafted image

- HEIC is accepted with no declared-size check (`src/lib/shared/ocr/image-kind.ts:133`). `imagePage` then decodes it at native size, because no resize option is set when `size` is null (`src/lib/ocr/image.ts:114`). `readingSize` applies only after the full decode.
- PNG and WebP at the 64 MP declared limit decode to about 256 MB RGBA before scaling, because `createImageBitmap` resize options do not guarantee a reduced decode.

**Effect:** a crafted image, for example one sent over chat and then picked, can crash the tab on a mid-range phone. Nothing leaks and it costs only the person's own session.

**Fix (optional):** parse the HEIF `ispe` box for the declared size, or lower the declared-pixel cap for PNG and WebP.

### Info

- **I1:** confidences and word positions come from the client, so the 69/70/90 confidence gates and the `low_confidence` review only protect against honest mistakes. A forged `c: 100` skips review. This does not cross any boundary, because the same user can type rows in by hand, and the server rebuilds all text, totals, balance checks, picks and keys. Everything is bounded by zod `strictObject`, the 512 KB body cap, the shared `statement-upload` throttle (checked before the body is read) and `overTransactionCreateLimit` on import.
- **I2:** `cacheMethod: 'write'` lets tesseract.js keep the public language data in IndexedDB. It holds no user data. The client sends no image or file name, and the server stores no words, text or logs (`guardedDb` logs a fixed line plus `errorLabel`). `filename` is null.
- **I3:** the OCR actions are not in `inStatementLane`. This is acceptable: the measured CPU cost is in the tens of milliseconds and the shared throttle applies.
- **I4:** the server EXIF refactor (`src/lib/server/photos/image.ts` now calls `exifOrientationAt`) is equivalent and its bounds are stricter (`Math.min(end, b.length)`, `o < 0`).

## Checked, no issue

- **Cross-space access:** `currentSpaceScope` is used on both actions. `fallbackWalletOf` checks the wallet against the space before anything is read (another space's wallet returns 404). Dedupe lookups are filtered by `space_id`, and two spaces importing the same reading both write their rows.
- **Untrusted OCR text:**
  - Each word goes through `cleanText`, which removes control and zero-width characters, normalises to NFC and caps the length at 64.
  - The server rebuilds each line's text.
  - `maskRow` masks digit runs in titles, notes and wallet names.
  - The component has no `{@html}` or `innerHTML`, and its `{#each}` blocks are keyed by index.
  - The existing export applies the formula-prefix rule.
- **Bounds:** `picks` indexes are bounded and checked against the row count. `institution` must come from the known parser list. Section is at most 2 digits. Wallet id length is checked. Unknown fields are refused, and hidden `rows` or `totalMinor` fields are ignored.
- **Client:**
  - File type is detected from magic bytes; the 15 MB, 5-image and 12-page caps hold, and declared pixels are capped at 64 MP.
  - The JPEG SOF walk and the EXIF IFD0 read stop after a fixed count (4096 segments, 512 entries) and stay inside the 64 KB head; they cannot read out of bounds.
  - pdf.js runs with `maxImageSize`, `disableFontFace` and no system fonts, and version 6.4.299 includes the fix for CVE-2024-4367.
  - Every engine path is set explicitly, `workerBlobURL: false`, and no object URL is created.

---

## Cycle 2 re-check

Diff reviewed: `git diff 2992eac..bbf3e66` (engineer 4f22c43, QA bbf3e66), with this report and the QA "Cycle 2 re-check" section. No source edited.

**Verdict: PASS** (no medium or high finding; M1, L1 and L3 fixed; two new low findings, L4 and L5)

### Commands run

- `git diff 2992eac..bbf3e66 -- src/lib/server/csp.ts _headers 'src/service-worker*'`: empty (0 lines). The CSP files are untouched since cycle 1, so the cycle 1 CSP review stands.
- `npx vitest run scripts/ocr-assets.test.ts src/lib/shared/ocr/image-kind.test.ts test/integration/impor-ocr.test.ts`: `Test Files 3 passed (3)`, `Tests 27 passed (27)`. No process left running.

### Status of cycle 1 findings

| Finding | Status | Evidence |
| - | - | - |
| M1 dedupe key collides across bank, account, wallet | Fixed | See M1 review below |
| L1 npm files size-only, fast path trusts sizes | Fixed (residual: L4) | See L1 review below |
| L2 install script and build-time fetch | Open, accepted (unchanged) | Not in the diff. Mitigation stays: `npm ci --ignore-scripts` in deploy and CI, keep `.ocr-cache/` |
| L3 client decode limits | Fixed (residual: L5) | See L3 review below |
| I1 to I4 | Unchanged | Not touched by the diff |

### M1 review: fixed, no new suppression or collision

`src/lib/server/statements/ocr-import.ts:106-122`: the tuple is now `institution.id | accountLast4 | defaultWalletId | date | signed amount | balance-or-time`, hashed to 128 bits, with `n` the occurrence in the reading.

- **Institution cannot be forged to a wrong value.** The key uses `reading.institution.id`, which the server derives from the rebuilt text (`read.ts:160,198`). The client `institution` field is only a hint, checked against the known parser lists (`ocr-validation.ts:140-144`) and refused with `institution_mismatch` when it disagrees with the letterhead or screenshot family (`read.ts:229-239`).
- **`accountLast4` comes from the server's parse** of the text (`mandiri.ts:322`, `ocbc.ts:340`: `account.slice(-4)` of a digit run), not from a client field. The client controls the words, so it can print any account number. The only effect is a different scope for its own rows, which means a re-import is not recognised as "already". That is the same power as typing the rows by hand, stays inside the caller's own space, and the "Mungkin duplikat" backstop (same wallet, same amount, at most one day apart) still flags it. Suppressing someone else's future row needs a real write of a matching row first, and `space_id` scopes the lookup (`csv-import.ts:153`), so no cross-space effect.
- **Delimiter injection into the tuple: not possible.** `institution.id` is a fixed parser id, `accountLast4` is digits, and the wallet id used in `importOcr` has already passed `fallbackWalletOf`, so it is an existing id of this space. The `|` join cannot be made ambiguous.
- **`defaultWalletId` is checked against the space.** `importOcr` (`ocr-import.ts:220`) calls `fallbackWalletOf` -> `getWallet(db, spaceId, id)` before `prepare` (`csv-import.ts:303-312`); another space's id returns `wallet_not_found` (404), the same answer as a missing id. `previewOcr` hashes the unchecked id but writes nothing and returns neither the id nor the hash; the lookup is space-scoped, so there is no wallet-existence oracle.
- **The scope matches the real destination.** OCR rows are built with `walletName: ''` (`statements/rows.ts:73`), so every row goes to the fallback wallet. A different wallet gives a different key and the same wallet gives the same key. Tests cover BCA into two wallets, Mandiri against BCA, and a repeat into one wallet (`impor-ocr.test.ts`, passing).
- **Residual (accepted by QA, not a finding):** a re-scan after switching between "no wallet" and an explicit wallet is not recognised as "already". Rows with no wallet are not written at all, so the only case is a deliberate second import, which the duplicate backstop flags.

### L1 review: fixed

- Every `OCR_ASSETS` entry now carries a SHA-256: the 5 engine files, 5 pdf.js files, 11 licence files, and the 2 tessdata files (already pinned). The `from` type requires `sha256` on both variants, so an entry without one fails type-check.
- `verifyAsset` (`scripts/ocr-assets.ts:45-52`) now checks size then hash for all kinds. `buildOcrAssets` verifies the npm bytes before copying, and the test passes (including the loop over `node_modules` files against the pins).
- `ocrAssetsCurrent` (`scripts/ocr-assets.ts:139-160`) now reads and hashes each file; an altered file of the same size is rebuilt, not trusted. A failed read or hash returns false (rebuild).

### L3 review: fixed

- **PNG, WebP, HEIC cap.** `checkOcrFile` (`image-kind.ts:154-165`) refuses a non-JPEG above `OCR_MAX_FULL_DECODE_PIXELS` (24 MP) with `too_big_to_decode`, and anything above 64 MP with `too_many_pixels`, before any decode. The UI maps the new refusal (`OcrImport.svelte:164-171`) and the English string exists.
- **HEIC `ispe` parsing is bounded** (`image-kind.ts:118-130`). The loop runs `i` from 4 to `length - 16`, so the reads `u32be(i-4)` and `u32be(i+8..i+15)` stay inside the head (512 KB, `OcrImport.svelte:231`). It does one pass, with no recursion and no offset taken from file content, so a malicious box cannot make it read out of bounds or loop. A box size other than exactly 20 is skipped. `width * height` of two 32-bit values is a double, at most about 1.8e19, which never wraps or turns negative, so a huge claim exceeds the cap. The largest `ispe` wins, so a small decoy cannot hide a larger one inside the head. No `ispe` gives `malformed`.
- **HEIC `size` is returned as null** so the browser's rotation box is still honoured; the `readingSize` scaling after decode stays as before.

### New findings

#### L4 (low): the "already built" fast path ignores extra files in `static/_ocr/<version>/`

`ocrAssetsCurrent` (`scripts/ocr-assets.ts:139-160`) checks the listed files and that `THIRD_PARTY_NOTICES.txt` exists, but not that the folder holds nothing else, nor the notices' content. A file planted in the version folder (for example an `.html` or `.svg`) survives the shortcut and ships under the `/_ocr/*` header (`script-src 'self' 'wasm-unsafe-eval'`). The full rebuild would delete it (`rmSync(target)`), but the shortcut never runs it. This needs write access to the build tree, the same precondition as L1, and `static/_ocr/` is git-ignored, so a clean CI build is unaffected.

**Fix (optional):** in `ocrAssetsCurrent`, list the folder and return false when it holds any path outside `OCR_ASSETS` plus the notices file.

**Resolution (2026-10-13): FIX.** `fix(import): OCR assets shortcut refuses extra files; HEIC size read from the walked meta box (FN-16g L4, L5)`. `ocrAssetsCurrent` now lists the version folder and returns false when it holds any file outside the pinned set plus the notices file, or when the notices text differs, so the rebuild removes planted files. Test: `scripts/ocr-assets.test.ts` "red team L4: a planted extra file or edited notices makes the folder not current (rebuilt)".

#### L5 (low): the HEIC size check can be skipped by a file whose real `meta` box is past the first 512 KB

`heicSize` reads only the 512 KB head. HEIF allows `meta` after `mdat`. A crafted file with a small decoy `ispe` pattern in the head and the real, huge `ispe` later passes the check, and the browser then decodes it at full size. The check is a pattern scan of the head, not a box walk. The effect is the same as cycle 1 L3: a tab crash on the person's own device, nothing leaks. It is much narrower than before (the file has to be crafted on purpose), and a normal iPhone or Android HEIC carries `meta` first.

**Fix (optional):** walk the top-level boxes to `meta`, and refuse a HEIC whose `meta` box does not end inside the head.

**Resolution (2026-10-13): FIX.** `fix(import): OCR assets shortcut refuses extra files; HEIC size read from the walked meta box (FN-16g L4, L5)`. The picker walks the top-level boxes by their sizes (`heicMetaBox`, at most 64 boxes, 64-bit sizes followed, reading only box headers and then the `meta` box, at most 512 KB) and `checkOcrFile` reads `ispe` only inside that `meta` box. A decoy elsewhere in the head is ignored, and a valid HEIC whose `meta` comes after a large `mdat` (I5, QA finding 3) is read instead of refused as damaged. Tests: `image-kind.test.ts` "red team L5: only the top-level meta box is read, wherever it is; a decoy elsewhere is ignored" and the reworked L3 test. Still synthetic boxes only: no real iPhone or Samsung HEIC was available.

### Info

- **I5:** the prior QA note that a valid HEIC with `meta` after a large `mdat` is refused as "Gambar rusak atau tidak lengkap" is the same condition as L5 seen from the honest side. A box walk would fix both.
- **I6:** `buildOcrAssets` hashes the npm bytes and then calls `copyFileSync` on the path, so there is a read-then-copy gap. Exploiting it needs a local attacker racing the build, which is outside the threat model here.

### Checklist

No new route, loader, action, migration, storage or logging in the diff. No secret or PII path touched; the key hashes only fixed ids, digits and amounts and stays server-side. CSP, `_headers` and the service worker are unchanged.
