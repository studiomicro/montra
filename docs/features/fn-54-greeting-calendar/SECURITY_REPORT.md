# FN-54 Greeting and calendar — security report

Reviewer: red-team-pentester, 2026-10-13. Scope: `git diff main...HEAD` at 4359a99 (feat/fn-54-greeting-calendar rebased onto main 9414412).

## Verdict: PASS

No medium or high findings. Two low findings are recorded so they stay tracked.

## Findings

### L1 (low): the Tanya question from Beranda travels in the URL

- Where: `src/lib/ui/home/GreetingHero.svelte:48` (`<form method="GET" action="/tanya">`) and `src/routes/(app)/tanya/+page.server.ts:73`.
- What happens: the user types a financial question on Beranda (for example "berapa gaji saya bulan ini"). It becomes `/tanya?q=...`. The text then stays in browser history, in synced history on other devices, and in any proxy or extension that records URLs.
- What limits it: `Referrer-Policy: strict-origin-when-cross-origin` keeps the query out of cross-origin Referer headers. `wrangler.jsonc` sets `invocation_logs: false`, so the Worker does not log the URL. Nothing is stored and no AI call is made.
- Suggestion: after hydration, remove `q` with `replaceState` once the composer has the text. Alternatively, open Tanya with JavaScript and pass the text through history state instead of the URL.

### L2 (low): a link can pre-fill the Tanya composer with attacker text

- Where: `src/routes/(app)/tanya/+page.server.ts:73`.
- Reproduction: a link to `https://app/tanya?q=<text>` opens Tanya with that text in the composer.
- What limits it: nothing is sent until the user presses Kirim. The text is cleaned by `cleanQuestion` (control and zero-width characters removed, capped at `TANYA_QUESTION_MAX`; reads are capped at 2 000 characters first) and is rendered only as text. The assistant tools are read-only and scoped to the session's space. The only risk is social engineering: the user may be tricked into sending a prepared prompt into their own space.
- Recommendation: accept the risk, or prefill only when the request comes from the same origin (`Sec-Fetch-Site: same-origin`).

## Checked and found sound

- **/kalender authorization:** `currentSpaceScope`, which runs `requireSpaceAccess`, runs before any read. All four reads use the scoped `spaceId`. Closures use `locals.user.id` only (`closedDatesIn`, user-scoped, `limit 31`). No read takes an id from the request. The integration tests cover two users and two spaces, a shared space and a removed member (404).
- **`bulan` and `hari` parameters:** checked for exact length, then `isMonthString`/`isDateString`, then clamped to the window (23 months back, 2 ahead). `hari` must fall inside the shown month. A fuzz PoC (13 malformed or out-of-range months, 8 malformed days, plus SQL quote, NUL, full-width digits and trailing whitespace) always fell back to a valid month or to null. Queries go through Drizzle and are parameterised.
- **Bounded reads:** one month of `dailyTotals` and one `PAGE_SIZE` day page. Subscriptions are capped by `MAX_SUBSCRIPTIONS_PER_SPACE` and series by `MAX_SERIES_PER_SPACE`. The expansion runs in memory with at most 40 steps per item, so a schedule that never advances still stops. No per-item query.
- **Daily sheet cookies:** a forged `montra-sapaan-seen` cookie that is not a 10-character real date counts as "not seen". `montra-sapaan-off` changes behaviour only when it is exactly `1`. Both cookies only show or hide the sheet. Its cards come from the load's own space figures. `storySeenCookie` writes only the date the server computed. The off cookie is HttpOnly, SameSite=Lax, Secure on HTTPS and Path=/.
- **Tampilan actions and CSRF:** `sapaan` requires a signed-in user, reads the body through `readFormBody` and accepts only the value `enabled === 'on'`; any other value means off. The cross-site form guard in `hooks.server.ts` (`isCrossSiteForm`) covers both actions. The renamed `theme` action still runs `isThemePref` and the `planOf` Pro gate. No caller still posts to the old default action.
- **"On this day" content:** the entries are a build-time JSON file. It is never fetched or written by a model, and it ships empty (`[]`). The validator accepts only `https:` URLs without credentials, at most 500 characters. A PoC confirmed that `javascript:`, `data:`, `http:`, `//host` and `user:pass@` URLs are all rejected. Text has length and sentence caps and is rendered as text, never with `{@html}`. Source links use `target="_blank" rel="noopener noreferrer"`. There are no images.
- **CSP:** unchanged (`script-src 'self'`, `style-src 'self'`, `img-src 'self' data:`, no `'unsafe-inline'`). The new components have no inline `style=` attributes. `HeroScene` and the illustrations have no external `href`/`xlink`, `<image>`, `<foreignObject>` or event attributes.
- **Hidden amounts:** every new amount (story cards, budget chip, calendar cells and their aria labels, due items, rows) goes through `shown()`. As in FN-25b, hidden amounts are only a display setting: the figures are in page data by design. The heat-cell intensity class (`l{level}`) is pre-existing (main `HeatCalendar.svelte:50`) and unchanged.
- **Nav registry:** only data changed (tones, hints, icons). Each route still enforces its own gate (module visibility, `/agen` plan lock). A link does not grant access.
- **Brand:** compared with the reference screenshots 6, 7 and 8. The diff contains none of the reference app's names, taglines or illustrations. The mascot is Montra's own pixel Koko (FN-44). The scene is generic blocks and coins, not the reference skyline art. "Good afternoon." is a generic phrase.
- **Engineering checklist:** bounded reads, one access rule, form-body guard, `{#each}` keyed by id or index, no `{@html}`, i18n entries present, no upload, AI or R2 paths touched.

## Commands

- PoC `src/lib/shared/zz-rt-poc.test.ts` (fuzzes `bulan`/`hari`, cookies, prefill cleaning and the URL validator): 5/5 passed, then deleted.
- `npx vitest run test/integration/kalender.test.ts`: 12 passed
- `npx vitest run test/integration/sapaan.test.ts`: 5 passed
- `npx vitest run test/integration/tanya.test.ts`: 30 passed
- `npx vitest run test/integration/beranda.test.ts`: 38 passed
- `npx vitest run src/lib/shared/calendar.test.ts`: 29 passed
- `npx vitest run src/lib/shared/on-this-day.test.ts`: 19 passed
- `npx vitest run src/lib/shared/daily-story.test.ts`: 19 passed
- `npx vitest run src/lib/ui/shell/nav.test.ts`: 25 passed

## Resolution (2026-10-13)

- **L1 — fixed.** Tanya removes `q` from the address with SvelteKit's `replaceState` once the page has hydrated and the
  composer holds the question (`src/routes/(app)/tanya/+page.svelte`), so the question stays out of the history entry
  and a reload starts empty. The GET form stays the no-JavaScript path; without JavaScript the question remains in that
  one URL, as any search form's does. Regression: `e2e/tanya.spec.ts` "FN-54: a prefilled question…" (URL becomes
  `/tanya`, a reload shows an empty composer); it failed before the fix.
- **L2 — mitigated, least intrusive option.** A prefilled question is marked in words above the composer: "Pertanyaan
  ini diisi dari tautan. Belum ada yang dikirim." (English: "This question was filled in from a link. Nothing has been
  sent."), shown while the text is still the prefill. Nothing is sent before the user presses Kirim (unchanged; no AI
  call, credit, key use or row on load, `test/integration/tanya.test.ts`), and the text is rendered only as a textarea
  value. A same-site marker was not chosen: it would need a new cookie or token round-trip and break the plain GET
  form without JavaScript, for no gain over showing the user that the text came from a link. Regression: the same e2e
  test checks the note; it failed before the fix.

## Cycle 2 re-check (4359a99..1e8ccd4): PASS

Reviewed `git diff 4359a99..1e8ccd4` only. No medium or high findings. L1 and L2 are closed; the open item is listed under "Not run" below.

- **L1 (closed):** `src/routes/(app)/tanya/+page.svelte` calls `replaceState` from `onMount`. It removes only `q` and keeps the other parameters and `page.state`, so the history entry no longer holds the question. Without JavaScript the URL still carries `q`. That is the accepted fallback for the plain GET form, and the URL is still not logged (`invocation_logs: false`).
- **L2 (closed):** a fixed, translated note ("Pertanyaan ini diisi dari tautan. Belum ada yang dikirim.") shows while the composer still holds the prefill unchanged. The note is static text, and the prefill is still rendered only as the textarea value. There is no new send path.
- **/kalender hidden amounts:**
  - **Cold load:** `applyAmountsHiddenAtLoad()` runs at script level, the same as Beranda, Dompet, Laporan, Kekayaan and Anggaran. On the server, the root layout's `provideAmountsHiddenAtLoad` resets the module state on every render, and SSR is synchronous (no async SSR in `vite.config.ts`). So one request's choice cannot reach another request on the same isolate. `kalender-page.test.ts` renders hidden and then shown in sequence: the day figure, every cell `aria-label`, the rows and the due items are masked, and the next render shows amounts again.
  - **Client:** `onMount` applies the device's stored choice, and leaving the page resets `amounts.hidden = false`. This matches HeroAmount on main and `/alur-uang`.
  - **`__data.json`:** it still carries the figures. This is by design: hidden amounts is a display setting, not access control (FN-25b).
- **Other changes:** the remaining changes are cosmetic: the DailyStory compact formatter (still wrapped in `shown()`), the input CSS, and HeroScene `meet`. The SVG still has no external references and no style attributes.

Commands, cycle 2:
- `npx vitest run "src/routes/(app)/kalender/kalender-page.test.ts"`: 2 passed
- `npx vitest run src/lib/ui/home/home.test.ts`: 30 passed
- `npx vitest run test/integration/tanya.test.ts`: 30 passed
- `npx vitest run test/integration/kalender.test.ts`: 12 passed
- PoCs: none needed; the render test already checks the shared server state from one request to the next.

Not run:
- `E2E_PORT=5471 npx playwright test e2e/tanya.spec.ts e2e/kalender.spec.ts`: did not start, `scripts/e2e-build.sh: line 4: exec: flock: not found` (exit 127). The e2e checks that `replaceState` actually removes `q` and that the client-side visit is masked are therefore not confirmed by this review. They rely on QA's e2e run.
