# FN-43 brand badges: security report

Scope: `git diff main...HEAD` at f78001a (branch `fn-43-brand-badges`). Reviewer: red-team-pentester, 2026-10-09.

## Verdict: PASS

No medium or high findings.

## What was checked

- **Markup, attribute and class injection.** User text (wallet names, subscription names, bill names) only goes
  into `matchBrand()` (`src/lib/shared/brands.ts:119`), which returns a constant `BRANDS` entry or null. Every class
  the badge renders (`b-{entry.id}` in `BrandBadgeById.svelte:205`, `series-brand-{id}` through `walletSeries()` at
  `brands.ts:156` → `alur-uang/+page.svelte:821` and the chart components) comes from a hard-coded registry id or
  the literal `accent`, never from the name. `Chip.svelte` `brand` and `PickerSheet` `option.brand` are fed only by
  `WALLET_QUICK_PICKS` constants and `institutionOption()` (registry id via `brandById`); an unknown id renders
  nothing. The badge text is `entry.badgeText` (constant), escaped by Svelte text interpolation. No `{@html}`, no
  `style=` attribute and no inline style in any changed file (`BrandBadge.test.ts` also asserts no `style=`, `<img`,
  `<svg`, `url(`).
- **ReDoS.** `cleanText` caps input at `NAME_MAX*4` (320) code units before any regex; the split regex
  `/[^\p{L}\p{N}]+/u` is linear; alias matching is array/Set lookups. Probe (scratch test, deleted): 1 MB of
  spaces, zero-width spaces, `-` and `"a "` repeated each matched in well under 200 ms.
- **Probe inputs:** `"><img src=x onerror=alert(1)> bca` → `bca` badge only; `walletSeries('x"><script>')` →
  `accent`; `brandById('bca" onmouseover="x')` → null; `institutionOption({id:'__proto__'})` → no brand.
- **CSP.** Colours are CSS custom properties in `tokens.css`, `series.css` and component-scoped stylesheets; no
  inline styles were added, so `style-src` needs no new allowance.
- **Data and authorization.** No server file, loader, form action, API route, migration or query changed. Matching
  runs on names already in each page's data from the caller's own space; no new fields are serialised and there
  are no cross-space reads.
- **Third-party artwork.** No image, SVG, font or remote asset is bundled or fetched. Badges are text monograms in
  MONTRA tokens with `--ink` text on a 16 % tint; the mono theme turns them grey.
- **QA e2e spec** (`e2e/qa-fn43-brand-badges.spec.ts`). Each test signs up a fresh fictional user in its own
  signed-out context, using the existing helpers. It adds only assertions and does not change config, skip or
  relax any test, auth or CSRF behaviour.
- **ENGINEERING_CHECKLIST.** Nothing in the diff touches space access, secrets, money arithmetic or storage.

## Findings

### L1 (low): badge hues and monograms sit close to third-party trade dress

`docs/design/tokens.css:79-106`, `src/lib/shared/brands.ts:28-94`. Each `--badge-*` hue is picked to be "close to"
the service's public colour, and several monograms copy the brand's own word-mark casing (`GoPay`, `Gojek`, `blu`,
`inDr`). This is not a logo and is not bundled artwork, but a coloured tile showing the brand name in the brand's
colour family moves toward trade dress. CLAUDE.md says "mirror behaviour, never brand", and the owner has not yet
decided on logos (`logoAsset` is deferred, `BrandBadgeById.svelte` comment).
Repro: open `/dompet` with a wallet named `GoPay` and compare the tile with the service's own app icon.
Fix: record an owner sign-off in the PRD that colour-family monograms are acceptable, or move to neutral hues.
Keep any `logoAsset` behind written brand-guideline permission, as the code comment already says.

### L2 (low, informational): name-based matching can mislabel a wallet

`brands.ts:119`. Any user-typed name containing a whole-word alias (for example `"Grab hutang teman"`, or
`"Saldo Maxim"` for a non-ride wallet) gets that service's badge and Alur uang hue. The effect is cosmetic only:
nothing is stored, and the user controls the name in their own space. It cannot cross spaces or reach another user.
Repro: create a wallet `Bayar ke BCA teman` → it shows the BCA badge.
Fix: none required. An optional "no badge" toggle could be added later.

## Commands run

- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 src/lib/shared/zz-rt-probe.test.ts src/lib/shared/brands.test.ts src/lib/ui/kit/BrandBadge.test.ts test/brands-contrast.test.ts`
  → Test Files 4 passed (4), Tests 162 passed (162). The probe file was deleted afterwards and `git status` is
  clean apart from this report.
- Playwright e2e was not run by this reviewer; the spec was only read.
