# FN-51 — More motion on phone PWA and desktop

Owner request 2026-10-12: "add more animation on the PWA and Desktop side". Baseline: `docs/design/DESIGN_SYSTEM.md`
§ Motion (quiet motion, `--ease`/`--ease-in-out`/`--spring`, `--duration-fast|base|slow` at
`docs/design/tokens.css:156-163`, mirrored in `src/lib/ui/motion.ts:5`), FN-40 Part 2
(`docs/features/fn-40-visual-refresh/PRD.md`), FN-44 Koko poses (`src/lib/ui/kit/Mascot.svelte:147-166`).

**Risk tier: Medium.** No migration, no auth, no money logic, no new external input — but it touches shared
components used on every page (`<main>` route transition, Skeleton, Sheet, TabBar, charts), so a regression is wide,
not deep. Pipeline: engineer, then QA and a narrow red team (CSP, tap loss, no inline styles) in parallel.

## Goal

FN-40 gave the app its first functional motion (sheet rise/sink, hero count-up, chart grow-in, 8-row stagger, page
fade) and FN-44 gave Koko finite poses. What is still static: route changes only fade (no movement), Laporan's and
Kekayaan's main charts (Donut, CumulativeChart, StackedBars, TrendChart, AllocationBar) and the Beranda/Anggaran
progress bar appear fully drawn, loading skeletons pulse with an old-style reduced-motion rule, rows removed in place
vanish, client-only banners pop in, desktop cards give no hover feedback, and the Tambah button does not acknowledge
that the sheet opened. This pass adds a bounded set of purposeful animations in both form factors — phone PWA
(installed/standalone and browser alike) and the ≥ 1024 px desktop layout — so state changes read as changes, while
keeping the design system's rules: quiet, ≤ 300 ms, transform/opacity only, nothing on first paint, nothing under
reduced motion, nothing infinite except while work is outstanding.

## Scope

Every item: where · duration/easing · reduced-motion end state · test. All CSS lives inside
`@media (prefers-reduced-motion: no-preference)` or behind `prefersReducedMotion`; no animation library; no new
dependency; no View Transitions API.

### A. Route content transition (phone + desktop)

- Where: `src/routes/+layout.svelte:56-68` (today: opacity 0.35 → 1 on `<main>` via Web Animations, gated by
  `pageFadeAllowed`, `src/lib/ui/motion.ts:33-40`). Becomes opacity 0 → 1 **plus** `translateY(8px) → 0` on `<main>`,
  fill mode `none` (no residual transform). Same-path query changes still skip it (`motion.ts:39`). Not the View
  Transitions API (Chromium drops taps, `DESIGN_SYSTEM.md:166-167`).
- `--duration-base` (200 ms), `--ease` (the WAAPI call takes the same cubic-bezier string; `motion.ts` exports it as
  `EASE` so Vitest keeps it equal to the token).
- Reduced motion / `document.hidden`: no animation; the new page is simply there.
- Tap safety: the page stays interactive throughout (no `pointer-events` change, `<main>` keeps hit-testing while
  transformed). Only `position: fixed` descendants of `<main>` would be offset by ≤ 8 px while it runs; today the
  one such element is the voice toast (`src/routes/(app)/riwayat/suara/+page.svelte:979`), shown after a save and
  never on page enter. TabBar, FAB and MascotLoading sit outside `<main>` (`src/routes/(app)/+layout.svelte:58-76`).
- Tests: Vitest `src/lib/ui/motion.test.ts` for the keyframes helper (`pageEnterKeyframes()` returns only
  `opacity`/`transform`, 200 ms, `EASE` equals the token). E2e `e2e/motion.spec.ts:201-230` extended: the running
  animation on `<main>` has a `transform` keyframe, a tap during it lands on `/laporan`, and after it ends
  `getComputedStyle(main).transform === 'none'`.

### B. List enter / exit

- B1 Riwayat "Muat lebih banyak" (`src/routes/(app)/riwayat/+page.svelte:408-418`, appended day groups at `373-407`):
  each newly mounted `GroupList` already replays the 8-row stagger (`src/lib/ui/kit/GroupList.svelte:31-56`, CSS on
  mount); add the same `row-in` to `DayHeader` (`src/lib/ui/kit/DayHeader.svelte`) so the header and its first row
  arrive together. `--duration-base`, `--ease`, `backwards`. Reduced: at once. Test: Vitest (`DayHeader.svelte` joins
  `MOTION_FILES` in `test/motion-css.test.ts:9-21`); e2e: after clicking "Muat lebih banyak" the first `li` of the
  new group has a running animation and a tap on it navigates (same pattern as `motion.spec.ts:175-199`).
- B2 Impor batch list (`src/routes/(app)/impor/+page.svelte:1049-1149`): the batch row an action result names (the
  new batch after an import; the batch just undone or moved by `?/undo` / `?/move`, whose hidden `id` is already
  posted at `1103`, `1133`) plays `row-in` once; the action result gains `batchId` if it lacks it (no new query —
  the id is already in hand). Rows the action did not name do not replay. `--duration-base`, `--ease`. Reduced: at
  once. Test: Vitest on the pure helper `highlightedBatchId(form)`; CSS gating via `MOTION_FILES`.
- B3 Exit for rows removed in place: Kotak masuk's draft `<li>` after `?/discard` (`src/routes/(app)/kotak-masuk/+page.svelte:169`,
  `use:enhance`): Svelte `out:` transition, opacity 1 → 0 + `scale(0.98)`, `--duration-fast` (150 ms), `--ease`.
  Svelte 5 runs CSS transitions through the Web Animations API (no injected `<style>`; the existing CSP watch in
  `motion.spec.ts:15-26` proves it). The rows below move up at once (no height animation). Reduced: duration 0,
  removed at once. Test: Vitest on the transition factory (`duration === 0` under reduced motion); e2e: zero CSP
  violations on `/kotak-masuk` with motion on.

### C. Chart draw-in on Laporan and Kekayaan

Same pattern as FN-40's BarChart/MonthLines/FlowChart (`BarChart.svelte:160-172`, `MonthLines.svelte:35-46`,
`FlowChart.svelte:180-199`): on mount only (keyed, never on a filter re-render), `backwards` fill, inside the
no-preference media query. Reduced motion: drawn in full at once.

| Component | File | Motion | Token |
| --- | --- | --- | --- |
| Donut (Laporan) | `src/lib/ui/charts/Donut.svelte:31-62` | slice group `rotate(-18deg)` → 0 about the centre + opacity 0 → 1; the centre text fades in after it | `--duration-slow`, `--ease`; text `--duration-base` delayed `--duration-fast` |
| CumulativeChart (Laporan) | `src/lib/ui/charts/CumulativeChart.svelte` | line draws with `pathLength="1"` + `stroke-dashoffset` 1 → 0 (MonthLines pattern); area fades in after | `--duration-slow`, `--ease` |
| StackedBars (Laporan) | `src/lib/ui/charts/StackedBars.svelte` | bars `scaleY(0)` → 1, `transform-box: fill-box`, origin bottom (FlowChart pattern) | `--duration-base`, `--ease` |
| TrendChart (Kekayaan) | `src/lib/ui/net-worth/TrendChart.svelte:84-94` | polyline draw as above; `.area`, dots and cursor fade in after | `--duration-slow`, `--ease` |
| AllocationBar (Kekayaan), CategoryBar (Beranda) | `src/lib/ui/net-worth/AllocationBar.svelte`, `src/lib/ui/kit/CategoryBar.svelte` | segments fade in 30 ms apart, first 8 only (GroupList cap) — no width animation | `--duration-base`, `--ease` |
| ProgressBar (Beranda safe-to-spend `src/routes/(app)/+page.svelte:372-379`, Anggaran) | `src/lib/ui/kit/ProgressBar.svelte:31` | `.fill` rect `scaleX(0)` → 1, `transform-box: fill-box`, origin left (SVG draw; `aria-valuenow` is the final value from the first frame) | `--duration-slow`, `--ease` |

There is no safe-to-spend ring in the code (the owner's "ring fill" is this bar); no new chart shape is added.
Tests: all six files join `MOTION_FILES`; the samples on `/dev/ui/charts` (`src/routes/(app)/dev/ui/charts/+page.svelte`)
and `/dev/ui` (ProgressBar) are what e2e reads: under `reduce` every listed selector has `animationName === 'none'`
(extend `motion.spec.ts:82-89`); with motion on, `.fill`/`.bar`/`polyline` report a running animation ≤ 300 ms.

### D. Skeleton shimmer

- `src/lib/ui/kit/Skeleton.svelte:16-31`: the opacity pulse (`infinite`, old `reduce` override) becomes a shimmer:
  one `::after` band per `.bar` (`overflow: hidden`), gradient from transparent through
  `color-mix(in srgb, var(--bg) 45%, transparent)` to transparent, `translateX(-100%) → translateX(100%)`,
  `--ease-in-out`, 1.2 s, `infinite` — allowed only because the component is in the DOM only while a load is
  outstanding (every caller: `{#if loading}`, e.g. `riwayat/+page.svelte:352-353`, `beruntun/+page.svelte:59-60`),
  the same exception MascotLoading uses (`MascotLoading.svelte:10-13`). `rows` is clamped to 8.
- Reduced motion: flat `--panel-2` bars, no band (the whole rule sits in the no-preference block; the old `reduce`
  override goes).
- Tests: Vitest — Skeleton joins `MOTION_FILES` for gating; the "nothing infinite" rule gets an allow-list
  `LOADING_ONLY = ['Skeleton.svelte', 'MascotLoading.svelte']` with a test that every `<Skeleton` call site in
  `src/routes` sits inside an `{#if …loading…}` / `aria-busy` branch (grep-based). E2e: on `/dev/ui` the sample
  bars have a running animation with motion on and `none` under reduce.

### E. Desktop hover / focus lift

- Where: tappable panel cards and rows only — `a.card` / `.selectable` rows: Beranda cards (`src/routes/(app)/+page.svelte:881`),
  `src/lib/ui/net-worth/CreditCardCard.svelte:45`, `src/lib/ui/kit/GroupRow.svelte` selectable/link rows, Dompet
  wallet rows. Rule: `@media (min-width: 1024px) and (hover: hover) and (pointer: fine)` → `:hover`/`:focus-visible`
  = background `--panel-2` (already the design system's hover colour) + `translateY(-1px)`; no shadow (principle 5,
  `DESIGN_SYSTEM.md:27-28`: shadows only on floating things). Press keeps the existing `scale(0.97)`.
- `--duration-fast`, `--ease`. Reduced motion: colour change only, no translate (transform inside the no-preference
  block; the colour rule outside it).
- Tests: Vitest — every new `transform` declaration in these files is gated by both media queries; focus ring
  unchanged (existing `focus-visible` rules still present). No e2e (CSS only; the desktop project runs under
  `reducedMotion: 'reduce'`, `playwright.config.ts:29`).

### F. Sheet and Tambah button

- Desktop dialog enter (`src/lib/ui/shell/Sheet.svelte:168-175`, ≥ 1024 px): `scale(0.96)` + opacity instead of the
  phone's 24 px rise (a centred dialog that slides up looks detached); `--duration-base`, `--ease`. Phone rise
  unchanged (`--duration-slow`, `--ease`; `--spring` only if the owner picks "playful", see Owner decisions). The
  "takes no taps until settled" rule (`Sheet.svelte:90-96`, e2e `motion.spec.ts:93-117`) stays for both.
- Sheet body: `.sheet-body` fades in 40 ms after the sheet (opacity only, `--duration-base`); the title row does not.
- Tambah FAB (`src/lib/ui/shell/TabBar.svelte:28-30, 81-100`): gets `aria-expanded={open}` from the layout
  (`src/routes/(app)/+layout.svelte:76`, `adding`) and rotates its "+" 45° while the sheet is open,
  `--duration-base`, `--ease`; reduced motion: rotated at once (the rotation is state, the transition is motion).
- Tests: Vitest — Sheet's desktop block declares `transform: scale(…)` inside no-preference; TabBar's `aria-expanded`
  rotation transition gated. E2e (own 1280 × 800 context inside `motion.spec.ts`, as `kit()` does for 360): the
  desktop dialog has a running animation with motion on, `pointerEvents === 'none'` while it runs, and `getAnimations()`
  is empty under reduce; phone: the FAB reports `aria-expanded="true"` once the sheet is open.

### G. Streak chip micro-animation

- FN-34 has no flame or coin (owner rule; `docs/FEATURES.md` FN-34 "Ours"); the chip is text (`src/routes/(app)/+page.svelte:243-246`,
  `.day-chip` at `611`). Motion: when `data.streak.current` increases while Beranda stays mounted (after "Tutup
  hari" — the same moment Koko celebrates), the chip hops once: `translateY(-3px)` and back, `--spring`,
  `--duration-slow`. Never on first paint (compare with the previous value in an `$effect`, like HeroAmount's
  count, `HeroAmount.svelte:46-58`). Reduced motion or hidden tab: nothing.
- Tests: Vitest on the pure helper `streakHop(prev, next, reducedMotion, hidden)` (true only for `next > prev`,
  motion allowed, visible); CSS gating via `MOTION_FILES` (the route file joins the list for this one keyframe).

### H. Client-only banner enter

- Where: cards that mount after hydration and today pop in — `src/lib/ui/pwa/InstallHint.svelte:48-56`,
  `src/lib/ui/pwa/WhatsNew.svelte:51-68`, `UpdateBanner` via `src/routes/+layout.svelte:97-101`,
  `OfflineQueueStatus` (`src/routes/(app)/+layout.svelte:69-73`). Enter: opacity 0 → 1 + `translateY(-6px) → 0`,
  `--duration-base`, `--ease`, `backwards`. The card takes its full height from the first frame (no height
  animation; the layout shift it causes exists today and is not changed). No exit animation (dismiss returns focus
  to `<main>` at once, `InstallHint.svelte:42-45`).
- Reduced motion: shown at once. Tests: Vitest — the four files join `MOTION_FILES`.
- No new Android install banner: `captureInstallPrompt` (`src/lib/ui/pwa/install.svelte.ts:21-37`) only stores the
  event for the install guide page; adding a banner would be new UX, not motion (Out of scope).

### I. Battery and visibility

- JS-driven motion (A, G, the hero count-up at `HeroAmount.svelte:46-58`) goes through one helper
  `motionAllowed({ reducedMotion, hidden })` in `src/lib/ui/motion.ts`; `pageFadeAllowed` and `countUpDuration`
  take `hidden` and return "no motion" when `document.hidden` is true (a navigation or save finishing in a
  background tab plays nothing). CSS animations need no handling: browsers do not paint hidden documents and
  resume from the end state. Tests: Vitest for each helper with `hidden: true`.

### J. Documentation and tokens

- One new token `--duration-loop: 1200ms` (the shimmer's cycle) in `docs/design/tokens.css` next to the other
  durations, mirrored as `DURATION_MS.loop` (the existing equality test covers it). No other token.
- `docs/design/DESIGN_SYSTEM.md` § Motion lists the new placements and the loading-only exception for `infinite`;
  change-log entry v3.2. `docs/design/APP_PARITY.md` unchanged (layout is untouched).
- i18n: no new user-visible string is expected (Koko has no copy; the FAB keeps `aria-label="Tambah"`). If one
  appears, it goes through `tr()` with an `i18n-en.ts` entry; `test/i18n-coverage.test.ts` stays green.

## Out of scope

- View Transitions API, any animation library, Rive runtime, Lottie.
- Pull-to-refresh indicator: not cheap — a new touch gesture that fights `overscroll-behavior: contain` on sheets
  and scrollers (`Sheet.svelte:149`, `BarChart.svelte:151`) and would reload under a half-typed form. Deferred.
- A new Android install banner or any new screen, card or copy.
- Animating width, height, margin, top/left, `box-shadow` or colour of amounts; exit animations for pages; a
  sidebar active-indicator slide (desktop) — different item heights make it unreliable; later if asked.
- Changes to money, dates, capture, sync, budgets, access control or any server query beyond adding an already-known
  `batchId` to an action's success result (B2).
- Per-user "turn animations off" setting: the OS `prefers-reduced-motion` remains the one switch.
- Koko "welcome back" on app open — built only if the owner says yes (Owner decision 3); the spec is there so the
  answer is a one-liner.

## Acceptance criteria

Vitest first; e2e only for real-browser behaviour (tap during a transition, dialog pointer-events, running
animations). Levels per `docs/ACCEPTANCE.md`: **Automated** = Vitest, **Browser** = Playwright.

**Reduced motion and end state**

1. Given `prefers-reduced-motion: reduce`, when any page, chart, skeleton, sheet, banner, chip or row touched by this
   PRD renders or changes, then no animation or transition runs and the end state is on screen at once — every
   `animation*`/`transition*`/non-keyframe `transform` declaration in every file added to `MOTION_FILES` sits inside
   `prefers-reduced-motion: no-preference` (Automated: `test/motion-css.test.ts`), and on `/dev/ui`, `/dev/ui/charts`
   and `/` every listed selector reports `animationName === 'none'` and `getAnimations().length === 0` (Browser:
   `e2e/motion.spec.ts`).
2. Given motion is allowed, when a chart, bar, skeleton or row animates, then the animation's declared duration is
   ≤ 300 ms except the Skeleton shimmer (loop) and Koko's existing poses (Automated: duration values in the scanned
   CSS resolve to `--duration-fast|base|slow` or `--duration-loop`).

**Performance rules (hard limits)**

3. Given any `@keyframes` block in a `MOTION_FILES` file, then it declares only `transform`, `opacity` or
   `stroke-dashoffset` — never `width`, `height`, `top`, `left`, `margin`, `padding`, `background`, `box-shadow`,
   `font-size` (Automated: new test in `test/motion-css.test.ts` using `declarations()` + `inKeyframes`; it must
   fail when a `width` keyframe is planted — fail-before proof in the report).
4. Given any `infinite` animation in `src/lib/ui`, then its file is in `LOADING_ONLY` (`Skeleton.svelte`,
   `MascotLoading.svelte`) and every `<Skeleton` call site in `src/routes` is inside a loading branch (Automated).
5. Given a first page load (server-rendered, before hydration or without JavaScript), then nothing waits for a
   script: mount animations are CSS with `backwards` fill from the server HTML, the route transition never runs
   on the first navigation (`pageFadeAllowed` with `from: undefined` is false, `motion.test.ts:67`), and the
   hero figure, progress bar `aria-valuenow`, chart values and row text are final from the first frame
   (Automated: helper tests; Browser: existing no-JS row tap `motion.spec.ts:175-199` still passes).
6. Given a measured representative page (Beranda, Riwayat, Laporan) before and after this PRD, then CLS does not
   increase; given a mid-range Android phone is available, then a 60 fps check of the route transition, Donut and
   Skeleton is recorded — both are manual, stated in the completion report as run or not run, never reported as
   passed if unrun (Pass level, manual).
7. Given `document.hidden === true`, when a navigation finishes, the hero figure changes or the streak count
   increases, then `pageFadeAllowed`, `countUpDuration` and `streakHop` return "no motion" (Automated).

**Route transition (A)**

8. Given motion is allowed, when a client-side navigation between two different paths completes, then `<main>` has
   a running Web Animation whose keyframes contain `transform` and `opacity` only, a real tap on a tab during it
   reaches its target page, and after ≤ 200 ms `getComputedStyle(main).transform === 'none'` (Browser:
   `motion.spec.ts:201-230` extended). Given reduced motion, then `<main>` has no running animation (Browser).
9. Given a navigation to the same path with a different query (a Riwayat filter), then no route transition plays
   (Automated: `pageFadeAllowed({ from: '/riwayat', to: '/riwayat' }) === false`, existing).

**Lists (B)**

10. Given Riwayat shows "Muat lebih banyak", when it is clicked with motion on, then the newly appended day's
    header and first row have a running animation, the 9th row of that group does not, and a tap on the first new
    row during its fade navigates to its edit page (Browser).
11. Given an import, undo or move action succeeds on `/impor`, when the page re-renders, then exactly the batch row
    whose id the action result names carries the `row-in` animation class/state; a reload without an action result
    marks no row (Automated: `highlightedBatchId` tests; Browser optional).
12. Given a Kotak masuk draft is discarded with JavaScript on, when the row leaves, then it fades for ≤ 150 ms and
    is removed; under reduced motion it is removed at once; no CSP violation is logged on that page with motion on
    (Browser: CSP watch pattern from `motion.spec.ts:15-26`).

**Charts and bar (C)**

13. Given `/laporan` or `/kekayaan` renders with motion on, when Donut, CumulativeChart, StackedBars, TrendChart or
    AllocationBar mounts, then its drawn elements have a running animation that ends within 300 ms and the final
    geometry (dash lengths, bar heights, points) is identical to the reduced-motion render (Browser on
    `/dev/ui/charts`: compare `getAttribute('stroke-dasharray')`/`height` between the two contexts; Automated for
    gating).
14. Given the Beranda budget bar renders, then `aria-valuenow` and `aria-valuetext` equal the final percent from the
    first frame while the fill rect scales in; given the figure changes on the page (a budget save), then the bar
    does not replay (keyed by budget id, not by percent) (Automated: component render test; Browser on `/dev/ui`).
15. Given a chart re-renders because of a filter or period change on the same page, then it does not replay its
    draw-in (elements keyed by stable ids/indices, FN-40 rule) (Automated: `{#each}` keys present, existing pattern).

**Skeleton (D)**

16. Given a page is loading with motion on, then each skeleton bar shows a moving band (`animationName !== 'none'`,
    `transform` only); given reduced motion, then bars are flat `--panel-2` with no animation; given `rows={20}`,
    then at most 8 bars render (Automated: component test; Browser: `/dev/ui`).

**Desktop (E, F)**

17. Given a ≥ 1024 px viewport with a fine pointer, when a tappable card or row is hovered or focused, then its
    background is `--panel-2` and it is translated −1 px; given reduced motion, then only the background changes;
    given a coarse pointer or < 1024 px, then neither rule applies (Automated: media-query context of every new
    declaration).
18. Given a ≥ 1024 px viewport with motion on, when a PickerSheet/Sheet opens, then it scales from 0.96 and takes no
    taps until settled (`pointerEvents === 'none'` while running), then takes a tap; under reduce it has no
    animation and takes taps at once (Browser: new 1280 × 800 context in `motion.spec.ts`).
19. Given the phone layout, when the Tambah sheet opens, then the FAB has `aria-expanded="true"` and its icon is
    rotated 45°; when it closes, `aria-expanded="false"` and the icon is upright (Browser: attribute check; the
    rotation itself Automated via CSS gating).

**Streak and banners (G, H)**

20. Given Beranda is mounted and the day is closed so that `streak.current` increases, then the chip hops once
    (≤ 300 ms); given first paint, a decrease, reduced motion or a hidden tab, then it does not (Automated:
    `streakHop` table test; the DOM effect is CSS-gated).
21. Given InstallHint, WhatsNew, UpdateBanner or OfflineQueueStatus appears after hydration with motion on, then it
    fades/slides in within 200 ms and its final height is occupied from the first frame; under reduce it appears at
    once (Automated: gating; the existing e2e for each banner is unchanged in assertions and still passes).

**Checklist-derived (every part)**

22. `npm run gates` (check, lint, test, build) is clean (Automated).
23. No new or changed space-scoped query: the diff touches no `src/lib/server/**` query and no `+page.server.ts`
    beyond returning an id already read by that action (B2); every existing load/action keeps its space-access
    check unchanged — verified by grepping the diff and stated in the report (Automated/manual).
24. Every state the touched screens already have — loading (Skeleton), empty (`EmptyState`), error (`ErrorState`),
    saving (disabled buttons, "Memuat…"), success (saved notices, Koko hop) — is unchanged in substance; this PRD
    only animates around them and never shows success before the server confirms (Automated: existing route and
    component tests pass unmodified).
25. Given any new Indonesian phrase, then it has an `i18n-en.ts` entry (Automated: `test/i18n-coverage.test.ts`);
    the expected count of new phrases is zero and the report says so.
26. Given the CSP, then no inline `style` attribute and no injected `<style>` is added by any animation (Svelte 5
    WAAPI transitions, CSS classes only); zero CSP violations across every page the motion spec opens (Browser:
    `motion.spec.ts` afterEach).
27. Given 360 px, then no new element widens the page or shrinks a touch target below 44 px (the FAB and chip keep
    their sizes; the shimmer band is clipped by `overflow: hidden`) (Browser: `e2e/ios-responsive.spec.ts` and
    `shell.spec.ts` pass unmodified).
28. Focus: the sheet still returns focus to its opener after the close transition (`motion.spec.ts:168-171`); the
    FAB's `aria-expanded` is the only accessibility-tree change (Browser, existing assertion).
29. Persisted state: this PRD adds none (Koko welcome, if chosen, stores one localStorage key `montra-welcome-wib-date`
    per device; a reload on the same WIB date does not replay) (Automated: pure decision helper with WIB vectors
    23:30 / 00:30, `src/lib/shared/dates` helpers).
30. Playwright economy: the default `reducedMotion: 'reduce'` (`playwright.config.ts:29`) stays; new motion-on cases
    live only in `e2e/motion.spec.ts` with their own contexts; no other spec gains a wait for an animation.

## Architecture notes

- `src/lib/ui/motion.ts` (+ `motion.test.ts`): `DURATION_MS.loop`, `EASE` string mirroring `--ease`,
  `motionAllowed`, `pageEnterKeyframes`, `pageFadeAllowed`/`countUpDuration` with `hidden`, `streakHop`,
  `highlightedBatchId`. Shared, pure, no DOM.
- `src/routes/+layout.svelte:56-68` — route transition call. `src/routes/(app)/+layout.svelte:76-77` — passes
  `adding` to `TabBar` as `open`.
- Components (CSS only unless noted): `src/lib/ui/kit/{Skeleton,DayHeader,ProgressBar,CategoryBar,GroupRow}.svelte`,
  `src/lib/ui/charts/{Donut,CumulativeChart,StackedBars}.svelte`, `src/lib/ui/net-worth/{TrendChart,AllocationBar,CreditCardCard}.svelte`,
  `src/lib/ui/shell/{Sheet,TabBar}.svelte` (TabBar gains the `open` prop), `src/lib/ui/pwa/{InstallHint,WhatsNew,UpdateBanner}.svelte`,
  `src/lib/ui/offline-queue/OfflineQueueStatus.svelte`, `src/lib/ui/kit/HeroAmount.svelte` (hidden-tab guard).
- Routes: `src/routes/(app)/+page.svelte` (streak chip hop, card hover), `src/routes/(app)/impor/+page.svelte`
  (+ `+page.server.ts` success result `batchId`), `src/routes/(app)/kotak-masuk/+page.svelte` (row `out:`),
  `src/routes/(app)/dev/ui/+page.svelte` and `dev/ui/charts/+page.svelte` (samples the e2e reads).
- Tokens/docs: `docs/design/tokens.css` (`--duration-loop`), `docs/design/DESIGN_SYSTEM.md` § Motion + change log.
- Tests: `test/motion-css.test.ts` (new files in `MOTION_FILES`, keyframe-property rule, `LOADING_ONLY`),
  `test/helpers/css.ts` reused (`cssOf`, `declarations`), `e2e/motion.spec.ts` (extended; one new 1280 context).
- Reuse, do not duplicate: `GroupList`'s stagger (`GroupList.svelte:31-56`), the `grow`/`draw`/`bar-grow` keyframe
  patterns, `prefersReducedMotion` from `svelte/motion`, `isStandalone()` (`install.svelte.ts:54-59`) if the Koko
  welcome is chosen, `focusMain` for banners.
- No D1 migration. No Worker other than the app Worker. No `src/lib/server` logic change.

## Prerequisites

None. No credential, provider or `.dev.vars.example` entry; nothing shows "Belum dikonfigurasi". Playwright needs
the local Chromium already used by `e2e/motion.spec.ts` (the `docs/TASKS.md` "install-deps chromium" **You** item
applies to e2e in general, not to this feature).

## Tracker impact

- `docs/TASKS.md`: no open To do item covers this (FN-40 parts 2+3 and FN-44 are ticked at `docs/TASKS.md:302-303,
  322`); add `- [ ] **Claude** — FN-51 more motion (phone PWA + desktop), no migration — docs/features/fn-51-motion/PRD.md`
  under the UI lines, tick it at completion.
- `docs/ACCEPTANCE.md:57` "360 px layout, 44 px touch targets, reduced motion | Browser | … (reduced motion is
  CSS-only; not browser-tested …)": the parenthetical is stale since FN-40's `e2e/motion.spec.ts`; with AC 1, 3 and 8
  passing, the Check column becomes "`e2e/shell.spec.ts`, `e2e/kit.spec.ts`, `e2e/motion.spec.ts`,
  `test/motion-css.test.ts` (keyframes transform/opacity only)". Status stays Browser.
- `docs/FEATURES.md`: FN-51 entry added with this PRD (after FN-49; FN-50 is another branch's).
- `docs/HISTORY.md`: one Completed-work bullet at the end of the build, with the manual CLS/Android check stated as
  run or not run.

## Owner decisions (defaults proposed; answer once before the build)

1. **Intensity — subtle (default) or playful.** Subtle = everything above as written. Playful = route slide 12 px
   with direction by tab order (left/right between Beranda → Riwayat → Laporan → Dompet), phone sheet rises with
   `--spring` (a 2 % overshoot), hover lift adds `--shadow-card`, Koko welcome on (decision 3). *Default: subtle* —
   it keeps `DESIGN_SYSTEM.md` principle 7 and the ≤ 300 ms rule without exceptions.
2. **Desktop-only extras.** Desktop gets the hover/focus lift (E) and the scale-in dialog (F); the phone gets the
   FAB rotation and the rising sheet. Nothing else differs by form factor. *Default: yes, exactly this split.*
3. **Koko "welcome back" on app open.** If yes: installed/standalone only (`isStandalone()`), once per WIB calendar
   date per device (localStorage), `wave` pose at 32 px beside Beranda's hero label for one cycle (≈ 1 s), mounted
   after hydration (never delays first paint), skipped under reduced motion and in a hidden tab, no copy (Koko never
   speaks). *Default: no* — "one number first" (`DESIGN_SYSTEM.md:22`) and Koko already greets in the zero-wallet
   and sign-in moments; easy to add later behind the same helper.
4. **Skeleton loop allowed.** The shimmer is the one new `infinite` animation, confined to loading. *Default: yes*
   (same exception MascotLoading already has); the alternative is a 3-cycle shimmer that then rests flat.
5. **Hover lift without shadow.** *Default: no shadow* (principle 5); the shadow version is part of "playful".
6. **Pull-to-refresh.** *Default: deferred* (Out of scope, reasons there). Say "build" to open a separate small PRD.
7. **Row exit in Kotak masuk (B3).** It is the one place the DOM waits 150 ms before removing a row. *Default: yes*;
   "no" drops B3 and nothing else changes.

## Owner decisions — answered 2026-10-12

1. Intensity: **subtle** (8 px slides, no shadow lift, `--ease`, no `--spring` beyond the existing sheet).
2. Desktop-only extras (hover/focus lift, dialog scale-in) and phone-only extras (FAB rotation, rising sheet): **yes**.
3. Koko "welcome back" on app open: **yes** — standalone only, once per WIB day, 32 px wave, no copy, skipped under
   reduced motion, never delays first paint.
4. Skeleton shimmer: infinite while loading, as proposed.
5. Hover lift: without shadow.
6. Pull-to-refresh: **include it** in this pass — installed app only, Beranda and Riwayat, transform/opacity
   indicator, reduced-motion end state, `document.hidden` guard; e2e for touch and for not triggering on scroll-up.
7. Kotak masuk row exit: yes.
