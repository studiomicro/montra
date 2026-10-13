# FN-13 Install and notifications (PWA) — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted).

- **Built:** `static/manifest.webmanifest` + our icons; service worker (`src/service-worker/`) caching only build files,
  static assets and `/offline.html` — never authenticated HTML or `__data.json`; `Clear-Site-Data` on sign-out and
  account deletion; offline page; install guide `/pengaturan/instal` with QR to itself and in-app-browser advice;
  per-device Web Push opt-in at `/pengaturan/notifikasi` (FN-12 Toggle); sending implemented on WebCrypto (RFC 8291
  aes128gcm + RFC 8292 VAPID, matches RFC test vectors), only to known push-service hosts, no redirects; subscriptions
  tied to a live session, normalised endpoints, 20 per user; migration `0009_push_subscriptions.sql`; root `_headers`
  gives static assets security headers; `wrangler.jsonc` `html_handling: "none"`.
- **QA:** PASS 26/26. **Red team:** PASS; Lows L1–L4 fixed in cycle 2.
- **Not verified:** real push delivery (needs production VAPID keys — owner item); iOS standalone and
  `beforeinstallprompt` paths (headless Chromium fires neither). Revisit `Clear-Site-Data: "storage"` before any
  IndexedDB working copy lands.
