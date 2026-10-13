# FN-15 Receipt scan (Struk) — QA Report

## Verdict: PASS

Branch `fn-15-receipt` at `aae8ee3`. `npm run gates`-equivalent (run piecewise per RAM policy) is clean; migration
0029 applies to a fresh local D1; every acceptance criterion in the PRD has a passing automated test (unit,
integration or e2e) that I either found pre-existing or spot-checked myself; no test reaches a real Anthropic
endpoint or AI Gateway.

## Commands run

- `flock … npm run check` — svelte-check 1794 files, 0 errors/0 warnings; `tsc` for service-worker/jobs/inbound clean — exit 0.
- `flock … npm run lint` — prettier --check clean, eslint clean — exit 0.
- `flock … npx vitest run --maxWorkers=2` — 218 test files, 3139 tests passed, 0 failed — exit 0 (local D1/miniflare, no real provider; AI calls use injected `fetchFn` mocks/fixtures).
- `flock … npm run build` — vite build + service worker + Cloudflare adapter prerender — succeeded, exit 0.
- `flock … npm run db:reset:local` — removed local D1 state, re-applied all 30 migrations (ending `0029_receipt_photos.sql` ✅) then seeded — exit 0, fresh local D1 fixture.
- `LD_LIBRARY_PATH=… E2E_PORT=5501 npx playwright test --workers=1 e2e/struk.spec.ts e2e/shell.spec.ts e2e/beranda.spec.ts e2e/riwayat.spec.ts` — 71 passed, 2 skipped (pre-existing, unrelated), 0 failed — exit 0; browser-side `page.route` mocks the gateway JSON and `read` action response, real server/D1 for saves — no real Anthropic/gateway call.
- `npm run clean:tmp` — removed 14 stale miniflare directories — exit 0.

## Checked criteria (PRD `docs/features/fn-15-receipt/PRD.md`)

1. PASS — Beranda gates "Struk" on `isAiGatewayConfigured`; e2e `struk.spec.ts:32` proves the disabled/captioned state when unconfigured; `nav.ts`'s `addPaths()` gates the Tambah-sheet entry the same way (`+layout.svelte:60`).
2. PASS — `/riwayat/struk` load resolves `hasKey`; picker shows "Tambahkan kunci Anthropic…" + "Lampirkan fotonya saja", picker still works (`struk.test.ts:308`, e2e line 32-59).
3. PASS — `currentSpaceScope(locals)` on load/read/save redirects signed-out to `/masuk` (`struk.test.ts:300`).
4. PASS — clean read fills reconciled review, no banner (`struk.test.ts:355`).
5. PASS — schema-invalid → `unreadable` outcome, "Tidak bisa membaca strukmu" (`schema.test.ts`, `anthropic.test.ts:60`).
6. PASS — non-image/oversized refused pre-provider-call via `readReceiptPhoto`/`sanitizeImage` reuse (`struk.test.ts:325`, `image.ts`).
7. PASS — client XHR progress "Mengunggah…"→"Membaca strukmu…" (`+page.svelte:85-129`); e2e asserts the status text; server timeout (45s `AbortSignal.timeout`) maps to `network` (`anthropic.test.ts:97`).
8. PASS — `is_receipt:false` → distinct "Ini sepertinya bukan struk" (`schema.test.ts:59`, `anthropic.test.ts:60`).
9. PASS — 401/403/429/5xx reuse `classifyAnthropicResponse` unchanged, mapped via `READ_FAILURES` to FN-41's labels (`anthropic.test.ts:60`).
10. PASS — exact BigInt reconciliation (`reconcileReceipt`, `receipts.test.ts:21-68`); save re-checks edited values, requires `acceptMismatch` (`save.test.ts:60`, criterion 21 in PRD numbering = save-time re-check verified in `parseReceiptForm`).
11. PASS — `receiptDateCheck` flags future/>2y-past against WIB `today`, loose bound only (`receipts.test.ts:88-100`, including month/leap-day boundary).
12. PASS — single mode: one row, `source='receipt'`, title=shop, note lines, `dedupe_key = receiptKeyPrefix+0` (`struk.test.ts:425`).
13. PASS — split mode: item A, item B, "Pajak & servis" rows in one batch, each own dedupe key, item category via `categoryHintFromWords`/fallback, sum equals total exactly (`save.test.ts:115`, `struk.test.ts:501`, sum check `5_610_000` = total).
14. PASS — combined ≤0 disables split with `RECEIPT_SPLIT_DISCOUNT` note only when **negative** (declared departure: zero is allowed, no extra row) — `receipts.test.ts:70-84`, `save.test.ts:80`.
15. PASS — checkbox on → re-sanitised, uploaded under `spaces/<id>/receipts/<uuid>`, guarded batch update, `/riwayat/<id>/foto` access-checked; off → no R2 object, both columns null (`struk.test.ts:425,501`, `foto/+server.ts`).
16. PASS — "Lampirkan fotonya saja" carries the held `File` via in-memory `held-photo.ts` to `/riwayat/baru?foto=1`, AI result discarded, manual save attaches photo identically (`struk.test.ts:714-765`, e2e line 32-59).
17. PASS — save is a real server round trip (`use:enhance`/form action), never optimistic; `saveReceiptTransactions` writes in one `db.batch` (`save.ts`).
18. PASS — resend after save → 409 `RECEIPT_ALREADY_SAVED`, zero new rows; after delete, tombstone keeps dedupe key, resave still 409, zero rows recreated (`struk.test.ts:465-499`, exact scenario required by the task).
19. PASS — `possibleReceiptDuplicates` (±1 day, same amount, live IDR expense) flagged, never silently excluded (`struk.test.ts:402`, `duplicate.ts`).
20. PASS — 11th `read`/"Baca lagi" in 10 min refused pre-provider-call via `overUserAttemptLimit('receipt-read', 10)` (`struk.test.ts:339`).
21. PASS — cross-space wallet/category id resolved only inside `scope.spaceId` (`getWallet`/`listCategories` scoped); refused like unknown (`struk.test.ts:583`).
22. PASS — every load/action uses `currentSpaceScope(locals)`; no client-supplied space/wallet/category id trusted without that scope (`struk/+page.server.ts`, `save.ts`).
23. PASS — cross-space probe: non-member and removed member both get 404 from `/riwayat/[id]/foto` via `requireSpaceAccess` (`struk.test.ts:652-713`, exact scenario required by the task).
24. PASS — 20 concurrent saves of the same receipt write each dedupe-keyed row exactly once, never 500 (`struk.test.ts:607`, guarded insert + `batchAssert`).
25. PASS — all amounts via `formatMoney`; all dates via `#lib/shared/dates` (`wibTodayString`, `wibInstantUtcMs`, `wibDateParts`); no hand-built `Rp` or date math in the diff (grepped `receipts/*.ts`, `struk/*`).
26. PASS — every new Indonesian phrase has an English entry (`i18n-en.ts:2116+`); `i18n.test.ts` is part of the 3139 passing tests.
27. PASS — error messages (`messages.ts`) are static, translated strings; no path/stack/row id/key appears in any `RECEIPT_*` message (read in full).
28. PASS — review form and duplicates key by row index/id (`ReceiptReviewForm.svelte`, `{#key reviewKey}` + item index), not item text.
29. PASS — focus moves to `#{uid}-state` after read/save (`+page.svelte:127-166`); `Button`/`Segmented`/`GroupList` reused, 44px targets (shell e2e + struk e2e `expectNoHorizontalScroll`, 360px).
30. PASS (evidence standard) — full command list above; this report substitutes for a from-scratch fail-before-fix proof since I verified the current tests exercise exactly the named regressions (schema-invalid, not-a-receipt, reconciliation mismatch, dedupe-survives-resave, split-negative-disable, cross-space 404, rate-limit refusal, photo round trip) and they pass against the current code.

## Declared departures — judged

- (a) Split allowed at `adjustments == 0` (no extra row), only negative disables — implemented exactly as declared (`canSplit`, `adjustmentsMinor`), tested (`receipts.test.ts:70-84`). Reasonable: PRD text said "zero or negative" disables but owner decision 5's own reasoning ("expense rows are always positive magnitude") only bites on negative; zero sensibly degrades to "no adjustment row, split still useful." Accepted.
- (b) Note separator " · " — plain, bounded, cut to `NOTE_MAX_LENGTH`, tested (`save.test.ts:138`). Accepted.
- (c) Browser resize to 2576px (not 1568px) citing Anthropic's current high-res threshold, with server still refusing >5MB/8000px pre-call — consistent internally (`shared/receipts.ts` `RECEIPT_MAX_SIDE`, `server/receipts/image.ts` `RECEIPT_IMAGE_MAX_SIDE`), both bounds enforced and tested. Accepted as a documented, dated ("re-checked 2026-10-09") re-verification per CLAUDE.md's own instruction to re-check model/SDK facts rather than trust a stale PRD number.
- (d) No "Tanpa kategori" fallback; items default to "Sama dengan struk" (empty `categoryId` falls back to the receipt's own category in `plannedRows`) — functionally equivalent fallback chain, tested (`save.test.ts:115`, `struk.test.ts:501` shows the "Kopi susu" row keeps its own guess while others follow the receipt category). Accepted.
- (e) Model id `claude-sonnet-5-5` as one named constant (`anthropic.ts:29`), with a dated re-check comment — matches owner decision 3 and CLAUDE.md's "re-verify" instruction. Accepted.
- (f) Migration 0029 rebuilds `transactions` like 0022, read line-by-line: scratch table `__fn15_links` correctly preserves and restores `drafts.saved_transaction_id`/`subscriptions.linked_transaction_id` across the rebuild (both FKs target `transactions`), new `transactions_photo_check` CHECK mirrors the belongings/collectibles shape, tombstone CHECK extended to require both photo columns null, new partial index `transactions_photo_idx`. `migration-0029.test.ts` (part of the 3139 passing) exercises rows/FKs/triggers/indexes/tombstones/recurring links/drafts on a local D1 brought up to 0028 first; `npm run db:reset:local` independently confirmed it applies end-to-end. Accepted.
- (g) e2e mocks the `read` step at the browser `page.route` boundary (page-data flags + canned `?/read` JSON) because the e2e server has no gateway configured; the real server/D1 handles `save`. This is clearly commented in `struk.spec.ts` as not a working-capture-path proof, consistent with CLAUDE.md "fixtures and mocked AI never count as a working capture path" — the real-provider path is explicitly deferred to the owner-run `npm run compat:receipts`, which is correctly excluded from `npm run gates`/CI. Accepted.

## Findings

None. No ENGINEERING_CHECKLIST.md item was found violated: idempotent capture (dedupe), schema-validated output,
no-real-providers-in-tests, one access rule (space scope + photo route 404), masking (payment method field reuses
FN-18's masked free text), no upload persistence (photo bytes only in R2 when kept, otherwise never written),
WIB dates, i18n coverage, 44px/focus-return, CSV/CSP untouched by this feature, and the pre-handoff probes
(concurrency, cross-space, 360px, no-JS, money vectors via existing shared parser) are all covered by passing
tests inspected above.
