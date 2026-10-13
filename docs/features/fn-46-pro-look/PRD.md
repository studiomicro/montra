# FN-46 — Montra Pro look

Status: proposed. Risk tier: **Medium** (no migration, no new space-scoped query, no provider/credential; but it
touches `hooks.server.ts` request handling, `docs/design/tokens.css`, the (app) layout's shared `ShellData`, the
PWA manifest/icon delivery path, and the Mascot component — breadth across the shell, like FN-40/FN-44 — plus one
genuinely new server-authorization surface: a client-stored theme cookie must never grant a Pro look to a Gratis
account).

Owner request (2026-10-11): "Montra Pro unique design." The owner picked all four parts named below the same day.

## Goal

Montra's Pro and Agen plans (`docs/features/fn-30-pro-hardening`, `src/lib/shared/billing/plans.ts`) already unlock
*capability* (more spaces, longer Gmail look-back, more credits) but look identical to Gratis. A visibly distinct,
own-brand "Pro look" — a badge wherever the account's name appears, two extra colour themes, a Pro home-screen icon
and mascot variant, and a quieter premium treatment of Beranda's one big number — gives the paid plans a reason to
be seen, not just used, and gives a free user something to see and want without ever blocking a feature they
already have. Every part is enforced on the server from the account's stored plan state
(`src/lib/server/billing/gate.ts:22` `planStateOf`), never from anything the client sends: a hidden cookie value or
a forged form field is not a plan.

## Scope

1. **Pro badge, everywhere the account's name/avatar already renders, plus a Pro card in Pengaturan › Paket.**
   - A new small `<ProBadge>` component (`src/lib/ui/kit/ProBadge.svelte`) — an own-brand pill/crown glyph, never a
     copy of any reference product's badge — shown next to:
     - the desktop sidebar's account row (`src/lib/ui/shell/Sidebar.svelte:113-121`, the `InitialsTile` + name);
     - Pengaturan's main screen title subtitle area (`src/routes/(app)/pengaturan/+page.svelte:13`, currently just
       `account?.email` with no name/avatar shown at all — this pass adds the account's name + an `InitialsTile`
       there too, so the badge has something to sit next to, matching the sidebar's own pattern);
     - `/pengaturan/akun`'s name row (`src/routes/(app)/pengaturan/akun/+page.svelte:61-65`).
   - A distinct "Pro card" on `/pengaturan/paket` showing the plan name and its end date in WIB, extending the
     existing hero `plan-line` (`src/routes/(app)/pengaturan/paket/+page.svelte:119-131`, which already computes
     this text) into its own visually separate card (background/border distinct from the plain `.plan-line` text)
     when `data.state.plan !== 'gratis'` — no new load data: `state.plan`, `state.currentPeriodEnd` already arrive
     from `planStateOf` (`+page.server.ts:51`).
   - Agen gets the **same** Pro badge and Pro card (Owner decision 6): both are "paid plan", not per-tier chrome.
     The Pro card's plan name text still reads "Agen" or "Pro" from `PLAN_CATALOGUE[plan].label`
     (`src/lib/shared/billing/plans.ts:40-74`) — only the badge/visual treatment is shared.

2. **Pro colour themes, gated.**
   - Two new `ThemePref` values beside the existing `system` / `light` / `dark` / `mono`
     (`src/lib/shared/theme.ts:4,7`): `gold` and `emerald` (Owner decision 1), each following the device's
     light/dark scheme exactly the way `mono` already does — one cookie value, a light sub-block and a
     `@media (prefers-color-scheme: dark)` sub-block in `docs/design/tokens.css`, the same structure
     `test/contrast.test.ts:12-13,17-23` already reads for `mono`/`mono-dark`. This supersedes
     `docs/features/fn-40-visual-refresh/PRD.md`'s "no 5th theme" note (Out of scope item 3 there) — that was
     written before this owner request.
   - `/pengaturan/tampilan` (`src/routes/(app)/pengaturan/tampilan/+page.svelte`, `+page.server.ts`) lists the two
     Pro themes after Hitam-putih, each row showing a lock affordance and leading to `/pengaturan/paket` with
     `tr('Perlu paket Pro atau Agen')` when the signed-in account's plan is Gratis, instead of being selectable.
   - **Server-side enforcement, not just a hidden picker row.** `resolveTheme` (`src/lib/server/prefs.ts:5-7`) stays
     a pure cookie parser (no DB access — matches its current signature and `building`-time use). The downgrade
     happens one level up, in `src/hooks.server.ts:52`, right after `authGate` has resolved `event.locals.user`
     (`src/hooks.server.ts:77`): when the cookie names `gold` or `emerald` and a user is signed in, look up
     `planOf(locals.db, user.id, Date.now())` (`src/lib/server/billing/gate.ts:36-38`, already the one place every
     other plan gate reads from) and, if the effective plan is `gratis`, overwrite `event.locals.theme` back to
     `'system'` before `resolve()` runs — `transformPageChunk`'s closure over `locals` (`src/hooks.server.ts:30-39`)
     reads the live object, so this one mutation is enough for the `%fin.theme%`/`data-theme` attribute, the
     `theme-color` meta tags and every page's rendered theme. Signed-out requests and the `building` prerender path
     (`src/hooks.server.ts:56-61`) never carry a Pro theme value meaningfully (no session to check) and are left as
     today — only reachable by an anonymous visitor directly setting the cookie, which still cannot authenticate as
     Pro, so there is nothing to protect there beyond what already happens (system theme shown). The query runs
     only when the cookie names a Pro theme (cheap, conditional — not on every request).
   - When a paid plan lapses while `gold`/`emerald` is the stored cookie, the very next request already reverts to
     `system` through the same check (no separate sweep, no stale look survives a page load) — this is what "a
     stored Pro theme falls back to default" means operationally (Owner decision 2: default is `system`, not the
     last non-Pro choice, since the cookie no longer names a value the account is free to keep).
   - i18n: `tr('Emas')`/`tr('Hijau tua')` (and English `'Gold'`/`'Deep green'`) added next to the existing
     `THEME_LABELS` (`src/lib/shared/theme.ts:9-14`); the lock copy `tr('Perlu paket Pro atau Agen')` too.

3. **Pro app icon, Koko crown, and the honest PWA-icon scope.**
   - **Research finding, stated plainly so the engineer does not re-discover it:** a Web App Manifest
     (`static/manifest.webmanifest`) and `<link rel="apple-touch-icon">` (`src/app.html:8,16`) are read once, at
     the moment the browser/OS installs the PWA to the home screen (iOS Safari's "Add to Home Screen", Android
     Chrome's "Install app" prompt). Neither is re-read afterwards: an icon that changes server-side after install
     does not update the already-placed home-screen icon. The scope here is therefore exactly: **the icon and
     manifest served *at the moment of installing or reinstalling* reflect the signed-in account's plan; an
     already-installed icon does not change live**, and the app says so once, in Indonesian, the first time a
     newly-Pro account opens `/pengaturan/instal` (reusing that existing install-guide route,
     `src/routes/(app)/pengaturan/instal/+page.svelte`) — e.g. "Ikon Pro terlihat saat kamu memasang ulang aplikasi
     dari layar utama" / "The Pro icon shows the next time you reinstall from your home screen" — never implying a
     silent swap.
   - `static/manifest.webmanifest` is currently a static asset served byte-for-byte (`src/app.html:8`); it cannot
     vary per session as a static file. This pass moves it to a server route, `src/routes/manifest.webmanifest/
     +server.ts` (the same "literal dotted filename as a route" pattern already used by
     `src/routes/api/v1/openapi.json/+server.ts`), which reads `locals.user`/`locals.plan` (see Architecture notes)
     and returns the existing JSON (`static/manifest.webmanifest`'s current content, unchanged for Gratis) or the
     Pro variant's `icons` array (same sizes/purposes, different `src` paths) for a paid account, with
     `cache-control: private, no-store` (it now carries an account-dependent answer, unlike a static asset) and the
     same `content-type: application/manifest+json`. `src/app.html:8`'s `<link rel="manifest">` href is unchanged
     (`%sveltekit.assets%/manifest.webmanifest` still resolves, now to the route instead of the static file — or,
     if the adapter's static-asset matching would shadow a route of the same path, the href moves to `/manifest.
     webmanifest` directly; the engineer confirms which against `@sveltejs/adapter-cloudflare`'s static/route
     precedence before relying on either). `test/manifest.test.ts` (currently reading the static file from disk)
     gains the Pro-icon-set assertions against the route's two possible JSON bodies instead of/alongside the file.
   - `src/app.html:16`'s `apple-touch-icon` href is swapped the same way `%fin.theme%` already is — a new
     `%fin.appleTouchIcon%` placeholder, substituted in `transformPageChunk`
     (`src/hooks.server.ts:30-39`) from the same `locals.plan` used for the theme/manifest checks, no second query.
   - New icon assets: `scripts/generate-mascot-icons.ts` (FN-44's deterministic Playwright-screenshot generator,
     already producing `icon-192`/`icon-512`/`apple-touch-icon`/maskable/monochrome PNGs from Koko's `idle` pose
     and a fixed light-theme palette, `scripts/generate-mascot-icons.ts:1-32`) gains a second fixed palette (`PRO`,
     alongside the existing `LIGHT` constant at line 23) adding a small gold crown accessory above Koko's head, and
     emits a second icon set: `icon-192-pro.png`, `icon-512-pro.png`, `apple-touch-icon-pro.png` (Owner decision 3:
     exactly these three — not a second maskable or monochrome set, since Android's maskable/themed icons are
     already shape-driven and a crown accessory would be clipped by the mask anyway).
   - **Koko's crown, wherever Koko already appears.** `Mascot.svelte` (`src/lib/ui/kit/Mascot.svelte:30-43`) gains
     an optional `pro` boolean prop; when true, a small fixed set of extra pixels (a crown, 3-4 px tall, same 24×24
     grid) renders above the current pose's head row, coloured by a new `k-crown` class mapped to a gold token
     (reusing the Pro theme's accent token from Part 2 so mono/gold/emerald all resolve it sensibly — never a raw
     hex in the component, matching `Mascot.test.ts`'s existing "no colour in the markup" rule). Every call site
     that already renders `<Mascot pose={...}>` (sign-up/sign-in hero, Beranda's zero-wallet state, error pages,
     `EmptyState`'s default, the three success moments, the loading indicator — `docs/features/fn-44-mascot/
     PRD.md:80-...`) passes `pro={<the page's own plan boolean>}`, not a fresh plan lookup per call site.

4. **Premium Beranda hero.**
   - `src/routes/(app)/+page.svelte`'s `<HeroAmount>` (`src/lib/ui/kit/HeroAmount.svelte`) gets an optional wrapping
     treatment — a subtle gradient or glass-card background behind the figure (reusing FN-40's `--glass-*` tokens,
     `docs/design/tokens.css`'s glass block, never a new blur budget violation: this is Beranda's hero, already one
     of the few places FN-40 allows a "frosted-over-colour" card per that PRD's Part 4 note on the hero area,
     `docs/features/fn-40-visual-refresh/PRD.md:146-148`) — shown only when the signed-in account's effective plan
     is Pro or Agen. The number itself, its size, its "one big number first" precedence and its WIB-bucketed
     `occurred_on` month total (`src/routes/(app)/+page.server.ts`'s `berandaSummary`) are **unchanged**: this is a
     background/frame treatment only, legible in light, dark and Hitam-putih (mono keeps it achromatic, like every
     other mono surface), never a second colour competing with `--money-in`/`--money-up`.
   - `HeroAmount` gains an optional `pro` boolean prop (default `false`); `src/routes/(app)/+page.svelte` passes the
     same plan boolean Part 1-3 already compute once per request.

## Out of scope

- Any change to what a plan actually *does* (credits, Gmail look-back, space count, Agent access) — FN-30 owns
  that; this feature is visual-only on top of the existing gate.
- A `.riv`/Rive asset or runtime for Koko's crown — stays hand-drawn SVG pixels, like the rest of Koko (FN-44).
- A live icon swap on an already-installed PWA — not possible per the research above; stated, not worked around.
- A third Pro theme, a per-space (vs. per-account) theme, or a user-authored custom colour — two Pro themes only,
  account-wide like every other theme value today.
- A different Pro card/badge visual for Agen versus Pro (Owner decision 6: identical chrome, different label text
  only) — a future request can split this later.
- Any new D1 table or column: every check reads `user_plan_state` (already exists, FN-30) through the existing
  `planOf`/`planStateOf` helpers; theme stays a cookie (as FN-40 established and this PRD keeps, just gated harder).
- Retention, credits cost, or AI usage — this feature calls no AI and spends no credit.
- Changing `/manifest.webmanifest`'s content for a signed-out visitor — signed-out always gets the Gratis manifest
  (there is no account to be Pro for), so the new route's Gratis branch is byte-identical to today's static file.

## Acceptance criteria

Vitest first; Browser only where real install/theme/viewport behaviour is the thing under test.

**Badge and Pengaturan (Part 1)**

1. Given a signed-in account whose effective plan is `pro` or `agen`, when the desktop sidebar, `/pengaturan` or
   `/pengaturan/akun` renders, then the Pro badge appears next to the account's name/avatar on all three (Automated:
   component test per surface; Browser: one `e2e` check on `/pengaturan`).
2. Given a signed-in account on `gratis` (including a never-paid and a lapsed-paid account), when the same three
   surfaces render, then no Pro badge appears (Automated, same tests, negative case).
3. Given a signed-in account on a paid plan, when `/pengaturan/paket` renders, then a distinct Pro card shows the
   plan label and `currentPeriodEnd` formatted in WIB via `formatDateTimeWib` (Automated: extend the existing
   `paket` page test; the formatting helper itself is already covered elsewhere — no new date-math test needed).
4. Given the account's stored plan is `agen`, then the badge and Pro card render identically to `pro` (same
   component, different label text only) (Automated: a parametrised test over both paid plans).
5. Given a plan with no `currentPeriodEnd` row at all (never purchased) and given a lapsed plan (`currentPeriodEnd`
   in the past), then neither shows the Pro badge or Pro card — `effectivePlan` already returns `gratis` for both
   (`src/lib/shared/billing/plans.ts:113-119`) (Automated: reuses the existing `effectivePlan` unit tests' two
   cases, asserted through the new UI).

**Themes (Part 2)**

6. Given a `gratis` account, when `/pengaturan/tampilan` renders, then `Emas`/`Gold` and `Hijau tua`/`Deep green`
   show a lock affordance and a link to `/pengaturan/paket`, and the form action that would set `theme=gold` or
   `theme=emerald` is refused (not merely hidden) when posted directly by a `gratis` session (Automated: a test
   that POSTs the form action with a `gratis` session and asserts the cookie is not set to the Pro value; Browser:
   `e2e` for the locked row's link).
7. Given a `pro`/`agen` account, when they pick `Emas` or `Hijau tua` on `/pengaturan/tampilan` with JavaScript
   disabled, then the `theme` cookie is set to `gold`/`emerald` and the next load shows `data-theme="gold"` (or
   `"emerald"`) (Browser: no-JS context, same pattern as `e2e/shell.spec.ts`'s existing no-JS theme test).
8. **Forged request, the acceptance template's named case.** Given a `gratis` session whose browser already holds
   a `theme=gold` cookie (set while the account was briefly Pro, or edited by hand in dev tools), when any page
   renders, then `hooks.server.ts` downgrades it to `system` server-side before the HTML is sent — `data-theme` is
   absent, not `"gold"` — regardless of what the client sent (Automated: a request test setting the cookie directly
   and asserting the rendered `data-theme`; this is the one case that must never regress to "trust the cookie").
9. **Plan lapse.** Given a `pro` account with `theme=gold` whose `currentPeriodEnd` has just passed (no action
   taken by the user), when they next load any page, then the same downgrade in item 8 applies — no separate sweep
   job, no stale Pro look survives one page load (Automated: same mechanism, a plan-state fixture with a past
   `currentPeriodEnd`).
10. Given either Pro theme is active, when contrast is measured for every pair `test/contrast.test.ts` already
    checks (`test/contrast.test.ts:31-55`), in both the light and dark OS scheme, then all meet WCAG AA 4.5:1 for
    body text, matching how `mono`/`mono-dark` are checked today (Automated: extend `THEMES` at
    `test/contrast.test.ts:24-29` with `gold`, `gold-dark`, `emerald`, `emerald-dark`).
11. Given a Pro theme is active, when an expense or income amount renders, then it still shows
    `--money-in`/`--money-up` (not the theme's accent hue) — colour only for meaning holds in every theme, Pro ones
    included (Automated: same pattern as FN-40's item 4 for mono).
12. Given every new Indonesian phrase this part adds (`Emas`, `Hijau tua`, the lock copy), then each has a matching
    `src/lib/shared/i18n-en.ts` entry (Automated: existing i18n coverage test).

**Icon, manifest and Koko (Part 3)**

13. Given a signed-in `pro`/`agen` account requests `/manifest.webmanifest`, then the response's `icons` array names
    the `-pro` PNG files and the response carries `cache-control: private, no-store`; given a `gratis` or signed-out
    request, then the response is byte-identical to today's static manifest (Automated: route test covering all
    three cases).
14. Given a signed-in `pro`/`agen` account loads any page, then `<link rel="apple-touch-icon">`'s `href` names the
    `-pro` file; given `gratis` or signed-out, then it names today's file (Automated: HTML-substitution test on
    `transformPageChunk`, the same style as the existing `%fin.theme%` test).
15. Given a newly-upgraded Pro account opens `/pengaturan/instal` for the first time after upgrading, then it shows
    the "reinstall to see the Pro icon" notice described above, in Indonesian with an English entry (Automated:
    component test for the copy's presence; this is a one-time informational notice, not a dismissible-state
    migration — no DB column, computed from the plan check alone every time the page renders for a paid account).
16. Given `pro` is passed to `<Mascot>`, when any pose renders, then the crown pixels are present and coloured via a
    theme-token class (no hex); given `pro` is false or omitted, then the crown is absent and every existing
    `Mascot.test.ts` snapshot is unchanged (Automated: extend `Mascot.test.ts`).
17. Given a `gratis` account, when any page that renders Koko executes, then `pro` is never passed as `true` for
    that account — covered by item 2's same plan-boolean source, re-asserted at each Mascot call site touched by
    this PRD (Automated: component tests per call site).

**Beranda hero (Part 4)**

18. Given a `pro`/`agen` account, when Beranda renders, then `HeroAmount` shows the premium background treatment
    and the figure, its size, and the "one big number first" layout are otherwise unchanged from a `gratis`
    render (Automated: component test diffing only the background class/style, not layout).
19. Given a `gratis` account, when Beranda renders, then no premium treatment appears (Automated, negative case).
20. Given the premium treatment is active, when contrast is measured for the figure and its `--muted` context line
    against the gradient/glass background's documented solid fallback, then it meets WCAG AA in light, dark and
    mono (Automated: extend `test/contrast.test.ts` with the new background/figure pair, same method as FN-40's
    glass-on-colour exception).
21. Given `data-theme="mono"` and a `pro` account, when Beranda renders, then the premium treatment is achromatic
    (no colour cast), consistent with every other mono surface (Automated: computed-style/token check).
22. Given demo/seed data (`Data demo` badge, `docs/HISTORY.md`/seed scripts' deterministic fictional rows) is shown
    on Beranda, then the premium treatment and Pro badge still only reflect the *real* account's plan state, never
    a property of the demo data itself (Automated: the demo-data flag and the plan flag are asserted independent
    in the component test — no accidental coupling).

**Checklist-derived (every part)**

23. Every server load/action this feature touches or adds (`/pengaturan/paket`, `/pengaturan/tampilan`'s form
    action, the new `/manifest.webmanifest` route, Beranda's load) re-derives the plan from `locals.user.id` through
    `planOf`/`planStateOf` on the server — never from a request body, query string or client-sent plan value
    (Automated: grep-and-review noted in the completion report, plus items 6/8/9/13 above as the executable proof).
24. `npm run gates` (check, lint, test, build) is clean after all four parts (Automated).
25. Every new Indonesian string has an `i18n-en.ts` entry; the existing i18n coverage test fails otherwise
    (Automated).
26. 360 px layout and 44 px touch targets hold for the badge, the two new theme-picker rows, and any new element on
    `/pengaturan/paket`'s Pro card (Browser: `e2e/shell.spec.ts`/`kit.spec.ts` pattern, extended).
27. Loading/empty/error/saving/success states on every touched page (`/pengaturan/paket`, `/pengaturan/tampilan`,
    Beranda) are unchanged in substance — this feature only adds a badge/background/icon around them, per
    `docs/ENGINEERING_CHECKLIST.md`'s "Truthful state" item (Automated: existing page tests for those routes still
    pass unmodified in assertions).
28. Space authorization: none of this feature's reads are space-scoped (plan is account-scoped, not
    space-scoped — `planOf`/`planStateOf` already take only `userId`); stated explicitly, as the template requires,
    and verified by grepping the diff for any new `space_id`-filtered query (there should be none) (Automated/
    manual grep, noted in the completion report).

## Architecture notes

- **New shared plan-boolean, computed once per request.** `src/hooks.server.ts:52` (where `event.locals.theme` is
  set) gains a conditional `planOf()` call and a new `event.locals.plan: Plan` (typed in `src/app.d.ts`'s `Locals`,
  alongside the existing `theme`), computed right after `authGate` resolves `event.locals.user`
  (`src/hooks.server.ts:77`) — one extra indexed-PK `user_plan_state` read, only when `event.locals.user` is set.
  `src/routes/(app)/+layout.server.ts:22-28`'s `ShellData` gains `plan: Plan` read from `locals.plan` (no second
  query) for the Sidebar/Pengaturan badge; Beranda's `+page.server.ts` and the new manifest/icon code read the same
  `locals.plan`. This is the one new piece of server plumbing this feature adds; everything else (Parts 1-4) is a
  consumer of it.
- `src/lib/ui/kit/ProBadge.svelte` — new, small, own-brand glyph; consumed by `Sidebar.svelte`, `pengaturan/
  +page.svelte` (which also gains the account name/`InitialsTile` it currently lacks), `pengaturan/akun/
  +page.svelte`, and `pengaturan/paket/+page.svelte`'s new Pro card.
- `src/lib/shared/theme.ts:4,7-14` — `ThemePref` gains `'gold' | 'emerald'`; `THEME_PREFS`, `THEME_LABELS` extended.
  `src/lib/server/prefs.ts` unchanged in shape (`resolveTheme` stays a pure parser).
- `src/hooks.server.ts` — the Pro-theme downgrade described in Scope item 2, next to the existing `locals.theme`
  line; no change to `transformPageChunk`'s own body beyond what already reads `locals.theme` live.
- `docs/design/tokens.css` — two new `:root[data-theme='gold']` / `:root[data-theme='emerald']` blocks plus their
  `@media (prefers-color-scheme: dark)` sub-blocks, following the `mono` block's exact structure
  (`docs/design/tokens.css:266,352`); a new gold accent token reused by Koko's crown (Part 3) and the Beranda
  premium treatment (Part 4) so there is one token, not three.
- `src/routes/(app)/pengaturan/tampilan/+page.svelte` + `+page.server.ts` — two new rows, locked for `gratis`; the
  form action gains the server-side refusal in item 6/8.
- `src/routes/(app)/pengaturan/paket/+page.svelte` — the Pro-card visual extension of the existing `plan-line`
  (`:119-131`); no load change (`+page.server.ts` already returns `state`).
- `src/routes/(app)/pengaturan/akun/+page.svelte`, `src/routes/(app)/pengaturan/+page.svelte` — badge + (for the
  latter) the new name/avatar row.
- `scripts/generate-mascot-icons.ts` — new `PRO` palette constant and crown overlay, emitting `icon-192-pro.png`,
  `icon-512-pro.png`, `apple-touch-icon-pro.png` under `static/icons/` (run by hand/CI as today, never part of
  `npm run gates`/`build`, per its own header comment at lines 6-14).
- `static/manifest.webmanifest` → `src/routes/manifest.webmanifest/+server.ts` (new dynamic route, same pattern as
  `src/routes/api/v1/openapi.json/+server.ts`); `test/manifest.test.ts` updated accordingly.
- `src/app.html:16` + `src/hooks.server.ts:30-39` — new `%fin.appleTouchIcon%` placeholder alongside `%fin.theme%`.
- `src/lib/ui/kit/Mascot.svelte`, `src/lib/ui/kit/mascot/poses.ts` (or a sibling file) — `pro` prop and crown pixels/
  `k-crown` class.
- `src/lib/ui/kit/HeroAmount.svelte`, `src/routes/(app)/+page.svelte` — `pro` prop and the premium background.
- `src/lib/shared/i18n-en.ts` — every new phrase.
- `test/contrast.test.ts` — extended `THEMES` array and new text/background pairs for the Beranda premium card.
- `src/app.d.ts` — `Locals.plan: Plan`.
- **No D1 migration.** Every plan check reads the existing `user_plan_state` table
  (`src/lib/server/db/schema.ts:1401-1421`) through the existing `planOf`/`planStateOf` (`src/lib/server/billing/
  gate.ts:22-38`); theme and the one-time install notice stay cookie/plan-derived, no new column.
- No Worker other than the app Worker is touched; no `workers/jobs` or `workers/inbound` change; no AI Gateway call.

## Prerequisites

None. Every part reads data already in D1 (`user_plan_state`, FN-30) and existing cookies; no new entry in
`.dev.vars.example` is required, no new provider account. The mock billing provider (`activeProvider`,
`src/lib/server/billing/provider.ts`) already lets a developer reach a paid plan locally in "mode uji" to exercise
every Pro-only path end to end without a real payment integration.

## Tracker impact

- Not already in `docs/TASKS.md`'s To-do list; new work opened directly from the owner's 2026-10-11 request (same
  pattern as FN-40/FN-44/FN-45's "owner request" entries there). Add a new "FN-46 Pro look" line to `docs/TASKS.md`
  once this PRD exists.
- `docs/ACCEPTANCE.md` rows this can extend once built and verified:
  - `Tokens from docs/design/tokens.css; AA contrast both themes | Automated | test/contrast.test.ts`
    (`docs/ACCEPTANCE.md:56`) → extend to six themes (light, dark, mono-light, mono-dark, gold(-dark),
    emerald(-dark)), still Automated.
  - A new row the owner may want: "Pro look (badge, theme, icon, Beranda hero) follows plan state server-side,
    never a client cookie | Automated | hooks.server.ts plan-downgrade test" once item 8 above passes.
- Closes no existing blocked/open `docs/TASKS.md` item (this is new scope, not a continuation of FN-30/FN-40/FN-44);
  it does depend on FN-30's `user_plan_state`/`planOf` already being merged (it is — `docs/TASKS.md:210` ticked).

## Owner decisions (defaults proposed; owner auto-accepts unless corrected)

1. **Pro theme names and colours: "Gold" (`gold`) and "Deep green" (`emerald`)**, each following the system
   light/dark scheme like Hitam-putih does today (one cookie value per theme, not a separate light/dark pick).
   *Default: yes*, using the owner's own example names.
2. **A lapsed or forged Pro theme falls back to `system`**, not to the account's last-chosen non-Pro theme (no such
   history is stored) and not to `light`. *Default: `system`*, matching every other "unset" theme behaviour today.
3. **Pro icon variants: exactly three new files** (`icon-192-pro.png`, `icon-512-pro.png`,
   `apple-touch-icon-pro.png`) — no second maskable or monochrome Pro set, since Android's maskable/monochrome
   icons are shape/silhouette-driven and would clip or flatten a crown accessory anyway. *Default: 3 files.*
4. **The honest PWA-icon scope**: the Pro icon and manifest apply only at install/reinstall time; already-installed
   icons do not update live, and the app says so once on `/pengaturan/instal` after an upgrade. *Default: yes* (no
   alternative is technically possible per the research above — this is a statement of fact, not a choice, but the
   owner is recorded as accepting the resulting UX).
5. **Agen gets the identical Pro badge/card/crown as Pro** (same visual, different plan-name text only) — no
   separate "Agen" tier of chrome in this pass. *Default: yes.*
6. **The Beranda premium hero treatment is a background/frame only** (gradient or glass card), never a different
   number size, colour, or layout — preserves "one big number first" exactly as FN-40's hero rules already require.
   *Default: yes.*
7. **`/manifest.webmanifest` moves from a static asset to a server route** to allow the per-account icon swap,
   losing static-asset-level caching for that one file (now `private, no-store`) in exchange for a per-session
   answer. *Default: yes* — the alternative (two fixed manifests at different URLs, with `app.html`'s `<link>`
   picking one server-side) was considered and rejected as equivalent complexity with a less conventional URL.

## Owner decisions — answered 2026-10-11

All proposed defaults accepted by the owner: themes "Emas" (Gold) and "Hijau tua" (Deep green), each following the
system light/dark setting; Agen has the same look as Pro (label differs only); the Pro icon applies at install or
reinstall, with a one-time note on `/pengaturan/instal`; a lapsed or forged Pro theme falls back to `system`. Items 3,
6 and 7 (three Pro icon files, background-only hero treatment, manifest as a server route) stay as proposed.
Orchestrator risk tier: Large (plan entitlement gates what a user may set), so QA and red team run in sequence.
