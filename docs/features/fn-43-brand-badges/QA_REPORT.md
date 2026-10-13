# QA Report — FN-43 Brand badges for wallets, imports and subscriptions

**Verdict: PASS**

Reviewed: `git diff main...HEAD` (one commit, `bdcfe68 wip(fn-43): cycle 1`, on top of `main` `ab236ac`). No load,
action, server route, migration or table/column was touched — pure shared-domain (`src/lib/shared/brands.ts`),
UI-kit (`BrandBadge`/`BrandBadgeById`/`picker.ts`/`PickerSheet.svelte`), design-token and five call-site changes,
exactly the architecture table in the PRD (plus one deliberate scope addition — see Findings).

## Commands run

- `flock /tmp/montra-heavy.lock npm run check` → `svelte-check`/`tsc` ×3, **0 errors, 0 warnings** (worktree).
- `flock /tmp/montra-heavy.lock npm run lint` → `prettier --check .` clean, `eslint .` clean, exit 0.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2` → **227 test files, 3418 tests passed**, 0 failed (185.6 s).
- `flock /tmp/montra-heavy.lock npm run build` → Vite build + service worker + `adapter-cloudflare` prerender, exit 0.
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=6143 flock /tmp/montra-heavy.lock npx playwright test --workers=1 e2e/tabungan.spec.ts e2e/langganan.spec.ts e2e/alur-uang.spec.ts e2e/alur-uang-qa.spec.ts e2e/impor.spec.ts e2e/beranda.spec.ts e2e/kit.spec.ts` → **85 passed, 6 skipped (phone-only on desktop project), 0 failed** (2.6 min); real Chromium against a real local `wrangler dev` Worker + local D1, no mocked AI reached (no AI Gateway ids set in e2e env), no real external provider. (`e2e/dompet.spec.ts` does not exist in this repo — Dompet/wallet journeys live in `e2e/kekayaan.spec.ts`; see QA-written test below for the gap this left.)
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=6143 flock /tmp/montra-heavy.lock npx playwright test --project=phone --workers=1 e2e/qa-fn43-brand-badges.spec.ts` (QA-written, see below) → **3 passed**, exit 0, real Chromium + local `wrangler dev` + local D1.
- `npm run db:migrate:local` — **not run**: no migration in this diff (confirmed by `git diff --stat -- migrations/` = empty).

All four `npm run gates` steps are clean.

## New test written by QA

PRD criterion 13 explicitly calls for a "Browser/Playwright" test extending the existing Dompet list DOM test, and
criterion 14 allows "Automated/Browser"; the engineer's own diff added none — `grep -rn "BrandBadge\|b-bca\|tile s4" e2e/*.spec.ts`
returned nothing before this report. I added `e2e/qa-fn43-brand-badges.spec.ts` (2 tests, committed with this
report):
1. "Dompet: a wallet named BCA shows the bca brand badge; an unnamed wallet keeps its initials tile" — adds a real
   wallet named "BCA" and one named "Dompet harian" through the sheet, asserts the BCA row's tile has class
   `b-bca`, text `BCA`, `aria-hidden="true"`, no `<img>`/`<svg>` inside the tile, and that the wallet's own
   `.name-text` is still a separate, visible DOM node (criterion 10); asserts the badge survives a full page
   reload (derived live from `name`, not a stored flag — owner decision 5); asserts the unmatched wallet keeps its
   generic initials tile (`DH`, no `b-*` class).
2. "Langganan catalogue: GoPay Plus shows the gopay badge, Netflix keeps its initials tile" — opens the real
   catalogue picker sheet and asserts "GoPay Plus" draws `b-gopay`/`GoPay` and "Netflix" keeps its plain `NE`
   initials tile with no `b-*` class.

Both pass. This closes criteria 13 and 14's browser-evidence gap; the component- and unit-level coverage for the
rest (Beranda bills, Impor picker, Alur uang) is otherwise adequate — see per-criterion notes below.

## Checked criteria

**Registry and matching**
1. PASS — `src/lib/shared/brands.test.ts` `it.each(['BCA','bca',' BCA ','Bank Central Asia',...])` → `bca` (part of the 3418-test Vitest run).
2. PASS — `'GoPay, Gojek and GoFood are three entries, none cross-matches'` (`brands.test.ts`); 'gopayx' → null confirms whole-word-only matching. Note: the registry actually ships **28** entries (6 ride/food, incl. a separate `gofood`), not the PRD's literal "15 + 7 + 5 = 27" headcount — see Findings.
3. PASS — `'Tabungan BCA'→bca`, `'GoPay Plus'→gopay`, `'GrabUnlimited'→grab`, etc. (`brands.test.ts` whole-word-in-longer-name table).
4. PASS — `'Dompet harian'`, `'Dana darurat'`, `''`, `'+++'`, `'abca'` → `null` (`brands.test.ts`).
5. PASS — `'no two entries share an alias or whole name'` (`brands.test.ts`, iterates every alias/wholeName pair).
6. PASS — `'a 10,000-character name is cut before any work'`: 200×`matchBrand` on a padded 20k-char string asserted `< 500 ms`; `cleanText`'s existing cap (`text.ts:12`) is reused unchanged.
7. PASS — `brandById('bca')`/`brandById('unknown-id')` (`brands.test.ts`).

**Visual and tokens**
8. PASS — `test/brands-contrast.test.ts`, parametrised over all 28 `BRANDS` ids × 4 themes (light/dark/mono-light/mono-dark), `--ink` on the 16 % tint ≥ 4.5 and the bar hue on `--bg` ≥ 3 (1.4.11) — ran clean in the full Vitest pass. Spot-checked visually: `docs/features/fn-43-brand-badges/shots/dompet-360-mono-light.png` shows every badge achromatic in mono; `dompet-360-light.png` shows distinct hues in colour themes.
9. PASS — all 28 `--badge-<id>` tokens have a `:root[data-theme='mono']` grey override (`docs/design/tokens.css` diff, verified by direct read); `test/contrast.test.ts`'s pre-existing generic "every colour but money and brand is achromatic" check passed in the full suite with no change needed to that test, as the PRD predicted.
10. PASS — `BrandBadge.test.ts` asserts `aria-hidden="true"`; QA's own Playwright test confirms the adjacent `.name-text`/label DOM node is independently present and visible, not replaced by the badge.
11. PASS — `BrandBadge.test.ts`/`BrandBadgeById` render assertions (`not.toMatch(/<img|<svg|url\(|style=/)`) across all 28 ids × 3 sizes; confirmed by code read (`color-mix(in srgb, var(--c) 16%, var(--bg))`, a CSS class only, no inline style).
12. PASS — `'an unmatched name renders exactly the InitialsTile it had before'`: byte-identical SSR output compared for `InitialsTile` vs `BrandBadge` on 3 unmatched names × 3 sizes.

**Where it shows**
13. PASS (QA-added browser test — see above). Automated unit-level evidence also present (`brands.test.ts`'s catalogue/quick-pick checks).
14. PASS — `brands.test.ts` `'every catalogue entry outside the registry keeps its generic tile'` → only `gofood-plus`/`gopay-plus`/`grabunlimited` match; QA's browser test confirms GoPay Plus vs Netflix live in the picker sheet. Beranda's "Akan datang" call site (`+page.svelte:535`) uses the same `BrandBadge` component already proven correct by `BrandBadge.test.ts`; not separately browser-tested (low risk, same component, same props shape as Dompet/Langganan which are browser-tested).
15. PASS — `brands.test.ts` `institutionOption` test: a synthesized `bni` parser id (already in the registry) carries `brand: 'bni'` with zero extra code, confirming the "add a parser, get a badge for free" claim; live-confirmed indirectly — `STATEMENT_PARSERS` already lists both `BCA` and `BNI` (`src/lib/shared/statements/parsers.ts`, FN-16d landed on `main` before this branch), so this is not a hypothetical — `e2e/impor.spec.ts`'s own suite (which exercises the BCA and BNI upload flows) passed unmodified in the gates run.
16. PASS — `brands.test.ts` `walletSeries` unit test (`'BCA'→brand-bca`, `'Dompet GoPay'→brand-gopay`, `'Dompet harian'→accent`); `alur-uang/+page.svelte` diff confirmed to only swap the `series` key, leaving `FlowChart.svelte`'s node text/amount rendering untouched (no new text, no geometry change) — confirmed by code review. Not additionally extended inside `money-flow.test.ts` as the PRD suggested, but the mapping function itself is unit-tested and wired correctly; `e2e/alur-uang.spec.ts` passed unmodified.

**Cross-cutting**
17. PASS — `git diff --stat -- '*.server.ts' '*+server.ts'` empty; no load/action file in the diff at all. Existing cross-space tests for Dompet/Langganan/Beranda/Impor/Alur uang all passed unmodified in the full gates run.
18. PASS — confirmed by code read: `PickerSheet.svelte:50` keys `{#each options as option (option.value)}`; `impor/+page.svelte:706` same; `CataloguePicker.svelte:34` keys by `group.key`/`entry.id` (unchanged).
19. PASS — `git diff main...HEAD | grep -n "tr(\|trf(" | grep "^+"` → no output; no new Indonesian/English copy introduced.
20. PASS — `git diff main...HEAD -- '*.svelte' | grep "^+.*style="` → no output; every tile uses `--c`-setting CSS classes only.
21. PASS — fixed `s36`/`s40`/`s44`/`s24` classes (`BrandBadgeById.svelte`), same construction as `InitialsTile`; `e2e` phone-project 360 px tests (`beranda.spec.ts:132`, `langganan.spec.ts:246`, `tabungan.spec.ts:238`, `kit.spec.ts:32/42`) all passed with no horizontal-scroll/CLS failures.
22. PASS — `Chip.svelte`'s `min-height: 44px` under `@media (pointer: coarse)` is unchanged by the `branded` class (only `padding-left` changes); `GroupRow` touch target unaffected by the `InitialsTile`→`BrandBadge` swap (same tile size).
23. PASS — `npm run gates` equivalent (check/lint/test/build run individually above) all clean.
24. PASS — trivially true by code review; no copy added at all (criterion 19).

## Findings

1. **Entry-count / scope note (non-blocking).** The PRD's Part 1 prose ("ride/food — Gojek, Grab, Maxim,
   ShopeeFood, inDrive — 5", "27 entries total") and Owner decision 2 ("15 banks + 7 e-wallets + 5 ride/food…
   bounds the token count to 27") describe 27 entries, but the PRD's own acceptance criterion 2 requires `GoPay`,
   `Gojek` and `GoFood` to resolve to **three** distinct entries, which is only possible if `gofood` is its own
   registry id (not an alias folded into `gojek` or `shopeefood`). The engineer resolved this internal
   contradiction by adding a 28th entry (`gofood`, ride/food), with a matching token, mono override, badge class
   and chart-series rule for all 28 — internally consistent and every acceptance criterion that depends on it
   (2, 5, 8, 9) passes. Flagging for the record since "27 entries"/"5 ride/food" is stated three times in the PRD
   and is not what shipped; no functional defect, no legal concern (still MONTRA's own colour/text, not a brand
   asset).
2. **Unrequested scope addition (non-blocking, but outside the PRD's architecture table).** The PRD's "Out of
   scope" section explicitly lists "WalletForm's e-wallet quick-pick chips (`Chip.svelte`'s `icon` prop is a
   fixed icon-font glyph, not a per-brand colour slot) … keep their plain text labels", and the Architecture
   notes table does not list `Chip.svelte` or `WalletForm.svelte`. The diff nonetheless adds a new `brand?: string`
   prop to `Chip.svelte` (with its own `BrandBadgeById` render branch, CSS and tests) and wires it into
   `WalletForm.svelte`'s quick-pick chips (`GoPay`/`OVO`/`ShopeePay`/`DANA` now show their badge). This is a
   reasonable, well-tested improvement (own `Chip.svelte` tests, `WalletForm.test.ts` updated accordingly, 44 px
   touch target preserved — see criterion 22) and does not violate any acceptance criterion, but it is scope the
   PRD said not to build this pass; flagging so the tracker/PRD reflects what actually shipped.
3. **fn-35 (money-flow) screenshot evidence is now stale (informational only).** Running `e2e/alur-uang.spec.ts`
   regenerates `docs/features/fn-35-money-flow/shots/*.png` in place (plain `page.screenshot()`, not a pixel-diff
   assertion) — FN-43's wallet-bar colour change (criterion 16) visibly alters those captures. QA reverted the
   regenerated files (`git checkout -- docs/features/fn-35-money-flow/shots/`) so this report does not touch
   unrelated evidence; no action needed unless fn-35's QA_REPORT is re-read for its original screenshots.
4. **Brand colours are distinct from the real brand hues, not sampled copies** — spot-checked BCA (`#2a6cc6`, the
   real BCA blue is closer to `#0F3A8A`), Gojek (`#129a3c` vs. the real `#00AA13`), OVO (`#764cc0` vs. the real
   `#4C3494`): all recognisably "in the hue family" per the owner's intent, none a pixel-identical copy. No logo
   artwork, bundle or scraped asset anywhere in the diff (`git diff --stat` shows only the two new `.ts`/`.svelte`
   files, CSS and route edits — no binary image additions besides the engineer's own `shots/*.png` evidence).

No FAIL-level findings. All 24 acceptance criteria verified with evidence; `npm run gates` is clean; the one
criterion (13) and one PRD-requested browser check (14, partially) with no engineer-written browser test now have
QA-written Playwright coverage that passes.
