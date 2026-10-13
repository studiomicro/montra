# FN-40 — Black-and-white theme, motion, isometric illustrations and glass material

Owner request 2026-10-08: "Add black and white theme. Then add animation for the app and add rive isometric design
for the app." Owner addition 2026-10-08 (Indonesian: "Update designnya seperti apple glass mode"): add an
Apple-Liquid-Glass-style material. Owner answered with the recommended defaults for every part (below); this PRD
records them so they are decided once.

## Goal

The app currently has two themes (light, dark) and almost no motion (`docs/design/DESIGN_SYSTEM.md:106-110` — a
press scale and reduced-motion rule exist, nothing else is animated: `grep -r "transition\|animation" src/lib/ui`
turns up only hover/press states). Every empty, loading and error state is plain text (`src/lib/ui/shell/EmptyState.svelte:22-27`,
`src/lib/ui/kit/ErrorState.svelte:9-12`). A visual refresh — a monochrome theme for users who want zero colour,
short functional motion so state changes read as changes, hand-drawn isometric illustrations where the app currently
shows nothing but a sentence, and a glass material on the floating chrome that is already described as "glass" in
the design system but only partly built — makes the product feel designed rather than assembled, without adding a
single new screen or server concept. Everything here is visual: no new money, capture or sync behaviour.

## Scope, split into four independently mergeable parts

Parts 1 (theme) and 4 (glass) both touch `docs/design/tokens.css` and should land in the same PR/sequence slot to
avoid a merge race on that file; build 1 before 4 (4 adds `--glass-*` variants per theme, mono included). Part 2
(motion) touches component `<style>` blocks and `svelte/transition` imports only, not tokens.css's colour blocks —
mergeable in parallel with 1/4. Part 3 (illustrations) only adds new files plus call sites in existing pages —
mergeable in parallel with everything. Suggested order: **1 → 4 → 2 and 3 in parallel**, or all four in parallel if
the engineer rebases part 4 onto part 1's tokens.css diff last.

### Part 1 — Monochrome theme ("Hitam-putih")

A 4th value next to Terang / Gelap / Sistem.

- `src/lib/server/prefs.ts:1-5` (`ThemePref = 'system' | 'light' | 'dark'`) gains `'mono'`; `resolveTheme` accepts
  `'mono'` from the cookie.
- `src/lib/ui/shell/theme.ts` (`ThemeChoice`, `nextTheme`, `themeCookie`) is a binary light/dark flipper used only
  by the sidebar's icon toggle (`src/lib/ui/shell/ThemeToggle.svelte:1-26`, used from
  `src/lib/ui/shell/Sidebar.svelte:9,46`). It stays as the quick light/dark flip; it does not gain a 3rd state.
- New route **`/pengaturan/tampilan`** ("Tampilan" / "Appearance"), listed under Pengaturan › Aplikasi
  (`src/routes/(app)/pengaturan/+page.svelte:39-79`, new `IconRow` before or after "Notifikasi"): a `PickerSheet`
  or radio list (reuse `src/lib/ui/kit/Segmented.svelte` or `PickerSheet.svelte`) with four rows Sistem / Terang /
  Gelap / Hitam-putih, writing the `theme` cookie server-side via a form action (works with and without JS, same
  pattern as the sidebar toggle but persists a 4th value) — no DB column; `theme` stays a cookie-only preference
  like today, so **no migration**.
- `docs/design/tokens.css`: mono does **not** get its own `data-theme` fork of light vs dark. It gets one
  `:root[data-theme='mono']` block (desaturated greys replacing `--bg`/`--panel`/`--panel-2`/`--line`/`--ink*`/
  `--muted`/`--faint`/`--accent`/`--heat-1..4`/`--chart-bar`/`--chart-track`/`--same`/`--warn`/`--warn-text`/
  `--raised`/category hues `--cat-*`), plus a nested `@media (prefers-color-scheme: dark)` sub-block inside it for
  the dark half — mono **follows the system scheme** (owner-recommended default), so there is no separate
  "mono-light"/"mono-dark" cookie value, matching how `:root` already forks light/dark today
  (`docs/design/tokens.css:118-159`). `--money-in` and `--money-up` are the one exception: they stay colour (green/
  red) in mono too, per CLAUDE.md "colour only for meaning" and the owner's instruction that expense/income colour
  stays; `--brand` (focus ring, links) also stays blue in mono (it is not a content colour, and removing all focus
  colour would fail contrast testing differently, not better).
- `app.html:10-11` theme-color meta tags: add a `data-theme='mono'` aware pair, or compute the shown colour in
  `hooks.server.ts`'s `transformPageChunk` the same way `%fin.theme%` is substituted today
  (`src/hooks.server.ts:30-33,46`) so a mono user's browser chrome matches `--bg` under mono, not light/dark.
- `e2e/shell.spec.ts:183-194` ("dark scheme follows the system; the theme cookie overrides it") gets a 3rd case:
  setting `theme=mono` sets `data-theme="mono"` and the body background becomes the mono grey, in both a
  `colorScheme: 'light'` and `colorScheme: 'dark'` browser context (proves the nested media query).
- i18n: `tr('Tampilan')`, `tr('Sistem')`, `tr('Terang')`, `tr('Gelap')`, `tr('Hitam-putih')`, a one-line description
  per option, every one with an `i18n-en.ts` entry ("Appearance", "System", "Light", "Dark", "Monochrome").

### Part 2 — Motion, subtle and functional

Svelte-native only: `svelte/transition` (`fly`, `fade`, `scale`), `svelte/motion` (`spring`/`tweened` for the
counting number), the View Transitions API behind a feature check — **no animation library** (none is installed;
`package.json` stays untouched here). New tokens in `docs/design/tokens.css` next to the existing `--ease*`
block (`docs/design/tokens.css:96-100`): `--duration-fast: 150ms`, `--duration-base: 200ms`, `--duration-slow: 300ms`
(sheet/dialog) — the existing `--ease`, `--ease-in-out`, `--spring` are reused, not duplicated.

Concrete placements:

- **Tambah sheet and dialogs** (`src/lib/ui/shell/Sheet.svelte:77-79,117-122`) already animate on open (`rise`
  0.32 s); add a matching close animation (currently only `dialog::backdrop`'s native fade covers the close) and
  move the duration/easing to the new tokens.
- **Beranda hero number counts up** (`src/lib/ui/kit/HeroAmount.svelte`, rendered from
  `src/routes/(app)/+page.svelte`'s `s.total`): a `svelte/motion` `Tweened` number animates from the previous
  shown value to the new one (≤ 300 ms) whenever the server figure changes (month switch, after a save) — never on
  first paint with JS disabled or before hydration (no layout shift, no CLS), and it shows the final digits at once
  under `prefers-reduced-motion`.
- **Charts grow in**: `src/lib/ui/kit/BarChart.svelte`, `src/lib/ui/kit/MonthLines.svelte`,
  `src/lib/ui/charts/HeatCalendar.svelte`, `src/lib/ui/charts/FlowChart.svelte` — bars/paths animate from a
  baseline to full height/length on mount only (CSS `@starting-style` or a Svelte transition on first render), not
  on every re-render.
- **List items stagger in**: `src/lib/ui/kit/GroupList.svelte`/`TransactionRow.svelte` rows fade/slide in with a
  small per-row delay on first paint of a page (e.g. Riwayat's day groups), capped (e.g. first 8 rows only — never
  an unbounded per-row timer on a 500-row page).
- **Press feedback**: already exists (`transform: scale(var(--press-scale))` on `Button.svelte:75-77`,
  `TabBar.svelte:62-63`, `Sidebar.svelte:283-285`) — extend the same rule to `Chip.svelte` and `GroupRow` tappable
  rows, which currently only change background on press.
- **Page transitions**: a soft cross-fade between route changes using the View Transitions API
  (`document.startViewTransition`) where `document.startViewTransition` exists, feature-detected, with no polyfill
  and no fallback animation (plain instant navigation) where it does not.
- All of the above wrapped so `@media (prefers-reduced-motion: reduce)` (already global at `src/app.css:35-43`)
  removes every transform/transition/animation addition this part makes — the counting number shows the end value
  immediately, charts render at full size immediately, staggered rows all appear at once.
- Playwright: `e2e/` tests that assert on immediate DOM state (most of `shell.spec.ts`, `kit.spec.ts`) must keep
  passing; the engineer either keeps new motion short enough not to need waits, or sets
  `page.emulateMedia({ reducedMotion: 'reduce' })` in the fixture used by journey tests so assertions are not racing
  an animation (ACCEPTANCE.md already flags "reduced motion is CSS-only; not browser-tested" —
  `docs/ACCEPTANCE.md:55` — this part should add the first browser check of it).

### Part 3 — Isometric illustrations (hand-drawn SVG, Rive-ready slot)

No `.riv` files exist and none can be authored in this pipeline (Rive requires its own editor). Scope is therefore:

- A new `<Illustration name={…} />` component (`src/lib/ui/kit/Illustration.svelte`) that today renders one of a
  fixed set of **original, hand-made isometric SVGs** (our own style — never another product's mascot, illustrations or any
  other brand's assets) inline, sized by a prop, recoloured via `currentColor` and a small number of CSS variables
  (so it repaints correctly in light, dark **and mono**) with a light CSS animation (a slow float/parallax, subject
  to `prefers-reduced-motion`). It takes `alt` text for a meaningful illustration or renders `aria-hidden="true"`
  with an empty `role="img"` fallback for decorative ones (the EmptyState/ErrorState text next to it already
  carries the meaning — CLAUDE.md: never decoration-only colour/content without a text equivalent).
- The component's prop shape (`name`, `size`, optional `alt`) is designed so a later `@rive-app/canvas` runtime can
  be swapped in behind the same `name` values once the owner supplies `.riv` files — **the Rive package is not
  added now** (no new dependency in this PRD).
- Exact placements (every one already has a bare-text empty/error state to attach the illustration next to, not
  replace):
  - `src/lib/ui/shell/EmptyState.svelte` (used by `riwayat`, `dompet`, `anggaran`, `ruang`, `kotak-masuk`, `langganan`,
    `koleksi`, `barang`, net worth and goals sections — files listed in the grep above) gains an optional
    `illustration` prop; each call site picks a scene (empty wallet, empty history, empty inbox, etc.) — the
    component itself stays usable without one (existing callers that pass no illustration keep their current text-
    only look, so this is additive).
  - `src/routes/(app)/+error.svelte:14-19` and `src/routes/+error.svelte:14-18` (404 / generic error) get one
    "something broke" isometric scene.
  - `src/routes/(auth)/daftar/+page.svelte` (sign-up) and `src/routes/(auth)/masuk/+page.svelte` gain a hero
    illustration above the form on wide viewports (hidden or shrunk at 360 px so it never pushes the form below the
    fold — no new tab-order change, it is purely decorative there, `aria-hidden`).
  - Beranda hero area (`src/routes/(app)/+page.svelte`, `HeroAmount.svelte`): one small illustration for the
    **zero-wallets** state only (the very first screen before any wallet exists) — not on every load, so it never
    competes with the one-big-number principle (`docs/design/DESIGN_SYSTEM.md:22`).
- i18n: every illustration's `alt` text (where not `aria-hidden`) goes through `tr()`/`trf()` with an
  `i18n-en.ts` entry, same as any other string.

### Part 4 — Glass material ("Liquid Glass"–style), owner addition 2026-10-08

Mirrors the *material* (translucent blur, specular edge, layered shadow, capsule shapes), never Apple's branding,
icons, SF Symbols or any shipped asset. Two sites already use a first version of this
(`docs/design/tokens.css:108-113` `--glass-bg`/`--glass-ring`/`--glass-blur`/`--on-glass-active`/`--scrim`, applied
at `src/lib/ui/shell/TabBar.svelte:39-42` and `src/lib/ui/kit/Banner.svelte:29-32`); this part extends the same
tokens to the rest of the floating chrome and formalises the fallback rules that are currently undocumented.

- Extend glass to: desktop sidebar top tools row / the sidebar itself when scrolled under content
  (`src/lib/ui/shell/Sidebar.svelte`), sticky screen-title top bars, the Tambah sheet and `PickerSheet` dialogs
  (`src/lib/ui/shell/Sheet.svelte:66-69`, `src/lib/ui/kit/PickerSheet.svelte`), floating action buttons, toasts
  (`FloatingCard.svelte`), `Segmented.svelte`'s track and `Chip.svelte`'s selected state. Content cards keep their
  current flat `--panel` fill (DESIGN_SYSTEM.md's "fills, not frames" principle, §5/§6) **except** where a card sits
  directly over a colour/photo background (Beranda hero area over the hero illustration from Part 3) — those get a
  lighter frosted variant, not full glass.
- New tokens per theme (light, dark, **and mono**) in `docs/design/tokens.css` next to the existing `--glass-*`
  block: `--glass-border` (the 1 px specular inner highlight, a translucent white/black line depending on theme),
  `--glass-shadow` (a layered soft shadow distinct from `--shadow-float`/`--shadow-card`), and a lighter
  `--glass-bg-soft`/`--glass-blur-soft` pair for the frosted-over-colour card case. Mono's glass stays achromatic
  (no tinted blur) like the rest of mono.
- **Text on glass meets WCAG AA**: every glass surface that carries text gets a solid-colour fallback rule so
  contrast is checked against the *opaque* fallback colour, not the blurred backdrop (which cannot be contrast-
  tested statically) — the existing `test/contrast.test.ts` (FN-00, referenced at `docs/ACCEPTANCE.md:54`) is
  extended to cover `--glass-bg`'s solid fallback the same way it covers `--panel` today.
- **`prefers-reduced-transparency: reduce`** and `@supports not (backdrop-filter: blur(1px))`: both switch every
  `--glass-*` surface to its solid fallback (`--panel`/`--bg` plus `--shadow-float`), matching what already happens
  implicitly on browsers without `backdrop-filter` support (`TabBar.svelte`/`Banner.svelte` currently have no
  explicit `@supports` fallback — this part adds one, a correctness fix as well as scope growth).
  `prefers-reduced-motion` is unrelated (glass is static, not animated) except for the Part 2 press-lift interaction
  below.
- **Performance budget**: at most **3** simultaneously blurred (`backdrop-filter`) layers on screen at any time
  (e.g. tab bar + one open sheet + one toast = 3; a 4th blur request — e.g. a toast while a `PickerSheet` is open
  over the Tambah sheet — falls back to the solid variant instead of stacking a 4th blur). State this as a constant
  the engineer enforces (a shared counter/class on `<body>`, or simply a design rule not to combine more than 3 at
  once given the app's actual screens — document which).
- **Press "lift"** (ties to Part 2): glass buttons/chips get a subtle shadow/elevation increase on press in
  addition to the existing `scale(var(--press-scale))`, removed under `prefers-reduced-motion`.
- Documentation: the engineer updates `docs/design/DESIGN_SYSTEM.md`'s Colour/Components/Change-log sections and
  `docs/design/APP_PARITY.md` § 3a with the new glass rules and token names, the same way v1→v2 was recorded there
  (`docs/design/DESIGN_SYSTEM.md:203-213`) — this is a documentation deliverable of the build, not something this
  PRD performs itself.

## Out of scope

- Any Rive dependency, `.riv` file, or Rive runtime integration — blocked on the owner supplying `.riv` assets from
  the Rive editor (not available to this pipeline). The `<Illustration>` slot exists so that swap is a later,
  small change.
- Copying another product's (or Apple's) mascot, logo, icons, SF Symbols, wallpapers, illustrations or any shipped asset —
  every illustration is original artwork made for this PRD.
- A 5th theme, a per-space or per-account stored theme preference (DB column), or an API to set theme — stays a
  cookie, like today.
- Changing `--money-in`/`--money-up`/`--brand` semantics outside what is stated above.
- New animation library, CSS framework, or build-time asset pipeline for illustrations beyond plain `.svelte`/`.svg`
  files checked into `src/lib/ui`.
- Any change to money, capture, sync, budgets or server logic; this PRD is visual-only.
- Native app, Rive on native (FN-33) — later.

## Acceptance criteria

Vitest first; e2e only where real-browser behaviour is the thing being tested (theme switching, reduced motion,
360 px, backdrop-filter fallback).

**Theme (Part 1)**

1. Given the `theme` cookie is unset, when a request renders any page, then `resolveTheme` returns `'system'` and
   `data-theme` is absent, exactly as today (Automated: extend `src/lib/server/prefs.test.ts`).
2. Given the `theme` cookie is `mono`, when a request renders any page, then `resolveTheme` returns `'mono'` and
   `<html data-theme="mono">` is set server-side (no flash of another theme before hydration) (Automated: `prefs.test.ts`; Browser: `e2e/shell.spec.ts`).
3. Given `data-theme="mono"` and a `light` OS colour scheme, when the page renders, then `--bg`/`--panel`/`--ink`
   etc. are the mono-light greys; given a `dark` OS colour scheme with the same cookie, then they are the mono-dark
   greys — both from the one `mono` cookie value (Browser: `e2e/shell.spec.ts`, two browser contexts as in the
   existing dark-scheme test at `e2e/shell.spec.ts:183-194`).
4. Given mono is active, when an expense or income amount renders, then it still shows `--money-up`/`--money-in`
   colour (not grey), proving "colour only for meaning" survives mono (Automated: a token-level or component
   snapshot test).
5. Given any of the 4 theme values in either OS scheme, when contrast is measured for every documented
   text/background pair, then all meet WCAG AA 4.5:1 for body text (Automated: extend `test/contrast.test.ts` to
   iterate `light`, `dark`, `mono-light`, `mono-dark`).
6. Given a signed-in user on `/pengaturan/tampilan`, when they pick a theme option and JavaScript is disabled, then
   the form action persists the cookie and the next page load shows that theme (Browser, no-JS context as in
   `e2e/shell.spec.ts`'s existing no-JS test).
7. Given every new Indonesian phrase added for this screen (`Tampilan`, `Sistem`, `Terang`, `Gelap`, `Hitam-putih`,
   descriptions), then each has a matching entry in `src/lib/shared/i18n-en.ts` (Automated: existing i18n coverage
   test).

**Motion (Part 2)**

8. Given `prefers-reduced-motion: reduce`, when the Beranda hero number, any chart, staggered list rows, the Tambah
   sheet, or a page transition would otherwise animate, then no movement occurs and the end state renders
   immediately (Automated: CSS assertion per component; Browser: one `e2e` test with
   `page.emulateMedia({ reducedMotion: 'reduce' })` covering at least the hero number and a sheet open/close).
9. Given reduced motion is not requested, when the Beranda total changes between two loads, then the displayed
   number animates from the old to the new value within 150–300 ms and settles on the exact server figure (never an
   intermediate or rounded value left on screen) (Automated: a `svelte/motion` unit test driving the tweened store).
10. Given a 500-row Riwayat day, when the page first renders, then at most a bounded number of rows (e.g. 8) carry a
    stagger delay and the remainder render with no added delay (Automated: component test asserting the delay is
    capped, not proportional to row count).
11. Given any new motion CSS, when Lighthouse/Web Vitals are measured on a representative page, then CLS is not
    increased versus the pre-FN-40 baseline (no animation reserves layout space it did not already have) (manual
    check noted in the completion report; not a blocking gate if tooling is unavailable, but must be stated, never
    reported as passed if unrun).
12. Given `npm run test:e2e` runs the existing shell/kit journeys unmodified in assertions, then they still pass
    with the new motion present (Browser: full existing suite, no regressions).

**Illustrations (Part 3)**

13. Given an `EmptyState` is rendered with an `illustration` name and no `alt`, then the SVG is `aria-hidden="true"`
    and the adjacent text remains the only accessible description (Automated: component test, axe/aria check).
14. Given an `EmptyState`/hero illustration is rendered under `data-theme="dark"` or `data-theme="mono"`, then its
    strokes/fills resolve via `currentColor`/CSS variables to the matching theme colours, with no hard-coded hex
    inside the SVG (Automated: snapshot or computed-style assertion per theme).
15. Given `prefers-reduced-motion: reduce`, when an illustration would otherwise float/parallax, then it is static
    (Automated/Browser, same pattern as item 8).
16. Given a 360 px viewport, when sign-up/sign-in or Beranda's zero-wallet state renders, then the illustration
    never pushes the primary form/action below the first viewport fold (hidden or shrunk at that width) (Browser:
    `e2e` 360 px viewport test).
17. Given no `.riv` file or Rive dependency exists, when `<Illustration>` renders any `name`, then it renders the
    hand-made SVG variant only — no network fetch, no new dependency import (Automated: static check / bundle
    import test that `@rive-app/*` is not imported anywhere).

**Glass material (Part 4)**

18. Given a glass surface carries text (e.g. a notification banner title), when contrast is measured against its
    documented solid fallback colour, then it meets WCAG AA in every theme including mono (Automated: extended
    `test/contrast.test.ts`).
19. Given `prefers-reduced-transparency: reduce` or `@supports not (backdrop-filter: blur(1px))`, when any glass
    surface renders, then it shows its opaque fallback (solid background, no blur) with equivalent shadow (Browser:
    an `e2e` test forcing the media feature, or a CSS-only Automated check if Playwright cannot emulate that media
    feature in the installed browser — state which).
20. Given more than 3 glass surfaces would be visible at once in any real screen combination the app can produce,
    then the 4th and beyond render as solid, not blurred (Automated: a documented rule plus a test enumerating the
    app's actual simultaneous-glass combinations and asserting none exceeds 3).
21. Given mono theme is active, when any glass surface renders, then its tint is achromatic (no colour cast),
    matching the rest of the mono palette (Automated: computed-style/token check).
22. Given `prefers-reduced-motion: reduce`, when a glass button or chip is pressed, then the added "lift" shadow
    change is removed, leaving only the pre-existing (non-glass) press scale untouched by this part (Automated:
    CSS assertion).

**Checklist-derived (every part)**

23. `npm run gates` (check, lint, test, build) is clean after all four parts (Automated).
24. Every new Indonesian string added anywhere in this feature has an `i18n-en.ts` entry; the existing i18n
    coverage test fails otherwise (Automated).
25. No `space_id`-scoped server query is added or changed by this feature (it is purely presentational), so no new
    space-authorization check is required — stated explicitly because the template calls for it, and its absence is
    itself verified by grepping the diff for any new `+page.server.ts`/`+server.ts` touching `db` (Automated/manual
    grep, noted in the completion report).
26. Every new/changed component exposes the existing loading/empty/error/saving/success states unchanged in
    substance — this feature only adds visuals around them, never replaces a state (Automated: existing page tests
    for affected routes still pass).
27. 360 px layout and 44 px touch targets hold for every new or changed interactive element (the appearance picker,
    any new glass button/chip) (Browser: `e2e/shell.spec.ts` / `e2e/kit.spec.ts` pattern, extended).

## Architecture notes

- `src/lib/server/prefs.ts` — extend `ThemePref` and `resolveTheme`.
- `src/hooks.server.ts:30-33,46` — `transformPageChunk`/`%fin.theme%` substitution; no other hook logic changes.
- `src/app.d.ts:12` — `Locals.theme: ThemePref` stays in sync with the widened type.
- `docs/design/tokens.css` — new `mono` theme block, new `--duration-*` motion tokens (reusing existing `--ease*`),
  new `--glass-border`/`--glass-shadow`/`--glass-bg-soft`/`--glass-blur-soft` tokens, each in light/dark/mono.
- `src/app.css:35-43` — existing global `prefers-reduced-motion` block; extend, do not duplicate, for the new
  `@supports`/`prefers-reduced-transparency` rules (Part 4).
- New route: `src/routes/(app)/pengaturan/tampilan/+page.svelte` + `+page.server.ts` (form action writing the
  `theme` cookie, same pattern as the sidebar toggle's cookie write but server-validated against the 4 allowed
  values); linked from `src/routes/(app)/pengaturan/+page.svelte`.
- `src/lib/ui/shell/theme.ts`, `ThemeToggle.svelte` — unchanged in behaviour (binary light/dark quick toggle);
  do not conflate with the new 4-way picker.
- New component: `src/lib/ui/kit/Illustration.svelte` + a set of `.svelte`/inline-SVG scene files under
  `src/lib/ui/kit/illustrations/` (naming scheme matching the `name` prop so a future Rive swap is a drop-in).
- `src/lib/ui/kit/HeroAmount.svelte`, `BarChart.svelte`, `MonthLines.svelte`, `src/lib/ui/charts/HeatCalendar.svelte`,
  `FlowChart.svelte`, `GroupList.svelte`, `TransactionRow.svelte`, `Chip.svelte`, `GroupRow` — motion additions only,
  no prop/behaviour contract changes.
- `src/lib/ui/shell/Sheet.svelte`, `src/lib/ui/kit/PickerSheet.svelte`, `src/lib/ui/shell/TabBar.svelte`,
  `src/lib/ui/kit/Banner.svelte`, `src/lib/ui/shell/Sidebar.svelte`, `FloatingCard.svelte`, `Segmented.svelte` —
  glass token application and `@supports`/reduced-transparency fallback.
- `src/lib/shared/i18n-en.ts` — every new phrase.
- `test/contrast.test.ts` (FN-00) — extended for mono and for glass solid fallbacks.
- `e2e/shell.spec.ts` — extended theme and reduced-motion/reduced-transparency cases.
- No D1 migration (theme stays a cookie preference, as `docs/TASKS.md`/`docs/ACCEPTANCE.md` already treat it; no
  table gains a column). No Worker other than the app Worker is touched. No `workers/jobs` or `workers/inbound`
  change.
- `docs/design/DESIGN_SYSTEM.md` and `docs/design/APP_PARITY.md` § 3a get a change-log entry for v3 (mono, motion
  tokens, glass extension) as part of this build, mirroring how v1→v2 was recorded
  (`docs/design/DESIGN_SYSTEM.md:203-213`).

## Prerequisites

None of the four parts needs a new credential, API key or provider account — everything is client-rendered tokens,
CSS, Svelte components and inline SVG. No entry in `.dev.vars.example` is required. The owner's note that Rive
needs `.riv` files from the Rive editor is accordingly treated as **out of scope** here (see above), not a blocked
prerequisite to work around with a stub: there is nothing for this PRD to gate behind "Belum dikonfigurasi", since
no Rive runtime ships in this pass.

## Tracker impact

- Not already listed in `docs/TASKS.md`'s "To do"; this is new work opened directly from the owner's 2026-10-08
  request (same day as the app-layout-parity and FN-38/FN-39 work already tracked there). Add to `docs/TASKS.md`
  under a new "FN-40 visual refresh" line once a PRD exists, per the existing convention (e.g. alongside the FN-16a/
  FN-38 lines at `docs/TASKS.md:118,114`).
- `docs/ACCEPTANCE.md` rows this can move once built and verified:
  - "Tokens from `docs/design/tokens.css`; AA contrast both themes | Automated | `test/contrast.test.ts`"
    (`docs/ACCEPTANCE.md:54`) → extend to four themes, still Automated.
  - "360 px layout, 44 px touch targets, reduced motion | Browser | … (reduced motion is CSS-only; not browser-tested)"
    (`docs/ACCEPTANCE.md:55`) → this PRD is what finally adds the browser-tested reduced-motion check that row
    already calls for; move the parenthetical note once item 8/19 above pass.
- Adds a brand-new row the owner may want in `docs/ACCEPTANCE.md`'s Design table once built: "Monochrome theme
  follows system scheme in both OS schemes | Browser | `e2e/shell.spec.ts`" and "Glass surfaces fall back to solid
  under reduced transparency / no `backdrop-filter` | Browser/Automated | …".

## Risk tier

**Medium.** No server/data risk (no migration, no new space-scoped query, no AI/credential path), but it touches
`tokens.css` and many shared components (`Button`, `Chip`, `Sheet`, `TabBar`, `GroupList`, every chart) across the
whole app, so a regression is wide, not deep — consistent with the project's size bands for a visual-system change
rather than a single-feature one.

## Owner decisions (defaults proposed; owner auto-accepts unless corrected)

1. **Mono follows the system scheme** (one `mono` cookie value, light/dark sub-variant by `prefers-color-scheme`),
   not two separate "mono-light"/"mono-dark" picks. *Default: yes* (owner's own phrasing: "propose… follows the
   system scheme").
2. **`--money-in`/`--money-up` stay colour (green/red) even in mono**; everything else desaturates. *Default: yes*
   (CLAUDE.md "colour only for meaning"; owner's request explicitly keeps this).
3. **`--brand` (focus ring, inline links) stays blue in every theme including mono** — it is UI chrome, not content
   meaning, and losing all focus colour would be an accessibility regression, not an improvement. *Default: keep
   `--brand` blue in mono.*
4. **No Rive dependency or `.riv` asset in this pass**; `<Illustration>` ships hand-made SVG only, with a slot
   shaped for a later swap. *Default: yes*, per the owner's own fallback instruction.
5. **Glass performance budget: ≤ 3 simultaneously blurred layers on screen.** *Default: 3* (owner's example number);
   the 4th+ falls back to solid rather than stacking blur.
6. **Beranda hero illustration shows only in the zero-wallets state**, not on every load, to protect "one number
   first". *Default: zero-wallets only*; the owner can ask for more placements later.
7. **View Transitions API used only where supported, no polyfill, no fallback animation** (instant navigation on
   unsupported browsers). *Default: yes* — avoids a new dependency and keeps the no-JS/older-browser path exactly
   as fast as today.
8. **List-item stagger capped at a fixed row count (proposed 8), not proportional to list length.** *Default: 8
   rows*, to bound worst-case animation cost on a long Riwayat day.
9. **The appearance picker lives at a new `/pengaturan/tampilan` page, not inline on the main Pengaturan screen** —
   keeps Pengaturan's existing row list unchanged except for one new `IconRow` link, matching how every other
   settings sub-area already works (Notifikasi, Privasi, Kategori, …). *Default: yes.*
