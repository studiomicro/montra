# FN-40 Visual refresh: summary

Status: **complete** (2026-10-09): all four parts merged.

## Parts 1 + 4: Hitam-putih theme and glass material

- Theme: a fourth choice, Hitam-putih, next to Sistem, Terang and Gelap; it follows the system light/dark scheme
  (mono-light, mono-dark). Accent, charts and chips turn achromatic; money in/out and `--brand` keep their colour.
  Cookie only, no migration. New page `/pengaturan/tampilan` (works without JavaScript). The sidebar quick toggle
  cycles Sistem → Terang → Gelap → Hitam-putih (a change from the PRD, which kept it a light/dark flip: one click
  used to drop Hitam-putih).
- Glass: shared `.glass` / `.glass-soft` rules on the tab bar, sheets, title bar, sidebar footer, banners and floating
  cards; selected chips and segmented controls get the glass edge without blur. Solid under reduced transparency,
  without `backdrop-filter`, and for page chrome under an open sheet; at most 3 blurred layers on screen.
- Tests: `test/contrast.test.ts` (four themes, text on glass, achromatic mono, per-scheme glass tokens),
  `test/glass-budget.test.ts`, prefs and GroupRow tests; e2e mono per scheme, glass fallback (CDP media emulation),
  `e2e/tampilan.spec.ts`, the sidebar theme cycle.
- QA: FAIL (sheet title band) → cycle 2 → PASS after a one-line test type fix. Red team: PASS (L1 user check before
  body read, L2 toggle dropping mono, both fixed).
- Not verified: Safari/WebKit glass rendering, real-device `theme-color`, CLS measurement.

## Parts 2 + 3: motion and isometric illustrations

- Motion: duration tokens `--duration-fast/base/slow`; `src/lib/ui/motion.ts`; sheets rise and sink; the Beranda
  amount counts to a new figure after a change (never on first paint, always ending on the server figure); charts
  grow in; the first 8 list rows fade in 30 ms apart; press feedback on chips and rows; a 200 ms opacity fade on
  `<main>` after navigation. All of it is off under `prefers-reduced-motion: reduce`.
- Deviation: the page fade replaces the View Transitions API, because Chromium drops taps during a View Transition
  (reproduced by QA outside the app). Playwright runs with `reducedMotion: 'reduce'` by default because its
  rAF-based stability check stalls on no-JS pages after a finite fade; `e2e/motion.spec.ts` turns motion on and proves
  a real tap mid-fade navigates.
- Illustrations: 11 original isometric SVG scenes (`src/lib/ui/kit/illustrations/`) behind `<Illustration name>`
  (Rive-ready slot, no Rive dependency); colours only from theme tokens, so they repaint in all four themes. Used on
  17 empty states, both error pages, sign-in/sign-up from 768 px, and a Beranda "first wallet" card when the space has
  no wallets (`walletCount` from the existing wallet list). The float runs three cycles then rests.
- Tests: `motion.test.ts`, `test/motion-css.test.ts` (no infinite motion, reduced-motion coverage),
  `Illustration.test.ts`, `HeroAmount.test.ts`, a beranda wallet-count case, `e2e/motion.spec.ts`.
- QA PASS (`QA_REPORT_P23.md`), red team PASS (`SECURITY_REPORT_P23.md`). Cycle 3 on main: an intermittent shell
  glass failure traced to the reduced-motion rule (0.01 ms transitions on every property kept the page chrome
  blurred for a frame under an open sheet; now `0s`); red team L1 (rising sheet and scrim take no taps until settled)
  and L2 (CSP-violation watch in `e2e/motion.spec.ts`) fixed.
- Not verified: CLS measurement (no Lighthouse here), Safari/WebKit.
