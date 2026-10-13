# FN-16g on-device OCR: QA report (cycle 1, commit d7a72b7)

**Verdict: PASS** (latest: cycle 2 re-check, commit 4f22c43, PASS; cycle 1 PASS with non-blocking findings below)

## Commands run

- `npm run gates` -> exit 0; svelte-check 0 errors 0 warnings; prettier + eslint clean; vitest `Test Files 275 passed (275)`, `Tests 4048 passed (4048)` (local D1, fixtures); build ok. Fixtures and mocks only, no real provider.
- `E2E_PORT=8963 npx playwright test e2e/impor-ocr.spec.ts e2e/impor.spec.ts --project=phone` -> `18 passed (23.0s)`, exit 0 (real Chromium against `wrangler dev`, real Tesseract/pdf.js engine from `/_ocr/`, fictional in-page drawn images, localhost only).
- `npx vitest run test/integration/impor-ocr-qa.test.ts` -> `Test Files 1 passed (1)`, `Tests 7 passed (7)` (added by QA, local D1).
- `npx eslint test/integration/impor-ocr-qa.test.ts`, `npx prettier --check` (via write) and `npx svelte-check --fail-on-warnings` -> 0 errors, 0 warnings.
- `npm run compat:ocr` -> prints `tidak ada sampel`, exit 0.

No migration added (highest is 0032; no 0034), so no `db:migrate:local` run. No background process of mine left (the workerd/wrangler processes seen belong to another pipeline).

## Checked criteria

| # | Result | Evidence |
| - | - | - |
| 1 | PASS | `package.json` exact pins (QA test "pins the three engine packages exactly"); engineer quotes `npm view` lines and `npm audit --omit=dev` 0 vulnerabilities (not re-run by QA) |
| 2, 3 | PASS | `scripts/ocr-assets.test.ts` (hash mismatch, tampered cache, missing file, wrong size, asset set) in gates |
| 4, 19 | PASS | `src/lib/ocr/guard.test.ts` (no CDN, no `https://` load target, no `createObjectURL`), `pipeline.test.ts` (sequential pages, one engine, canvas release) |
| 5 | PASS | `sw-policy.test.ts` "the on-device OCR engine" |
| 6, 8, 9 | PASS | e2e test 1 (zero `/_ocr/` before pick, same-origin only, headers, no violation, no `blob:` worker); criterion 9 "not needed" |
| 7 | PASS | `csp.test.ts`, `static-headers` (header equals `ocrAssetCsp()`), page CSP has `worker-src 'self'` only |
| 10, 14, 38 | PASS | e2e test 2 (cancel, full journey, 360 px >= 44 px stacked, import, Riwayat, undo, reload, double-click sends one request) |
| 11, 12, 13 | PASS | `support.test.ts`, `image-kind.test.ts`, `pipeline.test.ts` |
| 15, 40 | PASS | e2e test 3 (capture input attrs, no-camera copy, focus to gallery) and `impor.spec.ts` no-JS tests |
| 16, 17 | PASS | `exif.test.ts` (orientations 1-8), `deskew.test.ts` |
| 18 | PASS | `lines.test.ts` (photo_unclear, every row review) |
| 20-30 | PASS | `read.statements.test.ts`, `read.screens.test.ts` (boundaries 69/70/89/90, letters never digits, balance chain refused whole, WIB 23:30/00:30, Dec/Jan, mismatch neighbours, planted text, determinism) |
| 21 at server | PASS | QA test: 69 refused whole (400), 70 and 89 review and left out unless ticked, 90 clean |
| 29 | PASS | QA test: formula/markup/control/zero-width/64-char word planted in a title is cleaned in storage, amount sum unchanged |
| 31 | PASS | `impor-ocr.test.ts` other-space wallet 404 before read, removed member writes nothing in the shared space; QA test: same reading in two spaces writes to both, no leakage |
| 32, 33 | PASS | hidden `rows`/`totalMinor` ignored, unknown keys 400, 20 bound cases x 2 actions 400/413/415, 415 for JSON body, `__proto__` safe |
| 34 | PASS | 31st request 429 shared with `previewStatement`; 20 concurrent imports -> 3 rows once; `overTransactionCreateLimit` 429 |
| 35 | PASS | `source: 'statement'`, `ocr:<32 hex>:<n>` keys, masked card, WIB dates, rescan with jitter -> already, undo, deleted row not recreated, `filename: null` |
| 36 | PASS | no logging asserted on console spy; QA static guard (no console/R2/KV/audit in OCR server modules and client files, no localStorage/IndexedDB/object URL); no migration |
| 37 | PASS | `STATEMENT_NEEDS_AI` now points to the on-device section (`impor.spec.ts` scan test passes) |
| 39 | PASS | `i18n-coverage.test.ts` in gates (tr/trf/msg incl. multi-line calls); QA read of the Svelte template found no raw Indonesian text outside `tr()` |
| 41, 42 | PASS | live regions (`role=status/alert`), heading focus on result, 44/48 px targets (CSS), `submitting` guard + stale -> fresh preview in code; double click covered in e2e. No unit test of AA contrast for OCR-specific tokens (existing tokens only) |
| 43 | PASS | `compat-ocr.test.ts`, `npm run compat:ocr` |
| 44 | PARTIAL, non-blocking | `docs/FEATURES.md` has FN-16g; `docs/TASKS.md`, `ACCEPTANCE.md`, `RUNBOOK.md` not yet edited (engineer proposed RUNBOOK text for the orchestrator); `CLAUDE.md` untouched as required |

## Findings (none blocking)

1. Tracker docs (criterion 44): TASKS, ACCEPTANCE, RUNBOOK still to be updated by the orchestrator at completion (HISTORY too).
2. Design note, per PRD: dedupe key omits the description and, for bank statements, the printed balance (`keyParts` is `''`). Two genuinely distinct same-date, same-amount transactions that appear in two separate scans (first scan holds one, second scan holds only the other) get the same key `:0`, so the second is skipped as "already". The "Mungkin duplikat" backstop makes this visible but the user must read the count. Accepted PRD tradeoff; flagging for the red team.
3. Pre-existing (engineer noted): one `script-src eval` violation per page load from zod's JIT probe; not FN-16g.
4. Not verified (as the PRD says): accuracy on real screenshots, real camera hardware, iOS/Android phones, EXIF in practice, memory on mid-range phones. Layout parsers and confidence thresholds are calibrated on fictional fixtures only.

## Tests added

`test/integration/impor-ocr-qa.test.ts` (7 tests: planted-text cleaning, server confidence boundaries and tick-in rule, two-space isolation, unauthenticated call refused, package pins, no-persistence static guards).

---

## Cycle 2 re-check (commit 4f22c43, diff `2992eac..4f22c43`)

**Verdict: PASS** (red team M1, L1, L3 fixed and verified; no blocking finding; three non-blocking notes)

### Commands run

- `npx vitest run test/integration/impor-ocr.test.ts test/integration/impor-ocr-qa.test.ts scripts/ocr-assets.test.ts src/lib/shared/ocr/image-kind.test.ts test/i18n-coverage.test.ts src/lib/shared/i18n.test.ts` -> `Test Files  6 passed (6)`, `Tests  49 passed (49)`, exit 0 (local D1 and fixtures, no real provider).
- Not re-run by QA: `npm run gates` (engineer's `Tests 4062 passed (4062)` accepted, as instructed), e2e (`e2e/impor-ocr.spec.ts`), svelte-check, eslint. No background process left by QA.

### Fixed findings

| Finding | Result | Evidence |
| - | - | - |
| M1 dedupe key collides across bank/account/wallet | PASS | `ocr-import.ts` tuple is now `institution.id \| accountLast4 \| defaultWalletId \| date \| signed amount \| balance-or-time`. `impor-ocr.test.ts` "dedupe key is scoped to bank, account and wallet": BCA 03/09 -10.000 into wallet A (7 imported) then Mandiri 03 Sep -10.000 into wallet B -> `imported: 1, already: 0`, 8 distinct keys. Same BCA file into two wallets -> 7 and 7; repeat into the same wallet -> `imported: 0, already: 7`. |
| L1 npm files size-only, fast path trusts sizes | PASS | `assets.ts` pins a 64-hex SHA-256 on every `OCR_ASSETS` entry (test loops all entries and checks `node_modules` files against the pin); `verifyAsset` hashes all kinds; build rejects a same-size altered npm file (`/SHA-256/`); `ocrAssetsCurrent` returns true for an intact folder and false after a same-size altered file. |
| L3 client decode limits bypass | PASS | `image-kind.test.ts`: PNG 4800x5000 (24 MP) passes, 4900x4900 -> `too_big_to_decode`; WebP VP8X over 24 MP -> `too_big_to_decode`; JPEG 6000x8000 (48 MP) passes with its size; HEIC with `ispe` 320x240 + 4032x3024 passes (`size: null`), 8000x6000 -> `too_big_to_decode`, 20000x20000 -> `too_many_pixels`, HEIC with no or truncated `ispe` -> `malformed`. |

### Criteria re-checked (those the fix could touch)

| # | Result | Evidence |
| - | - | - |
| 2, 3 (asset build, tamper, asset set) | PASS | `scripts/ocr-assets.test.ts` in the run above: hash mismatch, tampered cache, missing file, wrong size, shipped set unchanged (no legacy cores, no `*.map`). |
| 13 (limits: 15 MB, 5th image, 65 MP, pages, crafted headers) | PASS | `image-kind.test.ts`: 15 MB + 1 -> `too_large`; 8125x8000 PNG (65 MP) -> `too_many_pixels` (checked before the 24 MP rule); lying huge headers still refused before decode; JPEG 64 MP boundary now asserted with a JPEG. |
| 35 (source `statement`, `ocr:<32 hex>:<n>` keys, rescan finds rows, undo, deleted row not recreated) | PASS | `impor-ocr.test.ts` and `impor-ocr-qa.test.ts` pass with the new tuple; rescan with description jitter into the same wallet still yields `already`. |
| 36 (nothing stored, no migration) | PASS | Static guards in `impor-ocr.test.ts` / `impor-ocr-qa.test.ts` pass; diff adds no migration, no logging, no storage. |
| 39 (Indonesian strings have English entries) | PASS | `test/i18n-coverage.test.ts` and `src/lib/shared/i18n.test.ts` pass; new string in `OcrImport.svelte` (inside `tr()`) has its `i18n-en.ts` entry. |
| Error states (criterion 10-13 states) | PASS | `refusalText` in `OcrImport.svelte` handles every `OcrInputRefusal` member including `too_big_to_decode`; the refusal sets `phase: idle` and `note`, announced through the live region, nothing downloaded or posted. |
| Untouched criteria (1, 4-12, 14-34, 37, 38, 40-44) | PASS (cycle 1 evidence kept) | Diff touches none of their code paths (CSP, service worker, parsers, throttle, picker). |

### Behaviour change: PNG/WebP/HEIC over 24 MP -> `too_big_to_decode`

- Message check: "Gambar PNG, WebP atau HEIC ini terlalu besar ... (lebih dari 24 megapiksel). Simpan sebagai JPG atau kecilkan, lalu coba lagi." / English entry matches. The threshold is exact (24,000,000 passes, above is refused), and a JPEG of up to 64 MP does pass, so the advice "save as JPG" is truthful and works. The 64 MP message is still shown for anything above 64 MP.
- Agrees with the PRD's caps? Only partly, see finding 1: it is stricter than PRD A5 and criterion 13, which state one 64 MP declared cap for every kind and say "a 48 MP phone photo fits". It is a deliberate tightening that the red team asked for (L3, "lower the declared-pixel cap for PNG and WebP", "parse the HEIF `ispe` box"), and criterion 13's tested boundary (65 MP refused) still holds.

### Findings (none blocking)

1. PRD not amended: A5 (`PRD.md:36`), the pixel-limit bullet (`PRD.md:160-161`) and criterion 13 still say 64 MP for all kinds. The 24 MP cap for PNG/WebP/HEIC exists only in code, the cycle 2 notes and `image-kind.ts`. A 24-64 MP PNG, WebP or HEIC (a 48 MP phone HEIC mode) is now refused where the PRD says it fits. Fix: amend A5 and criterion 13 (orchestrator).
2. Stale text in `ENGINEER_REPORT.md` "As built": the bullet "HEIC: no header size is read; Safari decodes it and the page bounds it after decoding" now contradicts cycle 2 (the header is read, HEIC over 24 MP is refused, a HEIC without `ispe` is refused). Fix: edit that bullet.
3. HEIC with no readable `ispe` inside the first 512 KB (`OcrImport.svelte:231`) is refused as `malformed` and shown "Gambar rusak atau tidak lengkap". A valid HEIC whose `meta` box lies after a large `mdat` would get that untrue message. Tested only on synthetic boxes; no real iPhone/Samsung HEIC was available, so unverified.
   - **Resolution (2026-10-13): FIX** with red team L5 (`fix(import): OCR assets shortcut refuses extra files; HEIC size read from the walked meta box (FN-16g L4, L5)`): the `meta` box is found by walking the top-level boxes, wherever it is.
4. Dedupe scope uses the wallet id as sent: a re-scan into an explicit wallet after an earlier import with no wallet chosen (or the reverse) has a different scope, so it is not skipped as "already". The "Mungkin duplikat" backstop (same wallet, same amount, at most one day apart) still flags it. Accepted consequence of the scope fix; also re-importing one statement into two wallets on purpose now creates both.
   - **Resolution (2026-10-13): ACCEPTED.** The report calls it the accepted consequence of the M1 scope fix. Rows with no wallet are never written, so the only case is a deliberate second import, which "Mungkin duplikat" still flags. No change.

### Not verified

Real HEIC files and iOS Safari decode, e2e journey after the message change (not re-run by instruction), cost of hashing about 20 MB in `ocrAssetsCurrent` on a slow machine, accuracy on real screenshots and cameras (as in cycle 1).

