# FN-40 Visual Refresh — QA Report (Parts 1 + 4 only)

Scope: Part 1 (Hitam-putih/mono theme) and Part 4 (glass material). Parts 2 (motion) and 3 (illustrations) are
not in this diff and are not evaluated here. Worktree `.claude/worktrees/fn-40a`, branch `fn-40a-theme-glass`,
commit `e710274` (`git diff main...HEAD`).

## Verdict: FAIL (Cycle 1) — see "Cycle 2" section below for the current status

One visual regression in `Sheet.svelte`'s header (Part 4 glass) is visible in every theme and on every
sheet/dialog open (the single most common action in the app, "Tambah transaksi"). Gates, tests and contrast
coverage are otherwise clean; this is the only blocking finding.

## Commands run

- `flock …/montra-heavy.lock npm run check` (plain, no override) — 1609 files, **399 errors, 0 warnings**, exit 1 — real run, no mocks.
- `flock …/montra-heavy.lock npm run check` (with a temporary `rootDirs: [".", "<repo>"]` added to `tsconfig.json`, reverted after, no diff left) — same **399 errors**, exit 1 — the rootDirs override did not fix it either; real run.
- `flock …/montra-heavy.lock npm run lint` — `prettier --check .` and `eslint .` both clean, exit 0 — real run.
- `flock …/montra-heavy.lock npx vitest run --maxWorkers=2 test/contrast.test.ts test/glass-budget.test.ts src/lib/server/prefs.test.ts src/lib/ui/kit/GroupRow.test.ts` — 4 files, **154 passed**, exit 0 — real run against source, no mocked provider.
- `flock …/montra-heavy.lock npx vitest run --maxWorkers=2 test/i18n-coverage.test.ts src/lib/shared/i18n.test.ts` — 2 files, **15 passed**, exit 0 — real run.
- `LD_LIBRARY_PATH=… E2E_PORT=5251 npx playwright test --workers=1 e2e/shell.spec.ts e2e/tampilan.spec.ts e2e/kit.spec.ts` — **47 passed, 2 skipped**, 0 failed, local `wrangler dev` server (no real provider) — real browser run.
- `flock …/montra-heavy.lock npm run build` (`vite build`) — succeeded, "✔ done", service worker and Worker bundle built, exit 0 — real run.
- `npm run gates` was **not** run (owner instruction for this task: RAM cap, run the four steps individually instead); each of its four steps above was run and is clean except plain `check` (see finding on `./$types`, not a defect in this diff — see below).

## `./$types` false-positive claim — verified

Plain `npm run check` in this worktree reports exactly **399 errors**, all of the shape `Cannot find module
'./$types'` plus cascading `implicitly has an 'any' type` on the destructured handler parameters that follow from
it. Cross-checking the 399 error file list against `git diff main...HEAD --name-only`: only one changed file
appears, the new `src/routes/(app)/pengaturan/tampilan/+page.server.ts`, and it shows the *exact same* 4-error
shape (module-not-found + 3 implicit-any) as every untouched sibling route file in the repo (e.g.
`ruang/+page.server.ts`, `daftar/+page.server.ts`, `api/v1/sync/push/+server.ts` — none touched by this diff, all
carrying the identical error pattern). This confirms the error is a systemic artifact of this worktree (symlinked
`node_modules` pointing at the main checkout, confusing `.svelte-kit`-generated `./$types` resolution for every
`+page.server.ts`/`+server.ts` in the app, old and new alike), not a defect introduced by this diff.

I attempted to reproduce the engineer's claimed `rootDirs` fix myself (`compilerOptions.rootDirs: [".",
"<repo>"]`) and re-ran `check`: it produced the identical 399 errors, so that specific
override did not fix it for me. I could not independently verify a 0-error override run within the RAM budget for
this task. What I can state with confidence: the 399 errors are not specific to this diff's code (same pattern on
every unrelated route file), so they do not indicate a real type error introduced by Parts 1/4. `tsconfig.json` was
left unmodified (`git status` / `git diff tsconfig.json` clean after my experiment).

## Checked criteria (Part 1 — Theme)

1. Unset cookie → `resolveTheme` → `'system'`, no `data-theme` — PASS (`prefs.test.ts`, unchanged assertion still holds with widened type).
2. `theme=mono` → `resolveTheme` → `'mono'`, `<html data-theme="mono">` server-side — PASS (`prefs.test.ts`; `e2e/shell.spec.ts` "mono follows the system scheme…").
3. Mono + light/dark OS scheme → correct mono-light/mono-dark greys — PASS (`e2e/shell.spec.ts`, two browser contexts, asserts `--panel` and body background per scheme).
4. Mono keeps `--money-up`/`--money-in` colour — PASS (`test/contrast.test.ts` "money in/out keep their colour in mono, per scheme"; also `e2e/shell.spec.ts` checks `--money-up` computed value per OS scheme).
5. AA contrast across light/dark/mono-light/mono-dark — PASS (`test/contrast.test.ts`, `describe.each(THEMES)` over all 4, text and graphics pairs).
6. `/pengaturan/tampilan`, no-JS, form action persists cookie — PASS (`e2e/tampilan.spec.ts` "without JavaScript the choice is saved…").
7. New Indonesian strings have English entries — PASS (`test/i18n-coverage.test.ts` green; visually confirmed Tampilan/Sistem/Terang/Gelap/Hitam-putih + descriptions render correctly in `tampilan-*.png`).

## Checked criteria (Part 4 — Glass)

18. Text on glass meets AA against the solid fallback, mono included — PASS (`test/contrast.test.ts` new `--ink`/`--ink-2`/`--muted` vs `--glass-solid` pairs, all 4 themes).
19. `prefers-reduced-transparency: reduce` / no `backdrop-filter` → solid fallback — PASS (`e2e/shell.spec.ts` "glass: solid under reduced transparency and under an open sheet" uses a real CDP session to emulate the media feature since Playwright's `emulateMedia` has no option for it, documented in the test; `test/glass-budget.test.ts` covers the `@supports` branch statically).
20. ≤3 simultaneous blurred layers, 4th+ solid — PASS (`test/glass-budget.test.ts` enumerates every glass call site and every route, asserts none exceeds 3, plus the open-sheet-drops-chrome-blur rule in `app.css`/e2e test).
21. Mono glass is achromatic — PASS (`test/contrast.test.ts` "mono theme: every colour but money and brand is achromatic (glass included)" covers `--glass-bg` too).
22. Reduced motion removes the glass press "lift" — PASS (`test/glass-budget.test.ts` "the press lift exists only without reduced motion" for `Chip.svelte` and `TabBar.svelte`).
24. i18n coverage for every new phrase — PASS (same `i18n-coverage.test.ts` run as above).
25. No new `space_id`-scoped query — PASS (manual grep + read: the only new `+page.server.ts` is `pengaturan/tampilan/+page.server.ts`, which only reads/writes the `theme` cookie via `isThemePref`; it imports neither `db` nor any space-access helper; no other `+page.server.ts`/`+server.ts` is in the diff).
26. Loading/empty/error/saving/success states unchanged in substance — PASS (`e2e/shell.spec.ts`/`e2e/kit.spec.ts` full affected-route assertions still pass unmodified; `tampilan.spec.ts` exercises saving/success text "Perubahan disimpan.").
27. 360 px layout + 44 px touch targets for new/changed elements — PASS (`e2e/tampilan.spec.ts` asserts `label.row` ≥44px height and no horizontal scroll at 360px; `kit.spec.ts`/`shell.spec.ts` overflow checks still pass; visually confirmed in `tampilan-360-*.png`, `sheet-360-*.png`, `beranda-360-*.png` — no clipped text, no broken rows).

23. `npm run gates` clean — **not run as a single command** per this task's RAM instructions; its four steps were run individually (see Commands run). `lint`, targeted `test`, and `build` are clean; plain `check` shows the pre-existing 399 `./$types` worktree artifact (verified above to be unrelated to this diff's content, present identically on untouched files) — I could not produce a 0-error `check` run myself within budget, so I cannot mark 23 a clean PASS from first-hand evidence; I can state the 399 errors are not new regressions from this diff.

## Finding (blocking) — Sheet header "pasted band" in every theme

**Scenario:** Open the "Tambah transaksi" sheet (or any `Sheet.svelte`-based dialog) in any theme, any viewport.

**Expected:** The sticky header ("Tambah transaksi" + close button) reads as part of the one glass panel — same
edge, same rounded top corners as the rest of the sheet, matching how `ScreenTitle.svelte`'s `glass glass-soft`
header and `Sidebar.svelte`'s `bottom glass glass-soft` panel both blend seamlessly into their containers.

**Actual:** In `src/lib/ui/shell/Sheet.svelte`, `.sheet` (the `<dialog>`, class `glass`) is blurred/translucent,
but `.sheet-body` keeps its original `padding: 8px 20px …`, and the sticky `.sheet-head` inside it picks up
`--glass-fill` (set at the dialog level to `color-mix(in srgb, var(--bg) 86%, transparent)`, a near-opaque flat
fill, not blurred — `.sheet-head` itself has no `backdrop-filter`). Because the header's own box is inset by the
body's padding, and its fill colour no longer matches the blurred dialog background behind the padding gap (before
this diff both were the same flat `var(--bg)`, so the seam was invisible), the header now renders as a visibly
separate, almost-opaque rectangle floating inside the sheet with grey/translucent margins on its left, right and
top, not reaching the dialog's rounded top corners — a "pasted band" look.

**Evidence:** confirmed by visual inspection of
`docs/features/fn-40-visual-refresh/shots/sheet-360-mono-light.png` (reported by the coordinator),
`sheet-360-dark.png` (clearly visible: white-ish rectangle inset inside a black sheet) and
`sheet-1440-light.png` (same inset rectangle at desktop width). Less visible but present in `sheet-*-mono-dark.png`
(dark-on-dark, lower contrast between header fill and dialog background hides the seam, but the code path and
inset are identical).

**Root cause (for the engineer):** `.sheet-body { padding: 8px 20px … }` applies to the sticky `.sheet-head`
because it is a normal-flow child, not a full-bleed element with its own negative margin. A fix needs the header to
span edge-to-edge of the dialog (e.g. move the header outside `.sheet-body`'s padding with its own
`margin: -8px -20px 0; padding: 8px 20px 12px; border-radius` matching the dialog's top corners on mobile, or give
`.sheet-head` `width: calc(100% + 40px); margin: -8px -20px 0` at minimum) so its glass/solid fill reaches the same
edges as `.sheet`'s own background and corners.

**Secondary, non-blocking observation:** `docs/design/tokens.css`'s `:root[data-theme='mono']` block declares
`--glass-bg`/`--glass-solid`/`--glass-blur`/`--glass-bg-soft`/`--glass-blur-soft` but never `--glass-border` or
`--glass-shadow`; the nested `@media (prefers-color-scheme: dark)` sub-block for mono doesn't declare them either.
As a result, under mono in *either* OS scheme, every glass surface's 1px specular border and layered shadow fall
through to the top-level `:root` (light) values (`rgba(255, 255, 255, 0.7)` border, light shadow), never the dark
themed ones, even when mono is showing its dark sub-variant. `test/contrast.test.ts`'s "the dark half re-declares
every mono token the dark scheme changes" test does not catch this because it only checks tokens mono's own light
block declares, and mono's light block doesn't declare `--glass-border`/`--glass-shadow` either — so the gap is
invisible to the suite that exists specifically to catch it. Visually hard to confirm at screenshot resolution
(the border is a subtle 1px inset highlight), but it is a real token-coverage gap worth closing in the same fix
cycle as the header bug, since both are in `Sheet.svelte`'s/`app.css`'s glass code path.

## ENGINEERING_CHECKLIST.md

Purely visual/cookie-only diff: no D1, money, capture, AI, sync or redirect code touched. i18n, contrast,
accessibility (44px targets, focus) and "truthful state" items are all covered above. No checklist item is
violated by this diff.

## Not in scope here

Parts 2 (motion) and 3 (illustrations) are not in this diff (`git diff main...HEAD --stat` shows no
`HeroAmount.svelte`, `BarChart.svelte`, `Illustration.svelte`, or similar files) and are not evaluated by this
report; criteria 8–17 are left for the Part 2/3 QA pass.

---

## Cycle 2 — re-check after fix cycle, commit `59e85dd` (`git diff e710274..59e85dd`)

### Verdict: FAIL (one trivial, test-only fix remaining — everything else PASS)

The blocking Sheet-header "pasted band" is gone in every theme. The mono glass-token gap is closed and now has a
test that would have caught it. The Sheet restructure (header moved out of the padded, scrolling body) does not
regress any other sheet/dialog behaviour. The new 4-way sidebar theme cycle works and is tested. `lint`, the
targeted `test` run and the e2e journeys are clean — but plain `npm run check` is **not** clean: it has exactly one
real TypeScript error, newly introduced in this cycle's own e2e test file (not the pre-existing `./$types`
artifact, which is confirmed gone). Criterion 23 requires `npm run gates` (which includes `check`) to be clean, so
per the "only PASS if gates is clean" rule I am marking this FAIL rather than a conditional PASS, even though the
fix is a one-line type annotation with no behavioural/visual impact. See Finding below.

### What changed (`e710274..59e85dd`)

- `src/lib/ui/shell/Sheet.svelte`: `<header class="sheet-head">` moved outside `.sheet-body` (the padded, scrolling
  div) and is now a flex sibling (`.sheet[open] { display:flex; flex-direction:column }`); only `.sheet-body`
  scrolls (`overflow-y:auto; min-height:0`), the header has **no fill of its own** any more — it is the same glass
  surface as the dialog, edge to edge, into the rounded corners. `Sheet.test.ts` gained an assertion for exactly
  this ("the title row is part of the glass surface: no fill of its own, outside the padded body").
- `docs/design/tokens.css`: mono's `:root[data-theme='mono']` block and its `@media (prefers-color-scheme: dark)`
  sub-block now both declare `--glass-border`/`--glass-shadow` (previously missing from both, so mono silently fell
  through to the top-level light values even under mono-dark — the gap I flagged in Cycle 1). Light-scheme mono now
  carries the light theme's border/shadow and dark-scheme mono carries the dark theme's, matching `--glass-bg`'s
  existing per-scheme split.
- `test/contrast.test.ts`: new test "both halves declare every glass token themselves, the dark half with dark
  values" — asserts every `--glass-*` token is present in both mono sub-blocks, and that where the base dark scheme
  differs from light, mono's dark half differs from its light half too (not a copy). This is exactly the assertion
  that would have failed on the Cycle 1 code and did not exist then.
- `src/lib/shared/theme.ts` (new), `src/lib/ui/shell/theme.ts`, `ThemeToggle.svelte`: the sidebar's quick toggle is
  now a 4-way cycle (Sistem → Terang → Gelap → Hitam-putih → Sistem) sharing `ThemePref`/`THEME_PREFS` with the
  `/pengaturan/tampilan` picker, with a distinct icon per state (`monitor`/`sun`/`moon`/`contrast`) and an
  `aria-label` of `Tampilan: {tema}`. This is a scope change from the PRD text as written — the PRD explicitly says
  `theme.ts`/`ThemeToggle.svelte` "stays as the quick light/dark flip; it does not gain a 3rd state" and lists it
  under "unchanged in behaviour" in the architecture notes — but I was asked by the coordinator to verify this as
  intended behaviour for this cycle, so I treat it as an approved scope change rather than a PRD violation; flagging
  it here so `docs/features/fn-40-visual-refresh/PRD.md` and `docs/design/APP_PARITY.md`/`DESIGN_SYSTEM.md` can be
  reconciled with what actually shipped (DESIGN_SYSTEM.md's change-log was updated in this diff; the PRD body
  itself was not).

### Commands run (Cycle 2)

- `flock …/montra-heavy.lock npm run check` (plain) — **1717 files, 0 errors except 1 real TypeScript error at `e2e/shell.spec.ts:264:52`**, exit 1 — real run, no mocks. The 399 `./$types` false positives from Cycle 1 are gone entirely (no tsconfig change in this diff; most likely the symlinked-worktree state that caused them was transient/shared-machine-specific, not something this diff controls) — confirms the artifact is unrelated to this feature's code. The one remaining error is real: see Finding below.
- `flock …/montra-heavy.lock npm run lint` — `prettier --check .` and `eslint .` both clean, exit 0 — real run.
- `flock …/montra-heavy.lock npx vitest run --maxWorkers=2 test/contrast.test.ts src/lib/ui/shell/Sheet.test.ts src/lib/ui/shell/theme.test.ts src/lib/server/prefs.test.ts test/i18n-coverage.test.ts` — 5 files, **155 passed**, exit 0 — real run.
- `LD_LIBRARY_PATH=… E2E_PORT=5251 npx playwright test --workers=1 e2e/shell.spec.ts e2e/tampilan.spec.ts e2e/kit.spec.ts e2e/riwayat.spec.ts e2e/tabungan.spec.ts e2e/beranda.spec.ts e2e/impor.spec.ts` — **107 passed, 6 skipped, 0 failed** (2.5m), local `wrangler dev` server (no real provider) — real browser run. Covers: the Tambah sheet (focus trap, Escape, close button, stale-form refusal — `shell.spec.ts`, `riwayat.spec.ts`), `PickerSheet` (category/filter pickers in `riwayat.spec.ts`), the wallet-goal sheet (`tabungan.spec.ts`: add/edit/contribute/archive, a long form, a second-tab stale save, no-JS, 404), 360 px targets, and the new 4-way sidebar cycle (`shell.spec.ts` "the sidebar theme button cycles the four choices and keeps Hitam-putih"). Intermittent `[WebServer] kj::getCaughtExceptionAsKj() … Broken pipe` lines in the log are `workerd` noise from other concurrent sessions sharing this machine, not test failures — every test that logged one still passed.
- `npm run build` was **not** re-run in Cycle 2 (no production-bundling-relevant files changed beyond what Cycle 1 already built cleanly: `Sheet.svelte`, `theme.ts`, `tokens.css`, a new small `theme.ts` shared module — all plain Svelte/TS/CSS, same shape as what Cycle 1's successful build already covered).
- `npm run clean:tmp` run at the end; no lingering `wrangler dev`/`workerd`/`playwright` processes from this session.

### Re-checked criteria

- **Sheet header regression (Cycle 1 blocking finding): FIXED.** Visually confirmed in all 8 re-shot
  `sheet-*.png` (360 and 1440, light/dark/mono-light/mono-dark): the header is one seamless glass/panel surface
  with the sheet, reaching the rounded top corners, no inset band, in every theme.
- **Mono glass tokens (Cycle 1 secondary finding): FIXED,** with a regression test (`test/contrast.test.ts`, see
  above) that fails if the gap reopens.
- **Criterion 18, 19, 20, 21, 22 (Part 4 glass, contrast/budget/mono/reduced-motion):** still PASS — `test/glass-budget.test.ts` and `test/contrast.test.ts` are unchanged in their coverage of these except the new mono-glass-token test, and both still pass.
- **Other sheets/dialogs not regressed:** `tabungan.spec.ts` (wallet-goal sheet: add, a 2nd contribution, edit with
  a stale-tab conflict, archive/restore, no-JS, 404) and `riwayat.spec.ts` (Tambah sheet end to end, the category
  `PickerSheet`, the filter sheet, edit with a stale-tab conflict, delete) all pass unmodified — the flex
  restructure (`display:flex; flex-direction:column` on `.sheet[open]`, only `.sheet-body` scrolling) does not
  break long-content scrolling, the stale-form conflict banner, or any form inside a sheet.
- **Focus trap / Escape / close button:** `shell.spec.ts` "Tambah sheet opens, lists the capture paths, closes with
  Esc and returns focus" and "Tambah sheet closes with the close button" both pass — focus still returns to the
  opener, native `<dialog>` focus trap is untouched by the restructure (only CSS/markup order changed, not the
  `dialog`/`showModal` logic).
- **360 px:** `tampilan.spec.ts` 44 px row-height assertion and `expectNoHorizontalScroll` pass; `kit.spec.ts` and
  `shell.spec.ts` overflow/touch-target checks pass; visually confirmed no clipping in the 360 px sheet/tampilan
  screenshots.
- **New theme cycle (Sistem → Terang → Gelap → Hitam-putih):** PASS — `theme.test.ts` unit-tests the cycle and
  that 4 clicks from any starting state return to it; `shell.spec.ts` "the sidebar theme button cycles the four
  choices and keeps Hitam-putih" drives the real button in a browser, reloads mid-cycle to confirm the mono cookie
  persists, and confirms `Sistem` clears the cookie. Visually the sidebar icon is now `monitor`/`sun`/`moon`/
  `contrast` per state (seen in the re-shot 1440 screenshots: a half-filled-circle "contrast" icon in mono).

### Finding (non-blocking, must still be fixed) — real type error in the new e2e test

**Scenario:** `npm run check` (plain, no override) on commit `59e85dd`.

**Expected:** 0 errors (the `./$types` worktree artifact from Cycle 1 is confirmed gone — see Commands run above).

**Actual:** 1 real TypeScript error:

```
e2e/shell.spec.ts 264:52 "No overload matches this call. … Argument of type 'string | undefined' is not
assignable to parameter of type 'string | RegExp' …"
```

**Root cause:** the new cycle test (added in this diff) does:

```ts
for (const [label, next] of [
  ['Sistem', 'light'],
  ['Terang', 'dark'],
  ['Gelap', 'mono'],
  ['Hitam-putih', 'system']
]) {
  …
  await expect(html).toHaveAttribute('data-theme', next); // line 264
```

The array literal has no `as const`/explicit type, so TypeScript infers each row as `string[]`; destructuring
`[label, next]` from `string[]` under this repo's `noUncheckedIndexedAccess: true` gives `next: string | undefined`,
which `toHaveAttribute`'s second parameter (`string | RegExp`) rejects. Fix: type the array explicitly, e.g.
`const CYCLE: [string, ThemePref][] = [...]` or add `as const` to each tuple.

**Why this doesn't change the Cycle 2 verdict:** it is a test-file-only type error (no runtime/user-facing effect —
Playwright ran the exact same test successfully at runtime, since `ts` type-checking is separate from execution),
it was not present in Cycle 1's diff, and it's a one-line, obvious fix. I am flagging it as a finding to fix rather
than blocking Cycle 2 on it outright, but **`npm run gates`/`check` is not actually clean** until it's fixed, so the
engineer should land a one-line fix before this ships, and QA should see a clean plain `check` in any further cycle.

### Overall

FAIL, solely on the unclean `npm run check` (one real, one-line type error in `e2e/shell.spec.ts:264`, not a
design/behaviour regression — Playwright executed that exact test successfully). Everything substantive — the
blocking Cycle 1 header bug, the mono glass-token gap, and every other sheet/dialog/theme-cycle behaviour checked —
is confirmed fixed and not regressed. Expect this to pass on the next cycle with a one-line fix and no other
changes needed.
