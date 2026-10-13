# FN-44 — Montra's mascot ("Koin hidup")

Status: proposed. Risk tier: **Medium** (no migration, no new space-scoped query, no provider/credential; a new
shared component plus call-site swaps across the app shell, auth pages, error pages, three success moments, and
every home-screen/browser icon asset — breadth, not depth, like FN-40).

Owner request (2026-10-09): "add mascot more montra like clawd." Owner answer, same day: concept **"Koin hidup"**
(a living coin) — an original pixel-art character with small eyes and feet, drawn in Montra's accent colour, easy
to animate (blink, hop, spin on success). Placements: empty states & error pages, onboarding & sign-in/sign-up,
success moments (transaction saved, streak/close-the-day, budget safe), the app icon (PWA/home screen), the
favicon and a loading indicator. "Like Clawd" names the *style* only — a small, charming pixel-art mascot, the way
Anthropic's Claude Code has one — not its shape, palette or any pose; `docs/design/DESIGN_SYSTEM.md` already
forbids copying any other product's mascot, and that rule extends here to Clawd and any other brand's
character: Koko is drawn from scratch for this app.

**Name:** proposed **"Koko"** (short, easy to say in Bahasa Indonesia and English, no existing product collision
inside this app's copy) — owner decision, default below.

**Personality note (for copy tone):** Koko is quietly encouraging, never scolding and never cute-at-the-user's-
expense. It reacts to what actually happened (a save that is confirmed, a day that is closed, an error that is
real) and never performs an emotion the data does not support — it does not celebrate a budget that is over, and
it does not look sad for a filtered list that is merely empty by choice. Its "voice" is entirely visual (pose,
never speech bubbles or its own copy) — all meaning stays in the existing `text` next to it, per the accessibility
rule already established for `<Illustration>` (`src/lib/ui/kit/Illustration.svelte:13-15`).

## Goal

Montra's empty states, error pages, onboarding and success moments are currently either plain text or a hand-drawn
isometric scene (`docs/design/DESIGN_SYSTEM.md:157-165`, FN-40 Part 3) that explains *what* is empty but carries no
character. A single, original, reusable pixel-art mascot that appears at the handful of moments the owner named —
and only there — gives the app a recognisable face without re-illustrating everything FN-40 already built, and
turns three already-confirmed server writes (a transaction saved, a day closed, a budget's safe-to-spend turning
positive) into a small moment of delight that is wired strictly to what the server actually confirmed, never
before, per `CLAUDE.md`'s "success only after the write is confirmed."

## Scope

### Part 1 — The mascot component and its poses

- New `src/lib/ui/kit/Mascot.svelte`: renders one pose from a **24×24 pixel grid** (owner decision 2 below) as
  inline SVG `<rect>` elements (one `<rect>` per non-transparent pixel, `shape-rendering: crispEdges` on the root
  `<svg>`), the same inline-only, no-`<image>`/no-external-reference discipline `<Illustration>` already follows
  (`src/lib/ui/kit/Illustration.svelte:23-37`, tested at `src/lib/ui/kit/Illustration.test.ts:81-85`). Props mirror
  `Illustration`'s shape for consistency: `pose` (the `IllustrationName`-style union below), `size` (px, square),
  `alt` (optional — decorative/`aria-hidden` by default, `role="img"`/`aria-label` only when it is the thing
  conveying state, e.g. a loading label).
- Colour comes from theme tokens only, reusing exactly what already passes `test/contrast.test.ts`'s graphics pairs
  (`test/contrast.test.ts:81-83`: `--accent` on `--bg`/`--panel`/`--chart-bar` already checked at 3:1 in all four
  themes) so **no new contrast pair or token is required**: body fill `var(--accent)` (desaturates to mono grey
  automatically — `docs/design/DESIGN_SYSTEM.md` FN-40 Part 1 lists `--accent` among the tokens mono desaturates,
  satisfying "colours from theme tokens (mono → greys)"), outline `var(--ink)` (already AA-tested against `--bg`
  and `--panel`), eyes/mouth as background-colour cut-outs (`var(--bg)`, negative space, no separate contrast
  check needed), feet/shadow `var(--ink-2)`. No hex, no `rgb()`, matching `Illustration.test.ts:61-79`'s existing
  "no colour in the markup" rule, which this PRD's new `Mascot.test.ts` repeats for Koko.
- Pose set (`src/lib/ui/kit/mascot/poses.ts`, one or more 24×24 frames per pose plus a frame-advance rule):
  `idle` (default, a slow blink folded in as a bounded 2-cycle loop — no separate always-invoked "blink" pose is
  required if idle already blinks a couple of times then rests, mirroring `Illustration.svelte:171-190`'s
  float/breathe pattern: 3–6 finite cycles, then still), `wave` (onboarding/auth), `hop` (transaction saved),
  `celebrate` (streak closed, budget safe), `sad` (error), `sleep` (generic empty state), `loading` (the one
  exception that runs for as long as work is outstanding — see Part 4). Frame-to-frame animation uses
  `animation-timing-function: steps(1)` (an instant cut between pixel frames, never an interpolated/blurred
  tween — pixel art stays crisp) and is **finite**: the same bounded-cycle-then-rest pattern as `Illustration`'s
  `float`/`breathe` (`@keyframes` + a fixed iteration count, not `infinite`), gated under
  `@media (prefers-reduced-motion: no-preference)` exactly like `Illustration.svelte:171-180` and tested the same
  way `test/motion-css.test.ts` already tests `Illustration.svelte` (add `src/lib/ui/kit/Mascot.svelte` to that
  file's `MOTION_FILES` array, `test/motion-css.test.ts:50-61`, so Koko inherits the "every animation is gated,
  nothing loops forever" checks for free).
- `src/lib/ui/kit/mascot/Mascot.test.ts`: the same test shapes as `Illustration.test.ts` — decorative by default
  (`aria-hidden`, no `role="img"`) unless `alt` is given; no hard-coded colour in the markup or stylesheet, every
  shape coloured by a class mapped to a theme token; inline-only (no `<image>`/`href`/`url()`); one snapshot per
  pose so a future edit to Koko's pixels is a reviewable diff.

### Part 2 — Where Koko replaces an existing isometric scene (owner decision 4 below)

To avoid "double art" (an isometric scene *and* a mascot in the same spot), Koko takes over only the placements the
owner named; the eight other `<Illustration>` scenes FN-40 already drew for domain-specific empty states (wallet,
budget, calendar, parcels, growth, goal, people, history, inbox — each listed with its call site at
`docs/features/fn-40-visual-refresh/PRD.md:116-130`) are **unchanged** this pass:

- **Onboarding/auth** — `src/routes/(auth)/daftar/+page.svelte:30` and `src/routes/(auth)/masuk/+page.svelte:29`
  (`<Illustration name="welcome" size={240} />`) become `<Mascot pose="wave" size={168} />` (decorative, same
  "hidden below 768 px so it never pushes the form down" rule already in place for that hero slot).
- **Error pages** — `src/routes/+error.svelte:15` and `src/routes/(app)/+error.svelte:16,23`
  (`illustration="broken"`) become `illustration`-equivalent `pose="sad"` — either `EmptyState` gains a `mascot`
  prop alongside its existing `illustration` prop (mutually exclusive, the engineer's call which is cleaner given
  `EmptyState.svelte`'s current single-slot layout at `src/lib/ui/shell/EmptyState.svelte:28-30`), or these three
  call sites render `<Mascot>` directly above `EmptyState`'s text the same way the hero slots above do. The text
  (`tr('Halaman tidak ditemukan.')`, `tr('Terjadi kesalahan. Coba lagi.')`) stays the only accessible description,
  unchanged.
- **Beranda's zero-wallet onboarding moment** — `src/routes/(app)/+page.svelte:286`
  (`<Illustration name="wallet" size={88} />`, shown only while the space has no wallet) becomes
  `<Mascot pose="wave" size={88} />`. Every *other* `illustration="wallet"` call site (`dompet`, `riwayat/baru`,
  `riwayat/suara`, `riwayat/struk`, `riwayat/berulang/baru` — all "add a wallet first" prompts, not the first-run
  moment) stays the isometric wallet scene, unchanged.
- **`EmptyState`'s own default** — today, an `EmptyState` with no `illustration` prop renders text only
  (`src/lib/ui/shell/EmptyState.svelte:28-30`, locked in by
  `src/lib/ui/kit/Illustration.test.ts:111-115`: "without `illustration` an empty state is text only, exactly as
  before"). This PRD changes that default to `<Mascot pose="sleep" size={120} />` when neither `illustration` nor a
  new `mascot={false}` opt-out is given — the additive placements FN-40 chose not to decorate (`ruang/undangan`'s
  two states, the catch-all `[stub=stub]` page, `anggaran`'s "all categories budgeted" line, `pengaturan/api`'s
  "no tokens", `pengaturan/aplikasi`'s "no connected apps", `impor`'s "no reading jobs yet", `pengaturan/
  integrasi`'s "no API key", `riwayat`'s filtered-empty state, the public blog's "no articles") now show Koko
  asleep instead of nothing. `Illustration.test.ts:111-115`'s existing assertion must be updated to match (it is
  the one pre-existing test this PRD knowingly changes the meaning of; the engineer updates it in the same diff,
  not a separate one, and notes it in the completion report).

### Part 3 — Success moments (wired after the server confirms, never before)

Exactly the three moments the owner named, each already an existing, server-confirmed success state this PRD adds
Koko next to — no new success state is invented:

- **Transaction saved** — the existing `role="status"` confirmation text at
  `src/routes/(app)/riwayat/+page.svelte:159-160,228-229` (`tr('Transaksi disimpan.')`, shown only after
  `data.saved` comes back from the server) and the existing save toast at
  `src/routes/(app)/riwayat/suara/+page.svelte:658-663` gain `<Mascot pose="hop" size={40} aria-hidden>` next to the
  text. No other transaction-saved surface (quick-add's plain redirect, the receipt/statement batch-save counts at
  `riwayat/struk/+page.svelte:209-210`) changes — bounded to the two spots that already render a persistent,
  readable confirmation line, not a toast that may have already auto-dismissed before the animation would read.
- **Streak / close-the-day** — the existing `role="status"` line at `src/routes/(app)/+page.svelte:474-477`
  (`trf('Hari ini ditutup · {berturut}', …)`, shown only after `?/closeDay`'s form action succeeds, never on a
  plain page load) gains `<Mascot pose="celebrate" size={40} aria-hidden>`.
- **Budget safe** — Anggaran's existing save-confirmation (`savedText`/`form.saved` pattern,
  `src/routes/(app)/anggaran/+page.svelte:150-158`) gains `<Mascot pose="celebrate" size={40} aria-hidden>` only
  when the just-saved budget's recomputed safe-to-spend is `kind: 'left'` (positive — the same `safe.kind` union
  Beranda already reads, `src/lib/shared/budget-progress.ts:7`, rendered at `src/routes/(app)/+page.svelte:368`).
  If the save results in `'spent'` or `'over'`, no mascot shows — Koko never celebrates a budget that is already
  blown. This is a one-time reaction to the save action, not a persistent decoration on Beranda's safe-to-spend
  display (which stays exactly as it renders today, every load, per "one number first").

### Part 4 — Loading indicator (the one pose allowed to keep running)

- New `src/lib/ui/kit/MascotLoading.svelte`: wraps `<Mascot pose="loading">` with a continuous
  `animation-iteration-count: infinite` `steps()` walk/bob **only while mounted** — the component is conditionally
  rendered (`{#if active}`), never present in the DOM on an idle page, so it never violates the spirit of
  `test/motion-css.test.ts`'s "nothing animates forever (an idle page comes to rest)" rule even though it is the
  one pose exempt from the finite-cycle rule Part 1 poses follow (it is *not* added to that test file's
  `MOTION_FILES` list; it gets its own dedicated test instead, asserting (a) no animation CSS when `active` is
  false — in fact no `<svg>` at all, (b) the animation is gated under `prefers-reduced-motion: no-preference`,
  and (c) under `reduce` the component renders **plain text only** (`tr('Memuat…')`), not even a static mascot
  image — the owner's explicit fallback rule, because a non-animating "loading" pose would look like a broken
  image rather than "nothing is happening yet").
- Wired once, as a new global top-of-shell indicator in `src/routes/(app)/+layout.svelte:49-62` (currently no
  loading indicator exists there; page-level loads use `Skeleton.svelte` instead, e.g.
  `src/routes/(app)/ruang/+layout.svelte:1-14`, which this PRD does **not** replace): `active` is derived from
  `navigating` (`$app/state`, the same store `ruang/+layout.svelte:2,8-9` and `riwayat/+page.svelte`'s own `loading`
  derivation already read) whenever a client-side navigation is in flight. `MascotLoading` stops the moment
  `navigating` clears — it is never shown after the destination page has rendered.

### Part 5 — App icon, favicon and manifest

- `static/icons/icon-192.png`, `static/icons/icon-512.png` (`purpose: "any"`), `static/icons/
  icon-maskable-512.png` (`purpose: "maskable"`, Koko's idle pose inset so it sits inside the maskable safe zone —
  the centre ~80 % circle — per the already-declared sizes in `static/manifest.webmanifest:14-23`), and
  `static/icons/apple-touch-icon.png` (180×180, no transparency — Apple fills transparent pixels with black) are
  regenerated from Koko's `idle` pose, replacing today's placeholder glyph (a generic dark-square monogram, same
  kind of placeholder `docs/TASKS.md:23` already names as open: "Product name, domain, logo and brand hue"). The
  manifest's `background_color`/`theme_color` (`static/manifest.webmanifest:12-13`) and `src/app.html:10-15`'s
  `theme-color` meta pair are **unchanged** — this PRD only replaces the icon artwork, not the PWA chrome colour
  scheme (that is still the open brand-hue decision, out of scope here).
- `static/favicon.svg` (today a placeholder: `rect` + a generic glyph, `static/favicon.svg:1`) is replaced with
  Koko's `idle` pose at a 32×32 viewBox, same crisp-pixel `<rect>` technique as `Mascot.svelte`, inlined directly in
  the static file (favicons cannot depend on the app's CSS theme tokens, so this one SVG hard-codes light-theme
  colours — the one deliberate exception to "no hard-coded colour," consistent with how `static/favicon.svg`
  already works today). No `favicon.ico` is added (none exists today either — `src/app.html:7` links only the SVG
  favicon; owner decision 8 below).
- **Deterministic generation**: a new checked-in script, `scripts/generate-mascot-icons.ts`, renders
  `Mascot.svelte`'s `idle` pose to each required PNG size and writes the files above. It uses the already-installed
  `@playwright/test` devDependency (`package.json:39`, already used for `npm run test:e2e`) to open a minimal HTML
  page containing the pose's SVG markup at a fixed pixel scale and screenshot it — **no new dependency**. This
  needs the same Chromium system libraries `docs/TASKS.md:38-40` already flags as not installed on this machine
  (`sudo npx playwright install-deps chromium`); until that is done, the script cannot run here, so the PNG outputs
  this PRD ships are generated once wherever Playwright's browser is available and committed to `static/icons/`
  like today's placeholders already are — this is not a new credential, just the same known local-environment gap
  `test:e2e` already has. The script is not added to `npm run gates` or `npm run build` (keeps both deterministic
  without a browser); it is a manual/CI step run only when Koko's artwork changes.

### i18n

- Koko's name and personality are not shown as copy anywhere in this pass (no "Koko says…" bubble); the only new
  user-facing string is the loading fallback, `tr('Memuat…')` — if that phrase does not already exist verbatim,
  add it to `src/lib/shared/i18n.ts`/`i18n-en.ts` ("Loading…") through the existing coverage test. Every `alt` text
  Koko might carry (the loading indicator's `aria-label`, if used instead of adjacent text) goes through
  `tr()`/`trf()` the same as any other string, with an `i18n-en.ts` entry.

## Out of scope

- Re-illustrating any of the eight domain-specific `<Illustration>` scenes FN-40 already drew (wallet, budget,
  calendar, parcels, growth, goal, people, history, inbox) with Koko — they stay isometric, unchanged.
- A persistent Koko decoration on Beranda's safe-to-spend display, the budget progress bar, or any figure that
  renders on every load — Koko only appears at the one-time success moments named in Part 3.
- A Rive runtime or `.riv` asset for Koko (same blocked-on-the-owner reason FN-40 already recorded,
  `docs/features/fn-40-visual-refresh/PRD.md:178-180`) — Koko ships as the same kind of hand-made, Rive-ready
  inline SVG `<Illustration>` already is.
- Koko speaking, a speech-bubble component, or any new copy beyond the one loading-fallback phrase above.
- `favicon.ico`, Windows tile icons, or any platform's icon beyond the four PWA/manifest sizes and the SVG favicon
  already declared in `static/manifest.webmanifest` and `src/app.html`.
- Changing the manifest's `theme_color`/`background_color`, `src/app.html`'s `theme-color` meta pair, or the
  product's brand hue (`--brand`/`--accent`) — those stay the open owner decision `docs/TASKS.md:23` already names.
- Any money, capture, sync, budget or server-logic change; this PRD is visual-only, like FN-40.
- Replacing `Skeleton.svelte`-based page loaders (e.g. `src/routes/(app)/ruang/+layout.svelte`) with
  `MascotLoading` — only the new global nav indicator in Part 4 is wired this pass.
- Native app icon sets (FN-33) — later, if/when a native shell exists.

## Acceptance criteria

**Component (Part 1)**

1. Given `<Mascot pose="idle">` renders with no `alt`, then the root `<svg>` is `aria-hidden="true"` with no
   `role="img"` and no `aria-label` (Automated: `Mascot.test.ts`, same pattern as `Illustration.test.ts:44-52`).
2. Given `<Mascot>` renders with an `alt`, then it is one labelled image (`role="img"`, `aria-label`, no
   `aria-hidden`) (Automated: `Mascot.test.ts`, mirrors `Illustration.test.ts:54-59`).
3. Given any pose renders, then the markup contains no hex colour, `rgb()`/`hsl()`/`oklch()` value, or `fill=`/
   `stroke=`/`style=` attribute — every pixel is a class resolving to a theme token (Automated: `Mascot.test.ts`,
   mirrors `Illustration.test.ts:61-79`).
4. Given any pose renders, then it draws inline only — no `<image>`, `<use>`, `href=` or `url()` (Automated:
   mirrors `Illustration.test.ts:81-85`).
5. Given `data-theme="dark"` or `data-theme="mono"`, then Koko's body resolves to the mono/dark `--accent` value
   (grey in mono, per `docs/design/DESIGN_SYSTEM.md` FN-40 Part 1's desaturation list) with no hard-coded hex in
   `Mascot.svelte`'s stylesheet (Automated: mirrors `Illustration.test.ts:87-106`).
6. Given any pose's frame-advance animation, when `prefers-reduced-motion: reduce` is set, then no movement occurs
   and the resting frame shows immediately (Automated: `test/motion-css.test.ts` with `Mascot.svelte` added to
   `MOTION_FILES`, `test/motion-css.test.ts:50-61`).
7. Given any pose's animation other than `loading`, then it runs a fixed, finite number of cycles and is never
   `animation: … infinite` (Automated: same `test/motion-css.test.ts` "nothing animates forever" check,
   `test/motion-css.test.ts:83-86`, extended to `Mascot.svelte`).
8. Given Koko's primary fill (`--accent`) against `--bg`, `--panel` and `--chart-bar` in every one of the four
   themes, then the existing graphics-contrast test already passes at ≥ 3:1 with no new token added (Automated:
   `test/contrast.test.ts:78-92`, unchanged — stated explicitly so the engineer does not add a redundant pair).

**Placements (Part 2)**

9. Given `/daftar` or `/masuk` renders at ≥ 768 px wide, then the hero shows `<Mascot pose="wave">` in place of the
   former `<Illustration name="welcome">`, still hidden/shrunk below 768 px exactly as today (Browser: the existing
   360 px viewport check this hero already has, `docs/features/fn-40-visual-refresh/PRD.md` item 16's pattern).
10. Given a 404 or a thrown error renders at `/` or inside `(app)`, then `EmptyState` shows `pose="sad"` (or the
    equivalent mascot slot) with the existing error text unchanged, and the text remains the sole accessible
    description (Automated: component test per the three call sites; Browser: `e2e` error-page journey if one
    exists, otherwise Automated only — state which).
11. Given a space has zero wallets, when Beranda renders, then its zero-wallet hero shows `<Mascot pose="wave">` in
    place of `<Illustration name="wallet">`; given the same space after a wallet exists, then the hero and the
    mascot no longer render (Automated: component/page test).
12. Given every other existing `illustration="wallet"`/`"budget"`/`"calendar"`/`"parcels"`/`"growth"`/`"goal"`/
    `"people"`/`"history"`/`"inbox"` call site, when it renders, then it is unchanged by this PRD (Automated: a
    snapshot/diff-style test or explicit assertion per call site that the isometric scene, not Koko, still renders).
13. Given an `EmptyState` renders with neither `illustration` nor an explicit mascot opt-out, then it shows
    `<Mascot pose="sleep">` (replacing today's text-only default); `Illustration.test.ts:111-115`'s old assertion
    is updated in this diff to match (Automated: updated test, explicitly called out as a known, intentional
    behaviour change in the completion report, not a silent regression).
14. Given an `EmptyState` renders with an explicit `illustration` prop (any of the nine domain scenes), then no
    mascot renders alongside it — never both an isometric scene and Koko in the same empty state (Automated:
    component test asserting exactly one of `<Illustration>`/`<Mascot>` markup is present, never neither-nor-both
    outside case 13).

**Success moments (Part 3)**

15. Given a transaction's save is confirmed by the server (`riwayat`'s `data.saved` or the voice toast's recorded
    result), when the confirmation text renders, then `<Mascot pose="hop">` renders beside it; given the save has
    not yet been confirmed (form pending, optimistic UI, or the offline queue per
    `src/routes/(app)/riwayat/baru/+page.svelte:33`), then no mascot renders (Automated: component test per call
    site, asserting the mascot is absent until the server-confirmed prop/data is present).
16. Given `?/closeDay` succeeds and the streak line renders, then `<Mascot pose="celebrate">` renders beside it;
    given the day is not yet closed (the "Tutup hari ini" button state), then no mascot renders (Automated:
    component test on `src/routes/(app)/+page.svelte`'s streak block).
17. Given a budget save is confirmed and the recomputed safe-to-spend is `kind: 'left'`, then
    `<Mascot pose="celebrate">` renders in the save confirmation; given the result is `'spent'` or `'over'`, then no
    mascot renders (Automated: component test on `src/routes/(app)/anggaran/+page.svelte`'s save flow, covering all
    three `safe.kind` values).
18. Given any of the three success-moment mascots, then it is `aria-hidden="true"` — the existing `role="status"`
    text remains the only thing assistive technology announces, unchanged by this PRD (Automated: component test).

**Loading indicator (Part 4)**

19. Given a client-side navigation is in flight (`navigating` is set), then `MascotLoading` renders and its pose
    animates continuously; given the navigation completes, then `MascotLoading` unmounts within one render (no
    lingering animated element on the destination page) (Automated: a Svelte component test driving a mocked
    `navigating` store; Browser: one `e2e` assertion if `wrangler dev` e2e is runnable here, otherwise Automated
    only — state which per `docs/TASKS.md:38-40`'s Playwright-dependency gap).
20. Given `prefers-reduced-motion: reduce`, when a navigation is in flight, then `MascotLoading` renders plain text
    (`tr('Memuat…')`) with no SVG and no animation — never a static, non-animating mascot image (Automated:
    component test asserting no `<svg>` in the reduced-motion render path).
21. Given no navigation is in flight (an idle page), then `MascotLoading` renders nothing — no element, no CSS
    animation present in the DOM (Automated: component test).

**Icons and manifest (Part 5)**

22. Given `static/manifest.webmanifest` is parsed, then its three icon entries (192, 512 any, 512 maskable) still
    resolve to existing files at the declared sizes, now Koko's artwork instead of the placeholder (Automated: a
    test reading the manifest JSON, loading each PNG and asserting its pixel dimensions match the declared
    `sizes`).
23. Given the maskable 512 icon, then Koko's artwork sits fully inside the centre ~80 % safe-zone circle (Automated:
    a pixel-bounds check on the generated PNG, or a documented manual check in the generation script's comments if
    automating it is not worthwhile — state which).
24. Given `src/app.html`'s `<link rel="icon">` and `<link rel="apple-touch-icon">`, then both resolve to files that
    exist in `static/` after this PRD (Automated: existing or new static-asset-exists test, same spirit as any
    current build-time asset check).
25. Given `scripts/generate-mascot-icons.ts` is run where Playwright's Chromium is installed, then it deterministically
    reproduces the same PNG bytes for the same pose/size inputs (no randomness, no timestamp baked into pixels)
    (Automated: run twice locally and diff the outputs — state as "not run" in the completion report if Chromium's
    system libraries are unavailable here, per `docs/TASKS.md:38-40`, never reported as passed if unrun).

**Checklist-derived (every part)**

26. `npm run gates` (check, lint, test, build) is clean after this feature (Automated).
27. Every new Indonesian phrase (the loading fallback, any new `alt` text) has an `i18n-en.ts` entry; the existing
    i18n coverage test fails otherwise (Automated).
28. No `space_id`-scoped server query is added or changed by this feature — stated explicitly and verified by
    grepping the diff for any new `+page.server.ts`/`+server.ts` touching `db` (Automated/manual grep, noted in the
    completion report, same as `docs/features/fn-40-visual-refresh/PRD.md` item 25).
29. Every changed route keeps its existing loading/empty/error/saving/success states in substance — this feature
    only adds Koko around them, never replaces a state's text or removes a state (Automated: existing page tests
    for every touched route still pass).
30. 360 px layout and 44 px touch targets hold for every placement Koko touches (none of them are themselves a tap
    target, but their containing `EmptyState`/hero/toast must not grow past the fold) (Browser: extend
    `e2e/shell.spec.ts`/`e2e/kit.spec.ts` pattern where those journeys already cover the touched pages).

## Architecture notes

- New: `src/lib/ui/kit/Mascot.svelte`, `src/lib/ui/kit/mascot/poses.ts` (pixel-grid frame data per pose),
  `src/lib/ui/kit/mascot/Mascot.test.ts`, `src/lib/ui/kit/MascotLoading.svelte` (+ its test).
- New: `scripts/generate-mascot-icons.ts` (Playwright-based PNG renderer; no new dependency — reuses
  `@playwright/test`, `package.json:39`).
- Changed static assets: `static/favicon.svg`, `static/icons/icon-192.png`, `static/icons/icon-512.png`,
  `static/icons/icon-maskable-512.png`, `static/icons/apple-touch-icon.png` (regenerated outputs, committed, same
  files that exist today — `static/manifest.webmanifest:14-23`, `src/app.html:7,9` — just with new pixel content).
- Changed call sites: `src/routes/(auth)/daftar/+page.svelte:30`, `src/routes/(auth)/masuk/+page.svelte:29`,
  `src/routes/+error.svelte:15`, `src/routes/(app)/+error.svelte:16,23`, `src/routes/(app)/+page.svelte:286`
  (pose swaps) and `:467-477` (celebrate on close-day), `src/routes/(app)/riwayat/+page.svelte:228-229`,
  `src/routes/(app)/riwayat/suara/+page.svelte:658-663` (hop on save), `src/routes/(app)/anggaran/+page.svelte:
  150-158` (celebrate on budget-safe save), `src/lib/ui/shell/EmptyState.svelte:28-30` (new default pose),
  `src/routes/(app)/+layout.svelte:49-62` (new `MascotLoading` wired to `navigating`).
- Changed tests: `src/lib/ui/kit/Illustration.test.ts:111-115` (the one assertion this PRD's default-pose change
  supersedes), `test/motion-css.test.ts:50-61` (add `Mascot.svelte` to `MOTION_FILES`).
- No new table, no migration, no new Worker, no `workers/jobs`/`workers/inbound` change — purely the app Worker's
  static/client surface, like FN-40.
- `docs/design/DESIGN_SYSTEM.md` gets a short "Mascot" section (next to its existing "Illustrations" section,
  `docs/design/DESIGN_SYSTEM.md:157-165`) naming Koko, its pose set, the 24×24 grid and the token mapping, as a
  documentation deliverable of the build (same convention FN-40 followed for its own sections).

## Prerequisites

None of this PRD needs a new secret or provider account — purely client-rendered tokens, CSS, inline SVG and a
build-time icon-generation script. No entry in `.dev.vars.example` is required. The one environment gap is the
same one `docs/TASKS.md:38-40` already names: `scripts/generate-mascot-icons.ts` needs Playwright's Chromium system
libraries (`sudo npx playwright install-deps chromium`) to actually run; until then the script is written and
tested for determinism where it *can* run, and the PNG outputs it would produce are generated once elsewhere and
committed — not a "Belum dikonfigurasi" runtime gate (nothing in the shipped app depends on the script running at
request time), just a one-time local/CI generation step, exactly like `docs/TASKS.md:38-40`'s existing
`npm run test:e2e` gap.

## Tracker impact

- Not already listed in `docs/TASKS.md`'s "To do"; this is new work opened from the owner's 2026-10-09 "add mascot"
  request. Add a `docs/TASKS.md` line once this PRD is accepted, following the FN-40/FN-43 convention (e.g. beside
  `docs/TASKS.md:145`'s FN-43 "in build" note).
- `docs/ACCEPTANCE.md` rows this can extend once built and verified: the Design table's existing contrast and
  360 px/touch-target/reduced-motion rows (`docs/ACCEPTANCE.md:54-55`) — Koko's assertions fold into the same
  automated/browser checks FN-40 already extended, no new row strictly required, though the owner may want a new
  row such as "App icon and favicon show Koko, not a placeholder | Automated | `test/icons.test.ts`" once that test
  exists.

## Owner decisions (defaults proposed; owner auto-accepts unless corrected)

1. **Name: "Koko."** *Default: yes* — short, pronounceable in Bahasa Indonesia and English, no collision with
   existing in-app copy or another brand's character name.
2. **Pixel grid: 24×24**, not 16×16 — enough resolution for small eyes and feet to read clearly at the sizes this
   PRD actually uses (40–240 px), while staying obviously pixel-art rather than a smooth icon. *Default: 24×24.*
3. **Primary colour: `var(--accent)`** (desaturates to grey in mono automatically, matches every other data-accent
   use in the app), outline `var(--ink)`, eyes/mouth as `var(--bg)` cut-outs, feet/shadow `var(--ink-2)` — no new
   token. *Default: yes.*
4. **Coexistence with FN-40's isometric illustrations: Koko replaces only four named slots** (auth hero, error
   pages, Beranda's zero-wallet hero, `EmptyState`'s no-illustration default) and leaves the nine domain-specific
   scenes (wallet-in-forms, budget, calendar, parcels, growth, goal, people, history, inbox) untouched, to avoid
   double art and bound this PRD's size. *Default: yes* — the owner can ask for a broader swap later.
5. **`EmptyState`'s default changes from text-only to `pose="sleep"`** when no `illustration` is given — an
   intentional, additive behaviour change to ~9 existing call sites, updating one pre-existing FN-40 test.
   *Default: yes.*
6. **Success-moment wiring is exactly the three named spots** (transaction saved, close-the-day, budget safe),
   each tied to an already-existing server-confirmed state — not a generic "every save shows Koko" rule, which
   would be noisy on routine saves (categories, API tokens, goals, collectibles, etc.). *Default: yes, these three
   only; the owner can name more later.*
7. **Loading indicator: one new global top-of-shell indicator for client-side navigation only** (`MascotLoading` in
   the `(app)` layout); existing `Skeleton`-based page loaders are not replaced this pass. *Default: yes.*
8. **No `favicon.ico`** — only `favicon.svg`, matching what the app already ships today (no regression, no new
   format to generate/maintain). *Default: skip `.ico`.*
9. **Icon generation: a checked-in Playwright script, run manually/CI, outputs committed** — no new dependency, no
   build-time browser requirement. *Default: yes.*
10. **A separate always-invoked "blink" pose is optional**; folding a bounded 2-cycle blink into `idle` itself
    (same finite-then-rest pattern as `Illustration`'s existing float) satisfies the owner's "easy to animate:
    blink" request without a ninth pose to maintain. *Default: fold into `idle`; the engineer may split it out if
    the pixel data turns out cleaner that way.*
