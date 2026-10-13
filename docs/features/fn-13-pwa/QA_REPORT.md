# FN-13 Install and notifications (PWA) — QA report (cycle 1)

## Verdict: PASS

Branch `fn-13-pwa`, commit under test `4d71626` (detached, based on `main@36eb361`). Engineer report:
`docs/features/fn-13-pwa/ENGINEER_REPORT.md`.

## Commands run

- `npm ci` — installed clean (0 errors), real npm registry — exit 0.
- `npx svelte-kit sync` — generated `.svelte-kit` types — exit 0.
- `npm run db:reset:local` — migrations 0001–0009 applied to a fresh local D1 (wrangler/miniflare, local only) — exit 0.
- `npm run gates` (check + lint + test + build) — svelte-check 0 errors/0 warnings; lint clean; **77 test files / 1052 tests passed**; build done — local toolchain, mocked AI, no real provider — exit 0.
- `npx vitest run test/integration/push.test.ts` (local D1) — 19/19 passed — exit 0.
- `npx vitest run test/i18n-coverage.test.ts` — 3/3 passed — exit 0.
- `E2E_PORT=8840 LD_LIBRARY_PATH=<scratchpad> npm run test:e2e` (full suite, `wrangler dev` + headless Chromium, local D1, no VAPID keys set — unconfigured push path only) — **151 passed, 14 skipped, 0 failed** — exit 0. `e2e/pwa.spec.ts` contributed 16/16 passes (8 scenarios × phone/desktop).
- Fail-before-proof spot-check: temporarily removed the `user_id` scope from `removeSubscription` in `src/lib/server/push/repo.ts`, re-ran `push.test.ts` → 1 failed (criterion 21 test), restored the file, re-ran → 19/19 passed again. Confirms the engineer's claimed fail-before proof for the cross-user unsubscribe guard.
- `wrangler dev` ad-hoc on port 8819 (`.dev.vars` from `.dev.vars.example`, no real VAPID keys) + `curl` probes: manifest 200 `application/manifest+json`; `/offline.html` 200; icons 192/512/maskable 200; `/offline` (no extension) 404 (no accidental route collision); `/` 303 (signed-out gate); `/masuk` 200. Server stopped after probes.

No remote/staging command run; no login; no deploy.

## Checked criteria

1. Manifest valid (`name: "Montra"`, `display: standalone`, `start_url: '/'`, `scope: '/'`, 3 icons incl. maskable, all 200, served `application/manifest+json`) — PASS (curl probes + `e2e/pwa.spec.ts:79`).
2. `beforeinstallprompt` → custom button → `.prompt()` called, button stays until `userChoice` resolves — PASS (`src/lib/ui/pwa/install.svelte.ts` `promptInstall` only clears `installPrompt.event` after `await event.userChoice`).
3. iOS Safari install guide (no button) + `display-mode: standalone` → "Sudah terpasang" — PASS (`/pengaturan/instal/+page.svelte`); not e2e-exercised (Chromium headless fires neither path), logic unit-covered and read directly.
4. QR code client-side, no third-party request — **PASS with noted deviation**: QR target is `${origin}/pengaturan/instal`, not the bare `url.origin` as literally stated. Judged acceptable: the bare origin would 303 a signed-out phone to `/masuk` instead of the install steps the criterion itself is about reaching; same-origin, no network call (`src/lib/shared/qr.ts`, pure, matches 12 reference matrices in `shared/qr.test.ts`). Verified via `e2e/pwa.spec.ts:194` (no third-party request).
5. Install caches build + static assets under one version-keyed cache — PASS (`src/service-worker/index.ts` `install`, `shellPaths()` in `sw-policy.ts`; `e2e/pwa.spec.ts:103`).
6. Activate deletes prior-version caches, no "update available" step — PASS (`activate` handler deletes every cache key `!== CACHE`, `self.skipWaiting()`/`clients.claim()` on install/activate).
7. Offline fallback on failed navigation; online always network-first, never stale — PASS (`navigate()` only reads cache on `fetch` throw; `e2e/pwa.spec.ts:121` offline→online).
8. Never caches `/api/*` or data pages, only shell + offline.html — PASS (`sw-policy.ts` `isDataPath`, unit-tested with mutation-style assertions in `sw-policy.test.ts`; `e2e/pwa.spec.ts:145` confirms post-sign-out cache contents hold no account data).
9. No SW registration under `vite dev` — PASS (`!dev` guard in `+layout.svelte`; `vite.config.ts` sets `serviceWorker: { register: false }` to suppress Kit's own auto-registration).
10. Registration is bundled JS, not inline `<script>`; CSP untouched — PASS (`+layout.svelte` `onMount`; `vite.config.ts` CSP diff is empty aside from `serviceWorker.register:false`; `e2e/pwa.spec.ts` asserts no CSP violation).
11. `detectInAppBrowser` correct on Instagram/TikTok/WhatsApp markers, null on 10 ordinary UAs incl. iPadOS — PASS (`src/lib/shared/user-agent.ts`, `user-agent.test.ts`).
12. `InAppBrowserNotice` shown, no install button, session-only dismissal — PASS (`+layout.svelte`, `sessionStorage` key, focus-to-`main` on dismiss; `e2e/pwa.spec.ts:226`).
13. `isPushConfigured()` false → disabled toggle, "Belum dikonfigurasi", no `requestPermission()` call — PASS (`vapid.ts` `isPushConfigured`/`vapidKeys`; `notifikasi/+page.svelte` branches on `data.configured` before any browser API call; `e2e/pwa.spec.ts:256`; `vapid.test.ts`).
14. Configured + toggle on → subscribe posts endpoint/p256dh/auth, one row written `user_id = locals.user.id`, "on" only after server confirms — PASS (`+page.server.ts` `subscribe` action scoped to `locals.user.id`; client `turnOn()` unsubscribes the browser again on a failed server write, never shows a false "on"; `push.test.ts` integration cases).
15. Same endpoint re-subscribed → updates in place, never duplicates (unique on `endpoint`) — PASS (`upsertSubscription`'s single guarded `INSERT…ON CONFLICT…DO UPDATE`; `push.test.ts` "10 concurrent posts" case).
16. Toggle off → row tombstoned + client `PushManager.unsubscribe()` called — PASS (`removeSubscription` tombstone; `turnOff()` calls `sub.unsubscribe()` after server confirms).
17. iOS Safari non-standalone → replaced by "install first" message, no permission prompt — PASS (`support === 'ios-needs-install'` branch renders before any `Notification`/`PushManager` call).
18. `devRoutesEnabled` → `sendTestPush` sends to every active subscription, shows per-device result; false → 404 — PASS (`+page.server.ts` `error(404)` guard; `push.test.ts` "dev-only 404" case).
19. 404/410 from push service self-cleans via `removeSubscription` before send returns — PASS (`send.ts`/`push.test.ts` "410/404 self-clean" vs "500 kept" cases).
20. Every load/action under `/pengaturan/notifikasi` resolves user from `locals.user`; `/pengaturan/instal` works signed out — PASS (`gate.ts` `PUBLIC_APP_ROUTES` exact allowlist; `notifikasi/+page.server.ts` redirects to `/masuk` when `!user`).
21. Foreign-endpoint `unsubscribe` probe refused, no cross-user tombstoning — PASS, independently reproduced via fail-before-proof mutation above, and `push.test.ts` "cross-user unsubscribe" case.
22. `subscribe`/`unsubscribe`/`sendTestPush` body size-capped, 400/415 never 500 — PASS (reuses `src/lib/server/forms.ts` `readFormBody`; `push.test.ts` "form bodies are guarded" case, criterion 22 named directly).
23. Every new Indonesian phrase has an English entry (`offline.html` exempt by construction) — PASS (`npx vitest run test/i18n-coverage.test.ts` 3/3; spot-checked "Belum dikonfigurasi", "Sudah terpasang", "Pasang dulu ke layar utama…" all present in `i18n-en.ts`).
24. Touch targets ≥44px, AA contrast, focus return on notice dismiss — PASS (Toggle reused from FN-12; install guide link `min-height: 44px`; `dismissNotice()` moves focus to `<main>`; no inline styles found in any new file — `grep style=` empty).
25. No file path/stack/row id/VAPID material/raw endpoint in user copy — PASS (endpoints only hashed to the page via `sha256Hex`; error messages are static `tr()` strings; spot-read confirms no interpolated identifiers).
26. `npm run gates` clean before hand-off; fail-before proof shown — PASS (gates run above; fail-before proof independently reproduced for criterion 21; engineer report lists five more mutation runs not independently re-run by QA but consistent with the rest of the code read).

## Findings

None blocking. One documented, judged deviation:

- **Criterion 4 wording vs. implementation:** the PRD's literal text says "a QR code encoding the current `url.origin`"; the engineer instead encodes `${origin}/pengaturan/instal}`. Judged correct — the bare origin would send a signed-out scanning phone to `/masuk`, not to the install instructions the criterion is actually about reaching (confirmed by reading `gate.ts`: `/` is a protected route). No action needed.

Minor, non-blocking gaps already disclosed in the engineer report and consistent with this feature's scope (no VAPID keys provisioned in this sandbox, so real push-service delivery, iOS standalone detection and `beforeinstallprompt` paths are exercised by unit tests and manual code reading only, not by e2e — Chromium headless fires neither event and there is no live push endpoint to subscribe to here).

## Engineering checklist

No violations found in the diff. Relevant items checked: form-body guard reused (not rebuilt), one switch primitive reused (`Toggle.svelte`), redirects go through the existing session-gate/`signInLocation` helper (no `startsWith('/')` check), `{#each}` lists keyed by static index only (no user-controlled keys), CSP untouched, i18n coverage test present and passing, touch targets and focus-return verified, D1 writes use guarded single statements for the concurrency-sensitive upsert/cap/takeover logic. Money, date-bucket, AI and sync/account-key checklist sections do not apply to this feature (no money, space, or AI surface touched).
