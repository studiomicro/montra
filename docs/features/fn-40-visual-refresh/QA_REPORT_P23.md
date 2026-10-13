# FN-40 Visual Refresh — QA Report (Parts 2 + 3 only)

**Verdict: PASS**

Scope: Part 2 (motion) and Part 3 (isometric illustrations). Parts 1 (mono theme) and 4 (glass material) are
already merged on `main` and are not re-evaluated here except where Parts 2/3 touch the same components
(Chip, GroupRow, Sheet) and could have regressed them.

Worktree `.claude/worktrees/fn-40b`, branch `fn-40b-motion-illustrations`, commit `6f4cb04` (`git diff main...HEAD`).

## Commands run

- `rm -rf .svelte-kit && flock …/montra-heavy.lock npm run check` — 0 ERRORS, 0 WARNINGS, 1743 files (real
  provider: none; local TypeScript/svelte-check only). **Note:** the first several attempts failed with 399
  spurious "Cannot find module './$types'" errors — traced to this worktree's `node_modules` being a plain
  symlink to `main`'s `node_modules` (sibling worktrees have their own copy); `svelte-kit sync` writes
  `node_modules/$app/tsconfig.json` with `rootDirs` relative to wherever that file physically lives, so a symlinked
  `node_modules` makes every worktree using it fight over one shared, wrong-rooted file. Fixed for this QA run only
  by replacing the symlink with a local hardlinked copy (`cp -al`) so the worktree gets its own `node_modules/$app`;
  no source file was touched. This is an environment/worktree-setup issue, not a defect in the diff — confirmed by
  reproducing the same 399 errors against a clean `main` checkout immediately after running `check` from this
  worktree (the shared file gets overwritten by whichever project ran sync last).
- `flock …/montra-heavy.lock npm run lint` — "All matched files use Prettier code style!", eslint clean, exit 0.
- `flock …/montra-heavy.lock npx vitest run --maxWorkers=2` — **Test Files 206 passed (206), Tests 2965 passed
  (2965)**, local D1/Vitest, no real providers.
- `flock …/montra-heavy.lock npm run build` — Vite client + server + service worker build succeeded, Cloudflare
  adapter bundled, exit 0.
- `E2E_PORT=5311 npx playwright test --workers=1 e2e/motion.spec.ts e2e/shell.spec.ts e2e/kit.spec.ts
  e2e/beranda.spec.ts e2e/fitur.spec.ts e2e/tabungan.spec.ts e2e/kekayaan.spec.ts` — **104 passed, 16 skipped
  (phone/desktop-specific variants), 1 failed**: `[phone] shell.spec.ts:226 "glass: solid under reduced
  transparency and under an open sheet"` — real local Chromium + local Miniflare/workerd dev server (no real
  provider), fixture data. Treated as an environment flake, not a defect: re-run `e2e/shell.spec.ts` alone twice
  (34/35 passed, 1 skipped, including that exact test on `[phone]`, both clean) and the single test 3/3 in
  isolation — all clean. The only anomaly in the full run was two benign `workerd` "Broken pipe" log lines from the
  dev server around the same time, with every subsequent test still passing.
- Independent verification scripts (not part of the app, run against the installed Playwright Chromium, in
  `/tmp/.../scratchpad/vt-test/`): confirmed (a) a real tap mid-`document.startViewTransition()` is dropped by
  Chromium (`clicksMid: 0`, `clicksAfter: 1` once the transition finished) and (b) `locator.click()` on a no-JS page
  with a finite CSS fade-in animation times out under `reducedMotion: 'no-preference'` but succeeds in 49 ms under
  `reducedMotion: 'reduce'` — both match the engineer's stated reasons for the two config deviations below.

No new migration in this diff; `db:migrate:local` not applicable.

## Declared deviations — verified independently, both accepted

1. **Page transition is an opacity-only fade on `<main>` via `afterNavigate`, not the View Transitions API.**
   Verified: a standalone Chromium test (own page, own CSS, not reusing the app's test suite) shows a tap during an
   active `startViewTransition` is dropped and only registers after the transition finishes. `e2e/motion.spec.ts`
   ("rows take a real tap while they are still fading in" and "page fade-in … takes a tap at once") further shows
   the chosen opacity-fade approach does **not** drop taps, with and without JavaScript. Accepted.
2. **`playwright.config.ts` defaults to `reducedMotion: 'reduce'`.** Verified: a standalone no-JS page with a finite
   CSS fade-in reproduces the exact failure mode described (Playwright's actionability "stable" wait times out under
   `reducedMotion: 'no-preference'`, succeeds immediately under `'reduce'`). `e2e/motion.spec.ts` explicitly opts
   back into real motion per-test via its own `browser.newContext({ reducedMotion: 'no-preference' })`. Accepted.
3. **Illustration float runs three cycles then rests.** `Illustration.svelte`: `animation: float 3s
   var(--ease-in-out) 6 alternate` — 6 alternating iterations of a 3 s half-cycle = 3 full there-and-back cycles,
   then the animation stops (no `infinite`); `test/motion-css.test.ts` asserts no FN-40 animation uses `infinite`.
   Accepted.
4. **Two existing e2e tests updated** (`e2e/shell.spec.ts` glass test, `e2e/kekayaan.spec.ts` sheet-scroll test).
   Both diffs are non-semantic adjustments: the shell test now clears Playwright's own `reducedMotion` context
   emulation before applying the CDP `prefers-reduced-transparency` override (needed because the suite now defaults
   to `reducedMotion: 'reduce'`); the kekayaan test narrows its scroll-height assertion to `.sheet-body` (the
   already-merged Part 1/4 commit `a4c1ac4` split the sheet into a fixed head + scrolling body). Neither weakens
   what is asserted. Both pass. Accepted.

## Checked acceptance criteria (Parts 2, 3 and the shared/checklist items)

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 8 | Reduced motion removes all new movement, end state renders immediately | PASS | `test/motion-css.test.ts` (every `animation`/`transition` declaration gated under `@media (prefers-reduced-motion: no-preference)`, none uses `infinite`); `e2e/motion.spec.ts` "reduced motion: the end state renders at once" (hero, sheet, rows, bars, polyline, illustration all `animationName: none`) |
| 9 | Hero number counts 150–300 ms and settles on the exact server figure | PASS | `src/lib/ui/motion.ts` `interpolateMinor`/`countUpDuration` (whole minor units, forces exact `to` at `t>=1`, 0 duration on reduced-motion/currency-change/no-change); `src/lib/ui/kit/HeroAmount.test.ts`; `e2e/motion.spec.ts` "with motion: the hero counts … in ≤ 300 ms" samples every frame and asserts the last is the exact figure and every intermediate value is a whole amount between old and new |
| 10 | Stagger capped at 8 rows, not proportional to list length | PASS | `src/lib/ui/kit/GroupList.svelte` is pure CSS `nth-child(-n+8)` + 7 explicit delay rules (no JS timer); `test/motion-css.test.ts` "list stagger is capped" asserts rows 9/10/100/500 never animate; `e2e/motion.spec.ts` confirms row 8 delay 0.21 s, row 9+ none |
| 11 | CLS not increased (manual/stated) | STATED, NOT TOOL-VERIFIED | No Lighthouse/Web Vitals tooling run in this QA pass (none available in this sandboxed env); not reported as passed. All new illustrations and the auth hero art have explicit `width`/`height` (`size`/`Math.round(size*3/4)` in `Illustration.svelte`, `size=240` fixed in `daftar`/`masuk`), and the hero art is `display: none` below `768px`/`720px` so it never shifts the 360 px layout — reduces CLS risk but Web Vitals were not measured |
| 12 | Existing shell/kit journeys still pass | PASS (1 flake, not reproducible in isolation) | See "Commands run" above: 104/121 passed, 16 skipped (device-scoped), 1 failed once in the combined run, reproduced clean 2× more afterwards (34/34 and 3/3) |
| 13 | `EmptyState` illustration with no `alt` is `aria-hidden`, text is the only description | PASS | `Illustration.svelte` (`aria-hidden={alt ? undefined : 'true'}`, no `role` when decorative); `Illustration.test.ts` "decorative by default" for all 11 scenes + "EmptyState illustration (additive)" |
| 14 | Illustration repaints via `currentColor`/CSS vars in dark/mono, no hard-coded hex | PASS | `Illustration.test.ts` greps compiled CSS and every scene's markup for hex/rgb/hsl and `fill=`/`stroke=`/`style=` attributes (none found); `e2e/motion.spec.ts` "repaint from the theme tokens" renders in light/dark/mono-light/mono-dark and asserts 4 distinct fill values, mono ones achromatic (r≈g≈b); visually confirmed via `p23-illustrations-light.png` and `p23-illustrations-mono-dark.png` (purple/gold in light vs. fully greyscale in mono-dark) |
| 15 | Illustration float is static under reduced motion | PASS | Same `@media (prefers-reduced-motion: no-preference)` gating as criterion 8; `e2e/motion.spec.ts` checks `.illustration .float`/`.shadow` animationName is `none` under reduced motion and not `none` otherwise |
| 16 | 360 px: illustration never pushes the form/action below the fold | PASS | `daftar`/`masuk`: `.hero-art { display: none }` below `768px`×`720px`; Beranda zero-wallet card only shows when `walletCount === 0`; `e2e/motion.spec.ts` "360 px: sign-in and sign-up" and "Beranda with no wallet" assert the field/action bottom ≤ viewport height and no horizontal scroll; visually confirmed via `p23-dompet-360-mono-light.png` (no clipping) |
| 17 | No Rive dependency/import, SVG-only | PASS | `Illustration.test.ts` "no Rive runtime yet" scans every `src/**/*.{svelte,ts,js}` file for `@rive-app/` imports (none) and `package.json` (no entry) |
| 23 | `npm run gates` clean | PASS (after fixing the pre-existing worktree `node_modules` symlink issue — see Commands run) | check/lint/test/build all exit 0, see above |
| 24 | Every new Indonesian string has an `i18n-en.ts` entry | PASS | Only two new phrases added: `'Belum ada dompet'` → `'No wallets yet'`, `'Tambah dompet pertamamu supaya setiap transaksi punya tempat.'` → `'Add your first wallet so every transaction has a home.'`; i18n coverage test passed as part of the 2965-test vitest run |
| 25 | No new space_id-scoped query / server authorization surface | PASS | `src/lib/server/budgets/summary.ts` only exposes `wallets.length` from the **already-fetched** `wallets` array (pre-existing `Promise.all`, used before this diff for `currency`); no new `+page.server.ts`/`+server.ts` touching `db` in the diff; confirmed by file list in `git diff --stat` |
| 26 | Loading/empty/error/saving/success states unchanged in substance | PASS | Every existing `EmptyState` call site keeps its original `text`; only an additive `illustration` prop was added (diffed every call site individually — see below); `EmptyState.test` "without `illustration` an empty state is text only, exactly as before" |
| 27 | 360 px / 44 px touch targets hold for new interactive elements | PASS | Beranda's new `.first-wallet-link` is `min-height: 44px`; `e2e/motion.spec.ts` "Beranda with no wallet" explicitly asserts `box.height >= 44` and fits within a 780 px viewport |

Criteria 1–7 (theme) and 18–22 (glass) belong to Parts 1/4, already QA'd and merged; not re-checked here except
that the shared components they touch (Chip, GroupRow, Sheet, ScreenTitle/glass budget) still pass their existing
tests after Part 2's additions (confirmed above).

## Engineering checklist (docs/ENGINEERING_CHECKLIST.md) — no violations found

- **Svelte keyed lists**: `GroupList`'s stagger is pure CSS (`nth-child`), no new `{#each}` without a key; the
  dev/ui harness's new `{#each staggerRows as n (n)}` and `{#each scenes as scene (scene)}` are keyed.
- **i18n**: covered above (criterion 24).
- **Accessibility**: focus-return-to-opener verified by `e2e/motion.spec.ts` (sheet close moves focus back to the
  "Dompet" trigger button); no heading skip introduced; new touch target is 44 px.
- **CSP**: `Illustration.svelte`'s SVGs carry no inline `style=`/`fill=`/`stroke=` attributes (enforced by
  `Illustration.test.ts`), only classes resolved via the component's scoped `<style>`.
- **No real AI/providers used or required** by this diff; n/a.

## Findings

None blocking. One non-blocking note already covered above: Web Vitals/Lighthouse CLS (criterion 11) was not
measured in this sandbox — stated, not claimed as passed, per PRD instruction ("not a blocking gate if tooling is
unavailable, but must be stated, never reported as passed if unrun").

The one e2e failure observed (`shell.spec.ts:226` on `[phone]`, once, inside a 121-test combined single-worker run)
is judged an environment flake rather than a defect in this diff: it reproduced pass 2/2 on a full re-run of
`shell.spec.ts` alone and 3/3 in complete isolation, with the only correlated anomaly being transient `workerd`
"Broken pipe" dev-server log noise around the same point in the run, after which every following test (including
the one that had failed) passed normally.

## Screenshots reviewed (of the budget of 5)

- `p23-illustrations-light.png`, `p23-illustrations-mono-dark.png` — all 11 scenes legible, clean isometric
  geometry (boxes/discs/flags/coins), no resemblance to any product mascot; light theme shows accent purple + gold,
  mono-dark theme is fully achromatic (confirms recolouring via theme tokens).
- `p23-dompet-360-mono-light.png` — 360 px, mono theme: illustration + empty-state text + CTA all fit, no clipping,
  no horizontal overflow.
- `p23-masuk-1440-light.png` — wide sign-in screen: hero illustration sits above the form without crowding it.

## Environment note for future QA runs in this worktree

If `npm run check` reports a wall of "Cannot find module './$types'" errors that don't match the actual diff, check
whether `node_modules` in the worktree is a symlink to another checkout (`readlink -f node_modules`). If so, replace
it with a local copy (e.g. `rm node_modules && mkdir node_modules && cp -al <source>/node_modules/. node_modules/`)
before running `check`/`build` — `svelte-kit sync` writes a path-sensitive `node_modules/$app/tsconfig.json` that
multiple worktrees sharing one physical `node_modules` will stomp on each other's.
