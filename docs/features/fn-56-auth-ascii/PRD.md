# FN-56 — ASCII field animation on sign-in and sign-up

Owner request 2026-10-13: "Add ascii animation on login and register", then a visual reference ("make like this", a
video of a third-party product page, used as **style only**). Baselines: `docs/design/DESIGN_SYSTEM.md` § Motion
(`:154-182`), § Typography (`:99-109`), § Mascot (`:198-218`), FN-51 (`docs/features/fn-51-motion/PRD.md`), FN-50
(Turnstile and passkey on the same two pages, `docs/features/fn-50-passkey-turnstile/PRD.md`), FN-40/FN-44 (Koko in the
wide-screen hero).

**Reference, as described by the owner's video (what we imitate, nothing else):** a full-bleed panel inside a rounded card;
a dense grid of tiny monospaced letters drawn only where a slowly morphing organic noise field is above a threshold, so
soft blobs drift, merge and split over about 10 s and the rest of the panel is empty; inside a blob the glyphs are denser
and brighter in the core and sparser and fainter at the edge; each row repeats the letters of one word. We copy none of
its text, logo, brand, colour or copy, and we use no code or bundle from it (`CLAUDE.md`: mirror behaviour, never brand).

**Risk tier: Small.** UI only: no migration, no `+page.server.ts` change, no `src/lib/server` change, no access or data
change, no new dependency, no external asset, no AI, no money logic. The wider edges are the shared `(auth)` layout
(`src/routes/(auth)/+layout.svelte`) and the removal of Koko's hero block from the two pages (Owner decision 3).
Pipeline: engineer, then QA; a red team pass is not needed (no input, no auth path touched). If the engineer has to change
the CSP or a `+page.server.ts`, this becomes Medium and stops for the coordinator.

## Goal

The first screen a new person sees after the landing page is a plain form. Montra's promise is that the app fills itself;
a quiet, living field of Montra's own letters (the word, digits and "Rp" drifting as soft shapes) gives the sign-in and
sign-up pages a recognisable, crafted feel in the first second without a sentence, an illustration file or a download. It
stays ink-and-white (colour only for meaning, so none), runs only when motion is welcome, and never stands between the
person and the form: no delay, no overlap, no layout shift, no focus stop. It also replaces the sign-in/sign-up Koko hero,
which only wide screens ever saw, with one piece of art that works at 360 px as well as at 1280 px.

## Current behaviour (so the engineer does not rediscover it)

- `src/routes/(auth)/+layout.svelte:11-17`: one narrow column. `.auth` grid (`:20-29`, `gap: 24px`, `justify-items:
  center`), `.top` wordmark row (`:31-34`, `max-width: 400px`), `<main class="card">` (`:45-48`, `max-width: 400px`).
  `@media (min-width: 1024px)` only changes `gap: 40px; padding-top: 10vh` (`:50-55`). The layout serves three routes:
  `/masuk`, `/daftar`, `/akun-dihapus`. There is no password-reset or forgot-password page in `src/routes` (grep "lupa",
  "forgot", "reset-password" finds nothing under `(auth)`).
- `src/routes/(auth)/masuk/+page.svelte:152-153` and `daftar/+page.svelte:41-42`: `<div class="hero-art"><Mascot
  pose="wave" size={168} /></div>`; CSS `.hero-art { display: none }`, shown only at `@media (min-width: 768px) and
  (min-height: 720px)` (`masuk:250-259`, `daftar:159-168`). Phones see no art today; the form starts under the H1.
- Locked by tests: `test/mascot-placements.test.ts:47-58` (page source contains that exact hero-art line and the `display:
  none` rule); `e2e/motion.spec.ts:605-632` (360x640: `.hero-art` hidden and the E-mail field's bottom <= 640;
  1280x800: `.hero-art svg.mascot.pose-wave` visible and `aria-hidden`).
- Page states that must stay intact: password form with pending state and eye toggle (`masuk:157-229`), Turnstile widget
  when `data.turnstile` (`:223-225`), passkey button drawn only after mount when WebAuthn exists (`:130-139`, `:231-245`),
  passkey notice `role="alert"` (`:243`). Sign-up: `daftar:48-154`.
- Tokens: `--font-mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace` (`docs/design/tokens.css:137`); Geist
  Mono is self-hosted (`src/app.css:20-26`, `static/fonts/geist-mono/1.7.2/GeistMono-Variable.woff2`), fetched only when
  something on the page uses it, precached by the service worker (`src/lib/shared/sw-policy.test.ts:100,118`), allowed by
  `font-src 'self'`. Motion tokens `--ease`, `--duration-*` (`tokens.css:156-164`), `src/lib/ui/motion.ts:5-8`;
  `motionAllowed({ reducedMotion, hidden })` at `motion.ts:20-22`. Design rules today: Geist Mono "only for keys,
  endpoints and code samples ... never for amounts" (`DESIGN_SYSTEM.md:106`); "nothing is infinite" except loading
  indicators (`DESIGN_SYSTEM.md:160-161`, `:172-173`; CSS enforced by `test/motion-css.test.ts:59-112`).
- CSP: `script-src 'self'`, `style-src 'self'`, `style-src-attr` limited to one hash (`src/lib/server/csp.test.ts:17-24`);
  the auth pages add the Turnstile origin only (`src/lib/server/auth/turnstile.ts:116-131`). A `style=""` attribute on the
  art would be blocked, so all sizing and tones are CSS classes and the frame is text only.

## Scope

1. **Field generator (pure, shared):** `src/lib/shared/ascii-field.ts` with its test `src/lib/shared/ascii-field.test.ts`
   (shared code runs unchanged anywhere; no DOM, no clock, no `Math.random`). Input `(t, cols, rows)` plus an optional
   seed constant; `t` is milliseconds of played time. Output: `rows` strings of exactly `cols` characters (`string[]`), and
   the same cells split into three brightness tiers (edge, mid, core) so the component can tone them with CSS only.
   Method: seeded **value noise** (integer lattice hash with `Math.imul`, smoothstep interpolation, 2 to 3 octaves of fbm),
   sampled in three dimensions (x, y, time) so blobs drift, merge and split over about 10 s; a cell shows a glyph when
   the field is above a threshold, more of them (denser) and in a higher tier as the value rises; outside the blobs the
   cell is a space. Cells are about twice as tall as wide, so y is scaled to keep blobs round. Only `+ - * /`, `Math.floor`
   and `Math.imul` in the noise: no `Math.sin`, `cos`, `pow`, `random`, `Date` (their results differ between engines and
   would break deterministic tests and golden frames).
2. **Glyphs:** each row repeats one string built from "MONTRA", the digits `0123456789` in order and "Rp" (for example
   `MONTRA0123456789Rp`), shifted per row so the columns do not line up. The digits are a fixed ramp, never a number a
   person could read as an amount (acceptance criterion 3).
3. **Frame constants:** `ASCII_STATIC_T` (the engineer picks, by eye, a `t` whose frame shows two or three well-formed
   blobs; this is the server-rendered still and the starting point of the animation, so there is no jump), the two grid
   sizes (item 5), the frame interval and the played-time cap (item 6).
4. **One shared component** `src/lib/ui/auth/AsciiField.svelte`: a rounded panel containing the glyph text, `aria-hidden="true"`,
   no `tabindex`, `pointer-events: none`, `user-select: none`, hidden in print. Server-rendered with the still frame, so
   no-JS and reduced motion show a finished picture from the first byte. Fill `--panel` (panel fill, no border, no shadow;
   "fills not frames"), radius from the existing radius tokens (the same as the other panel cards). Glyph colour from tokens
   only, light and dark alike: `--muted` for the edge and mid tiers (via the layer's static `opacity`) and `--ink-2` for the
   core; never `--ink` at full strength and no accent, category or brand colour. Dark theme therefore gives light glyphs on
   near-black, light theme gives muted ink glyphs on the light panel; the mono variants follow the tokens. The three tiers
   are three stacked `<pre>`s (or an equally CSP-safe equivalent) so no per-character element and no inline style exist;
   the engineer may merge them if density alone reads well, and says so in the report.
5. **Sizes, fixed in CSS** (the box never depends on the text, the text is clipped with `overflow: hidden`, so a font swap
   from `font-display: swap` or a fallback monospace cannot move anything). One component, one generator, two grids;
   both `<pre>`s are server-rendered and CSS shows one, and only the shown one animates:
   - **Phone and tablet (< 1024 px):** a short band, 140 px tall, the column's width (up to 400 px), above the form. Grid about
     56 columns x 10 rows at 12 px type and 14 px line (advance about 0.6 em, so about 7.2 px per column); columns beyond the
     box are clipped.
   - **Desktop (>= 1024 px):** a tall card beside the form, 360 x 560 px. Grid about 50 columns x 40 rows at the same type.
   The engineer may adjust the numbers after measuring Chromium and WebKit; the boxes stay fixed, equal at every frame, and
   the phone band stays inside 120-160 px.
6. **Playback:** driven by `requestAnimationFrame`, drawing at most once per 66 ms (about 15 fps; Owner decision 7), with `t`
   advanced by played time (never wall time), so a resume continues smoothly. Paused by `visibilitychange`
   (`document.hidden`), by an `IntersectionObserver` (off-screen; an unsupported observer counts as visible) and by
   `prefers-reduced-motion: reduce` (tracked live, e.g. `prefersReducedMotion` from `svelte/motion`, used at
   `src/lib/ui/kit/HeroAmount.svelte:4`); the decision is a pure helper in `src/lib/ui/auth/ascii-playback.ts` reusing
   `motionAllowed` (`src/lib/ui/motion.ts:20`). After 60 s of played time per page view the field freezes where it is
   (Owner decision 5). Cleans up its rAF handle, observer and listeners on destroy. Only the shown grid runs.
7. **Placement** (Owner decisions 2 and 3): rendered once by `src/routes/(auth)/+layout.svelte` for `/masuk` and `/daftar`
   only (one route constant), between the wordmark row and the card on phone and tablet, beside the card on desktop (art on
   the left; the form column keeps its 400 px, the wordmark stays above the form column; gap about 48-64 px; whole group
   centred). `/akun-dihapus` renders as today. The `.hero-art` Koko blocks and their CSS are removed from both pages.
8. **Docs:** `docs/design/DESIGN_SYSTEM.md` § Motion (a script-driven rAF frame animation: throttled, paused hidden /
   off-screen, none under reduce, finite), § Typography (Geist Mono also draws the auth art; still never amounts), § Mascot
   (`:209` loses "sign-in/sign-up hero above 768 px" if Owner decision 3 is "replace"), change log v3.3.
   `docs/FEATURES.md` gets the FN-56 entry (added with this PRD).
9. **i18n:** zero new phrases. No headline or tagline is drawn on the panel (Owner decision 6); the art is `aria-hidden` and
   has no copy. `test/i18n-coverage.test.ts` stays green; the report says "0 new phrases".

## Out of scope

- Any ASCII art on `/akun-dihapus`, an app (signed-in) page, the marketing site, an error page or the install guide (Owner
  decision 4). There is no password-reset page to cover.
- Canvas, WebGL, SVG, CSS keyframes, an animation, noise or ASCII library, a font or image file, Lottie, any network request.
- A strong-colour variant (the reference has a coloured one; here colour only carries meaning), a headline or tagline on the
  panel, Montra brand blue.
- Reacting to form state (typing, pending, error, Turnstile solved, passkey prompt). The field is decoration; it never
  stands in for a spinner, a "signing in" status or a success mark (checklist "Truthful state").
- Sound, haptics, pointer interaction (parallax, hover), click-to-replay, a "turn animation off" setting (the OS
  `prefers-reduced-motion` stays the one switch).
- Changing the wordmark, form fields, copy, Turnstile or passkey behaviour, redirects, the `next` handling, the CSP, any
  server file.
- A new e2e spec file. Existing specs are extended where listed.
- Redrawing Koko or removing it from other places (empty states, error pages, Beranda's first-wallet card).

## Acceptance criteria

Levels per `docs/ACCEPTANCE.md`: **Automated** = Vitest, **Browser** = Playwright (existing specs), **Pass** = a named manual
check recorded in the completion report as run or not run. Never report an unrun check as passed.

**Generator (Automated, `src/lib/shared/ascii-field.test.ts`)**

1. Given the same `(t, cols, rows, seed)`, when the generator is called twice (and again after a fresh module import), then
   the output is identical, and one golden frame per grid size (a stored hash of the rows at `ASCII_STATIC_T`) is stable.
   Given a different seed, then the frame differs.
2. Given `t` sampled across 0 to 60 000 ms (step 997) and both grid sizes, then the output has exactly `rows` strings of
   exactly `cols` characters (spaces kept, nothing trimmed) and each tier layer has the same dimensions; given degenerate
   input (`cols`/`rows` 0, 1, negative, fractional, `NaN`, above the cap; `t` negative, `NaN`, `Infinity`), then the call
   never throws, sizes are clamped to 1 .. the cap (so work is bounded) and `t` is clamped to a finite range.
3. Given any frame, then every character is a space or a character of the glyph string (letters M O N T R A, digits 0-9, R,
   p), all printable ASCII; the union of the three tier layers equals the combined rows; no row matches `/Rp ?\d/` (a
   rupiah-like "Rp" followed at once by a digit) and no non-ASCII character (U+2212 included) ever appears: the field never
   shows or implies an amount.
4. Given sampled `t` values, then the share of glyph cells stays between a lower and an upper bound (never a blank panel,
   never a full one; the engineer sets and states the bounds, expected roughly 8-65 %), including at `ASCII_STATIC_T`.
5. Given sampled frames, then glyph density rises with tier: the share of the tier's own neighbourhood that is filled is
   lowest at the edge and highest in the core (edge < mid < core), measured on the generator's tier layers.
6. Given two frames one interval (66 ms) apart, then at most a small share of cells change (the field drifts, it does not
   flicker; the engineer sets the bound); given two frames 10 s apart, then more than a minimum share differ (it really
   morphs).
7. Given the module source, then it contains no `Math.sin`, `Math.cos`, `Math.pow`, `**`, `Math.random` or `Date`, and imports
   nothing from `$app`, `svelte` or the DOM (Automated, source grep).
8. Fail-before proof in the report: the size test (criterion 2) fails when one row is made a character short, the amount test
   (criterion 3) fails when "Rp 5" is planted, and the purity test (criterion 7) fails when `Math.random` is planted.

**Component and playback (Automated, fake rAF / timers, Svelte render)**

9. Given reduced motion on, then no `requestAnimationFrame` is ever requested and the text stays the still frame; given motion
   allowed and visible, then the text changes, drawn at most once per 66 ms however fast rAF fires; given `visibilitychange`
   to hidden, then the pending frame is cancelled and nothing changes, and on return it resumes from the same `t`; given the
   observer reports not-intersecting, the same; given reduced motion switched on while running, it stops within one frame
   on the still frame.
10. Given 60 s of played time (hidden and off-screen time excluded), then the field freezes and requests no more frames; one
    rAF handle exists at a time; after destroy no rAF, observer or listener remains.
11. Given the generator is forced to throw, or `IntersectionObserver` is missing, then the component keeps showing the still
    frame (or treats itself as visible) and nothing reaches the form (no error thrown into the page).

**Render, accessibility and CSP (Automated + Browser)**

12. Given the server HTML of `/masuk` and `/daftar` (rendered with the layout, as `test/auth-pages.test.ts` renders the pages),
    then it contains the `aria-hidden="true"` field with the still frame in both grid sizes (one shown by CSS), no
    `tabindex`, no `role`, no `<canvas>`, no `style=` attribute and no `{@html}` anywhere in it; `/akun-dihapus` contains none.
13. Given a Tab walk on `/masuk` and `/daftar`, then the first focus stop is the same element as before (the wordmark link, then
    the first field), Shift+Tab from the first field never lands in the art, and the accessibility tree has no node for it
    (Browser: the rewritten `e2e/motion.spec.ts:605-632` case).
14. Given Chromium with the CSP active, then zero CSP violations are logged on `/masuk` and `/daftar` with motion on (the
    `collectCspViolations` pattern at `e2e/turnstile.spec.ts:58`), the component injects no inline style or `<style>`, and
    `src/lib/server/csp.test.ts` passes unmodified (Browser + Automated).
15. Given the component source, then it declares no CSS `animation*` or `transition*` and no `infinite` (all motion is
    script frames, which leaves `test/motion-css.test.ts:94-112` meaningful), every colour is a token reference
    (`var(--panel|--muted|--ink-2)`, no hex, `rgb()` or literal `color-mix`), and it reads no storage API (Automated, grep).

**Motion rules (FN-51 conventions)**

16. Given `prefers-reduced-motion: reduce` (the default of the Playwright projects, `playwright.config.ts:29`), then the field
    shows the still frame and its text never changes over 1 s of waiting (Browser, in the rewritten `motion.spec.ts` case).
    Given motion allowed in a dedicated context (as `motion.spec.ts` does for its motion-on cases), then the text changes
    within 1 s, and `document.hidden` stops it (Browser).
17. Given the animation running, it takes no pointer events and does not delay the form: inputs, the show/hide password
    button, the Turnstile container, the passkey button and the "Daftar"/"Masuk" links accept a click as soon as the page is
    interactive (Browser: the existing sign-in and sign-up flows pass unchanged, see "Existing specs").

**Layout (Browser)**

18. Given 360 x 640 on `/masuk` and `/daftar`, then the band sits above the form, is 120-160 px tall, has no horizontal scroll
    (`expectNoHorizontalScroll`), the E-mail field's bottom is still <= 640 px (assertion at `e2e/motion.spec.ts:616-617`,
    kept, now with the band present; expected about 550 px on `/daftar`), and the box measures the same before and after
    1 s of playing with motion on (bounding box compared; zero layout shift from the art).
19. Given a viewport shorter than 600 px (landscape phone, small screens), then the art is `display: none` and the form starts
    where it does today; given 768-1023 px wide, the band stays above the form in the single column.
20. Given 1280 x 800 (and exactly 1024 px), then the card is a fixed 360 x 560 px sibling to the left of the 400 px form column,
    the form column keeps 400 px, the wordmark stays above the form column, nothing overlaps (card, wordmark, form,
    Turnstile), the form's top edge does not move when the animation starts, and there is no horizontal scroll.
21. Given light and dark themes (and the mono variants where the e2e already toggles them), then glyphs are visible but quieter
    than the H1, use ink tones only, and are absent from the contrast audit as text (decorative). Pass: screenshots at 360 and
    1280, light and dark, attached to the report.

**Pages unchanged in substance**

22. Given `/masuk` with Turnstile configured, then the widget still renders with `data-action="sign-in"`, fits a 360 px column
    and the art never covers it (`e2e/turnstile.spec.ts:54-89` unchanged); with Turnstile off, no widget and no script as before
    (`test/auth-pages.test.ts:32-42`).
23. Given a browser with WebAuthn, then the passkey button still appears under the form after mount without moving the art or
    the form above it, and the notice stays in place (`e2e/passkey.spec.ts` unchanged).
24. Given JavaScript off, then the art shows the still frame, both forms post and sign the person in as before
    (`e2e/passkey.spec.ts:215-230`).
25. Given a refused submit, a validation error, `pending` or the offline banner, then each looks and behaves as before and the
    art neither changes nor reacts (`e2e/accounts.spec.ts`).

**Checklist-derived**

26. Server-side authorization and data: the diff touches no `+page.server.ts`, no `src/lib/server/**`, no `hooks`, no
    `migrations/`, no `package.json` dependency and no `static/` file; `/masuk` and `/daftar` redirect a signed-in user exactly
    as before and `/akun-dihapus` is unchanged. No new load or action exists, so no space-scoped query is added (grep the diff;
    state it in the report).
27. Persisted state: none. No cookie, localStorage, sessionStorage or IndexedDB key; a reload shows the same still frame and
    starts again from `ASCII_STATIC_T`. States: the art has no loading, empty, error, saving or success state of its own.
28. i18n, money and dates: no new Indonesian phrase (`test/i18n-coverage.test.ts` green); no amount and no date is shown, so no
    money arithmetic or WIB bucketing is involved (criterion 3 proves no amount appears).
29. Performance and weight: generation for the desktop grid is measured (median ms per frame in Node, stated in the report; the
    engineer keeps it well under the 66 ms interval); `npm run build` auth-route JS is measured before and after (target: the
    generator plus component add under about 4 KB gzipped); no new dependency; no new network request other than the Geist Mono
    file if Owner decision 6 keeps it (Automated + Pass).
30. `npm run gates` (check, lint, test, build) is clean.
31. Touch targets and zoom: at 360 px every button and the "Daftar"/"Masuk" link keep >= 44 px (`e2e/accounts.spec.ts:260-300`
    unchanged); at 200 % browser zoom the page reflows without horizontal scroll (Pass).
32. Cross-browser: the layout checks run in WebKit (`e2e/ios-responsive.spec.ts`, `e2e/parity-d.spec.ts`), plus a manual look at
    iOS Safari and Android Chrome with Geist Mono loaded and blocked (fallback monospace): same box, no jank, no clipped panel
    (Pass, manual; stated as run or not run).
33. Docs: the DESIGN_SYSTEM edits in Scope 8 are made and `test/font.test.ts` still passes (Geist Mono version string unchanged).

## Existing specs and tests that touch these pages

Must pass **unchanged**:

- Unit/integration: `test/auth-pages.test.ts` (server HTML of `/masuk`, `/daftar`: Turnstile on/off, no passkey button without
  JS), `test/integration/turnstile.test.ts`, `test/integration/passkeys.test.ts`, `test/i18n-coverage.test.ts`,
  `test/motion-css.test.ts`, `test/font.test.ts`, `test/platform-css.test.ts`, `src/lib/server/csp.test.ts`,
  `src/lib/shared/sw-policy.test.ts`.
- E2e (every one signs up through `/daftar` or signs in through `/masuk`, so an overlap or a shifted field breaks them all):
  `e2e/accounts.spec.ts` (sign-up, sign-in, `next` return, 360 px light/dark with the 44 px target check at `:260-300`),
  `e2e/turnstile.spec.ts` (`:54-89` 360 px fit and CSP), `e2e/passkey.spec.ts` (button, conditional UI, no-JS at `:215-230`),
  `e2e/parity-d.spec.ts:31-49` (360 x 780: H1 visible, no horizontal scroll on `/masuk` and `/daftar`),
  `e2e/ios-responsive.spec.ts` (WebKit, signs up at `:104`), `e2e/pwa.spec.ts` (loads `/masuk` and `/daftar` at `:90-231`,
  `:826`, `:996-999`, `:1484`; offline shell and install flows), `e2e/offline-queue.spec.ts:30,161,224`,
  `e2e/catatan-rilis.spec.ts:55,151`, `e2e/ruang.spec.ts:38-50,221` (the "Daftar" link on `/masuk` with `next`),
  `e2e/site.spec.ts:96,201,247`, `e2e/auth.setup.ts:20` and `e2e/ledger.ts:30` (the shared sign-up helpers used by about 25
  specs), `e2e/account-key.spec.ts`.

**Change on purpose** (Koko hero removed, Owner decision 3 "replace"; if the owner picks "keep", these stay and the layout
criteria 18-20 gain a Koko clause):

- `test/mascot-placements.test.ts:47-58`: the sign-in/sign-up case is rewritten to assert the pages no longer contain the
  hero-art Koko block and that `Mascot` remains on Beranda's first-wallet card (`:60-66`, unchanged).
- `e2e/motion.spec.ts:605-632`: renamed and rewritten to criteria 13, 16 and 18-20 (phone: band visible above the form, E-mail
  bottom <= 640; 1280 x 800: card beside the form, `aria-hidden`; no Koko). This is the one place the new browser assertions
  go; no new spec file.

## Architecture notes

- New: `src/lib/shared/ascii-field.ts` (+ `.test.ts`), `src/lib/ui/auth/ascii-playback.ts` (+ `.test.ts`),
  `src/lib/ui/auth/AsciiField.svelte` (+ a component test beside it). `src/lib/ui/auth/` already holds `Field.svelte`,
  `FormBanner.svelte`, `Turnstile.svelte`, `webauthn.ts`.
- Edited: `src/routes/(auth)/+layout.svelte` (render the field for `/masuk` and `/daftar` from one route constant; a class on
  `.auth` switches to two columns at `min-width: 1024px`; `.top`/`.card` keep `max-width: 400px`; read the route with `page`
  from `$app/state`), `src/routes/(auth)/masuk/+page.svelte` and `daftar/+page.svelte` (remove the hero block, its CSS and
  the now-unused `Mascot` import), `docs/design/DESIGN_SYSTEM.md`, `docs/FEATURES.md`.
- Reuse, do not duplicate: `motionAllowed` (`src/lib/ui/motion.ts:20`), `prefersReducedMotion` (`svelte/motion`), the tokens
  in `docs/design/tokens.css` (`--panel`, `--muted`, `--ink-2`, `--font-mono`, the radius tokens), `collectCspViolations`
  and `expectNoHorizontalScroll` from the e2e helpers, `cssOf`/`declarations` in `test/helpers/css.ts` for the grep-style
  checks. The component has no `$app/*` import (the layout decides where it shows), so a test can render it directly.
- No D1 migration. No Worker other than the app Worker. No change to headers, CSP or service-worker precache.

## Prerequisites

None. No credential, provider, `.dev.vars.example` entry or secret; nothing shows "Belum dikonfigurasi". Playwright runs on the
local Chromium/WebKit the existing specs use; the `docs/TASKS.md` "install-deps chromium" **You** item applies to e2e
generally, not to this feature.

## Tracker impact

- `docs/TASKS.md`: no open item covers this. Add under the FN-5x lines (around `:206-216`) `- [ ] **Claude** — FN-56 ASCII field
  animation on sign-in and sign-up, no migration — docs/features/fn-56-auth-ascii/PRD.md` and tick it at completion; if the
  device look (criterion 32) is not run, add `- [ ] **You** — FN-56 manual check: ASCII field on a real iPhone and Android
  phone (box size, smoothness, Geist Mono and fallback)` next to the FN-51 manual item at `:204`.
- `docs/ACCEPTANCE.md:57` ("360 px layout, 44 px touch targets, reduced motion", Browser): add `e2e/motion.spec.ts` (auth art
  case) and `src/lib/shared/ascii-field.test.ts` to the Check column; status stays **Browser**, no row moves.
- `docs/HISTORY.md`: one Completed-work bullet at the end of the build (checks run, generator ms per frame, added JS size,
  manual looks run or not).

## Owner decisions (defaults proposed; answer once before the build)

1. **Subject.** *Default (your reference): a drifting field of Montra's own letters, the word "MONTRA", the digits 0-9 and
   "Rp", shown as soft blobs of a slow noise field, denser and brighter in the core, fainter at the edge, empty outside.*
   Replaces the earlier money-flow idea (coins into a bar). Style only; nothing of the reference's text, logo or brand is
   used. The digits are a fixed 0-9 ramp, tested never to read as an amount ("Rp" is never followed at once by a digit).
   Alternative: letters of "MONTRA" only (no digits, no "Rp"), the safest reading of "no invented figures".
2. **Placement.** *Default: phone and tablet (< 1024 px) a 140 px band above the form (120-160 px allowed); desktop (>= 1024 px) a
   tall 360 x 560 px card beside the form on the left; hidden when the viewport is shorter than 600 px.* Phone cost: +164 px
   above the fields (140 px band + 24 px gap): on 360 x 640 the E-mail field still ends above 640 px, but on `/daftar` the
   password field and checkboxes move down. Alternative: no art on phone (form first), or a band below the form (below the
   fold, rarely seen).
3. **Koko hero on sign-in/sign-up.** *Default: the field replaces it* (one hero, not two; Koko stays everywhere else).
   Consequence: `wave` loses its sign-in/sign-up placement in `DESIGN_SYSTEM.md:209` and two tests change. Alternative: keep
   Koko at >= 768 x 720 px and show the field in addition (busier).
4. **Other pages.** *Default: `/masuk` and `/daftar` only.* `/akun-dihapus` (a sober deletion confirmation) is left as is;
   there is no password-reset page. Alternative: also `/akun-dihapus` (one more entry in the route constant).
5. **How long it runs.** *Default: about 15 fps while the tab is visible and the panel on screen, frozen after 60 s of played
   time per page view.* This keeps the spirit of `DESIGN_SYSTEM.md:160-161` ("nothing is infinite") and saves battery. The
   reference never stops; the alternative is no cap (one constant) but it becomes the second non-loading perpetual motion in
   the app and the design rule is rewritten to say so.
6. **Font, copy and colour.** *Default: `var(--font-mono)` = self-hosted Geist Mono, system monospace as fallback; no headline
   or tagline on the panel (the page already has an H1 and a subtitle; the reference has both, we add zero strings); glyphs in
   ink tones on the panel fill, one look in every theme (no strong-colour variant).* Costs: a first-time signed-out visitor
   downloads the Geist Mono file on `/masuk` or `/daftar` (size stated from the build; precached after the first visit); the
   rule "Geist Mono is only for code samples" is widened by one sentence. Alternatives: system monospace only (no download, look
   varies by device); a tagline reusing an existing phrase.
7. **Smoothness vs battery.** *Default: 15 fps (one frame per 66 ms), rAF, about 2 000 cells on desktop and 560 on phone.*
   Alternative: 12 fps (cheaper, a little steppier, closer to an "ASCII" feel) or 24 fps (smoother, about 60 % more work).
   No reaction to typing or submit either way.

## Owner decisions - answered

Answered by the owner on 2026-10-13. Where these differ from the PRD above, these win.

1. **Subject:** the letter field, as written (MONTRA, the 0-9 ramp, "Rp").
2. **Placement:** a band above the form on phone and tablet, a tall card beside the form from 1024 px.
3. **Koko: keep Koko.** The ASCII card sits next to Koko on desktop; it does not replace Koko. `test/mascot-placements.test.ts`
   and the Koko assertions in `e2e/motion.spec.ts` stay as they are unless layout forces an edit; the ASCII browser
   assertions are added beside them. The desktop has no overlap and no horizontal scroll at 1024, 1280 and 1440 px; if Koko,
   card and form cannot fit at 1024 px, the card shows from 1280 px and the phone band stays below that.
4. **Pages:** `/masuk` and `/daftar` only.
5. **Run length:** stops after 60 s of played time, freezing on a frame.
6. **Text:** no text on the card. Geist Mono as proposed; `DESIGN_SYSTEM.md` gets the one-sentence widening of the font rule.
7. **Frame rate:** 15 fps.
8. **Colour (overrides the ink-on-panel look in Scope 4, criteria 15 and 21, and "Out of scope: brand blue"):** match the
   reference. Light theme: an electric-blue card (about `#0B3DF5`, with AA contrast for the brightest glyph tier) with
   white glyphs at 3 opacity tiers. Dark theme: a black card with light glyphs. The phone band uses the same colours. The
   blue is a new design token pair in `docs/design/tokens.css` (a surface plus its "on" colour), defined for light and dark
   like the other tokens, never hard-coded in the component. The rest of the app is not restyled now; `DESIGN_SYSTEM.md`
   gets one line saying the brand blue exists, is used by the auth card, and that an app-wide accent change is pending
   as FN-57.
