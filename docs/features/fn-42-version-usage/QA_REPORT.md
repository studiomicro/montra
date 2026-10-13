# QA Report — FN-42 Version, updates and usage in Pengaturan

**Verdict: PASS**

## Commands run

- `flock montra-heavy.lock npm run check` — svelte-check 1781 files, 0 errors, 0 warnings; tsc for service-worker/jobs/inbound clean — exit 0 — real toolchain, no mock.
- `flock montra-heavy.lock npm run lint` — prettier + eslint, all files clean — exit 0 — real toolchain.
- `flock montra-heavy.lock npx vitest run --maxWorkers=2` — 214 test files, 3062 tests passed, 0 failed — exit 0 — unit/integration against local D1 (`openLocalD1`), no real external provider (none needed for this feature).
- `LD_LIBRARY_PATH=… E2E_PORT=5441 npx playwright test e2e/pwa.spec.ts --workers=1 --grep "FN-42"` — 9 passed (phone+desktop) — exit 0 — real Chromium, real local Worker (`wrangler dev`), real Service Worker lifecycle, real D1.
- `LD_LIBRARY_PATH=… E2E_PORT=5442 npx playwright test e2e/offline-queue.spec.ts --workers=1` — 19 passed (phone+desktop) — exit 0 — real browser, confirms the FN-02 offline-queue refactor (shared `e2e/offline-queue.ts` helper) didn't regress.
- `flock montra-heavy.lock npm run build` — Vite build + service-worker build + Cloudflare adapter succeeded, 18 prerendered files bundled — exit 0 — confirms AC6 (build doesn't fail when a version, e.g. none shipped yet beyond 0.4.0, has no release note).
- `npm run clean:tmp` — removed 17 stale miniflare dirs — exit 0.

`npm run gates`/`npm test` were intentionally not run (RAM policy); the four gate steps were run individually above with the same net coverage.

## Checked criteria

1. Signed-out → `/masuk` redirect, both pages — PASS (`test/integration/pengaturan-pemakaian.test.ts` "redirects a signed-out visitor… (AC1)").
2. Space-scoped figures read only after `requireSpaceAccess`; account figures for `locals.user.id` only; no id from query/form — PASS (code review of `+page.server.ts`; no request param is ever used as a space/user id).
3. Forged `space` cookie naming a non-member space → 404, no figure rendered — PASS. Note: `resolveCurrentSpace` already falls back silently to the user's personal space for a cookie naming a space they don't belong to, so `locals.space` can never actually hold an unauthorized space; the test instead forges `locals.space` directly (`{ space: b.spaceId }` path in the test harness) to prove `requireSpaceAccess` still throws 404 in that case — a stronger check than the literal cookie scenario, and the literal-cookie case is also covered ("a space cookie naming another space falls back to the own personal space: only own figures").
4. `/pengaturan/tentang` shows "Versi {APP_VERSION}", equal to `/api/v1/health`'s `version` — PASS (integration test asserts both from the same binding; e2e no-JS test asserts `data-testid="app-version"` text equals `Versi {health.version}` against the real running Worker).
5. Locale-correct bullets, matched by `version` — PASS (integration test loads both `id` and `en` locales and checks distinct, correct bullets).
6. Build still succeeds when a version has no release-note pair — PASS (`npm run build` succeeded; `release-notes.test.ts`/integration test exercise 0.4.1 with no note, page still loads with `releasedOn: null`).
7. Newest-first by semver, no "Behind the scenes" line — PASS (`compareVersionsDesc` unit-tested in `release-notes.test.ts`; integration test checks order and absence of "behind the scenes" case-insensitively; manual diff of all 4 release-notes pairs against `CHANGELOG.md` confirms the "Behind the scenes" lines were correctly dropped and the rest is a faithful, separately-written bilingual translation, not machine-translated boilerplate).
8. Fresh install: `skipWaiting()` immediately, no banner — PASS (e2e: `workers(page)` shows `{active: 'service-worker.js', waiting: null}` right after first install, banner absent).
9. Existing controller + new worker finishes installing → waits, banner within one `updatefound` cycle, "Muat ulang sekarang" posts SKIP_WAITING, reloads exactly once — PASS (e2e journey test, both the simulated "old build via query-string update" step and the final real-build-over-old-build step reach `waiting`, banner shows, click reloads once — load counter checked before/after).
10. FN-02 queue survives the reload, unconfirmed item not lost — PASS (same e2e test: an item blocked mid-send is still `queueSize === 1` after the SW-triggered reload, then drains to 0 and appears once in `/riwayat` — no duplicate).
11. "Periksa pembaruan" with nothing new → "Sudah versi terbaru", no reload — PASS (e2e: load counter unchanged after click, banner text asserted visible).
12. No-JS: version + "Apa yang baru" render, no update control, no error — PASS (e2e `javaScriptEnabled: false` test, `Periksa pembaruan` button and banner both `toHaveCount(0)`; `UpdateBanner`/check button are inside `{#if hydrated}`, which never becomes true without JS).
13. Credit balance equals `creditBalance` and equals `/pengaturan/paket`'s figure — PASS (integration test "the balance equals what /pengaturan/paket shows for the same account").
14. "This month's credits used" buckets by WIB month, 23:30/00:30 boundary vectors — PASS (`creditsSpentThisMonth` test exercises the exact 23:30/00:30 WIB vectors across Sep/Oct/Nov 2026 and confirms UTC-month would have misbucketed them).
15. 100/100 categories incl. hidden, then over-cap shown accurately, never capped — PASS (integration test, exact values asserted: `100/100` then `CATEGORY_LIST_MAX/100`).
16. No connected apps → "0" with no "of N"; demo rows never counted as real — PASS (schema/UI has no ceiling field for this row; test confirms `{real:0, demo:1}` for a demo connection).
17. Personal space → "Ruang pribadi", not a ratio — PASS (e2e `usage-members` text and integration test both confirm `null`→"Ruang pribadi" for personal, a real ratio for shared).
18. No FN-41 key / AI row: "Belum ada pemakaian AI", link only when `/pengaturan/integrasi` exists — PASS (`INTEGRATIONS_PAGE` is a build-time `import.meta.glob` check; FN-41 has landed in this build so the link is present and asserted in both e2e and integration tests; the build-time-absent branch is unit-reasoned via the same glob mechanism, same pattern as blog's own existing check).
19. Photo counts: live rows only, non-null `photo_key`, this space only — PASS (integration test "stored photos: live rows with a photo key only, per kind, this space only (AC19)" covers photo/no-photo/deleted/other-space in one assertion).
20. Bounded query count — PASS (integration test instruments `d1.prepare` and asserts exactly 10 statements regardless of row counts, with ledger capped at `LEDGER_PAGE_SIZE` and `olderCursor` set).
21. i18n completeness — PASS (`src/lib/shared/i18n.test.ts` ran clean inside the 3062-test vitest pass; spot-checked ~15 new strings incl. `trf()` templates all have English entries; `Kategori`/`Ruang` reused pre-existing entries).
22. Release notes id/en are real, separate text, not placeholders — PASS (manual read of all 8 new `.md` files; each language reads as independently-written prose, consistent word-for-word with `CHANGELOG.md`'s already-plain bullets).
23. Keyed lists — PASS (`{#each usage.limits as limit (limit.key)}`, `{#each usage.ledger as row (row.id)}`, `{#each data.notes as note (note.version)}`).
24. No figure shown before resolution; failed query → error state, never a stale/zero figure — PASS (integration test "a failing query is the page error state, never a zero presented as real (AC24)": forces `db.all` to reject, asserts `usage: null` + the fixed error string, never a zero).
25. Accessibility — PASS (`UpdateBanner` uses `role="status"`; dismiss button is 44×44 px by its own CSS; e2e asserts ≥44 px row height for both new Pengaturan-index rows; reuses `GroupList`/`IconRow`/`ScreenTitle`, no bespoke markup).
26. No new `'unsafe-inline'` — PASS (message-passing code ships inside `src/service-worker/index.ts`, bundled; e2e no-JS test asserts zero CSP violations via `collectCspViolations`).
27. Fail-before proof — Not independently re-verified by running old code (would require reverting; not done this cycle), but all new tests are meaningful and specific (exact numeric/string assertions), consistent with a real fail-before cycle. No red flag found.
28/29. N/A as scoped (no AI provider, no untrusted text) — confirmed by code review, no AI call and no user-supplied text rendered.
30. 360 px, no horizontal scroll — PASS (`expectNoHorizontalScroll` asserted on both new pages in e2e, phone viewport).

## Findings

None. No ENGINEERING_CHECKLIST.md violations found: bounded D1 work confirmed by instrumented test, one access rule (`requireSpaceAccess`) used before every space-scoped read, no money/float handling involved (credits are integer counts via `SUM(delta)`), WIB month boundary explicitly vector-tested, Svelte lists keyed by id, no CSP/`unsafe-inline` change, i18n complete, truthful-state/error-state criteria met, no file paths or internal identifiers in any user-facing string (release notes and error copy both reviewed).

One implementation note (not a defect): the e2e update-flow test cannot literally redeploy new bytes under the same `/service-worker.js` URL, so it registers a second worker at `/service-worker.js?build=old` to force a genuine browser-native install/waiting cycle, then lets the real `/service-worker.js` "update" over it. This is a legitimate exercise of the production `skipWaitingOnInstall`/`isSkipWaitingMessage`/controllerchange code paths in a real browser (not a stub of the Service Worker API) — judged sufficient to satisfy AC9/AC10/AC11.
