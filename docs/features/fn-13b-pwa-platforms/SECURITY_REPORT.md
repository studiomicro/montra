# SECURITY REPORT: FN-13b PWA platforms

Diff reviewed: `git diff 6093a3f..d98fa8e` (narrow scope: CSP, manifest, client storage, UA detection, service worker, scripts). No source modified.

## Verdict: PASS

No high or medium findings. Two low/informational notes below.

## Checks

1. CSP: PASS. No new inline script or style in `src/`. The only inline `style=` strings are in `scripts/` (screenshot ribbon, splash render pages), which run in a local headless browser and never ship. `csp.ts` is unchanged (`style-src-attr` hash untouched, no `unsafe-*` added). New `<link rel="apple-touch-startup-image">`, manifest, icon, splash and screenshot URLs are all same-origin paths, covered by `img-src 'self'` / `default-src 'self'`. `_headers` is unchanged; `/*` static rules (nosniff, HSTS, COOP) cover the new PNGs. `offline.html` gained only `<meta theme-color>`, compatible with its `script-src 'none'` CSP.
2. Manifest: PASS. `id`, `start_url` and `scope` are `/`. All 4 shortcut URLs (`/riwayat/baru`, `/riwayat/suara`, `/riwayat/struk`, `/tanya`) are relative, same-origin and in scope. They are static strings, so there is no redirect parameter and no open redirect. All referenced icons, shortcut icons and screenshots exist on disk. The 3 screenshots show only fictional `Data demo` rows, a "Data demo" ribbon, and the account "Akun Demo" / `demo-screens@montra.local` (a `.local` address). No real PII.
3. Client storage: PASS. The only new key is `montra-install-hint-dismissed` = `"1"` (non-sensitive, no user data). All reads and writes are in try/catch. Sign-out already sends `Clear-Site-Data`, which clears it. Even if it survives, the effect is only that the hint stays hidden.
4. UA / standalone detection: PASS. `detectIosBrowser`, `isAppleUserAgent` and `isStandalone` only choose UI: install steps, splash links, hint, push guidance. `+layout.server.ts` returns `iosBrowser` and `appleDevice` as presentation data and no authorization depends on them. UA slices are capped at 1024 chars and the regexes are linear. The only new external link (`data.guideUrl`) got `rel="noopener noreferrer"`; no new `target=_blank` and no `{@html}` in the diff.
5. Service worker: PASS. `shellPaths` still filters `isDataPath` (`/api/`, `__data.json`) and now also drops `/splash/` and `/screenshots/`. `requestPolicy` is unchanged: navigations are network-only, so authenticated HTML is never cached. Non-shell paths fall through to the network.
6. Scripts: PASS. `assertLocalBaseUrl` allows only http(s) with host exactly `localhost`, `127.0.0.1` or `[::1]`, and rejects credentials. Its tests cover `localhost.evil.test`, `localhost@evil.test`, `0.0.0.0` and LAN IPs. `capture-store-screenshots.ts` calls it before launching a browser and then runs `scripts/seed-local.ts`, which keeps its own `assertLocalOnly` guard and writes only to the local persist dir. `wrangler.jsonc` has no `"remote"` binding. The splash and icon generators are offline (Playwright setContent plus file writes), with no network and no D1.

## Findings

- LOW-1 (info, FIXED after the report: `Vary: User-Agent` on HTML in `hooks.server.ts`, e2e `pwa.spec.ts` › "HTML pages vary by User-Agent"): `src/routes/+layout.server.ts` makes the first HTML differ by User-Agent (splash links only for Apple devices). Authenticated responses get `private, no-store` (`hooks.server.ts:95`). Anonymous pages have no explicit `Vary: User-Agent` or `Cache-Control`, so a future shared HTML cache could serve the wrong head (cosmetic only, no data exposure). Repro: `curl -A "iPhone" /masuk` vs `curl -A "Linux" /masuk` and compare `apple-touch-startup-image` links.
- LOW-2 (info): the screenshot script uses `bypassCSP: true` and a fixed demo password (`terang-benderang-8`) for a `.local` demo account. Local only (guarded). Nothing to do unless the demo account is ever created on a shared environment. Repro: read `DEMO_ACCOUNT` in `scripts/capture-store-screenshots.ts`.

ENGINEERING_CHECKLIST: no violations in the reviewed scope (no new loaders, actions or API routes; no new secrets or PII; no raw SQL).

## Follow-up — Resolution (2026-10-13)

- Provider checkout returning inside the iOS standalone in-app browser without the session (PRD § E, R20; tracked as
  "FN-13b follow-ups"): OWNER. The fix depends on the payment provider's return flow (Xendit or Midtrans, an owner
  decision) and on a real iPhone to verify; with the mock checkout there is no provider return to change. Nothing
  leaks: the in-app browser simply has no session and asks the user to sign in.
- LOW-2: ACCEPTED, as the report says ("Nothing to do"): the demo password is for a `.local` account behind the
  local-only guard.
