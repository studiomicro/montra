# FN-13b PWA platform fit for iOS and Android — PRD

Owner request 2026-10-10: "adjust the PWA compatibility with iOS and Android". Extends FN-13
(`docs/features/fn-13-pwa/{PRD,SUMMARY,ENGINEER_REPORT}.md`). The FN-42/FN-42b service-worker update flow
(`docs/features/fn-42-version-usage/`, `docs/features/fn-42b-changelog-auto-update/`) must keep working unchanged.
Catalogue: `docs/FEATURES.md` › FN-13 (lines 110-117), and FN-24 (line 296) for the push surface.

**Risk tier: Medium.** No migration, no auth, money or access-control change, no new external input. It touches the
document head, the manifest, the service worker's precache list, the app shell's fixed and sticky chrome, and two
build scripts. Pipeline: engineer, then QA and a narrow red team in parallel. Branch `feat/fn-13b-pwa-platforms`
(worktree `montra-worktrees/fn-13b-pwa`).

**Platform claims.** Every platform claim below cites a URL in **References** (R1–R24). Claims marked
**[uncertain]** could not be confirmed in current official docs on 2026-10-10. The engineer must not build
behaviour that depends on an uncertain claim. It must also degrade safely when the claim is wrong.

## Goal

Montra's main journey (record by voice, see Beranda, get a payment notification) repeats daily only if the
home-screen app feels native on the two phones Indonesians use. FN-13 made the app installable. On iPhone it still
gaps:

- a white flash on launch;
- no install steps inside the app, because they live only on the public site;
- the notification page fails generically on older iOS and in non-Safari iOS browsers;
- the search field and Beranda's chart picker zoom the page on focus.

On Android, the manifest has no shortcuts, no screenshots for Chrome's richer install dialog, no monochrome or
192 px maskable icon, and the theme toggle leaves a stale status-bar colour. FN-13b closes these gaps. It reuses
FN-13's install state, user-agent module and icon pipeline, and adds no new platform surface beyond the manifest and
head tags.

## Current behaviour (audit, file:line)

**Head and manifest**

- **Head:** `src/app.html:5` has `viewport-fit=cover`. `:8` has `apple-touch-icon`. `:9-15` has two
  `theme-color` metas filled by `hooks.server.ts:30-38` from `src/lib/server/prefs.ts:13-25`. The head has no
  `apple-mobile-web-app-*`, `mobile-web-app-capable` or `apple-touch-startup-image` tag.
- **Manifest:** `static/manifest.webmanifest:1-23` has name, id, start_url, scope, `display: standalone`,
  `orientation: portrait`, background and theme `#ffffff`, and icons 192, 512 and maskable 512. It has no
  `shortcuts`, `screenshots`, `categories`, `prefer_related_applications`, monochrome icon, maskable 192 or
  `share_target`. There is no share target anywhere in `src/` or `static/`.
- **Icons:** made by `scripts/generate-mascot-icons.ts:45-50` (Playwright Chromium, committed PNGs). This is the
  pattern the new scripts follow.

**Service worker and offline page**

- **Precache:** `src/service-worker/index.ts:23-35` precaches `shellPaths(immutable, assets)`
  (`src/lib/shared/sw-policy.ts:20-28`), which is every file in `static/`. Any splash or screenshot PNG added to
  `static/` would be downloaded by every visitor on install.
- **Offline page:** `static/offline.html:9-11` has a viewport and `color-scheme`, but no `theme-color`. Its CSP
  comes from `_headers` (`/offline.html` block).

**Install guide and install state**

- **Install page:** `src/routes/(app)/pengaturan/instal/+page.svelte:39-71` shows "Sudah terpasang" in standalone
  mode, and the "Instal aplikasi" button when Chrome fired `beforeinstallprompt` (`:51-57`). Otherwise it links
  the public guide (`+page.server.ts:8-12`), or shows "Belum dikonfigurasi" when no site host is configured.
- **Install steps:** the per-OS steps exist only on the public site
  (`src/routes/(site)/site/pasang/+page.svelte:15-34`). The page has no inline iOS steps, no note for iOS
  third-party browsers and no one-time hint.
- **Install state:** `src/lib/ui/pwa/install.svelte.ts:21-37` captures `beforeinstallprompt` and `appinstalled`.
  `:43-51` shows the prompt. `:54-59` `isStandalone()` checks `display-mode: standalone` or
  `navigator.standalone`.
- **User-agent module:** `src/lib/shared/user-agent.ts:33-39` `detectMobileOs` knows iOS (including touch iPadOS),
  Android and other. It does not tell Safari from CriOS, FxiOS or EdgiOS. The root `+layout.server.ts` passes
  `inAppBrowser` and `mobileOs`.
- **Session-only notice:** the in-app-browser notice is dismissible for the session through sessionStorage
  `fin-in-app-notice-dismissed` (`src/routes/+layout.svelte:22-33`).

**Notifications page**

- `src/routes/(app)/pengaturan/notifikasi/+page.svelte:219-226` shows "Pasang dulu ke layar utama…" for iOS outside
  standalone (`src/lib/ui/pwa/push.ts:11-18`).
- iOS in standalone without the Push API (iOS below 16.4) gets the generic "Browser ini tidak mendukung
  notifikasi." (`:227-228`). An iOS third-party browser gets the install message, but no hint that installing
  needs Safari.
- `requestPermission()` is the first `await` after the toggle's change event (`:83-95`, `:135-153`).

**Theme colour**

- `src/lib/ui/shell/ThemeToggle.svelte:19-21` changes `data-theme` and the cookie without a reload. The
  `theme-color` metas keep the old colours until the next full load.

**Fixed and sticky chrome**

- `src/lib/ui/shell/TabBar.svelte:27-30`: fixed, bottom inset. Left and right are 14 px without a side inset.
  `:88-92` sets the scroll padding.
- `src/lib/ui/shell/ScreenTitle.svelte:65-66`: sticky, `top: 0`, no top inset.
- `src/lib/ui/shell/Sheet.svelte:76`: `100dvh` plus the top inset. `:149-150` sets `overscroll-behavior: contain`
  and the bottom inset.
- `src/lib/ui/shell/Sidebar.svelte:128-135` (sticky, `100dvh`) and `:254-255` (sticky bottom), desktop and iPad
  landscape.
- `src/lib/ui/kit/MascotLoading.svelte:22-24`: fixed, top inset.
- Suara undo toast `src/routes/(app)/riwayat/suara/+page.svelte:922-931`: fixed, bottom inset, `100vw`.
- `src/routes/(app)/+layout.svelte:75-86`: `100dvh` and a bottom inset, with 20 px sides and no side insets.
- `src/app.css:4-18`: root 17 px, `body` `min-height: 100dvh`.
- No `100vh` is used in `src/`. The app has no FAB component: Tambah is a tab-bar button.

**Inputs under 16 px** (computed font size; these zoom iOS on focus, see R12)

- `src/lib/ui/kit/SearchField.svelte:67`: 15 px.
- `src/routes/(app)/+page.svelte:694`: Beranda `.picker select`, 13 px.
- The file inputs `src/lib/ui/photos/PhotoField.svelte:73` and `src/routes/(app)/riwayat/struk/+page.svelte:357`
  (15 px) open a picker and do not focus-zoom. They belong to the camera branch (see Constraint).

**External links and the update flow**

- External links: `pengaturan/integrasi/+page.svelte:86` (console.anthropic.com), the public guide link, and the
  billing checkout redirect (`pengaturan/paket/+page.server.ts:125`). In standalone mode, an out-of-scope URL opens
  in an in-app browser over the app. On iOS that browser is isolated from the PWA's storage, and `window.open()`
  returns `null` (R20).
- Update flow (must not regress): `src/lib/ui/pwa/update.svelte.ts`, `auto-check.ts` and
  `src/lib/shared/sw-update.ts` are covered by `e2e/pwa.spec.ts:321-676`.

## Scope

### A. Head tags (iOS and Android)

1. **`apple-mobile-web-app-title`** set to `Montra` in `src/app.html`.
2. **`apple-mobile-web-app-status-bar-style`** set to `default` (Owner decision B). With `default`, content sits
   below the status bar, so the top inset is 0 in portrait. The status bar takes the page and theme colour in light
   and dark. With `black-translucent`, iOS draws white status icons over the content and ignores the theme colour
   (R3, R4). Those white icons are unreadable on the light theme's `#ffffff`. The glass tab bar is at the bottom
   and is unaffected. It keeps `viewport-fit=cover` and the bottom inset.
3. **No `apple-mobile-web-app-capable`, and no `mobile-web-app-capable`.**
   - The manifest's `display: standalone` already makes iOS 16.4+ add a home-screen web app (R5).
   - From iOS 26, every site added to the Home Screen opens as a web app by default, with an "Open as Web App"
     toggle (R6).
   - web.dev advises against the deprecated Apple meta tags, because they bypass the manifest's `start_url` and
     `scope` (R4).
   - Chrome logs a deprecation warning for the Apple-only tag **[uncertain: secondary sources only, R7]**.
   - The e2e test asserts that both tags are absent.
4. **`apple-touch-startup-image` splash screens.** iOS does not build splash screens from the manifest; without a
   matching image it shows a white screen at launch (R4). Whether current iOS (18, 26) still reads these links is
   **[uncertain]**: no 2025-26 official source confirms or denies it. They are cheap and inert when ignored, so
   they ship.
   - **Script:** `scripts/generate-splash-screens.ts` (new, committed, run by hand like
     `generate-mascot-icons.ts`; never part of `gates` or `build`). It renders Koko's idle icon (reuse `iconSvg`
     from `generate-mascot-icons.ts`) centred on `--bg`: light `#ffffff`, dark `#111112`, the values
     `prefs.ts:13-18` already holds and `test/contrast.test.ts` checks. Icon size is a fixed fraction of the
     short side.
   - **Outputs:** `static/splash/splash-<w>x<h>-<light|dark>.png`, plus a generated TS table
     `src/lib/shared/splash-screens.ts`: device points, scale and file per scheme. The root layout and a unit test
     both read this table.
   - **Devices:** portrait only (Owner decision C; the manifest says `orientation: portrait`). Start from Apple's
     current device table (R8). The engineer re-checks every row against R8 at build time, because the HIG page
     renders client-side and was not machine-readable here **[uncertain]**.
     - iPhone, scale 3: 440×956, 402×874, 420×912, 430×932, 393×852, 428×926, 390×844, 375×812 and 414×896.
     - iPhone, scale 2: 414×896 and 375×667.
     - iPad, scale 2: 1032×1376, 1024×1366, 834×1210, 834×1194, 820×1180, 744×1133 and 810×1080.
     - Total: 18 sizes × 2 schemes = 36 PNGs.
   - **Budget:** all files in `static/splash/` together ≤ **1.5 MB**, checked by a unit test. Use flat colour,
     indexed PNG and no metadata. If the budget cannot be met, drop the oldest scale-2 iPhone sizes first and list
     them in the engineer report.
   - **Media queries:** each `<link rel="apple-touch-startup-image">` carries `(device-width)`, `(device-height)`,
     `(-webkit-device-pixel-ratio)` and `(orientation: portrait)`, plus `(prefers-color-scheme: light|dark)` for
     the scheme. Whether iOS honours `prefers-color-scheme` here is **[uncertain]**. If it does not, the light
     image (listed first) is what shows.
   - **Emitted only for Apple devices:** the root layout writes the links through `<svelte:head>` only when the
     request UA is iOS or a Macintosh (iPadOS sends a desktop UA). Android and other pages do not pay about 7 KB
     of head per page.
5. **Theme colour follows the theme toggle.** When `ThemeToggle` changes the theme, the page updates both
   `theme-color` metas to the colours `themeColors()` returns for the new preference. The colours come from one
   shared function; move it to `src/lib/shared/theme.ts` and keep the server import working. Note: iOS 26 Safari
   is listed as not supporting `theme-color` (R9) **[uncertain whether standalone differs]**. Chrome for Android
   honours it (R9, R10).
6. **`static/offline.html`:** add two static `theme-color` metas (light `#ffffff`, dark `#111112`). No script. The
   `_headers` CSP stays unchanged.

### B. Manifest (Android Chrome; harmless elsewhere)

All changes are in `static/manifest.webmanifest`. Its human-readable strings stay Indonesian (Owner decision E).

1. **`shortcuts`** (Chrome for Android shows at most 3, R11), in this order. Each points at an existing route:
   - "Tambah transaksi" → `/riwayat/baru`
   - "Suara" → `/riwayat/suara`, **without** `?mulai=1`, because auto-start only follows an in-app navigation
     (`riwayat/suara/+page.svelte:223-233`, red team L2)
   - "Struk" → `/riwayat/struk`, which already explains when receipt reading is not configured
   - "Tanya" → `/tanya`

   Each shortcut has a `short_name`, a `description` and one 96×96 PNG icon (R11), drawn by the icon script from
   the app's own icon glyphs (`src/lib/ui/icons.ts`: plus or keyboard, mic, receipt, chat) on the white tile. A
   signed-out launch goes through the existing gate to `/masuk?next=…` (`gate.ts:25`).
2. **`screenshots`**, made by `scripts/capture-store-screenshots.ts` (new, committed, run by hand):
   - Rules (R13): PNG; each side 320–3840 px; long side ≤ 2.3 × short side; identical aspect ratio within a
     `form_factor`; at most 8 are shown.
   - **narrow:** 2 images at 1080×2340 (a 360×780 viewport at scale 3, ratio 2.17): Riwayat with demo rows, and
     the Tambah sheet open.
   - **wide:** 1 image at 1280×800 (ratio 1.6): Riwayat on desktop.
   - Each image has a `label`.
   - **Source data:** only the local dev seed (`scripts/seed-local.ts`, `scripts/demo-seed.ts`). The script
     refuses any non-localhost base URL (reuse `scripts/local-guard.ts`). It signs up a fixed fictional account
     (`demo-screens@montra.local`), adds an IDR wallet, runs the seed and captures.
   - **Demo badge:** every image carries the in-row "Data demo" badges, plus a visible "Data demo" ribbon composited
     in a corner. No real data appears.
   - Budget: `static/screenshots/` ≤ **1 MB** in total.
   - Beranda is not used: demo rows are excluded from totals, so it would show Rp 0.
3. **Icons:**
   - add a **maskable 192** (`icons/icon-maskable-192.png`);
   - add a **monochrome** icon (`icons/icon-monochrome-512.png`, purpose `monochrome`): Koko's silhouette with
     alpha only, colour ignored (R14);
   - shortcut icons as above.

   All are generated by extending `ICONS` in `scripts/generate-mascot-icons.ts:45-50`. Whether Chrome uses
   `monochrome` for the main launcher icon (Android themed icons) is **[uncertain]**: per the spec discussion, no
   user agent did as of 2023, though Android used it for shortcut icons (R15). It ships as harmless metadata.
4. **`categories: ["finance", "productivity"]`** (R16, app-store metadata only).
5. **`prefer_related_applications: false`**, the explicit default (R17).
6. **`description`** stays, and stays under 324 characters (R13).
7. **`theme_color` / `background_color`** stay `#ffffff`. The manifest cannot vary them by colour scheme (R10).
   In dark mode, Chrome's status bar follows the page's media-queried meta once the page loads. The launch splash
   stays white: a known limitation, stated in the engineer report.
8. Unchanged: `id`, `start_url`, `scope`, `display`, `orientation`. No `share_target` (Out of scope).

The service worker must not precache splash or screenshot images. `shellPaths` (`sw-policy.ts:20-28`) excludes
`/splash/` and `/screenshots/`. They are served from the network when iOS or Chrome asks for them. Shortcut and
monochrome icons are small and stay in the shell.

### C. Install guidance in the app (iOS)

1. **`src/lib/shared/user-agent.ts`:** add `detectIosBrowser(ua)`, returning `'safari' | 'chrome' | 'firefox' |
   'edge' | 'other' | null`.
   - The UA markers are `CriOS`, `FxiOS`, `EdgiOS` and others such as `OPiOS`, `GSA`, `DuckDuckGo` and
     `YaBrowser`. `null` means the device is not iOS.
   - Reuse `detectMobileOs`, including the touch-Macintosh rule.
   - In-app browsers (`detectInAppBrowser`) keep their own notice and are never `'safari'`.
   - Extend this module. Do not add a second one (FN-13 rule).
2. **`/pengaturan/instal` on iOS** (not standalone): shows the steps inline, through `tr()`, with no dependence on
   the site host.
   - Steps: open in Safari; tap Bagikan; choose Tambah ke Layar Utama; "if a Buka sebagai App Web option is shown,
     leave it on" (iOS 26 has this toggle, R6); tap Tambah.
   - Add the note: "after installing, sign in once more in the app". On iOS a home-screen web app keeps its storage
     apart from Safari (R20), so the session does not carry over.
   - Android and desktop keep today's button and guide link.
3. **iOS third-party browsers** (`detectIosBrowser` is `chrome`, `firefox`, `edge` or `other`): the page and the
   hint say "Untuk memasang, buka halaman ini di Safari."
   - Copy addition: "Beberapa browser lain juga punya Tambah ke Layar Utama, tapi Safari yang paling pasti." Since
     iOS 16.4, entitled third-party browsers may offer Add to Home Screen (R5). Current per-browser support (Chrome
     in particular) is inconsistent across sources **[uncertain, R18]**, so the copy promises nothing about them.
   - In the EU, this may not apply to non-WebKit browsers (R18).
4. **One-time hint:** the `(app)` layout shows it on iOS Safari only, when not standalone, signed in, and not on
   `/pengaturan/instal`.
   - It is an in-flow card at the top of `<main>`, below the update banner and "Baru di Montra": "Pasang Montra di
     layar utama" with a "Lihat caranya" link to `/pengaturan/instal` and a "Tutup" button.
   - Closing it, or opening the guide from it, writes localStorage **`montra-install-hint-dismissed` = `1`** (try,
     catch). With storage blocked, it hides for the page lifetime.
   - It never shows again on that browser. This is the only new client storage.
   - It is never shown in standalone, in in-app browsers, on Android or on desktop.
   - Focus returns to `<main>` on dismiss (`focusMain`).

### D. Notifications page (`/pengaturan/notifikasi`)

`pushSupport` (`src/lib/ui/pwa/push.ts:11-18`) gains the input `iosBrowser` and returns these states:

- `'ios-needs-install'` (iOS Safari, not standalone): the current message, plus the iPhone requirement "iOS 16.4 atau
  lebih baru" and a link to `/pengaturan/instal` (R5).
- `'ios-open-in-safari'` (iOS third-party browser, not standalone): "Notifikasi di iPhone hanya untuk aplikasi yang
  dipasang dari Safari ke layar utama." and a link to the guide.
- `'ios-too-old'` (iOS **standalone** but no `PushManager`): "Notifikasi di iPhone butuh iOS 16.4 atau lebih baru.
  Perbarui iOS, lalu buka lagi dari layar utama."
  - This uses feature detection, not a UA version: the iOS UA version is not a reliable signal **[uncertain whether
    iOS 26 freezes it]**.
- `'unsupported'` and `'supported'`: unchanged.

`Notification.requestPermission()` stays the first awaited call inside the toggle's user-gesture handler. iOS
requires the request to follow a user action (R5).

### E. Layout: safe areas, viewport units, inputs, overscroll

1. **One source for the insets:** `src/app.css` defines on `:root` the variables `--sai-top`, `--sai-right`,
   `--sai-bottom` and `--sai-left` as `env(safe-area-inset-*, 0px)`. Every component uses the variables. No
   component calls `env(safe-area-inset-*)` directly, and a static test enforces this. With one source, the e2e test
   can emulate a notch by overriding the variables (Chromium cannot fake `env()`; R19).
2. **Fixed and sticky chrome uses the insets:**
   - TabBar: bottom, plus `max(14px, --sai-left/right)` for the sides.
   - ScreenTitle sticky `top: var(--sai-top)`, with its background extended upward so content never shows above it.
   - Sidebar: sticky top and bottom.
   - Sheet: top, bottom and the side padding.
   - MascotLoading: top.
   - Suara toast: bottom and side clamp; replace `100vw` with `100%` of a containing block, or with the dynamic
     inline size.
   - Root and `(app)` content: side padding `max(20px, --sai-left/right)`.
   - The update banner, in-app notice, WhatsNew and install hint are in flow under `--sai-top`.
   - There is no FAB to change.
3. **Viewport units:**
   - No `100vh` in `src/`, enforced by a static test (today there is none).
   - Full-height surfaces keep `dvh`.
   - The sheet's max height uses `dvh` with the top inset.
   - The default `interactive-widget` stays: Chrome 108+ and iOS resize only the visual viewport for the keyboard
     (R21), so the tab bar does not ride above the keyboard.
   - Focused fields inside a sheet and the `/tanya` composer must stay visible above the keyboard (`scroll-margin`
     and the sheet body as the scroll container). This is a manual device check.
4. **Inputs at 16 px or more:**
   - **Global rule:** in `src/app.css`, outside any layer,
     `input:not([type=checkbox], [type=radio], [type=range], [type=file], [type=color]), select, textarea` get
     `font-size: max(16px, 1em)`. This sets the floor for every input that does not set its own size.
   - **Explicit sizes:** components that set their own smaller size are raised to at least 16 px (`SearchField.svelte:67`
     and `(app)/+page.svelte:694`, plus any other found by the e2e scan).
   - User zoom is never disabled: no `maximum-scale` and no `user-scalable` in the viewport meta (R12).
5. **Overscroll and pull-to-refresh in standalone** (Owner decision D):
   - The page keeps the browser default, so Chrome for Android's pull-to-refresh stays available in standalone
     (R22). It is the only manual reload there.
   - Sheets and horizontal scrollers keep `overscroll-behavior: contain` (`Sheet.svelte:149`, `BarChart.svelte:148`).
   - The `html` and `body` backgrounds equal `--bg`, so iOS rubber-banding never shows another colour (already true,
     `app.css:4-18`). Add an e2e check.
6. **Standalone and external links:**
   - **Standalone detection:** `isStandalone()` (`install.svelte.ts:54-59`) stays the only check. It is used by
     the hint, the guide, the notifications page and any future "open in browser" link.
   - **No-install surfaces in standalone:** there, nothing tells the person to "open in Safari or Chrome" or to
     install.
   - **External links:** every cross-origin link in `(app)` gets `rel="noopener noreferrer"`. These are the
     Anthropic console link and the public guide link (today the guide link has no `rel`). The checkout redirect
     stays a same-tab navigation. The in-app browser behaviour of out-of-scope URLs is accepted as is (R20), and
     the code does not use `window.open()` for them.
   - **Known limitation, in the engineer report:** on iOS, a provider checkout that returns to an in-scope URL may
     land inside the in-app browser without the PWA's session. A follow-up item is added (Tracker impact).

### F. Strings

Every new phrase goes through `tr()`/`trf()` in `src/lib/shared/i18n.ts` call sites with an English entry in
`i18n-en.ts`. This covers the guide steps, the third-party-browser note, the hint, the three new notification states
and the "sign in again" note. The manifest strings (shortcut names and descriptions, screenshot labels) and the
splash images carry no `tr()`. They are static files, exempt by construction like `offline.html` (Owner decision E).

## Out of scope

- **Share target.** It does not exist. FEATURES.md lists it as FN-15's "Ours"
  (`docs/FEATURES.md:117`). No `share_target` is added.
- **Restyling photo and camera components.** The camera branch `feat/fn-45-camera-gallery` edits the photo inputs.
  Apart from the global input font-size rule in `src/app.css`, which excludes `type=file`, the engineer must **not
  touch** these files:
  - `src/lib/ui/photos/*`
  - `src/routes/(app)/riwayat/struk/+page.svelte`
  - receipt capture inputs
- Landscape splash images, an English manifest or a per-locale manifest, and dark `background_color`. No manifest
  colour-scheme variant exists in the spec (R10).
- An Android one-time install hint. Android keeps the existing "Instal aplikasi" button on `/pengaturan/instal`
  (Owner decision F).
- Badging API, notification actions, and any change to push sending, VAPID, the subscription table or FN-24 kinds.
- Any change to the update handshake: `skipWaitingOnInstall`, the `SKIP_WAITING` message, `applyUpdate`,
  `auto-check`, WhatsNew, or the offline queue.
- Native wrappers or TWA (FN-33). A fix for the in-app-browser checkout session is a follow-up item.
- A CSP change. None is needed: every new file is same-origin and covered by `img-src 'self'`, and no new script
  exists.

## Acceptance criteria

Verification levels follow `docs/ACCEPTANCE.md`:

- **Automated:** Vitest.
- **Browser:** Playwright, extending `e2e/pwa.spec.ts`. Playwright cannot install a PWA, open a keyboard or fake
  `env()`, so browser checks assert markup, the manifest, UA-emulated pages, computed styles and overridden inset
  variables.
- **Manual:** a real device. Recorded in the QA report as "not automatable", never as passed without a device.

**Head and meta (Browser)**

1. Given an iPhone Safari UA (`Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) … Version/18.0 Mobile/15E148
   Safari/604.1`), when `/masuk` loads, then:
   - the head has `apple-mobile-web-app-title` = `Montra` and `apple-mobile-web-app-status-bar-style` = `default`;
   - it has **no** `apple-mobile-web-app-capable` and **no** `mobile-web-app-capable`;
   - it has one `apple-touch-startup-image` link per row of `splash-screens.ts` and scheme;
   - each link's `media` names the device width, height, pixel ratio, portrait and the scheme;
   - each `href` answers 200 `image/png` with exactly the stated pixel size.
2. Given the Pixel 7 UA (phone project) or the desktop project, when any page loads, then no
   `apple-touch-startup-image` link is in the head. The title and status-bar metas may be present.
3. Given the theme is Sistem, when the sidebar or Tampilan theme toggle switches to Gelap without a reload, then both
   `theme-color` metas hold `#111112` at once. Switching to Terang gives `#ffffff`, and Hitam-putih gives the mono
   pair (`themeColors()`, unit-tested in its new shared home).
4. `/offline.html` carries the light and dark `theme-color` metas and still has no `<script>`. Its `_headers` CSP is
   unchanged (the existing e2e header test passes).

**Manifest (Automated and Browser)**

5. `manifest.webmanifest` parses as JSON, and:
   - `shortcuts` has 4 entries in the order Tambah transaksi, Suara, Struk, Tanya;
   - each has `name`, `short_name`, `description`, and a `url` within scope that resolves to an existing route
     (`/riwayat/baru`, `/riwayat/suara`, `/riwayat/struk`, `/tanya`, without query);
   - each has one 96×96 PNG icon that answers 200.
6. `screenshots`:
   - every entry has `src`, `sizes`, `type: image/png`, `form_factor` and `label`;
   - each file's real pixel size equals its `sizes`, and each side is 320–3840 px;
   - long side ≤ 2.3 × short side;
   - all `narrow` entries share one aspect ratio, as do all `wide` entries;
   - there are ≥ 1 `narrow` and ≥ 1 `wide`, and ≤ 8 in total.
7. Every screenshot shows the "Data demo" ribbon. The capture script refuses a non-localhost base URL (unit test on
   its guard), and its account is the fixed fictional one.
8. `icons` includes:
   - 192 `any`, 512 `any`, 192 `maskable`, 512 `maskable` and 512 `monochrome`, each answering 200 with its
     stated size;
   - the monochrome PNG has transparent background pixels;
   - no icon declares `"any maskable"` together.
9. The manifest has `categories` `["finance","productivity"]` and `prefer_related_applications: false`. `id`,
   `start_url`, `scope`, `display` and `orientation` are unchanged, and there is no `share_target`.
10. Given a signed-out visitor, when each shortcut URL is opened, then it redirects to `/masuk?next=<that path>`.
    Signed in, each one renders. `/riwayat/struk` shows its own "belum dikonfigurasi" reason when AI is unset.
    Opening `/riwayat/suara` from a full load does **not** start recording.

**Service worker and update flow (Automated and Browser)**

11. `shellPaths` never returns a path under `/splash/` or `/screenshots/` (unit test, failing first). Given the worker
    has installed, the shell cache holds no such entry (e2e `cachedEntries`).
12. The FN-13, FN-42 and FN-42b cases in `e2e/pwa.spec.ts` and `e2e/catatan-rilis*.spec.ts` pass unchanged:
    - offline page;
    - shell-only cache;
    - sign-out cache;
    - first install silent;
    - the update waits for "Muat ulang sekarang", reloads once, and the offline item survives;
    - automatic checks.
13. Given the phone project with `display-mode: standalone` emulated, when the network is offline and a page is
    navigated, then `/offline.html` renders with no CSP violation.

**Install guidance (Browser)**

14. Given the iPhone Safari UA, not standalone, when `/pengaturan/instal` loads (signed out and signed in), then:
    - the inline steps list shows Bagikan › Tambah ke Layar Utama and the "Buka sebagai App Web" step;
    - the "masuk sekali lagi" note shows;
    - no "Instal aplikasi" button shows;
    - no request goes to a third-party origin.
15. Given an iOS Chrome UA (`CriOS`), and likewise `FxiOS` and `EdgiOS`, when `/pengaturan/instal` loads, then
    "buka halaman ini di Safari" shows, and the Safari steps are still listed. `detectIosBrowser` is unit-tested on
    real-format UA strings (Safari, CriOS, FxiOS, EdgiOS, OPiOS, GSA, iPadOS desktop UA with touch), Android
    Chrome, desktop Chrome and the three in-app browsers.
16. Given `navigator.standalone === true`, or `display-mode: standalone` emulated, then:
    - `/pengaturan/instal` shows "Sudah terpasang";
    - no install hint, no "open in Safari/Chrome" text and no install steps render anywhere.
17. Given the iPhone Safari UA, signed in, when Beranda loads, then:
    - the install hint shows once, below any update banner;
    - "Tutup" hides it, moves focus to `<main>` and sets `montra-install-hint-dismissed=1`;
    - after a reload it is not shown;
    - with localStorage throwing (stubbed) the page still renders and the hint can be closed.
    - It never shows for the Pixel 7 UA, the desktop project, an in-app-browser UA, standalone, or on
      `/pengaturan/instal`.
18. Given Chromium fires a synthetic `beforeinstallprompt`, the existing "Instal aplikasi" button behaviour is
    unchanged (FN-13 criterion 2).

**Notifications (Automated and Browser)**

19. `pushSupport` unit table:
    - iOS Safari not standalone → `ios-needs-install`;
    - iOS CriOS not standalone → `ios-open-in-safari`;
    - iOS standalone without the Push API → `ios-too-old`;
    - iOS standalone with the Push API → `supported`;
    - Android or desktop → unchanged.
20. With VAPID configured (test env) and the iPhone Safari UA, `/pengaturan/notifikasi` shows the install message
    with "iOS 16.4" and the guide link. With CriOS it shows the Safari message. Neither calls
    `Notification.requestPermission` (spy). Without VAPID, "Belum dikonfigurasi" stays first (FN-13 criterion 13).

**Layout at 360 px (Browser, phone project, 360×780)**

21. With the inset variables overridden on `:root` to top 47 px, bottom 34 px and sides 0, then:
    - the tab bar's bottom edge is ≥ 34 px above the viewport bottom;
    - the sticky ScreenTitle's top is ≥ 47 px once scrolled;
    - an open Sheet's content keeps ≥ 34 px bottom padding;
    - the Suara toast sits above the tab bar.
    With the sides overridden to 44 px (landscape notch, 780×360), the tab bar and content start at ≥ 44 px from
    the side. There is no horizontal scroll on Beranda, Riwayat, Tambah sheet, `/pengaturan/instal` or
    `/pengaturan/notifikasi`.
22. On each of these routes, every visible `input` (except checkbox, radio, range, file and color), `select` and
    `textarea` has a computed `font-size` ≥ 16 px:
    - `/`, `/riwayat`, `/riwayat/baru`, `/riwayat/suara`, `/tanya`, `/dompet`, `/impor`, `/anggaran`,
      `/langganan`, `/pengaturan/api`, `/pengaturan/aplikasi`, `/masuk`;
    - and inside the open Tambah sheet.
    The viewport meta has no `maximum-scale` and no `user-scalable`.
23. Static tests (Vitest over `src/`): no `100vh`; no `env(safe-area-inset-` outside the `:root` definition in
    `app.css`; no `user-scalable` or `maximum-scale`. Each fails first on a planted violation.
24. `html` and `body` computed backgrounds equal `--bg` in light and dark, for iOS overscroll.

**Cross-cutting (checklist)**

25. **Server authorization:**
    - no new load or action reads space data;
    - the root layout's UA-derived `iosBrowser` and splash decision are presentation only, never access;
    - `/pengaturan/instal` stays public (`gate.ts:10`) and every other touched `(app)` route stays gated;
    - the existing `/pengaturan/notifikasi` actions are unchanged and still resolve `locals.user`.
26. **i18n:** every new Indonesian phrase has an English entry, and the coverage test passes. The English UI
    (locale `en`) shows the English install steps, hint and notification messages.
27. **CSP:** no new CSP directive and no `'unsafe-inline'`; e2e sees no CSP violation on `/masuk`,
    `/pengaturan/instal`, `/pengaturan/notifikasi` and Beranda with the iPhone UA.
28. **Accessibility:**
    - hint and guide controls are ≥ 44 px on the phone project;
    - headings do not skip;
    - the hint is an `aside` with a label;
    - AA contrast in both themes (`test/contrast.test.ts` unaffected);
    - splash and screenshot files are not referenced as content images.
29. **User copy:** no file path, UA string or internal id appears in any message.
30. **Asset budgets:** `static/splash/` ≤ 1.5 MB and `static/screenshots/` ≤ 1 MB (unit test). Re-running each
    script on the same Chromium produces the same files (the engineer reports a byte diff of a second run).
31. **Gates:** `npm run gates` is clean. Every new regression test is shown failing on the unfixed code first (the
    `sw-policy` exclusion, input sizes, static greps, `pushSupport` states and `detectIosBrowser`).

**Manual device checks (Manual; listed in QA report, not blocking automation)**

32. Run on an iPhone with iOS 26 or the latest available, and ideally one with iOS 17 or 18:
    - Add to Home Screen from Safari;
    - the splash shows the right scheme, or the gap is noted if iOS ignores it;
    - the status bar is readable in light and dark;
    - no content sits under the status bar or home indicator;
    - a search field focus does not zoom;
    - the `/tanya` composer stays above the keyboard;
    - the notification toggle prompts after a tap.
33. On Android Chrome:
    - install;
    - a long-press on the icon shows 3 shortcuts that open the right screens;
    - the richer install dialog shows the screenshots;
    - the status bar follows the light and dark theme;
    - pull-to-refresh works in standalone.

## Architecture notes

- **Head:** `src/app.html` gains the static title and status-bar metas. Startup-image links go in through
  `src/routes/+layout.svelte` `<svelte:head>`, from root layout data (`+layout.server.ts` adds `iosBrowser` and
  `appleDevice: boolean`). No inline script; the CSP is unchanged (`src/lib/server/csp.ts:10-23`).
- **Theme:** move `themeColors` and the BG table from `src/lib/server/prefs.ts:13-25` to
  `src/lib/shared/theme.ts`. `prefs.ts` re-exports it, so `hooks.server.ts:30-38` is unchanged. `ThemeToggle.svelte`
  updates the metas, and the Tampilan form action already reloads.
- **Manifest:** `static/manifest.webmanifest` (hand-edited JSON; the icon and screenshot files come from scripts).
  A Vitest `test/manifest.test.ts` (new) checks criteria 5–9 offline from the file and the PNG headers.
- **Scripts:** extend `scripts/generate-mascot-icons.ts` (maskable 192, monochrome 512, shortcut icons 96). Add
  `scripts/generate-splash-screens.ts` (writes `static/splash/*` and `src/lib/shared/splash-screens.ts`) and
  `scripts/capture-store-screenshots.ts` (local only, through `local-guard.ts`; uses the dev server, `seed-local.ts`
  and Playwright Chromium). Neither runs in `gates`, `build` or CI.
- **Service worker:** `src/lib/shared/sw-policy.ts` `shellPaths` excludes `/splash/` and `/screenshots/`.
  `src/service-worker/index.ts` is otherwise untouched. A changed worker byte triggers the normal FN-42 update
  banner, which is expected.
- **Install and push:**
  - `src/lib/shared/user-agent.ts`: `detectIosBrowser`.
  - `src/lib/ui/pwa/push.ts`: the new `pushSupport` states.
  - `src/lib/ui/pwa/InstallHint.svelte` (new, small).
  - The `(app)` layout mounts the hint.
  - `pengaturan/instal/+page.svelte` gets the inline iOS steps. Reuse `msg()` keys with the site's
    `pasang/+page.svelte:15-34` where the wording is the same: one phrase, one English entry.
  - `pengaturan/notifikasi/+page.svelte` gets the new states.
- **Layout:**
  - `src/app.css`: the inset variables and the global input floor.
  - Touched components: `TabBar`, `ScreenTitle`, `Sheet`, `Sidebar`, `MascotLoading`, the Suara toast,
    `(app)/+layout.svelte`, `SearchField`, and the Beranda `.picker select`.
  - Static tests in `test/` (new `test/platform-css.test.ts`).
- **Worker:** app Worker only. No change to `workers/jobs`, `workers/inbound`, `wrangler.jsonc` or migrations.
- **Docs:** `docs/RUNBOOK.md` › the PWA section names the three scripts, when to rerun them (brand mark change, new
  Apple device, UI change) and the budgets.

## Prerequisites

None. No secret and no provider. The scripts need Playwright's Chromium (the existing devDependency) and, for
screenshots, a local dev server with the local D1 (`npm run db:reset:local`, `npm run db:seed:local`). Without
VAPID keys the notifications page keeps "Belum dikonfigurasi" (FN-13). Without a site host, `/pengaturan/instal`
still shows the iOS steps inline, and the guide link stays "Belum dikonfigurasi" for other platforms.

## Tracker impact

- `docs/TASKS.md` has no open line for this. Add and tick "FN-13b PWA platform fit (iOS/Android)" under the
  Phase 1 PWA work. Add `- [ ] **Claude** — FN-13b follow-up: provider checkout return inside the iOS standalone
  in-app browser (session isolation, R20)`. Add `- [ ] **You** — FN-13b manual device checks (criteria 32–33) on a
  real iPhone and Android phone`.
- `docs/ACCEPTANCE.md` row "360 px layout, 44 px touch targets, reduced motion" (line 55) can add `e2e/pwa.spec.ts`
  (safe-area overrides, input ≥ 16 px) as Browser evidence once criteria 21–22 pass.

## Owner decisions

All accepted by default (owner 2026-10-10: proceed automatically).

- **A. Scope of iOS splash screens.** Default: ship them (18 portrait sizes × light/dark, ≤ 1.5 MB, not precached,
  only in Apple-device heads), even though current-iOS support is unconfirmed. Trade-off: about 1.5 MB in the repo
  and the deploy, and the files must be regenerated for new devices. Without them, there is a white launch flash.
  Accepted by default (owner 2026-10-10: proceed automatically).
- **B. Status bar style `default`, not `black-translucent`.** Default: `default`. Trade-off: no edge-to-edge content
  under the status bar. In exchange, the status icons are readable on both the white and the dark theme (with
  translucent they are white, and the theme colour is ignored). Accepted by default (owner 2026-10-10: proceed
  automatically).
- **C. Portrait-only splash.** Default: portrait only, matching `orientation: portrait`. Trade-off: an iPad launched
  in landscape shows a plain colour screen instead of the splash. Accepted by default (owner 2026-10-10: proceed
  automatically).
- **D. Keep pull-to-refresh in standalone.** Default: keep the browser default on the page and `contain` on sheets
  and scrollers. Trade-off: an accidental pull reloads the page on Android, but it is the only manual reload in
  standalone. A reload is safe for the offline queue (FN-42). Accepted by default (owner 2026-10-10: proceed
  automatically).
- **E. Manifest and splash text stay Indonesian only.** Default: the static manifest in the default language,
  exempt from `tr()` like `offline.html`. Trade-off: an English-language user sees Indonesian shortcut names on
  Android. A per-locale manifest is possible later, but browsers fetch the manifest without the locale cookie.
  Accepted by default (owner 2026-10-10: proceed automatically).
- **F. Install hint on iOS Safari only, once.** Default: iOS Safari only, dismissed for good with one localStorage
  key (`montra-install-hint-dismissed`). Android keeps the button on `/pengaturan/instal`. Trade-off: Android users
  get no proactive nudge. The hint never comes back after a dismissal, even years later. Accepted by default (owner
  2026-10-10: proceed automatically).
- **G. Four shortcuts, with Tanya last.** Default: Tambah transaksi, Suara, Struk, Tanya. Chrome for Android shows 3,
  so Tanya appears only where more are shown (e.g. desktop). Trade-off: you choose which 3 phone users see.
  Accepted by default (owner 2026-10-10: proceed automatically).
- **H. Screenshots from demo data, with a "Data demo" ribbon.** Default: Riwayat (2 narrow) and Riwayat on desktop
  (1 wide), ribboned. Beranda is not used because demo rows are excluded from totals. Trade-off: less attractive
  store imagery, but no invented or real figures. Accepted by default (owner 2026-10-10: proceed automatically).
- **I. Small selects grow to 16 px.** Default: Beranda's chart picker (13 px) and the search field (15 px) render at
  16 px. Trade-off: a slightly larger pill on Beranda in exchange for no focus zoom. Accepted by default (owner
  2026-10-10: proceed automatically).

## References

Checked 2026-10-10. **[uncertain]** marks claims without a current official confirmation.

- R1. Apple, Safari HTML Reference › Supported Meta Tags (archived 2014; capable and status-bar-style values;
  "black-translucent … content … partially obscured by the status bar"):
  https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html
- R2. MDN, `<meta name>` (`theme-color` with `media` is standard; the Apple names are not listed):
  https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name
- R3. Same as R1, for the status-bar values `default`, `black` and `black-translucent`.
- R4. web.dev, Learn PWA › Enhancements:
  - iOS needs `<link>` startup images, or the launch screen is white;
  - "You shouldn't use these metatags" (apple-mobile-web-app-capable);
  - black-translucent draws white icons, and "The theme color is ignored in this mode".
  https://web.dev/learn/pwa/enhancements
- R5. WebKit blog, "Web Push for Web Apps on iOS and iPadOS" (16.4):
  - push only for Home Screen web apps;
  - manifest `display` standalone or fullscreen;
  - permission after a user action;
  - entitled third-party browsers may Add to Home Screen.
  https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- R6. WebKit blog, "News from WWDC25: Web technology coming this fall in Safari 26 beta": every Home Screen site
  opens as a web app by default, with a user toggle "Open as Web App":
  https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/
- R7. **[uncertain]** Chrome's deprecation warning for `apple-mobile-web-app-capable` without
  `mobile-web-app-capable`. Secondary only: https://wiki.suikawiki.org/n/apple-mobile-web-app-capable and
  https://developer.apple.com/forums/thread/649131
- R8. **[uncertain: page not machine-readable]** Apple HIG › Layout (device sizes and scale factors); verify every
  splash row there: https://developer.apple.com/design/human-interface-guidelines/layout
- R9. Can I use, `theme-color` meta (iOS Safari 15–18.7 supported; 26.0–26.6 "Not supported"; Chrome for Android
  partial): https://caniuse.com/meta-theme-color. **[uncertain]** whether iOS standalone differs.
- R10. MDN, manifest `theme_color`: one colour, no media queries; dark variants go through the meta tag:
  https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/theme_color
- R11. web.dev, "Get things done quickly with app shortcuts": Chrome for Android shows 3; icons ≥ 96×96 (Bubblewrap);
  URLs within scope; updates are capped to daily: https://web.dev/articles/app-shortcuts. Also MDN `shortcuts`:
  https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/shortcuts
- R12. **[uncertain: no official WebKit source]** iOS focus zoom below 16 px; disabling zoom harms accessibility:
  https://weblog.west-wind.com/posts/2023/Apr/17/Preventing-iOS-Textbox-Auto-Zooming-and-ViewPort-Sizing
- R13. web.dev, "Richer PWA installation UI":
  - JPEG or PNG; each side 320–3840 px; maximum side ≤ 2.3 × minimum side;
  - the same aspect ratio per form factor; 8 shown;
  - `narrow` on mobile and `wide` on desktop;
  - description truncated after about 7 lines (about 324 characters).
  https://web.dev/articles/web-apps/richer-install-ui. Also MDN `screenshots`:
  https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/screenshots
- R14. MDN, manifest `icons` › `purpose` (`monochrome` uses alpha only):
  https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons
- R15. **[uncertain]** W3C manifest issue thread (2023): monochrome is not implemented for main app icons, but Android
  uses it for shortcut icons: https://lists.w3.org/Archives/Public/public-webapps-github/2023May/0827.html
- R16. MDN, manifest `categories` (`finance` is a known value; store metadata only):
  https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/categories
- R17. MDN, `prefer_related_applications` (default `false`; Chromium requires false or omitted to install):
  https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/prefer_related_applications
- R18. **[uncertain]** iOS third-party browser Add to Home Screen support (Edge yes; Chrome conflicting; EU non-WebKit
  caveat):
  - https://ios.gadgethacks.com/how-to/add-website-shortcuts-your-iphones-home-screen-for-fast-access-web-apps-and-bookmarks-0385522/
  - https://tantek.com/2023/114/b1
  - https://ios.gadgethacks.com/how-to/you-dont-need-safari-add-web-apps-your-iphones-home-screen-try-these-browsers-instead-0385351/
- R19. WebKit blog, "Designing Websites for iPhone X" (`viewport-fit=cover`, `env(safe-area-inset-*)`):
  https://webkit.org/blog/7929/designing-websites-for-iphone-x/
- R20. web.dev, Learn PWA › Windows:
  - out-of-scope URLs open an in-app browser;
  - on iOS it is SafariViewController, "isolated from your PWA storage";
  - `open()` returns null on iOS.
  https://web.dev/learn/pwa/windows
- R21. Chrome for Developers, "Prepare for viewport resize behavior changes" (Chrome 108 resizes the visual viewport
  only; `interactive-widget`; iOS Safari already does so): https://developer.chrome.com/blog/viewport-resize-behavior
- R22. web.dev, Learn PWA › App design (pull-to-refresh in Chrome Android standalone; `overscroll-behavior-y:
  contain`; `display-mode` media query; safe areas): https://web.dev/learn/pwa/app-design
- R23. MDN, CSS `<length>` (`svh`, `lvh` and `dvh` definitions): https://developer.mozilla.org/en-US/docs/Web/CSS/length
- R24. web.dev, "How Chrome handles updates to the web app manifest" (checked about daily on launch; `name`,
  `icons`, `shortcuts` and `theme_color` trigger an update; screenshots do not):
  https://web.dev/articles/manifest-updates
- R25. MDN, manifest `display` (fallback chain; the `display-mode` media feature):
  https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display
