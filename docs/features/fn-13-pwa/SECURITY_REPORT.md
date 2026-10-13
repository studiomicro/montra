# FN-13 PWA — Security report (cycle 1)

- Reviewed: `git diff 36eb361..4d71626` (service worker, offline page, Web Push crypto, subscriptions,
  install guide, sign-out `Clear-Site-Data`, `html_handling: "none"`).
- Method: code review plus live probes against a local `wrangler dev` on 127.0.0.1:8820 (local D1 after
  `npm run db:reset:local`, throwaway local VAPID keys in an ignored `.dev.vars`, deleted afterwards). No remote,
  no login, no deploy.

## Verdict: PASS

No high or medium findings. Five low findings are tracked below.

## What was verified

| Area | Result |
| --- | --- |
| SW cache scope | Built `service-worker.js` caches only `_app/immutable/*` plus the static folder (`manifest`, icons, `offline.html/.css`, favicon). `requestPolicy` (`src/lib/shared/sw-policy.ts:135-146`): non-GET, cross-origin, `__data.json`, `/api/*` and anything with a query string go to the network untouched; navigations are network-only, with the cached `offline.html` as the fallback. No authenticated HTML, data or API response is ever written to Cache Storage, so a second person on a shared device cannot be shown one (offline navigation gets only the static page). Signed-in responses keep `cache-control: private, no-store` (no bfcache/HTTP cache replay). |
| SW update | `skipWaiting` + `clients.claim`; `activate` deletes every cache except `shell-<version>`. Scope `/`, same-origin script, registered from bundled code, so the CSP stays unchanged (`script-src 'self'`). |
| Clear-Site-Data | Live: `signOut`, enhanced and plain, answers `clear-site-data: "cache", "storage"` along with both cookies expired; `deleteAccount` sets the same flag (`src/routes/(app)/pengaturan/akun/+page.server.ts:26,48`). `storage` unregisters the SW, which drops its push subscription. |
| `html_handling: "none"` | Live: `/offline.html` 200; `/offline`, `/offline/`, `/icons`, `/icons/`, `/_app/`, `/_worker.js`, `/.assetsignore`, `/_headers`, `/%2e%2e/wrangler.jsonc`, `/icons/..%2f_worker.js` all 404 (no listing, no traversal, no worker source). `static/` has no `index.html`, so the setting does not change which paths the Worker owns. No prerendered pages exist. |
| RFC 8291 | Fresh ECDH key pair and 16-octet random salt per message (`encrypt.ts:48-53,72`); the injectable sender is used only by the RFC Appendix A vector test. Key/length checks on p256dh (65, 0x04) and auth (16). Single record, padding delimiter 0x02, size cap. |
| RFC 8292 | `aud` = `new URL(endpoint).origin`, `exp` = now + 12 h (≤ 24 h), `sub` validated as `mailto:`/`https:`. The private scalar is imported as a non-extractable key and is never in loaders: `__data.json` of `/pengaturan/notifikasi` holds `publicKey`, `configured`, `devTools` and SHA-256 endpoint hashes only (grep for `privateKey`/`VAPID_PRIVATE`: 0). Logs carry only an HTTP status. |
| Endpoint allow-list | Live, refused (400): `fcm.googleapis.com.evil.com`, `u:p@fcm…`, port 8443, `http:`, `evil.com#@fcm…`, trailing-dot host, `169.254.169.254`, `evil.com\.notify.windows.com`. Accepted and checked to resolve to the real push host under WHATWG parsing (the same parser `fetch` uses): `FCM.googleapis.com`, `fcm%2egoogleapis%2ecom`, `fcm.googleapis.com\@evil.com` (backslash becomes a path separator; host = fcm), `:443`. `send.ts:232` validates again before every POST. |
| Subscriptions IDOR | Live: user B re-posting user A's live endpoint → 409, row unchanged; B `unsubscribe` with A's endpoint → generic success, but A's row is untouched (scoped by `user_id`). |
| Cap under concurrency | Live: 30 parallel subscribes by one user → 20 × 200, 10 × 409; D1 holds exactly 20 live rows (single guarded `INSERT … SELECT … WHERE count < 20 ON CONFLICT`). |
| Session binding | Live: after sign-out, every row of that session is tombstoned (keys and UA blanked; CHECK constraint enforces this). Account deletion deletes all rows before sessions. |
| CSRF / body caps | Live: foreign `Origin` → 403; 20 KB body → 400 (shared `readFormBody`, 8 KiB cap). Actions read the body within the cap before auth. |
| Notification click | Payload URL must match `^\/(?![/\\])[^\\\s]*$`, and the resolved URL must be same-origin before `navigate`/`openWindow`. |
| Install guide / QR / UA | `/pengaturan/instal` is the only public `(app)` route (exact match, tested). QR encodes `url.origin` + fixed path; on Workers the origin is the routed host. In-app browser detection only shows a notice and gates nothing. No `{@html}` in the diff. |

## Findings

### L1 — Subscriptions outlive an expired session (low)
`src/lib/server/push/repo.ts:109-126` (`listActiveSubscriptions`) does not check that the row's session is still
live; only explicit sign-out tombstones rows (`session.ts:147-158`). Scenario: user A on a shared or lost phone
never signs out; the session expires after its lifetime, there is no `Clear-Site-Data`, and the SW stays registered.
Once FN-19/FN-24 senders exist, A's notifications (possibly merchant/amount text) keep reaching that lock screen
indefinitely. Fix: in `listActiveSubscriptions`, join `sessions` and require `revoked_at is null and
expires_at > now` (or tombstone rows when a session is found expired in `resolveSession`), and treat a future
"sign out all devices" path the same way.

### L2 — Endpoint stored un-normalised; unique index can be sidestepped (low)
`src/lib/server/push/validation.ts:322` returns the raw string, not `url.href`. Repro: subscribe
`https://fcm.googleapis.com/x` as A, then `https://FCM.googleapis.com/x` or `https://fcm.googleapis.com:443/x`
as B → both accepted as different rows that point at the same push resource. Impact is small: B must already
know A's capability URL, and messages encrypted to B's keys cannot be decrypted by A's browser. It does defeat the
"live foreign row is left alone" rule and lets one user hold duplicates. Fix: store and compare
`new URL(endpoint).href`, and check that the normalised form equals the input (or just store the normalised form).

### L3 — Push fetch follows redirects (low)
`src/lib/server/push/send.ts:242-253` uses the default `redirect: 'follow'`. The allow-list is checked only on
the first URL; a 3xx from an allow-listed host (including any `*.notify.windows.com` subdomain) would make the
Worker POST the VAPID-signed body elsewhere. Push services do not redirect today, so impact is theoretical.
Fix: `redirect: 'manual'` and treat 3xx as `PushSendError`.

### L4 — Static HTML served without security headers (low)
`wrangler.jsonc:7-9` together with `static/offline.html`: assets bypass the Worker, so `/offline.html` (and
`service-worker.js`, the manifest) carry no CSP, `frame-ancestors`/`X-Frame-Options` or `nosniff` (live:
headers absent). The page has no script, form or data, so it cannot be used to exploit anything today. It is the
first HTML document outside the Worker's `withSecurityHeaders`. Fix: add a `static/_headers` block for
`/offline.html` (CSP `default-src 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`).

### L5 — `Clear-Site-Data: "storage"` will wipe the local-first working copy (low, tracking)
`src/hooks.server.ts:12-13,69`. Correct for shared devices now. Once the IndexedDB working copy lands, sign-out
would also delete unsynced local edits. Not a vulnerability. Track it for the sync feature: flush, or warn before
signing out.

## ENGINEERING_CHECKLIST

- Concurrent writes and cap: one guarded statement; the 20-cap holds under 30 parallel posts.
- Form bodies: shared guard (400/415, never 500), as observed live.
- Redirects: `notificationclick` uses a regex plus a same-origin check instead of the shared safe-return helper.
  This is acceptable because the origin comparison is the real guard, but it is a checklist deviation.
- CSP: unchanged, no `unsafe-inline`.
- Logs: endpoints (capability URLs) are never logged; the load failure logs the DB error only (the only bound
  parameter is the user id).
- Bounded work: the send loop is capped at 20 subscriptions.

## Commands

- `npm ci` → exit 0; `npx svelte-kit sync` → ok; `npm run build` → done; `npm run db:reset:local` → ok.
- `npx wrangler dev --port 8820 --ip 127.0.0.1` (local) → probes above; server stopped afterwards.
- `npx vitest run src/lib/server/push src/lib/shared/sw-policy.test.ts src/lib/shared/push.test.ts test/integration/push.test.ts` → 34 passed (34).
