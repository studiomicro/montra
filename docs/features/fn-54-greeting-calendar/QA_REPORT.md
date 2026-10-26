# FN-54 QA report (cycle 1)

**Verdict: FAIL** (criterion 7 broken on /kalender; two visual defects in the hero). Gates are otherwise clean.

Worktree HEAD 4359a99 on top of main 9414412. No migration in the diff.

## Commands run

- `npm run check` — svelte-check 2346 files, 0 errors, 0 warnings, tsc for service worker and both workers clean; exit 0; no provider.
- `npm run lint` — prettier "All matched files use Prettier code style!", eslint clean; exit 0; no provider.
- `npm run build` — adapter-cloudflare "done", 18 prerendered site files; exit 0; no provider.
- `npm run test` — 375 files passed, 6393 tests passed; exit 0; local D1 (miniflare), no real provider.
- Touched Vitest files run one at a time (calendar, daily-story, greeting, on-this-day, home, nav, Illustration, contrast, glass-budget, motion-css, pro-look-ui, integration beranda/kalender/pro-look/sapaan/tanya, i18n-coverage) — every file passed (counts: 29, 19, 26, 19, 27, 25, 40, 587, 9, 170, 24, 38, 12, 15, 5, 30, 3); local D1.
- Playwright (E2E_PORT=5429, --workers=1, local app, no AI Gateway, mocked provider where the spec says so): beranda-hero, kalender, sapaan, beranda, fitur, alur-uang, period-reports, tampilan, shell, ios-responsive, pro-look — 131 passed, 4 skipped (viewport-gated by design), exit 0.
- Playwright motion, struk, pwa, beruntun (criterion 47 list) — 121 passed, 22 skipped (project-gated), exit 0.
- Temporary Playwright probes (screenshots in light, dark, mono at 360 and 1280; computed style of the ask input; hidden-amounts cold load of `/kalender` and `/`) — run, then deleted; nothing left in the tree. Other features' screenshots restored with `git checkout -- docs` (tree clean).
- Not run: `npm run db:migrate:local` (no migration), real-device checks (criterion 48, the "You" items), screen-reader pass.

## Acceptance criteria

1. greeting/WIB vectors incl. 03:59/04:00 — PASS (`greeting.test.ts` 26 tests; uses epoch arithmetic, no `getHours`).
2. 23:59/00:00 WIB date, badge, label — PASS (integration beranda 38, kalender WIB test, `home.test.ts` badge Nov case).
3. English locale — PASS (`home.test.ts`, `i18n-coverage.test.ts`).
4. state line count equals Riwayat day group — PASS (integration beranda, e2e "a transaction today").
5. chip 1 unchanged, no percent — PASS (existing CompareLine; e2e `%` count 0).
6. chip 2 phrases and figure equal budget line — PASS (`home.test.ts` BudgetChip, e2e budget chip vs line).
7. hidden amounts from first server render on hero, chips and `/kalender` day detail — **FAIL**. Hero and chips mask (`/` cold load with cookie: 19 "••••", no Rp digits; e2e shows "•••• masih bisa dipakai"). `/kalender` does not: with cookie `montra-amounts-hidden=1` the server HTML has `Rp 25.000` in the day figure, the cell labels (`aria-label="1 Okt: Rp 0"`), and the day's rows, 0 "••••". See Finding 1.
8. Pro frame once, shrink-to-fit — PASS (`home.test.ts` Pro frame test; e2e pro-look).
9. 360 px no overflow, first viewport, 44 px — PASS (beranda-hero e2e, ios-responsive both devices).
10. ask field only prefills Tanya, `q` cleaned/capped — PASS (`tanya.test.ts` 30; code review: `cleanQuestion` after a 2000-char read cap, no send path).
11. disabled with visible reason, GET works without JS — PASS (home test, e2e JS-off case).
12. scene renders per period, no style/image/filter, size — PASS (`home.test.ts` HeroScene, no CSP violations in e2e). Visual defect, Finding 2.
13. reduced motion, no layout shift — PASS (`motion-css.test.ts`, motion e2e, beranda-hero height-from-first-paint test).
14. contrast AA, chip glyphs 3:1 — PASS (`contrast.test.ts` 587).
15. header placement, tab order, one Struk/Suara per viewport — PASS (beranda-hero e2e placement test; desktop screenshot confirms badge, Struk, Suara right of h1).
16. Struk disabled with `aria-describedby` and visible reason — PASS (e2e; desktop shows the reason line under the header).
17. badge name and link — PASS (e2e). Deviation: name reads "Kalender, Selasa, 13 Oktober 2026" (second comma from `formatDayLabel`); accepted.
18. authorization, two users/spaces, signed-out, removed member — PASS (`kalender.test.ts` 12). Removed member: the hook falls back to their personal space, so they see 0 of the shared rows; same behaviour as every other (app) page; accepted. `currentSpaceScope` still re-checks membership first.
19. `bulan`/`hari` validation and clamp — PASS (integration + e2e out-of-window).
20. WIB 23:30/00:30, Feb 2028 29 cells — PASS (integration).
21. cell/day figure equals Riwayat, demo excluded and badged — PASS (integration, e2e).
22. bill/recurring marks, day 31, paused series, read count — PASS (`calendar.test.ts` 29, integration; visual: Netflix day 31 marked on 31 Oct).
23. closed ring + shade, keyboard focus — PASS (`home.test.ts` HeatCalendar marks; e2e focus).
24. states — PASS (integration injected failures; page has Skeleton, per-read ErrorState, empty text).
25. no-JS calendar — PASS (e2e).
26. URL state across reload — PASS (e2e).
27. registry glyphs/hues — PASS (`nav.test.ts` 25; sidebar screenshot shows distinct glyphs on chips).
28. tiles, Kelola fitur, hidden modules — PASS (`home.test.ts`, e2e fitur).
29. mono/Emas/Hijau tua, sidebar fit — PASS (shell e2e incl. sidebar-scroll case; mono screenshot greys the chips).
30. icon safe zone, RUNBOOK section, no icon file change — PASS (`test/icons.test.ts` reused; RUNBOOK.md line 415; `static/` untouched in diff).
31. sheet opens after hydration, steps, Escape, focus to main — PASS (sapaan e2e; screenshots at 360 and 1280).
32. once per WIB day, cookie, 23:59→00:00 — PASS (`daily-story.test.ts` 19, e2e).
33. off switch, JS and no-JS, survives reload — PASS (`sapaan.test.ts`, e2e).
34. never-open cases — PASS (decision helper table, e2e `?anggaran=1`, first-paint test).
35. card figures equal Beranda's and respect the mask — PASS for equality (values are the same integers). The sheet prints the per-day figure in full with sen ("Rp 156.578,94 sehari untuk 19 hari") while Beranda's line prints it compact ("Rp148 rb"). Low finding 3. Mask: PASS (`shown()` on `/`, where the page applies the cookie).
36. validator, empty file, cited links — PASS (`on-this-day.test.ts` 19; `entries.json` is `[]`).
37. review log cross-check — PASS (log is empty, matches empty file).
38. one blurred layer — PASS (`glass-budget.test.ts`).
39. access/bounded queries — PASS (diff review: every read takes the scope's `spaceId`/`userId`; day totals for one month, one list page, 100 subscriptions).
40. money/dates grep — PASS (`greeting.test.ts` grep case).
41. i18n coverage — PASS (`i18n-coverage.test.ts`; 38 new `i18n-en.ts` entries).
42. untrusted text — PASS (`q`, `bulan`, `hari`, cookies validated; entries rendered as text).
43. CSP — PASS (collectCspViolations in beranda-hero and kalender e2e: none).
44. accessibility — PASS in e2e/DOM checks; manual screen-reader pass not run.
45. truthful state — PASS (Mematikan… then success only after the server answered; Tampilan toggle).
46. no-JS — PASS (e2e).
47. gates and updated specs — PASS (all listed specs run above).
48. real-device checks — not run (You items).

## Engineer deviations judged

- Badge accessible name with extra comma: accepted.
- "Tidak ada pengeluaran tercatat kemarin.": accepted, more accurate than the PRD wording because the bar is expense-only.
- Removed member lands on their personal space: accepted (see criterion 18).
- Icon safe-zone tests reused: accepted (`test/icons.test.ts` covers the maskable PNGs and manifest).
- Privacy text unchanged: accepted; `/privasi` lists no cookie names, so nothing to add.
- No copying of the reference app: hero is Montra's own isometric blocks and coin tower with Koko (no skyline photo, no orange cat, no "Today, you can too" line); wording "Nothing recorded today" is close to the reference's "Nothing logged yet today" but generic; "Sources:" label is mandated by the PRD.
- FN-53 Alur uang: still works (alur-uang and period-reports specs green; sidebar entry and Kelola fitur sheet show the chip icons).

## Findings

1. **High — `/kalender` ignores the hidden-amounts cookie (criterion 7).** Input: signed-in user with one Rp 25.000 expense today, cookie `montra-amounts-hidden=1`, cold GET `/kalender`. Expected: day figure, cell labels and row amounts show "••••". Actual: server HTML contains `<strong>Rp 25.000</strong>`, 12 cell labels "Rp 0", and the row amount; 0 "••••". Cause: `src/routes/(app)/kalender/+page.svelte` never calls `applyAmountsHiddenAtLoad()` (Beranda, Dompet, Laporan, Kekayaan do), so `shown()` is a no-op on a cold load. Because `amounts` is module state shared on the server, the page may also render with whatever the previous request on that isolate set; the fix (call `applyAmountsHiddenAtLoad()` at the top of the script, as the other pages do) removes that too. There is no e2e or render test for this; add one for `/kalender` cold load with the cookie.
2. **Medium — sun and moon are cut off on wide hero cards.** At 1280 px the strip is 492 × 120 px for a 320 × 96 viewBox with `slice`, `yMax`: the scene scales to 1.54 and 27 px are cropped at the top, so the `siang` sun (cy 16) is half cut (visible in the desktop screenshot), and the night moon and first star are partly cropped. At 1440 px it is worse. Expected: the celestial disc visible at every width (PRD B5).
3. **Low — the ask field shows a stray rectangle.** The global `input` rule adds `box-shadow: inset 0 0 0 1px` (16 % ink) and the field has radius 0, so a square box shows inside the pill in light and dark (computed style confirmed). Expected: no inner box (the pill is the field). Fix: `box-shadow: none; border-radius: 0` on `.ask input`, or style the focus on the pill only.
4. **Low — daily sheet prints the per-day figure with sen** ("Rp 156.578,94 sehari…") where Beranda prints it compact. The value is the same exact integer, so no fabricated figure, but the precision implies more than a spending hint should. Use the same compact formatter as Beranda's line.

Engineering-checklist review of the diff: no further violations (space scope on every load/action, parameterised bounded reads, WIB dates, i18n entries, no inline styles, no migration).

# Cycle 2 (HEAD 1e8ccd4)

**Verdict: PASS.** Findings 1 to 4 are fixed; no new finding; all earlier criteria still hold.

## Commands run

- `npm run check` — 2347 files, 0 errors, 0 warnings; exit 0; no provider.
- `npm run lint` — prettier and eslint clean; exit 0; no provider.
- Touched Vitest one at a time (kalender-page.test 2, home.test 30, glass-budget 9, i18n-coverage 3, integration tanya 30, kalender 12, beranda 38, motion-css 170) — all passed; local D1.
- `npm run test` — 376 files, 6398 tests passed; exit 0; local D1, no real provider.
- Playwright (kalender, beranda-hero, sapaan, tanya, hidden-amounts.qa, beranda, shell; E2E_PORT=5429, --workers=1; local app, no AI Gateway) — 96 passed, 3 skipped (viewport-gated), exit 0.
- Temporary Playwright probes (cold and client-nav hidden amounts on /kalender, no-JS /tanya?q=, hero screenshots at 360, 1280, 1920 in light, dark, mono) — run, then deleted; tree clean, other features' shots restored.
- `npm run build` — adapter-cloudflare "done"; exit 0; no provider.
- Not run: real-device checks.

## Fixed findings

1. **/kalender hidden amounts (criterion 7): PASS.** Cold GET with `montra-amounts-hidden=1`: 15 "••••", 0 `Rp` digits in `<main>` (cycle 1: 0 dots, `Rp 25.000` shown). Eye clicked on Beranda, then the badge (client navigation): 0 `Rp` on /kalender; same after reload. `kalender-page.test.ts` "cookie masks the day figure, every cell label, the rows and the due items" fails on 4359a99 sources and passes now; the second case shows the next request starts unmasked (no state leak). Note: a cookie set without the device's stored choice is reset on mount (existing `loadAmountsHidden` rule, same as Beranda); real use sets both.
2. **HeroScene crop: PASS.** `preserveAspectRatio="xMidYMax meet"`; the test checks every circle lies inside the viewBox (fails on 4359a99). Screenshots at 360 (dark), 1280 (mono) and 1920 (light): the sun is whole, scene undistorted, card height unchanged. At 1920 the card is 740 px wide, so the scene sits centred with sky at the sides and the ground line ends short of the edges: cosmetic, accepted. Moon (y 12 to 29) and stars (y 17 to 37) are inside the 96-high viewBox, so `meet` never crops them; the night variant was not on screen at the time of the run (it is 13:xx WIB), covered by the viewBox test only.
3. **Ask pill inner box: PASS.** `box-shadow: none; border-radius: 0` on the input; screenshots show a clean pill in all three themes; the test fails on 4359a99.
4. **Daily sheet per-day figure: PASS.** `formatMoneyCompact`, as Beranda's line; test fails on 4359a99. (`glass-budget.test.ts` regex now allows `box-shadow: none` only; still rejects any other shadow.)

## Red team items re-verified

- Tanya strips `q` from the address after hydration: `e2e/tanya.spec.ts` passes (URL ends `/tanya`, reload shows an empty composer and no note).
- Link-prefill note "Pertanyaan ini diisi dari tautan. Belum ada yang dikirim." is visible while the text equals the prefill; English entry present (`i18n-coverage` passes).
- No-JS: `/tanya?q=Halo%20kopi` with JavaScript disabled still prefills the composer (value "Halo kopi", URL keeps `q`), nothing sent.

## Criteria

All 48 criteria keep their cycle 1 result; criterion 7 is now PASS, criteria 12 and 35 are PASS without the earlier visual notes. Criterion 48 (real-device) and the screen-reader pass remain not run.
