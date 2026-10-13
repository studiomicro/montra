# FN-40 Parts 2 + 3 (motion, isometric illustrations) — Security report

Scope: `git diff main...HEAD` at 6f4cb04 (read-only worktree `fn-40b-rt`), Medium tier, narrow review.
Reviewer: red-team-pentester, 2026-10-09.

## Verdict: PASS

No medium or high findings. Two low findings and notes are tracked below.

## Checks

| Area | Result |
| --- | --- |
| CSP (`src/lib/server/csp.ts`: `style-src 'self'`, `style-src-attr` one hash, `script-src 'self'`, no `unsafe-inline`) | Compatible. Diff adds no `style=`/`style:` attributes, no `{@html}`, no Svelte `transition:`/`in:`/`animate:` (which inject runtime `<style>`), no `.style.` writes. All motion is component CSS (`@keyframes`, `@starting-style`, transitions) shipped through SvelteKit's normal hashed/nonced CSS path; the page fade uses `Element.animate()` (Web Animations are not gated by `style-src`); the hero count uses `svelte/motion` `Tween` (JS state only). |
| SVG scenes (`src/lib/ui/kit/illustrations/*.svelte`, `iso.ts`) | Only `<path>`, `<circle>`, `<ellipse>`, `<g transform>` with numeric `d` strings computed from constant literals. No `<script>`, `<foreignObject>`, `<image>`, `<use>`, `<a>`, `href`/`xlink:href`, `url(...)` or inline style; `Illustration.test.ts` asserts this. |
| `<Illustration name>` | Every call site passes a string literal or `Object.keys(SCENES)` (`/dev/ui`, gated by `devRoutesEnabled` → 404). `EmptyState.illustration` is also literal everywhere. `name` is typed `keyof typeof SCENES`; never from URL, form, loader or DB. Unknown name → `SCENES[name]` undefined → Svelte 5 renders no component (no throw, no injection). Decorative: `aria-hidden`, `pointer-events: none`. |
| `walletCount` (`src/lib/server/budgets/summary.ts:63`) | `wallets.length` of the existing `listWallets(db, spaceId)` call (filters `space_id = ?` and `deleted_at is null`, Drizzle-parameterised). `spaceId` comes from `currentSpaceScope(locals)` (re-checks `requireSpaceAccess`). No new query, no ID from the client, no cross-space leak; integration test covers 0 / >0 / deleted. |
| `src/routes/+layout.svelte` `afterNavigate` fade | Opacity-only 200 ms animation on `<main>` (0.35 → 1); no focus, scroll, history or URL handling touched; only pathnames compared locally, nothing logged or sent. Skipped on first load, same-path query changes and reduced motion. |
| `playwright.config.ts` `reducedMotion: 'reduce'` default | Does not skip or filter any spec (no `testIgnore`/`grep` change); auth, access, CSP and webhook journeys still run, only under reduced motion. `e2e/motion.spec.ts` re-enables motion for the animated paths. `shell.spec.ts` resets the emulation before its own CDP media override. |
| Motion vs. confirmation UI | Closing sheet: `pointer-events: none` while it sinks (no ghost clicks into a dialog that is going away). Rows: 6 px slide, ≤ 410 ms, rows are links not destructive buttons. Page fade does not move layout. Hero count-up starts at the server figure (SSR/no-JS show the final digits) and settles on the exact value. |
| Secrets / PII / page data | No new loader fields except an integer count; no logging added. |

## Findings

### L1 (low) — Opening sheet is tappable while it is still fading in
`src/lib/ui/shell/Sheet.svelte:115-123` (`@starting-style` `opacity: 0; translateY(24px)` → visible over 300 ms; no `pointer-events: none` on the opening state).
Scenario: a user double-taps a trigger whose sheet holds a primary/destructive button positioned under the same point; the second tap can land on that button while the sheet is still faint (opacity near 0). Reproduce: with motion on, open a sheet whose confirm button sits under the trigger and tap twice within ~150 ms.
Mitigation already present: same exposure existed before (old `rise` keyframe, 0.32 s), and server-side actions remain authorised. Suggestion: give destructive confirms a short `pointer-events: none` window at open, or place them away from the opener.

### L2 (low) — No browser-level CSP-violation assertion for the motion paths
`e2e/motion.spec.ts` checks behaviour but does not listen for `securitypolicyviolation` / console CSP errors while motion runs, and the suite default is now reduced motion, so the `@starting-style`/WAAPI paths are only exercised in that one spec. Code review found nothing that would violate the CSP; this is a regression-guard gap only. Suggestion: in `motion.spec.ts` attach `page.on('console')` and fail on `Content Security Policy` messages.

### Notes (not findings)
- `+layout.svelte` fade runs on `(auth)` pages too; harmless (opacity only, no data).
- The `/dompet?tambah=1` link on the first-wallet card is a same-origin GET that only opens a form; no state change.

## ENGINEERING_CHECKLIST
Diff touches UI/CSS and one server summary field; no new queries, routes, actions, bindings, secrets or migrations. Reduced-motion honoured; CSP unchanged and without `unsafe-inline`.

## Commands run (fn-40b-rt @ 6f4cb04)
- `flock … npx vitest run --maxWorkers=2 src/lib/ui/kit/Illustration.test.ts src/lib/ui/motion.test.ts test/motion-css.test.ts src/lib/server/csp.test.ts src/lib/ui/kit/HeroAmount.test.ts` → 5 files, 77 tests passed.
- `flock … npx vitest run --maxWorkers=2 test/integration/beranda.test.ts` → 1 file, 32 tests passed.
- Playwright not run (review only).
